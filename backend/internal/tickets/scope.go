package tickets

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strconv"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"harbor/internal/domain"
	"harbor/internal/persistence"
)

const MorphoScope = "morpho"

// TicketScope is the Support Access aggregate for product membership. Source
// groups and personal agent mappings are separate from this shared business rule.
type TicketScope struct {
	Tenant            string   `gorm:"primaryKey" json:"-"`
	Product           string   `gorm:"primaryKey" json:"product"`
	Name              string   `json:"name"`
	Revision          int      `json:"revision"`
	IncludeUnassigned bool     `json:"includeUnassigned"`
	UpdatedAt         string   `json:"updatedAt"`
	UpdatedBy         string   `json:"updatedBy"`
	GroupIDs          []string `gorm:"-" json:"groupIds"`
}
type TicketScopeGroup struct {
	Tenant  string `gorm:"primaryKey"`
	Product string `gorm:"primaryKey"`
	GroupID string `gorm:"primaryKey"`
}
type TicketScopeChange struct {
	Tenant    string       `gorm:"primaryKey" json:"-"`
	Product   string       `gorm:"primaryKey" json:"product"`
	Revision  int          `gorm:"primaryKey" json:"revision"`
	ActorID   string       `json:"actorId"`
	ActorName string       `json:"actorName"`
	ChangedAt string       `json:"changedAt"`
	Snapshot  string       `json:"-"`
	Before    *TicketScope `gorm:"-" json:"before,omitempty"`
	After     *TicketScope `gorm:"-" json:"after,omitempty"`
}

var initialMorphoGroups = []string{"4918", "4974", "5041", "5042", "5043", "5044"}

