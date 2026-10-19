package tickets_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"harbor/internal/domain"
	"harbor/internal/tickets"
)

func TestBackgroundIndexSearchFreshnessAndFailure(t *testing.T) {
	db, s, source, admin := fixture(t)
	ctx := context.Background()
	own := actor(t, db, "one@example.com")
	before := len(source.calls)
	initial, e := s.List(ctx, own, "", "", 20)
	if e != nil || initial["initializing"] != true || len(source.calls) != before {
		t.Fatal("initialization must not fetch source", initial, e)
	}
	source.tickets[0]["content"] = "problem-needle 中文"
	source.tickets[0]["custom_fields_v2"] = M{"TextField_900": "custom-needle"}
	if e = s.Sync(ctx); e != nil {
		t.Fatal(e)
	}
	calls := len(source.calls)
	for _, word := range []string{"problem-needle", "中文", "custom-needle", "#1"} {
		page, err := s.Search(ctx, own, "", "", 1, "replied_at:desc", word)
		if err != nil || page["totalCount"] != 1 {
			t.Fatal("body/field search", word, page, err)
		}
	}
	forbidden, e := s.Search(ctx, own, "", "", 20, "", "FOREIGN")
	if e != nil || forbidden["totalCount"] != 0 {
		t.Fatal("search leaked foreign ticket", forbidden, e)
	}
	masked, e := s.Search(ctx, own, "", "", 20, "", "customer@example.com")
	if e != nil || masked["totalCount"] != 0 {
		t.Fatal("search leaked masked contact", masked, e)
	}
	literal, e := s.Search(ctx, own, "", "", 20, "", "%")
	if e != nil || literal["totalCount"] != 0 {
		t.Fatal("wildcard not literal", literal, e)
	}
	if _, e = s.List(ctx, admin, "", "global:1", 1); e != nil {
		t.Fatal(e)
	}
	if len(source.calls) != calls {
		t.Fatal("PG queries called Udesk")
	}
	// Tick de-duplication is database backed, including a second service instance.
	other := &tickets.Service{DB: s.DB, API: s.API, Tenant: s.Tenant}
	if e = other.Sync(ctx); e != nil || len(source.calls) != calls {
		t.Fatal("duplicate tick scanned twice", e)
	}
	// A failing cycle retains the last complete membership and time.
	source.broken = true
	db.DB.Model(&tickets.SyncState{}).Where("tenant=?", s.Tenant).Update("last_attempt", nil)
	if e = s.Sync(ctx); e == nil {
		t.Fatal("source failure not reported")
	}
	cached, e := s.List(ctx, own, "", "", 20)
	if e != nil || cached["totalCount"] != 1 || cached["syncError"] == "" {
		t.Fatal("fresh cache lost on failure", cached, e)
	}
	old := time.Now().Add(-16 * time.Minute)
	db.DB.Model(&tickets.SyncState{}).Where("tenant=?", s.Tenant).Update("last_success", old)
	stale, e := s.List(ctx, own, "", "", 20)
	if e != nil || stale["stale"] != true || len(domain.Rows(stale, "items")) != 0 {
		t.Fatal("stale scoped data exposed", stale, e)
	}
	staleAdmin, e := s.List(ctx, admin, "", "", 20)
	if e != nil || staleAdmin["stale"] != true || staleAdmin["totalCount"] != 3 {
		t.Fatal("admin stale visibility", staleAdmin, e)
	}
}

func TestSyncReassignmentRemovalAndImmediateMappingChanges(t *testing.T) {
	db, s, f, a := fixture(t)
	ctx := context.Background()
	own := actor(t, db, "one@example.com")
	if e := s.Sync(ctx); e != nil {
		t.Fatal(e)
	}
	f.tickets[0]["assignee_id"] = 22
	f.tickets[0]["user_group_id"] = 8
	// Detail still checks latest source assignment before the next index sync.
	_, e := s.Detail(ctx, own, "1", false)
	checkError(t, e, 404)
	db.DB.Model(&tickets.SyncState{}).Where("tenant=?", s.Tenant).Update("last_attempt", nil)
	if e = s.Sync(ctx); e != nil {
		t.Fatal(e)
	}
	got, e := s.List(ctx, own, "", "", 20)
	if e != nil || got["totalCount"] != 0 {
		t.Fatal("reassigned ticket exposed", got, e)
	}
	if _, e = s.Configure(a, M{"agentId": "11", "scope": "group", "groups": []any{"7"}}); e != nil {
		t.Fatal(e)
	}
	got, e = s.List(ctx, own, "", "", 20)
	if e != nil || got["totalCount"] != 1 {
		t.Fatal("current group grant ignored", got, e)
	}
	db.DB.Model(&tickets.Mapping{}).Where("tenant=? AND agent_id=?", s.Tenant, "11").Update("enabled", false)
	_, e = s.List(ctx, own, "", "", 20)
	checkError(t, e, 403)
	// A successful later scan removes absent index membership, not source history.
	f.tickets = f.tickets[:1]
	db.DB.Model(&tickets.SyncState{}).Where("tenant=?", s.Tenant).Update("last_attempt", nil)
	if e = s.Sync(ctx); e != nil {
		t.Fatal(e)
	}
	got, e = s.List(ctx, a, "", "", 20)
	if e != nil || got["totalCount"] != 1 {
		t.Fatal(got, e)
	}
	var n int64
	db.DB.Model(&tickets.Ticket{}).Count(&n)
	if n != 3 {
		t.Fatal("removed history erased", n)
	}
}

func TestPrematureRepeatedSourcePageCannotPublish(t *testing.T) {
	_, s, f, a := fixture(t)
	first := M{"contents": []M{{"id": 1}}, "meta": M{"total_pages": 3}}
	f.listPages = map[int]M{1: first, 2: first, 3: first}
	if e := s.Sync(context.Background()); e == nil {
		t.Fatal("intermediate repeat accepted")
	}
	got, e := s.List(context.Background(), a, "", "", 20)
	if e != nil || got["initializing"] != true {
		t.Fatal(fmt.Sprint(got), e)
	}
}
