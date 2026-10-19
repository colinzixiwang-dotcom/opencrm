package tickets

import (
	"context"
	"log"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"harbor/internal/domain"
	"harbor/internal/persistence"
	source "harbor/internal/supportsource"
)

// Run starts one minute ticks. One worker never overlaps itself; a PostgreSQL
// session advisory lock deduplicates across servers, released on disconnect.
func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		if err := s.Sync(ctx); err != nil && ctx.Err() == nil {
			log.Printf("Udesk background synchronization failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) Sync(ctx context.Context) error {
	ctx = source.Background(ctx)
	return s.DB.WithContext(ctx).Connection(func(conn *gorm.DB) error {
		conn = conn.Session(&gorm.Session{NewDB: true})
		key := persistence.Prefix(conn) + s.Tenant + ":udesk.sync"
		var locked bool
		if e := conn.Raw("SELECT pg_try_advisory_lock(hashtextextended(?,0))", key).Scan(&locked).Error; e != nil {
			return e
		}
		if !locked {
			return nil
		}
		defer conn.WithContext(context.Background()).Exec("SELECT pg_advisory_unlock(hashtextextended(?,0))", key)
		worker := &Service{DB: conn, API: s.API, Tenant: s.Tenant}
		// Another instance may have just completed the same scheduled tick.
		var base SyncState
		conn.Where("tenant=? AND scope=''", s.Tenant).First(&base)
		if base.LastAttempt != nil && time.Since(*base.LastAttempt) < 55*time.Second {
			return nil
		}
		now := time.Now().UTC()
		if e := conn.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant"}, {Name: "scope"}}, DoUpdates: clause.AssignmentColumns([]string{"last_attempt"})}).Create(&SyncState{Tenant: s.Tenant, Scope: "", LastAttempt: &now}).Error; e != nil {
			return e
		}
		_, at, catalogError := worker.catalog()
		if catalogError != nil {
			return catalogError
		}
		parsed := sourceTime(at)
		if parsed == nil || time.Since(*parsed) > 30*time.Minute {
			if e := worker.refreshMetadata(ctx); e != nil {
				worker.syncFailure("", e)
				return e
			}
		}
		scopes := []string{""}
		catalog, _, e := worker.catalog()
		if e != nil {
			return e
		}
		for _, f := range catalog.Filters {
			if f.Active && f.ID != "" {
				scopes = append(scopes, f.ID)
			}
		}
		var firstError error
		for _, scope := range scopes {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			started := time.Now().UTC()
			run := Run{ID: domain.ID("SYNC"), Kind: "tickets.background", Status: "running", CreatedAt: started.Format(time.RFC3339Nano)}
			if e := conn.Create(&run).Error; e != nil {
				return e
			}
			all, e := worker.scan(ctx, scope)
			if e == nil {
				e = worker.publish(scope, all, started)
			}
			updates := map[string]any{"status": "completed", "count": len(all), "completed_at": domain.Now()}
			if e != nil {
				worker.syncFailure(scope, e)
				updates["status"] = "failed"
				updates["error"] = e.Error()
				if firstError == nil {
					firstError = e
				}
			}
			if updateErr := conn.Model(&run).Updates(updates).Error; updateErr != nil {
				return updateErr
			}
		}
		return firstError
	})
}

func (s *Service) syncFailure(scope string, e error) {
	now := time.Now().UTC()
	s.DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant"}, {Name: "scope"}}, DoUpdates: clause.AssignmentColumns([]string{"error", "last_attempt"})}).Create(&SyncState{Tenant: s.Tenant, Scope: scope, LastAttempt: &now, Error: e.Error()})
}

func (s *Service) scan(ctx context.Context, scope string) ([]source.Ticket, error) {
	return s.API.ScanTickets(ctx, scope)
}

func (s *Service) publish(scope string, all []source.Ticket, started time.Time) error {
	return s.DB.Transaction(func(tx *gorm.DB) error {
		worker := &Service{DB: tx, API: s.API, Tenant: s.Tenant}
		generation := domain.ID("INDEX")
		for _, t := range all {
			if e := worker.persist(t, started.Format(time.RFC3339Nano)); e != nil {
				return e
			}
		}
		members := make([]FilterMember, 0, len(all))
		for _, t := range all {
			members = append(members, FilterMember{Tenant: s.Tenant, Scope: scope, Generation: generation, TicketID: t.ID})
		}
		if len(members) > 0 {
			if e := tx.CreateInBatches(members, 500).Error; e != nil {
				return e
			}
		}
		now := time.Now().UTC()
		state := SyncState{Tenant: s.Tenant, Scope: scope, Generation: generation, LastSuccess: &now, LastAttempt: &started}
		if e := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant"}, {Name: "scope"}}, DoUpdates: clause.AssignmentColumns([]string{"generation", "last_success", "last_attempt", "error"})}).Create(&state).Error; e != nil {
			return e
		}
		return tx.Where("tenant=? AND scope=? AND generation<>?", s.Tenant, scope, generation).Delete(&FilterMember{}).Error
	})
}
