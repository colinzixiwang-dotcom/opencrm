package tickets_test

import (
	"context"
	"encoding/json"
	"fmt"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"harbor/internal/ruoyi"
	"harbor/internal/store"
	"harbor/internal/tickets"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

type M = domain.M
type fake struct {
	data       map[string]M
	tickets    []M
	calls      []string
	broken     bool
	replyPages map[int]M
	listPages  map[int]M
}

func (f *fake) Get(_ context.Context, path string, q url.Values) (M, error) {
	f.calls = append(f.calls, path)
	if f.broken {
		return nil, fmt.Errorf("upstream unavailable")
	}
	if path == "tickets/detail" {
		for _, v := range f.tickets {
			if fmt.Sprint(v["id"]) == q.Get("id") || v["field_num"] == q.Get("num") {
				return domain.Clone(M{"ticket": v}), nil
			}
		}
		return nil, fmt.Errorf("not found")
	}
	if path == "tickets" || path == "tickets/tickets_in_filter" {
		if f.listPages != nil {
			page, _ := strconv.Atoi(q.Get("page"))
			if v, ok := f.listPages[page]; ok {
				return domain.Clone(v), nil
			}
			return nil, fmt.Errorf("unexpected source list page %d", page)
		}
		return domain.Clone(M{"contents": f.tickets, "meta": M{"total_pages": 1, "total_count": len(f.tickets)}}), nil
	}
	if strings.HasSuffix(path, "/replies") && f.replyPages != nil {
		page, _ := strconv.Atoi(q.Get("page"))
		if v, ok := f.replyPages[page]; ok {
			return domain.Clone(v), nil
		}
		return nil, fmt.Errorf("unexpected source reply page %d", page)
	}
	if v, ok := f.data[path]; ok {
		return domain.Clone(v), nil
	}
	return nil, fmt.Errorf("unexpected endpoint %s", path)
}
func fixture(t *testing.T) (*store.Store, *tickets.Service, *fake, M) {
	t.Helper()
	db, e := store.Open(":memory:")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	var u ruoyi.SysUser
	db.DB.Where("email=?", "admin@harbor.local").First(&u)
	a := (ruoyi.Service{DB: db.DB}).Actor(u)
	f := &fake{data: map[string]M{
		"agents":      {"agents": []M{{"id": 11, "email": "one@example.com", "nick_name": "One", "role_name": "agent", "disable_status": "enable", "user_group_ids": []any{float64(7)}, "password": "SIP-SECRET"}, {"id": 22, "email": "two@example.com", "nick_name": "Two", "role_name": "unexpected custom role", "disable_status": "enable", "user_group_ids": []any{float64(8)}}, {"id": 33, "email": "disabled@example.com", "nick_name": "Disabled", "role_name": "agent", "disable_status": "disable"}}, "meta": M{"total_pages": 1}},
		"user_groups": {"user_groups": []M{{"id": 7, "name": "A"}, {"id": 8, "name": "B"}}, "meta": M{"total_pages": 1}}, "agent_roles": {"agent_roles": []M{{"id": 1, "name": "agent"}}},
		"tickets/status":           {"status": []M{{"status_id": 1, "name": "开启", "en_name": "open"}, {"status_id": 5, "name": "Pending", "en_name": "solving_5"}}},
		"tickets/ticket_templates": {"templates": []M{{"id": 1, "custom_fields": []M{{"field_name": "SelectField_1", "field_title": "Issue"}}}}},
		"custom_fields":            {"fields": []M{{"field_name": "SelectField_1", "field_label": "Issue", "options": []M{{"title": "Fault", "value": "0"}}}, {"field_name": "TextField_2", "content_type": "file"}}},
		"tickets/filters":          {"filters": []M{{"id": 1, "name": "All", "permission": "All"}, {"id": 1, "name": "All", "permission": "All"}, {"id": 2, "name": "Private", "permission": "User", "permission_id": 22}}, "meta": M{"total_pages": 1}},
		"tickets/1/replies":        {"replies": []M{{"id": 1, "content": "A reply", "function_type": "internat", "author": M{"email": "person@example.com"}}}, "meta": M{"total_pages": 1}},
	}}
	f.tickets = []M{{"id": 1, "field_num": "#1", "assignee_id": 11, "user_group_id": 7, "subject": "OWN", "user_email": "customer@example.com", "custom_fields": M{"SelectField_1": []any{"0"}, "UnknownField": []any{M{"name": "file", "url": "https://example.com/a"}}}, "updated_at": "2026-10-16T10:00:00+08:00"}, {"id": 2, "field_num": "#2", "assignee_id": 22, "user_group_id": 8, "subject": "FOREIGN"}, {"id": 3, "field_num": "#3", "assignee_id": nil, "user_group_id": 7, "subject": "UNASSIGNED"}}
	svc := tickets.New(db.DB, &udesk.Client{Base: "https://example.udesk.cn"})
	svc.API = f
	if _, e = svc.SyncAccounts(context.Background(), a, false); e != nil {
		t.Fatal(e)
	}
	return db, svc, f, a
}
func actor(t *testing.T, db *store.Store, email string) M {
	t.Helper()
	var u ruoyi.SysUser
	if e := db.DB.Where("email=?", email).First(&u).Error; e != nil {
		t.Fatal(e)
	}
	return (ruoyi.Service{DB: db.DB}).Actor(u)
}
func checkError(t *testing.T, e error, status int) {
	t.Helper()
	d, ok := e.(*domain.Error)
	if !ok || d.Status != status {
		t.Fatalf("error %v want status %d", e, status)
	}
}
func TestSourceFieldsScopeAndLiveReads(t *testing.T) {
	db, s, f, a := fixture(t)
	ctx := context.Background()
	one := actor(t, db, "one@example.com")
	two := actor(t, db, "two@example.com")
	meta, e := s.Metadata(ctx, one, true)
	if e != nil {
		t.Fatal(e)
	}
	if len(domain.Items(meta["filters"])) != 1 || len(domain.Rows(domain.Obj(meta["fields"]), "fields")) != 2 {
		t.Fatal("metadata dedup/permissions/fidelity")
	}
	page, e := s.List(ctx, one, "1", "", 20)
	if e != nil {
		t.Fatal(e)
	}
	items := domain.Rows(page, "items")
	if len(items) != 1 || domain.Obj(items[0]["source"])["subject"] != "OWN" {
		t.Fatal(page)
	}
	source := domain.Obj(items[0]["source"])
	if source["user_email"] != "••••" || domain.Obj(source["custom_fields"])["UnknownField"] == nil {
		t.Fatal("mask or unknown fields lost")
	}
	_, e = s.List(ctx, one, "2", "", 20)
	checkError(t, e, 403)
	_, e = s.Detail(ctx, two, "1", false)
	checkError(t, e, 404)
	_, e = s.Replies(ctx, two, "1", 1)
	checkError(t, e, 404)
	for _, path := range f.calls {
		if path == "tickets/1/replies" {
			t.Fatal("foreign replies requested")
		}
	}
	_, e = s.Detail(ctx, two, "#1", true)
	checkError(t, e, 404)
	for i := 0; i < 2; i++ {
		if _, e = s.Detail(ctx, one, "1", false); e != nil {
			t.Fatal(e)
		}
	}
	var n int64
	db.DB.Model(&tickets.Ticket{}).Count(&n)
	if n != 1 {
		t.Fatal("non-idempotent persistence", n)
	}
	if _, e = s.Configure(a, M{"agentId": "11", "scope": "group", "groups": []any{"7"}}); e != nil {
		t.Fatal(e)
	}
	page, e = s.List(ctx, one, "", "", 20)
	if e != nil || len(domain.Rows(page, "items")) != 2 {
		t.Fatal("supervisor own + assigned group", page, e)
	}
	page, e = s.List(ctx, a, "", "", 20)
	if e != nil || len(domain.Rows(page, "items")) != 3 {
		t.Fatal("admin", page, e)
	}
	// Fresh source reassignment overrides previous cache permission.
	f.tickets[0]["assignee_id"] = 22
	f.tickets[0]["user_group_id"] = 8
	_, e = s.Detail(ctx, one, "1", false)
	checkError(t, e, 404)
	unmapped := actor(t, db, "operator@harbor.local")
	_, e = s.List(ctx, unmapped, "", "", 20)
	checkError(t, e, 403)
	f.broken = true
	if _, e = s.List(ctx, a, "", "", 20); e == nil {
		t.Fatal("source failure disguised as cached success")
	}
}
func TestAccountsDefaultPasswordUnknownRolesAndDisable(t *testing.T) {
	db, s, f, a := fixture(t)
	ctx := context.Background()
	two := actor(t, db, "two@example.com")
	if strings.Contains(fmt.Sprint(two["roles"]), "admin") {
		t.Fatal("unknown source role escalated")
	}
	var disabled ruoyi.SysUser
	db.DB.Where("email=?", "disabled@example.com").First(&disabled)
	if disabled.Status != "1" {
		t.Fatal("disabled source enabled")
	}
	if _, e := s.SyncAccounts(ctx, a, true); e != nil {
		t.Fatal(e)
	}
	users := []ruoyi.SysUser{}
	db.DB.Find(&users)
	for _, u := range users {
		if !domain.VerifyPassword("HarborDemo!2026", u.Password) {
			t.Fatal("password not reset")
		}
	}
	var meta tickets.Metadata
	db.DB.Where("kind='agents'").First(&meta)
	if strings.Contains(meta.Raw, "SIP-SECRET") {
		t.Fatal("SIP secret persisted")
	}
	_, e := s.Configure(two, M{"agentId": "11", "scope": "group", "groups": []any{"7"}})
	checkError(t, e, 403)
	f.data["agents"]["agents"] = domain.Items(f.data["agents"]["agents"])[1:]
	if _, e = s.SyncAccounts(ctx, a, false); e != nil {
		t.Fatal(e)
	}
	_, e = s.List(ctx, actor(t, db, "one@example.com"), "", "", 20)
	checkError(t, e, 403)
}
func TestDirectorySyncPreservesRevokedRolePermissions(t *testing.T) {
	db, s, _, a := fixture(t)
	var role ruoyi.SysRole
	var menu ruoyi.SysMenu
	db.DB.Where("role_key=?", "support_agent").First(&role)
	db.DB.Where("perms=?", "erp:service:view").First(&menu)
	if e := db.DB.Where("role_id=? AND menu_id=?", role.RoleID, menu.MenuID).Delete(&ruoyi.RoleMenu{}).Error; e != nil {
		t.Fatal(e)
	}
	if _, e := s.SyncAccounts(context.Background(), a, false); e != nil {
		t.Fatal(e)
	}
	one := actor(t, db, "one@example.com")
	if (ruoyi.Service{DB: db.DB}).HasPermi(domain.Str(one["id"]), "erp:service:view") {
		t.Fatal("Directory sync restored an explicitly revoked permission")
	}
}
func TestDraftSnapshotsAndAtomicRMA(t *testing.T) {
	db, s, f, _ := fixture(t)
	ctx := context.Background()
	one := actor(t, db, "one@example.com")
	draft, e := s.SaveDraft(ctx, one, "1", M{"description": "Support issue"})
	if e != nil {
		t.Fatal(e)
	}
	p := domain.Obj(draft["payload"])
	snapID := domain.Str(p["ticketSnapshotId"])
	f.tickets[0]["content"] = "changed source"
	if _, e = s.Detail(ctx, one, "1", false); e != nil {
		t.Fatal(e)
	}
	var snap tickets.Snapshot
	db.DB.First(&snap, "id=?", snapID)
	if strings.Contains(snap.Raw, "changed source") {
		t.Fatal("immutable snapshot changed")
	}
	input := domain.Clone(p)
	for k, v := range (M{"orderNumber": "ORDER-1", "platform": "Amazon", "productId": "PRD-1", "rootCauseId": "device_fault", "solutionId": "goodwill", "taskInputs": M{"gift": M{"amountCents": 15000}}}) {
		input[k] = v
	}
	// Invalid eligibility must leave draft unsubmitted and create no linkage.
	bad := domain.Clone(input)
	bad["solutionId"] = "replacement"
	if _, e = db.Apply(domain.Str(one["id"]), "rma.create", bad, ""); e == nil {
		t.Fatal("invalid eligibility accepted")
	}
	var links int64
	db.DB.Model(&tickets.Link{}).Count(&links)
	if links != 0 {
		t.Fatal("failed RMA left link")
	}
	result, e := db.Apply(domain.Str(one["id"]), "rma.create", input, "draft-once")
	if e != nil {
		t.Fatal(e)
	}
	r := domain.Obj(result["result"])
	if domain.Obj(r["ticketReference"])["snapshotId"] != snapID {
		t.Fatal("snapshot reference lost")
	}
	replay, e := db.Apply(domain.Str(one["id"]), "rma.create", input, "draft-once")
	if e != nil || !domain.Bool(replay["replayed"]) {
		t.Fatal("draft replay", e)
	}
	_, e = db.Apply(domain.Str(one["id"]), "rma.create", input, "")
	checkError(t, e, 409)
	db.DB.Model(&tickets.Link{}).Count(&links)
	if links != 1 {
		t.Fatal("duplicate links", links)
	}
	state, e := db.State()
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, saved := range domain.Rows(state, "rmas") {
		if saved["id"] == r["id"] {
			found = domain.Obj(saved["ticketReference"])["snapshotId"] == snapID
		}
	}
	if !found {
		t.Fatal("transaction did not save source reference")
	}
	var stored tickets.Draft
	db.DB.First(&stored, "id=?", p["draftId"])
	if stored.RMAID != domain.Str(r["id"]) {
		t.Fatal("draft not linked")
	}
	var original M
	json.Unmarshal([]byte(snap.Raw), &original)
	if original["subject"] != "OWN" {
		t.Fatal("source payload")
	}
}

func TestUdeskLinkUsesInternalID(t *testing.T) {
	_, service, source, actor := fixture(t)
	service.Tenant = "https://ticketmorpho.udeskglobal.com/open_api_v1"
	source.tickets = []M{{"id": 20713607, "field_num": "#717", "subject": "Link regression"}}
	result, err := service.Detail(context.Background(), actor, "20713607", false)
	if err != nil {
		t.Fatal(err)
	}
	if result["udeskUrl"] != "https://ticketmorpho.udeskglobal.com/entry/ticket/show/20713607" {
		t.Fatalf("wrong ticket URL: %v", result["udeskUrl"])
	}
}

func TestTotalPagesRespectScope(t *testing.T) {
	db, service, _, admin := fixture(t)
	result, err := service.List(context.Background(), admin, "", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if result["totalPages"] != 2 {
		t.Fatalf("administrator total = %v", result["totalPages"])
	}
	result, err = service.List(context.Background(), actor(t, db, "one@example.com"), "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if result["totalPages"] != 1 || result["totalCount"] != 1 {
		t.Fatal("source global count leaked to scoped actor")
	}
}

func TestAttachmentReferenceRequiresLiveTicketAccess(t *testing.T) {
	db, service, source, admin := fixture(t)
	source.tickets[0]["attachments"] = []any{M{"url": "https://bucket.aliyuncs.com/photo.jpg?Signature=first"}}
	ref := "https://bucket.aliyuncs.com/photo.jpg"
	raw, err := service.AttachmentURL(context.Background(), admin, "1", ref, 0)
	if err != nil || raw != "https://bucket.aliyuncs.com/photo.jpg?Signature=first" {
		t.Fatalf("attachment resolution: %v %v", raw, err)
	}
	source.tickets[0]["attachments"] = []any{M{"url": "https://bucket.aliyuncs.com/photo.jpg?Signature=renewed"}}
	raw, err = service.AttachmentURL(context.Background(), admin, "1", ref, 0)
	if err != nil || raw != "https://bucket.aliyuncs.com/photo.jpg?Signature=renewed" {
		t.Fatal("did not renew signed attachment URL")
	}
	_, err = service.AttachmentURL(context.Background(), admin, "1", "http://127.0.0.1/secret", 0)
	checkError(t, err, 404)
	_, err = service.AttachmentURL(context.Background(), actor(t, db, "two@example.com"), "1", ref, 0)
	checkError(t, err, 404)
	source.tickets[0]["assignee_id"] = 22
	_, err = service.AttachmentURL(context.Background(), actor(t, db, "one@example.com"), "1", ref, 0)
	checkError(t, err, 404)
}

func TestRepliesReadChronologicallyAcrossSourcePages(t *testing.T) {
	_, s, f, a := fixture(t)
	f.replyPages = map[int]M{
		1: {"replies": []M{{"id": 4, "created_at": "2026-10-04T10:00:00Z"}, {"id": 3, "created_at": "2026-10-03T10:00:00Z"}}, "meta": M{"current_page": 1, "total_pages": 2, "total_count": 4}},
		2: {"replies": []M{{"id": 2, "created_at": "2026-10-02T10:00:00Z", "attachments": []M{{"url": "https://example.com/old.png"}}}, {"id": 1, "created_at": "2026-10-01T10:00:00Z"}}, "meta": M{"current_page": 2, "total_pages": 2, "total_count": 4}},
	}
	for page := 1; page <= 2; page++ {
		got, err := s.Replies(context.Background(), a, "1", page)
		if err != nil {
			t.Fatal(err)
		}
		list := domain.Rows(got, "replies")
		if len(list) != 2 || domain.N(list[0]["id"]) != int64(page*2-1) || domain.N(list[1]["id"]) != int64(page*2) {
			t.Fatalf("page %d: %v", page, got)
		}
		if domain.N(domain.Obj(got["meta"])["current_page"]) != int64(page) {
			t.Fatal("source page leaked into display pagination", got)
		}
	}
	raw, err := s.AttachmentURL(context.Background(), a, "1", "https://example.com/old.png", 1)
	if err != nil || raw != "https://example.com/old.png" {
		t.Fatal("oldest page attachment lost", raw, err)
	}
	_, err = s.Replies(context.Background(), a, "1", 3)
	checkError(t, err, 400)
}

func TestGlobalSortBeforePagination(t *testing.T) {
	db, service, source, admin := fixture(t)
	old := M{"id": 1, "field_num": "#2", "assignee_id": 11, "replied_at": "2026-10-01T10:00:00Z"}
	latest := M{"id": 2, "field_num": "#100", "assignee_id": 11, "replied_at": "2026-10-03T10:00:00Z"}
	foreign := M{"id": 3, "field_num": "#900", "assignee_id": 22, "replied_at": "2026-10-04T10:00:00Z"}
	same := M{"id": 4, "field_num": "#10", "assignee_id": 11, "replied_at": "2026-10-03T18:00:00+08:00"}
	missing := M{"id": 5, "field_num": "#20", "assignee_id": 11}
	source.listPages = map[int]M{
		1: {"contents": []M{old, missing}, "meta": M{"total_pages": 3, "total_count": 99}},
		2: {"contents": []M{latest, foreign, same}, "meta": M{"total_pages": 3}},
		3: {"contents": []M{old, missing}, "meta": M{"total_pages": 3}},
	}
	own := actor(t, db, "one@example.com")
	page, e := service.List(context.Background(), own, "", "", 2)
	if e != nil {
		t.Fatal(e)
	}
	items := domain.Rows(page, "items")
	if fmt.Sprint(domain.Obj(items[0]["source"])["id"]) != "4" || fmt.Sprint(domain.Obj(items[1]["source"])["id"]) != "2" {
		t.Fatalf("wrong global default order: %v", items)
	}
	if page["totalCount"] != 4 || page["totalPages"] != 2 {
		t.Fatalf("wrong authorized deduplicated totals: %v", page)
	}
	second, e := service.List(context.Background(), own, "", domain.Str(page["nextCursor"]), 2)
	if e != nil {
		t.Fatal(e)
	}
	items = domain.Rows(second, "items")
	if fmt.Sprint(domain.Obj(items[0]["source"])["id"]) != "1" || fmt.Sprint(domain.Obj(items[1]["source"])["id"]) != "5" || second["nextCursor"] != "" {
		t.Fatalf("wrong next page: %v", second)
	}
	ascending, e := service.ListSorted(context.Background(), own, "", "", 10, "replied_at:asc")
	if e != nil {
		t.Fatal(e)
	}
	items = domain.Rows(ascending, "items")
	if fmt.Sprint(domain.Obj(items[0]["source"])["id"]) != "1" || fmt.Sprint(domain.Obj(items[3]["source"])["id"]) != "5" {
		t.Fatalf("missing date must stay last: %v", items)
	}
	numeric, e := service.ListSorted(context.Background(), admin, "", "", 2, "field_num:desc")
	if e != nil {
		t.Fatal(e)
	}
	items = domain.Rows(numeric, "items")
	if fmt.Sprint(domain.Obj(items[0]["source"])["id"]) != "3" || fmt.Sprint(domain.Obj(items[1]["source"])["id"]) != "2" {
		t.Fatalf("wrong global numeric order: %v", items)
	}
	_, e = service.ListSorted(context.Background(), admin, "", "", 2, "content:desc")
	checkError(t, e, 400)
	_, e = service.List(context.Background(), admin, "", "1:0", 2)
	checkError(t, e, 400)
	delete(source.listPages, 2)
	_, e = service.List(context.Background(), admin, "", "", 2)
	if e == nil {
		t.Fatal("failed source page must fail the complete result")
	}
}