func scopeFrom(db *gorm.DB, tenant string) (TicketScope, error) {
	var p TicketScope
	if e := db.Where("tenant=? AND product=?", tenant, MorphoScope).First(&p).Error; e != nil {
		return p, e
	}
	p.GroupIDs = []string{}
	e := db.Model(&TicketScopeGroup{}).Where("tenant=? AND product=?", tenant, MorphoScope).Order("group_id").Pluck("group_id", &p.GroupIDs).Error
	return p, e
}
func (s *Service) scope(ctx context.Context) (TicketScope, error) {
	// A tenant's defaults are inserted exactly once. Never restore removed groups
	// on restart, and never auto-include newly discovered source groups.
	var p TicketScope
	e := s.DB.WithContext(ctx).Where("tenant=? AND product=?", s.Tenant, MorphoScope).First(&p).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			p = TicketScope{Tenant: s.Tenant, Product: MorphoScope, Name: "Morpho", Revision: 1, UpdatedAt: domain.Now(), UpdatedBy: "system"}
			r := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&p)
			if r.Error != nil {
				return r.Error
			}
			if r.RowsAffected == 0 {
				return nil
			}
			for _, g := range initialMorphoGroups {
				if e := tx.Create(&TicketScopeGroup{Tenant: s.Tenant, Product: MorphoScope, GroupID: g}).Error; e != nil {
					return e
				}
			}
			p.GroupIDs = append([]string{}, initialMorphoGroups...)
			return tx.Create(&TicketScopeChange{Tenant: s.Tenant, Product: MorphoScope, Revision: 1, ActorID: "system", ActorName: "System", ChangedAt: p.UpdatedAt, Snapshot: enc(p)}).Error
		})
	}
	if e != nil {
		return p, e
	}
	// Read parent and children in one snapshot, including concurrent admin saves.
	e = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error { var err error; p, err = scopeFrom(tx, s.Tenant); return err }, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	return p, e
}
func (p TicketScope) matchesGroup(g string) bool {
	if g == "" {
		return p.IncludeUnassigned
	}
	for _, allowed := range p.GroupIDs {
		if g == allowed {
			return true
		}
	}
	return false
}
func (p TicketScope) apply(q *gorm.DB) *gorm.DB {
	if len(p.GroupIDs) == 0 {
		if p.IncludeUnassigned {
			return q.Where("group_id='' OR group_id IS NULL")
		}
		return q.Where("1=0")
	}
	if p.IncludeUnassigned {
		return q.Where("(group_id IN ? OR group_id='' OR group_id IS NULL)", p.GroupIDs)
	}
	return q.Where("group_id IN ?", p.GroupIDs)
}
func scopeAdmin(actor M) error {
	if !admin(actor) {
		return fail("Only administrators can configure ticket group membership.", 403)
	}
	return nil
}
func (s *Service) ScopeConfig(ctx context.Context, actor M) (M, error) {
	if e := scopeAdmin(actor); e != nil {
		return nil, e
	}
	p, e := s.scope(ctx)
	if e != nil {
		return nil, e
	}
	groups, at, e := s.groupDirectory()
	if e != nil {
		return nil, e
	}
	history := []TicketScopeChange{}
	// One extra snapshot supplies the predecessor for the oldest displayed entry.
	if e = s.DB.WithContext(ctx).Where("tenant=? AND product=?", s.Tenant, MorphoScope).Order("revision desc").Limit(21).Find(&history).Error; e != nil {
		return nil, e
	}
	for i := range history {
		var after TicketScope
		if json.Unmarshal([]byte(history[i].Snapshot), &after) == nil {
			history[i].After = &after
		}
		if i+1 < len(history) && history[i+1].Revision == history[i].Revision-1 {
			var before TicketScope
			if json.Unmarshal([]byte(history[i+1].Snapshot), &before) == nil {
				history[i].Before = &before
			}
		}
	}
	if len(history) > 20 {
		history = history[:20]
	}
	return M{"policy": p, "groups": groups, "groupsFetchedAt": at, "history": history}, nil
}
func (s *Service) SyncGroups(ctx context.Context, actor M) (M, error) {
	if e := scopeAdmin(actor); e != nil {
		return nil, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	groups, e := s.API.ReadGroups(ctx)
	if e != nil {
		return nil, e
	}
	clean := []M{}
	seen := map[string]bool{}
	for _, g := range groups {
		key := g.ID
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		clean = append(clean, M{"id": key, "name": g.Name})
	}
	if e = s.saveMetadata("groups", M{"groups": clean}); e != nil {
		return nil, e
	}
	return s.ScopeConfig(ctx, actor)
}

var groupIDPattern = regexp.MustCompile(`^[0-9]{1,20}$`)

func (s *Service) scopeInput(ctx context.Context, actor M, body M) (TicketScope, error) {
	if e := scopeAdmin(actor); e != nil {
		return TicketScope{}, e
	}
	current, e := s.scope(ctx)
	if e != nil {
		return current, e
	}
	values, ok := body["groupIds"].([]any)
	if !ok {
		if typed, yes := body["groupIds"].([]string); yes {
			values = make([]any, len(typed))
			for i, v := range typed {
				values[i] = v
			}
			ok = true
		}
	}
	include, valid := body["includeUnassigned"].(bool)
	if !ok || !valid || len(values) > 1000 {
		return current, fail("Choose valid ticket groups and an unassigned-ticket setting.", 400)
	}
	known := map[string]bool{}
	directory, _, directoryError := s.groupDirectory()
	if directoryError != nil {
		return current, directoryError
	}
	for _, g := range directory {
		known[g.ID] = true
	}
	// Existing selections remain editable if the source directory loses a group.
	for _, g := range current.GroupIDs {
		known[g] = true
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, v := range values {
		g, ok := v.(string)
		if !ok || !groupIDPattern.MatchString(g) || !known[g] {
			return current, fail("Unknown Udesk group. Update the group directory first.", 400)
		}
		if !seen[g] {
			ids = append(ids, g)
			seen[g] = true
		}
	}
	sort.Strings(ids)
	current.GroupIDs = ids
	current.IncludeUnassigned = include
	return current, nil
}
func (s *Service) SaveScope(ctx context.Context, actor, body M) (M, error) {
	p, e := s.scopeInput(ctx, actor, body)
	if e != nil {
		return nil, e
	}
	revision, parseError := strconv.Atoi(id(body["revision"]))
	if parseError != nil || revision < 1 {
		return nil, fail("A valid configuration revision is required.", 400)
	}
	e = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current TicketScope
		if e := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("tenant=? AND product=?", s.Tenant, MorphoScope).First(&current).Error; e != nil {
			return e
		}
		if current.Revision != int(revision) {
			return fail("Ticket group configuration changed. Reload before saving.", 409)
		}
		p.Revision = current.Revision + 1
		p.UpdatedAt = domain.Now()
		p.UpdatedBy = domain.Str(actor["id"])
		if e := tx.Model(&current).Select("revision", "include_unassigned", "updated_at", "updated_by").Updates(&p).Error; e != nil {
			return e
		}
		if e := tx.Where("tenant=? AND product=?", s.Tenant, MorphoScope).Delete(&TicketScopeGroup{}).Error; e != nil {
			return e
		}
		for _, g := range p.GroupIDs {
			if e := tx.Create(&TicketScopeGroup{Tenant: s.Tenant, Product: MorphoScope, GroupID: g}).Error; e != nil {
				return e
			}
		}
		return tx.Create(&TicketScopeChange{Tenant: s.Tenant, Product: MorphoScope, Revision: p.Revision, ActorID: p.UpdatedBy, ActorName: domain.Str(actor["name"]), ChangedAt: p.UpdatedAt, Snapshot: enc(p)}).Error
	})
	if e != nil {
		return nil, e
	}
	return s.ScopeConfig(ctx, actor)
}
func (s *Service) PreviewScope(ctx context.Context, actor, body M) (M, error) {
	p, e := s.scopeInput(ctx, actor, body)
	if e != nil {
		return nil, e
	}
	out := M{"totalCount": 0, "indexedCount": 0, "groupCounts": []M{}, "fetchedAt": "", "initializing": true}
	e = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var state SyncState
		e := tx.Where("tenant=? AND scope=''", s.Tenant).First(&state).Error
		if errors.Is(e, gorm.ErrRecordNotFound) {
			return nil
		}
		if e != nil {
			return e
		}
		if state.LastSuccess == nil {
			return nil
		}
		out["initializing"] = false
		out["fetchedAt"] = state.LastSuccess
		base := func() *gorm.DB {
			return tx.Model(&Ticket{}).Where("tenant=?", s.Tenant).Where("external_id IN (SELECT ticket_id FROM "+persistence.Table(tx, "filter_members")+" WHERE tenant=? AND scope='' AND generation=?)", s.Tenant, state.Generation)
		}
		var count, indexed int64
		if e = base().Count(&indexed).Error; e != nil {
			return e
		}
		if e = p.apply(base()).Count(&count).Error; e != nil {
			return e
		}
		counts := []struct {
			GroupID string
			Count   int64
		}{}
		if e = base().Select("COALESCE(group_id,'') AS group_id, count(*) AS count").Group("COALESCE(group_id,'')").Scan(&counts).Error; e != nil {
			return e
		}
		groups := []M{}
		for _, c := range counts {
			groups = append(groups, M{"groupId": c.GroupID, "count": c.Count})
		}
		out["totalCount"] = count
		out["indexedCount"] = indexed
		out["groupCounts"] = groups
		return nil
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	return out, e
}
