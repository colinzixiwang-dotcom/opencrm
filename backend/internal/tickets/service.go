package tickets

import (
	"context"
	"encoding/json"
	"fmt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Service struct {
	DB     *gorm.DB
	API    udesk.API
	Tenant string
	mu     sync.Mutex
}

func New(db *gorm.DB, c *udesk.Client) *Service { return &Service{DB: db, API: c, Tenant: c.Tenant()} }
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
func (s *Service) mapping(actor M) (Mapping, error) {
	var m Mapping
	e := s.DB.Where("tenant=? AND user_id=? AND enabled=?", s.Tenant, domain.Str(actor["id"]), true).First(&m).Error
	if e != nil {
		return m, fail("Your account is not mapped to an active Udesk agent.", 403)
	}
	return m, nil
}
func (s *Service) canRead(actor, ticket M) bool {
	if admin(actor) {
		return true
	}
	m, e := s.mapping(actor)
	if e != nil {
		return false
	}
	if id(ticket["assignee_id"]) == m.AgentID {
		return true
	}
	if m.Scope == "group" {
		var groups []string
		json.Unmarshal([]byte(m.Groups), &groups)
		for _, g := range groups {
			if g != "" && g == id(ticket["user_group_id"]) {
				return true
			}
		}
	}
	return false
}
func (s *Service) readPermission(actor M) error {
	if admin(actor) {
		return nil
	}
	_, e := s.mapping(actor)
	return e
}
func (s *Service) allowedFilter(actor, f M) bool {
	if admin(actor) {
		return true
	}
	m, e := s.mapping(actor)
	if e != nil {
		return false
	}
	switch strings.ToLower(id(f["permission"])) {
	case "all", "":
		return true
	case "agent", "user":
		return id(f["permission_id"]) == m.AgentID
	case "agent_group", "usergroup":
		var groups []string
		sourceGroups := m.SourceGroups
		if m.Scope == "group" {
			sourceGroups = m.Groups
		}
		json.Unmarshal([]byte(sourceGroups), &groups)
		for _, g := range groups {
			if g == id(f["permission_id"]) {
				return true
			}
		}
	}
	return false
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
	for _, item := range []struct {
		kind, path string
		q          url.Values
	}{{"statuses", "tickets/status", nil}, {"templates", "tickets/ticket_templates", nil}, {"fields", "custom_fields", url.Values{"category": {"ticket"}}}} {
		v, e := s.API.Get(ctx, item.path, item.q)
		if e != nil {
			return e
		}
		if e = s.saveMetadata(item.kind, v); e != nil {
			return e
		}
	}
	filters := []M{}
	seen := map[string]bool{}
	for page := 1; page <= 100; page++ {
		v, e := s.API.Get(ctx, "tickets/filters", url.Values{"page": {strconv.Itoa(page)}, "per_page": {"50"}})
		if e != nil {
			return e
		}
		for _, f := range rows(v["filters"]) {
			if !seen[id(f["id"])] {
				seen[id(f["id"])] = true
				filters = append(filters, f)
			}
		}
		if page >= int(domain.N(obj(v["meta"])["total_pages"])) {
			return s.saveMetadata("filters", M{"filters": filters})
		}
	}
	return fail("Udesk metadata pagination exceeded its limit.", 502)
}
func (s *Service) Metadata(ctx context.Context, actor M, refresh bool) (M, error) {
	if e := s.readPermission(actor); e != nil {
		return nil, e
	}
	_, at := s.metadata("fields")
	if refresh || at == "" {
		s.mu.Lock()
		e := s.refreshMetadata(ctx)
		s.mu.Unlock()
		if e != nil {
			return nil, e
		}
	}
	out := M{}
	for _, kind := range []string{"statuses", "templates", "fields", "filters"} {
		v, t := s.metadata(kind)
		out[kind] = v
		out["fetchedAt"] = t
	}
	visible := []M{}
	for _, f := range rows(obj(out["filters"])["filters"]) {
		if s.allowedFilter(actor, f) {
			visible = append(visible, f)
		}
	}
	out["filters"] = visible
	return out, nil
}
func (s *Service) validateFilter(actor M, filter string) error {
	if filter == "" {
		return nil
	}
	data, _ := s.metadata("filters")
	for _, f := range rows(data["filters"]) {
		if id(f["id"]) == filter && s.allowedFilter(actor, f) {
			return nil
		}
	}
	return fail("This Udesk filter is not available to your account.", 403)
}
func sourceTicket(v M) M {
	if t, ok := v["ticket"].(map[string]any); ok {
		return t
	}
	return v
}
func (s *Service) persist(t M, at string) error {
	if id(t["id"]) == "" {
		return fail("Udesk returned a ticket without an ID.", 502)
	}
	updated := id(t["updated_at"])
	if stamp, e := time.Parse(time.RFC3339Nano, updated); e == nil {
		updated = stamp.UTC().Format("2006-01-02T15:04:05.000000000Z")
	}
	return s.DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant"}, {Name: "external_id"}}, DoUpdates: clause.AssignmentColumns([]string{"number", "assignee", "group_id", "source_updated", "fetched_at", "raw"}), Where: clause.Where{Exprs: []clause.Expression{clause.Expr{SQL: "excluded.source_updated >= tickets.source_updated OR tickets.source_updated = ''"}}}}).Create(&Ticket{Tenant: s.Tenant, ExternalID: id(t["id"]), Number: id(t["field_num"]), Assignee: id(t["assignee_id"]), GroupID: id(t["user_group_id"]), SourceUpdated: updated, FetchedAt: at, Raw: enc(t)}).Error
}
func (s *Service) public(actor, t M, at string) M {
	t = domain.Clone(t)
	if !admin(actor) {
		for _, k := range []string{"user_email", "user_cellphone", "customer_telephone"} {
			if id(t[k]) != "" {
				t[k] = "••••"
			}
		}
	}
	links := []Link{}
	q := s.DB.Where("tenant=? AND ticket_id=?", s.Tenant, id(t["id"]))
	if !admin(actor) {
		q = q.Where("owner_id=?", domain.Str(actor["id"]))
	}
	q.Find(&links)
	rmas := []string{}
	for _, l := range links {
		rmas = append(rmas, l.RMAID)
	}
	base := strings.TrimSuffix(s.Tenant, "/open_api_v1")
	return M{"source": t, "fetchedAt": at, "udeskUrl": strings.TrimRight(base, "/") + "/entry/ticket/show/" + url.PathEscape(id(t["id"])), "rmaIds": rmas}
}

