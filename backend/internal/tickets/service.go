package tickets

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"harbor/internal/domain"
	source "harbor/internal/supportsource"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Service struct {
	DB     *gorm.DB
	API    source.Source
	Tenant string
	mu     sync.Mutex
}

func New(db *gorm.DB, c source.Source) *Service { return &Service{DB: db, API: c, Tenant: c.Tenant()} }
func enc(v any) string                          { b, _ := json.Marshal(v); return string(b) }
func obj(v any) M                               { return domain.Obj(v) }
func id(v any) string {
	if v == nil {
		return ""
	}
	if n, ok := v.(float64); ok {
		return strconv.FormatFloat(n, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}
func rows(v any) []M                        { return domain.Items(v) }
func fail(message string, status int) error { return &domain.Error{Message: message, Status: status} }
func admin(actor M) bool {
	for _, r := range domain.Strings(actor["roles"]) {
		if r == "admin" {
			return true
		}
	}
	return false
}

// Everyone shares the configured product scope; personal agent mappings are
// directory information, not an authorization prerequisite.
func (s *Service) canReadGroup(actor M, group string) bool {
	if s.readPermission(actor) != nil {
		return false
	}
	p, e := s.scope(context.Background())
	return e == nil && p.matchesGroup(group)
}
func (s *Service) readPermission(actor M) error {
	if domain.Str(actor["id"]) == "" || actor["active"] == false {
		return fail("An active CRM account is required.", 403)
	}
	return nil
}
func (s *Service) metadata(kind string) (M, string) {
	var m Metadata
	if s.DB.Where("tenant=? AND kind=?", s.Tenant, kind).First(&m).Error != nil {
		return M{}, ""
	}
	v := M{}
	json.Unmarshal([]byte(m.Raw), &v)
	return v, m.FetchedAt
}
func (s *Service) saveMetadata(kind string, v M) error {
	return s.DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant"}, {Name: "kind"}}, DoUpdates: clause.AssignmentColumns([]string{"raw", "fetched_at"})}).Create(&Metadata{Tenant: s.Tenant, Kind: kind, FetchedAt: domain.Now(), Raw: enc(v)}).Error
}
func (s *Service) refreshMetadata(ctx context.Context) error {
	catalog, e := s.API.ReadMetadata(ctx)
	if e != nil {
		return e
	}
	return s.DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant"}, {Name: "kind"}}, DoUpdates: clause.AssignmentColumns([]string{"raw", "normalized", "mapping_version", "fetched_at"})}).Create(&Metadata{Tenant: s.Tenant, Kind: "catalog", Raw: enc(catalog.Evidence), Normalized: enc(catalog), MappingVersion: source.MappingVersion, FetchedAt: domain.Now()}).Error
}
func (s *Service) catalog() (source.Metadata, string, error) {
	var row Metadata
	if e := s.DB.Where("tenant=? AND kind=?", s.Tenant, "catalog").First(&row).Error; e == nil {
		var m source.Metadata
		if e = json.Unmarshal([]byte(row.Normalized), &m); e != nil {
			return m, "", e
		}
		_ = json.Unmarshal([]byte(row.Raw), &m.Evidence)
		return m, row.FetchedAt, nil
	} else if e != gorm.ErrRecordNotFound {
		return source.Metadata{}, "", e
	}
	// Existing metadata stays usable before the first adapter-backed sync.
	data := map[string]json.RawMessage{}
	at := ""
	for _, kind := range []string{"statuses", "templates", "fields", "filters"} {
		v, t := s.metadata(kind)
		data[kind] = json.RawMessage(enc(v))
		at = t
	}
	m, e := s.API.DecodeMetadata(data)
	return m, at, e
}
func (s *Service) groupDirectory() ([]source.Group, string, error) {
	v, at := s.metadata("groups")
	groups, e := s.API.DecodeGroups(json.RawMessage(enc(v)))
	return groups, at, e
}
func (s *Service) Metadata(ctx context.Context, actor M, refresh bool) (M, error) {
	if e := s.readPermission(actor); e != nil {
		return nil, e
	}
	m, at, e := s.catalog()
	if e != nil {
		return nil, e
	}
	visible := []source.Filter{}
	for _, f := range m.Filters {
		if f.Active {
			visible = append(visible, f)
		}
	}
	return M{"fields": m.Fields, "templates": m.Templates, "filters": visible, "fetchedAt": at, "_compatMetadata": m.Evidence}, nil
}
func (s *Service) validateFilter(actor M, filter string) error {
	if filter == "" {
		return nil
	}
	m, _, e := s.catalog()
	if e != nil {
		return e
	}
	for _, f := range m.Filters {
		if f.ID == filter && f.Active {
			return nil
		}
	}
	return fail("This Udesk filter is not available to your account.", 403)
}
func (s *Service) persist(t source.Ticket, at string) error {
	if t.ID == "" {
		return fail("Source returned a ticket without an ID.", 502)
	}
	updated := t.UpdatedAt
	if stamp := source.ParseTime(updated); stamp != nil {
		updated = stamp.Format("2006-01-02T15:04:05.000000000Z")
	}
	number, _ := strconv.ParseInt(strings.TrimPrefix(t.Number, "#"), 10, 64)
	text := []string{t.Number, t.Subject, t.Content, enc(t.CustomValues)}
	record := Ticket{Tenant: s.Tenant, ExternalID: t.ID, Number: t.Number, Assignee: t.AssigneeID, GroupID: t.GroupID, SourceUpdated: updated, FetchedAt: at, Raw: string(t.Evidence), Normalized: enc(t), MappingVersion: source.MappingVersion, Subject: t.Subject, Status: t.Status, Channel: t.Channel, AssigneeName: t.AssigneeName, NumberValue: number, CreatedTime: source.ParseTime(t.CreatedAt), UpdatedTime: source.ParseTime(t.UpdatedAt), RepliedTime: source.ParseTime(t.RepliedAt), SearchText: strings.Join(text, " ")}
	return s.DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant"}, {Name: "external_id"}}, DoUpdates: clause.AssignmentColumns([]string{"number", "assignee", "group_id", "source_updated", "fetched_at", "raw", "normalized", "mapping_version", "subject", "status", "channel", "assignee_name", "number_value", "created_time", "updated_time", "replied_time", "search_text"}), Where: clause.Where{Exprs: []clause.Expression{clause.Expr{SQL: "excluded.source_updated >= tickets.source_updated OR tickets.source_updated = ''"}}}}).Create(&record).Error
}
func sourceTime(value string) *time.Time { return source.ParseTime(value) }
func (s *Service) decodeRecord(row Ticket) (source.Ticket, error) {
	if row.MappingVersion == source.MappingVersion && row.Normalized != "" {
		var t source.Ticket
		e := json.Unmarshal([]byte(row.Normalized), &t)
		t.Evidence = json.RawMessage(row.Raw)
		return t, e
	}
	return s.API.DecodeTicket(json.RawMessage(row.Raw))
}
func (s *Service) public(actor M, t source.Ticket, at string) M {
	// Copy nested values before redaction; no cached/shared record is mutated.
	evidence := t.Evidence
	b, _ := json.Marshal(t)
	_ = json.Unmarshal(b, &t)
	t.Evidence = evidence
	if !admin(actor) {
		for _, p := range []*string{&t.CustomerEmail, &t.CustomerPhone, &t.CustomerTelephone} {
			if *p != "" {
				*p = "••••"
			}
		}
		for i, f := range t.Fields {
			if f.Key == "customerEmail" {
				t.Fields[i].Value = t.CustomerEmail
			}
			if f.Key == "customerPhone" {
				t.Fields[i].Value = t.CustomerPhone
			}
			if f.Key == "customerTelephone" {
				t.Fields[i].Value = t.CustomerTelephone
			}
		}
	}
	links := []Link{}
	q := s.DB.Where("tenant=? AND ticket_id=?", s.Tenant, t.ID)
	if !admin(actor) {
		q = q.Where("owner_id=?", domain.Str(actor["id"]))
	}
	q.Find(&links)
	rmas := []string{}
	for _, l := range links {
		rmas = append(rmas, l.RMAID)
	}
	return M{"ticket": t, "fetchedAt": at, "sourceUrl": s.API.TicketURL(t.ID), "rmaIds": rmas}
}

// List reads only the locally published, authorized index. Source reads belong
// to Sync; no browser query can trigger an upstream scan.
func (s *Service) List(ctx context.Context, actor M, filter, cursor string, size int) (M, error) {
	return s.Search(ctx, actor, filter, cursor, size, "replied_at:desc", "")
}
func (s *Service) ListSorted(ctx context.Context, actor M, filter, cursor string, size int, order string) (M, error) {
	return s.Search(ctx, actor, filter, cursor, size, order, "")
}

func (s *Service) detail(ctx context.Context, actor M, key string, number bool) (source.Ticket, string, error) {
	if e := s.readPermission(actor); e != nil {
		return source.Ticket{}, "", e
	}
	t, e := s.API.ReadTicket(ctx, key, number)
	if e != nil {
		return t, "", e
	}
	p, e := s.scope(ctx)
	if e != nil {
		return t, "", e
	}
	if !p.matchesGroup(t.GroupID) {
		return source.Ticket{}, "", fail("Ticket not found or outside the configured Morpho groups.", 404)
	}
	at := domain.Now()
	if e = s.persist(t, at); e != nil {
		return t, "", e
	}
	return t, at, nil
}
func (s *Service) Detail(ctx context.Context, actor M, key string, number bool) (M, error) {
	t, at, e := s.detail(ctx, actor, key, number)
	if e != nil {
		return nil, e
	}
	return s.public(actor, t, at), nil
}
func (s *Service) conversation(ctx context.Context, actor M, key string, page int) (source.ConversationPage, error) {
	if _, _, e := s.detail(ctx, actor, key, false); e != nil {
		return source.ConversationPage{}, e
	}
	v, e := s.API.ReadConversation(ctx, key, page)
	if e != nil {
		return v, e
	}
	row := ReplyPage{Tenant: s.Tenant, TicketID: key, Page: v.SourcePage, FetchedAt: domain.Now(), Raw: string(v.Evidence), Normalized: enc(v), MappingVersion: source.MappingVersion}
	if e = s.DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant"}, {Name: "ticket_id"}, {Name: "page"}}, DoUpdates: clause.AssignmentColumns([]string{"raw", "normalized", "mapping_version", "fetched_at"})}).Create(&row).Error; e != nil {
		return v, e
	}
	return v, nil
}
func (s *Service) Replies(ctx context.Context, actor M, key string, page int) (M, error) {
	v, e := s.conversation(ctx, actor, key, page)
	if e != nil {
		var upstream *source.Error
		if errors.As(e, &upstream) && upstream.Kind == source.InvalidQuery {
			return nil, fail(upstream.Message, 400)
		}
		return nil, e
	}
	if !admin(actor) {
		for i := range v.Messages {
			v.Messages[i].Author.Email = ""
		}
	}
	return M{"messages": v.Messages, "currentPage": v.CurrentPage, "totalPages": v.TotalPages, "totalCount": v.TotalCount, "fetchedAt": domain.Now(), "_compatRedacted": !admin(actor)}, nil
}
func (s *Service) Cached(ctx context.Context, actor M, key string) (M, error) {
	if _, _, e := s.detail(ctx, actor, key, false); e != nil {
		return nil, e
	}
	var row Ticket
	if e := s.DB.Where("tenant=? AND external_id=?", s.Tenant, key).First(&row).Error; e != nil {
		return nil, e
	}
	t, e := s.decodeRecord(row)
	if e != nil {
		return nil, e
	}
	return s.public(actor, t, row.FetchedAt), nil
}
func (s *Service) SaveDraft(ctx context.Context, actor M, key string, payload M) (M, error) {
	t, at, e := s.detail(ctx, actor, key, false)
	if e != nil {
		return nil, e
	}
	snap := Snapshot{ID: domain.ID("TSNAP"), Tenant: s.Tenant, TicketID: t.ID, Number: t.Number, GroupID: t.GroupID, Provider: t.Ref.Provider, FetchedAt: at, Raw: string(t.Evidence), Normalized: enc(t), MappingVersion: source.MappingVersion}
	d := Draft{ID: domain.ID("INTAKE"), UserID: domain.Str(actor["id"]), Tenant: s.Tenant, TicketID: snap.TicketID, SnapshotID: snap.ID, CreatedAt: at, UpdatedAt: at}
	previousSnapshot := ""
	if oldID := domain.Str(payload["draftId"]); oldID != "" {
		var old Draft
		if e = s.DB.Where("id=? AND user_id=? AND tenant=? AND rma_id=''", oldID, d.UserID, s.Tenant).First(&old).Error; e != nil {
			return nil, fail("Draft is unavailable.", 404)
		}
		d.ID = old.ID
		d.CreatedAt = old.CreatedAt
		previousSnapshot = old.SnapshotID
		if old.TicketID != snap.TicketID {
			return nil, fail("The draft ticket reference cannot be changed.", 409)
		}
		if supplied := domain.Str(payload["ticketSnapshotId"]); supplied != "" && supplied != old.SnapshotID {
			return nil, fail("Draft changed. Reload before saving.", 409)
		}
	}
	delete(payload, "draftId")
	payload["ticketNumber"] = snap.Number
	payload["ticketId"] = snap.TicketID
	payload["draftId"] = d.ID
	payload["ticketSnapshotId"] = snap.ID
	d.Payload = enc(payload)
	e = s.DB.Transaction(func(tx *gorm.DB) error {
		if e := tx.Create(&snap).Error; e != nil {
			return e
		}
		if previousSnapshot == "" {
			return tx.Create(&d).Error
		}
		updated := tx.Model(&Draft{}).Where("id=? AND user_id=? AND rma_id='' AND snapshot_id=?", d.ID, d.UserID, previousSnapshot).Updates(map[string]any{"snapshot_id": d.SnapshotID, "payload": d.Payload, "updated_at": d.UpdatedAt})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return fail("Draft changed or was submitted. Reload before saving.", 409)
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	duplicate := []string{}
	links := []Link{}
	q := s.DB.Where("tenant=? AND ticket_id=?", s.Tenant, snap.TicketID)
	if !admin(actor) {
		q = q.Where("owner_id=?", d.UserID)
	}
	q.Find(&links)
	for _, l := range links {
		duplicate = append(duplicate, l.RMAID)
	}
	return M{"draft": d, "payload": payload, "duplicateRmaIds": duplicate, "fetchedAt": at}, nil
}
func (s *Service) Drafts(actor M) ([]M, error) {
	if e := s.readPermission(actor); e != nil {
		return nil, e
	}
	data := []Draft{}
	if e := s.DB.Where("tenant=? AND user_id=? AND rma_id=''", s.Tenant, domain.Str(actor["id"])).Order("updated_at desc").Limit(100).Find(&data).Error; e != nil {
		return nil, e
	}
	out := []M{}
	for _, d := range data {
		out = append(out, M{"draft": d})
	}
	return out, nil
}
func (s *Service) Draft(ctx context.Context, actor M, key string) (M, error) {
	var d Draft
	if e := s.DB.Where("id=? AND tenant=? AND user_id=? AND rma_id=''", key, s.Tenant, domain.Str(actor["id"])).First(&d).Error; e != nil {
		return nil, fail("Draft is unavailable.", 404)
	}
	if _, _, e := s.detail(ctx, actor, d.TicketID, false); e != nil {
		return nil, e
	}
	p := M{}
	json.Unmarshal([]byte(d.Payload), &p)
	return M{"draft": d, "payload": p}, nil
}

// Replayed submissions must still reach the transaction's idempotency receipt.
func (s *Service) ValidateSubmission(ctx context.Context, actor M, key string) error {
	var d Draft
	if e := s.DB.Where("id=? AND tenant=? AND user_id=?", key, s.Tenant, domain.Str(actor["id"])).First(&d).Error; e != nil {
		return fail("Draft is unavailable.", 404)
	}
	_, _, e := s.detail(ctx, actor, d.TicketID, false)
	return e
}

// AttachDraft runs in the SAME transaction as RMA/task creation.
func AttachDraft(tx *gorm.DB, actor, b, result M) error {
	key := domain.Str(b["draftId"])
	if key == "" {
		return nil
	}
	var d Draft
	if e := tx.Where("id=? AND user_id=? AND rma_id=''", key, domain.Str(actor["id"])).First(&d).Error; e != nil {
		return fail("Draft is unavailable or already submitted.", 409)
	}
	var snap Snapshot
	if e := tx.First(&snap, "id=?", d.SnapshotID).Error; e != nil {
		return e
	}
	service := Service{DB: tx, Tenant: d.Tenant}
	if !service.canReadGroup(actor, snap.GroupID) {
		return fail("Ticket is outside your authorized scope.", 403)
	}
	// A current lookup by the HTTP layer revalidates source ownership before submission.
	var latest Ticket
	if e := tx.Where("tenant=? AND external_id=?", d.Tenant, d.TicketID).First(&latest).Error; e != nil {
		return e
	}
	if !service.canReadGroup(actor, latest.GroupID) {
		return fail("Ticket is outside your authorized scope.", 403)
	}
	if domain.Str(b["ticketNumber"]) != snap.Number {
		return fail("The draft ticket reference cannot be changed.", 409)
	}
	if supplied := domain.Str(b["ticketSnapshotId"]); supplied != "" && supplied != snap.ID {
		return fail("Draft changed. Reload before submitting.", 409)
	}
	result["ticketReference"] = M{"provider": snap.Provider, "tenant": d.Tenant, "id": d.TicketID, "number": snap.Number, "snapshotId": snap.ID, "fetchedAt": snap.FetchedAt}
	result["intakeDraftId"] = d.ID
	if e := tx.Create(&Link{Tenant: d.Tenant, TicketID: d.TicketID, RMAID: domain.Str(result["id"]), OwnerID: d.UserID, SnapshotID: snap.ID}).Error; e != nil {
		return e
	}
	return tx.Model(&d).Update("rma_id", result["id"]).Error
}
func (s *Service) AuditRun(actor M, key string) (Run, error) {
	var r Run
	q := s.DB.Where("id=?", key)
	if !admin(actor) {
		q = q.Where("user_id=?", domain.Str(actor["id"]))
	}
	e := q.First(&r).Error
	if e != nil {
		return r, fail("Synchronization record not found.", 404)
	}
	return r, nil
}
func (s *Service) LastSync(actor M) string {
	var state SyncState
	if s.DB.Where("tenant=? AND scope=''", s.Tenant).First(&state).Error != nil || state.LastSuccess == nil {
		return ""
	}
	return state.LastSuccess.UTC().Format(time.RFC3339Nano)
}
