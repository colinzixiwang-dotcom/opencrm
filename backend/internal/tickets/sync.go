package tickets

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strconv"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"harbor/internal/domain"
	"harbor/internal/persistence"
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
		_, at := worker.metadata("fields")
		parsed := sourceTime(at)
		if parsed == nil || time.Since(*parsed) > 30*time.Minute {
			if e := worker.refreshMetadata(ctx); e != nil {
				worker.syncFailure("", e)
				return e
			}
		}
		scopes := []string{""}
		data, _ := worker.metadata("filters")
		for _, f := range rows(data["filters"]) {
			if active, ok := f["active"].(bool); ok && !active {
				continue
			}
			if key := id(f["id"]); key != "" {
				scopes = append(scopes, key)
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

// Use the existing verified list contract first. The tenant can overstate its
// last page and return page one again: tolerate only an exact first-page repeat
// on the final advertised page, never a duplicate in the middle of the scan.
func (s *Service) scan(ctx context.Context, scope string) ([]M, error) {
	all := []M{}
	seen := map[string]bool{}
	firstIDs := []string{}
	for page, pages := 1, 1; page <= pages; page++ {
		path := "tickets"
		q := url.Values{"page": {strconv.Itoa(page)}, "per_page": {"100"}}
		if scope != "" {
			path = "tickets/tickets_in_filter"
			q.Set("filter_id", scope)
		}
		v, e := s.API.Get(ctx, path, q)
		if e != nil {
			return nil, e
		}
		if page == 1 {
			pages = max(1, int(domain.N(obj(v["meta"])["total_pages"])))
			if pages > 10000 {
				return nil, fmt.Errorf("Udesk synchronization range exceeds its page limit")
			}
		}
		batch := rows(v["contents"])
		ids := []string{}
		added := 0
		for _, row := range batch {
			ticket := sourceTicket(row)
			key := id(ticket["id"])
			if key == "" {
				return nil, fmt.Errorf("Udesk returned a ticket without an ID")
			}
			ids = append(ids, key)
			if !seen[key] {
				seen[key] = true
				all = append(all, ticket)
				added++
			}
		}
		if page == 1 {
			firstIDs = ids
		}
		if page > 1 && added == 0 {
			a, _ := json.Marshal(ids)
			b, _ := json.Marshal(firstIDs)
			if page == pages && (len(ids) == 0 || string(a) == string(b)) {
				break
			}
			return nil, fmt.Errorf("Udesk repeated or omitted an intermediate source page")
		}
	}
	return all, nil
}

func (s *Service) publish(scope string, all []M, started time.Time) error {
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
			members = append(members, FilterMember{Tenant: s.Tenant, Scope: scope, Generation: generation, TicketID: id(t["id"])})
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