// List scans only enough source pages for this authorized page, with a bounded budget.
// Cursor is a source page + offset, not a local-cache or global source count.
func (s *Service) List(ctx context.Context, actor M, filter, cursor string, size int) (M, error) {
	if e := s.readPermission(actor); e != nil {
		return nil, e
	}
	if e := s.validateFilter(actor, filter); e != nil {
		return nil, e
	}
	if size < 1 || size > 100 {
		return nil, fail("Page size must be between 1 and 100.", 400)
	}
	page, offset := 1, 0
	if cursor != "" {
		if _, e := fmt.Sscanf(cursor, "%d:%d", &page, &offset); e != nil || page < 1 || page > 100000 || offset < 0 || offset >= 100 {
			return nil, fail("Invalid ticket cursor.", 400)
		}
	}
	items := []M{}
	at := domain.Now()
	next := ""
	exhausted := false
	var totalPages any
	run := Run{ID: domain.ID("SYNC"), UserID: domain.Str(actor["id"]), Kind: "tickets", Status: "running", CreatedAt: at}
	if e := s.DB.Create(&run).Error; e != nil {
		return nil, e
	}
	for scan := 0; scan < 3 && !exhausted; scan++ {
		path := "tickets"
		params := url.Values{"page": {strconv.Itoa(page)}, "per_page": {"100"}}
		if filter != "" {
			path = "tickets/tickets_in_filter"
			params.Set("filter_id", filter)
		}
		v, e := s.API.Get(ctx, path, params)
		if e != nil {
			s.DB.Model(&run).Updates(map[string]any{"status": "failed", "error": e.Error(), "completed_at": domain.Now()})
			return nil, e
		}
		source := rows(v["contents"])
		pages := int(domain.N(obj(v["meta"])["total_pages"]))
		// Only an administrator's source count equals their authorized count.
		if admin(actor) {
			if count, exists := obj(v["meta"])["total_count"]; exists {
				n := int(domain.N(count))
				totalPages = max(1, (n+size-1)/size)
			}
		}
		for i := offset; i < len(source); i++ {
			t := sourceTicket(source[i])
			if !s.canRead(actor, t) {
				continue
			}
			if e := s.persist(t, at); e != nil {
				return nil, e
			}
			items = append(items, s.public(actor, t, at))
			if len(items) >= size {
				next = ""
				if i+1 < len(source) {
					next = fmt.Sprintf("%d:%d", page, i+1)
				} else if page < pages {
					next = fmt.Sprintf("%d:0", page+1)
				}
				exhausted = true
				break
			}
		}
		if !exhausted {
			page++
			offset = 0
			if len(source) == 0 || page > pages {
				exhausted = true
			} else {
				next = fmt.Sprintf("%d:0", page)
			}
		}
	}
	if exhausted && len(items) < size {
		next = ""
	}
	if e := s.DB.Model(&run).Updates(map[string]any{"status": "completed", "count": len(items), "completed_at": domain.Now()}).Error; e != nil {
		return nil, e
	}
	return M{"items": items, "nextCursor": next, "fetchedAt": at, "filterId": filter, "scanLimited": !exhausted, "runId": run.ID, "totalPages": totalPages}, nil
}
func (s *Service) detail(ctx context.Context, actor M, key string, number bool) (M, string, error) {
	if e := s.readPermission(actor); e != nil {
		return nil, "", e
	}
	params := url.Values{}
	if number {
		params.Set("num", key)
	} else {
		params.Set("id", key)
	}
	v, e := s.API.Get(ctx, "tickets/detail", params)
	if e != nil {
		return nil, "", e
	}
	t := obj(v["ticket"])
	if !s.canRead(actor, t) {
		return nil, "", fail("Ticket not found or outside your authorized scope.", 404)
	}
	at := domain.Now()
	if e = s.persist(t, at); e != nil {
		return nil, "", e
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
func (s *Service) Replies(ctx context.Context, actor M, key string, page int) (M, error) {
	if page < 1 || page > 100000 {
		return nil, fail("Invalid replies page.", 400)
	}
	if _, _, e := s.detail(ctx, actor, key, false); e != nil {
		return nil, e
	}
	path := "tickets/" + url.PathEscape(key) + "/replies"
	v, e := s.API.Get(ctx, path, url.Values{"page": {"1"}, "per_page": {"20"}})
	if e != nil {
		return nil, e
	}
	// Udesk returns newest replies first. Traverse source pages from the end,
	// then reverse the selected page so the entire conversation reads oldest first.
	pages := int(domain.N(obj(v["meta"])["total_pages"]))
	if page > max(1, pages) {
		return nil, fail("Invalid replies page.", 400)
	}
	sourcePage := max(1, pages) - page + 1
	if sourcePage != 1 {
		v, e = s.API.Get(ctx, path, url.Values{"page": {strconv.Itoa(sourcePage)}, "per_page": {"20"}})
		if e != nil {
			return nil, e
		}
	}
	at := domain.Now()
	if e = s.DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant"}, {Name: "ticket_id"}, {Name: "page"}}, DoUpdates: clause.AssignmentColumns([]string{"fetched_at", "raw"})}).Create(&ReplyPage{Tenant: s.Tenant, TicketID: key, Page: sourcePage, FetchedAt: at, Raw: enc(v)}).Error; e != nil {
		return nil, e
	}
	replies := rows(v["replies"])
	for left, right := 0, len(replies)-1; left < right; left, right = left+1, right-1 {
		replies[left], replies[right] = replies[right], replies[left]
	}
	ordered := make([]any, len(replies))
	for i, reply := range replies {
		ordered[i] = reply
	}
	v["replies"] = ordered
	meta := obj(v["meta"])
	meta["current_page"] = page
	v["meta"] = meta
	if !admin(actor) {
		for _, r := range replies {
			delete(r, "cc")
			a := obj(r["author"])
			delete(a, "email")
		}
	}
	v["fetchedAt"] = at
	return v, nil
}
func (s *Service) Cached(ctx context.Context, actor M, key string) (M, error) {
	// Recheck current source assignment before exposing any cached personal data.
	if _, _, e := s.detail(ctx, actor, key, false); e != nil {
		return nil, e
	}
	var t Ticket
	if e := s.DB.Where("tenant=? AND external_id=?", s.Tenant, key).First(&t).Error; e != nil {
		return nil, e
	}
	v := M{}
	json.Unmarshal([]byte(t.Raw), &v)
	return s.public(actor, v, t.FetchedAt), nil
}
func (s *Service) SaveDraft(ctx context.Context, actor M, key string, payload M) (M, error) {
	t, at, e := s.detail(ctx, actor, key, false)
	if e != nil {
		return nil, e
	}
	snap := Snapshot{ID: domain.ID("TSNAP"), Tenant: s.Tenant, TicketID: id(t["id"]), Number: id(t["field_num"]), FetchedAt: at, Raw: enc(t)}
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
	ticket := M{}
	json.Unmarshal([]byte(snap.Raw), &ticket)
	service := Service{DB: tx, Tenant: d.Tenant}
	if !service.canRead(actor, ticket) {
		return fail("Ticket is outside your authorized scope.", 403)
	}
	// A current lookup by the HTTP layer revalidates source ownership before submission.
	var latest Ticket
	if e := tx.Where("tenant=? AND external_id=?", d.Tenant, d.TicketID).First(&latest).Error; e != nil {
		return e
	}
	current := M{}
	json.Unmarshal([]byte(latest.Raw), &current)
	if !service.canRead(actor, current) {
		return fail("Ticket is outside your authorized scope.", 403)
	}
	if domain.Str(b["ticketNumber"]) != snap.Number {
		return fail("The draft ticket reference cannot be changed.", 409)
	}
	if supplied := domain.Str(b["ticketSnapshotId"]); supplied != "" && supplied != snap.ID {
		return fail("Draft changed. Reload before submitting.", 409)
	}
	result["ticketReference"] = M{"provider": "udesk", "tenant": d.Tenant, "id": d.TicketID, "number": snap.Number, "snapshotId": snap.ID, "fetchedAt": snap.FetchedAt}
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
	var r Run
	q := s.DB.Where("status='completed' AND kind='tickets'")
	if !admin(actor) {
		q = q.Where("user_id=?", domain.Str(actor["id"]))
	}
	if q.Order("completed_at desc").First(&r).Error != nil {
		return ""
	}
	return r.CompletedAt
}
