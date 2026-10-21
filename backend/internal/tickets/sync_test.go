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
	if e != nil || cached["totalCount"] != 2 || cached["syncError"] == "" {
		t.Fatal("fresh cache lost on failure", cached, e)
	}
	old := time.Now().Add(-16 * time.Minute)
	db.DB.Model(&tickets.SyncState{}).Where("tenant=?", s.Tenant).Update("last_success", old)
	stale, e := s.List(ctx, own, "", "", 20)
	if e != nil || stale["stale"] != true || len(domain.Rows(stale, "items")) != 0 {
		t.Fatal("stale scoped data exposed", stale, e)
	}
	staleAdmin, e := s.List(ctx, admin, "", "", 20)
	if e != nil || staleAdmin["stale"] != true || staleAdmin["totalCount"] != 0 {
		t.Fatal("admin stale visibility", staleAdmin, e)
	}
}

func TestSyncProductRemovalAndImmediateConfigurationChanges(t *testing.T) {
	db, s, f, a := fixture(t)
	ctx := context.Background()
	own := actor(t, db, "one@example.com")
	if e := s.Sync(ctx); e != nil {
		t.Fatal(e)
	}
	f.tickets[0]["assignee_id"] = 22
	f.tickets[0]["user_group_id"] = 5060
	_, e := s.Detail(ctx, own, "1", false)
	checkError(t, e, 404)
	db.DB.Model(&tickets.SyncState{}).Where("tenant=?", s.Tenant).Update("last_attempt", nil)
	if e = s.Sync(ctx); e != nil {
		t.Fatal(e)
	}
	got, e := s.List(ctx, own, "", "", 20)
	if e != nil || got["totalCount"] != 1 {
		t.Fatal(got, e)
	}
	// A config change applies to already indexed rows without a source scan.
	calls := len(f.calls)
	if _, e = s.SaveScope(ctx, a, scopeBody(1, "5042", "5060")); e != nil {
		t.Fatal(e)
	}
	got, e = s.List(ctx, own, "", "", 20)
	if e != nil || got["totalCount"] != 3 || len(f.calls) != calls {
		t.Fatal(got, e)
	}
	db.DB.Model(&tickets.Mapping{}).Where("tenant=? AND agent_id=?", s.Tenant, "11").Update("enabled", false)
	got, e = s.List(ctx, own, "", "", 20)
	if e != nil || got["totalCount"] != 3 {
		t.Fatal("mapping affected shared scope", got, e)
	}
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

func TestColumnFiltersApplyBeforePagingAndNeverExpandMorphoScope(t *testing.T) {
	db, s, f, admin := fixture(t)
	ctx := context.Background()
	mine := actor(t, db, "one@example.com")
	f.tickets = []M{}
	for i := 1; i <= 48; i++ {
		agent := 11
		if i%2 == 0 {
			agent = 22
		}
		status := "开启"
		if i%3 == 0 {
			status = "等待客户"
		}
		group := 5042
		if i == 48 {
			group = 5060
		}
		f.tickets = append(f.tickets, M{"id": i, "field_num": fmt.Sprint("#", i), "subject": fmt.Sprint("Ticket ", i), "assignee_id": agent, "user_group_id": group, "status": status, "replied_at": fmt.Sprintf("2026-10-%02dT10:00:00+08:00", i%28+1)})
	}
	if e := s.Sync(ctx); e != nil {
		t.Fatal(e)
	}
	calls := len(f.calls)
	query := func(who M, assignment, status, cursor string) M {
		t.Helper()
		r, e := s.Search(ctx, who, "", cursor, 5, "repliedAt:desc", "", tickets.ListSelection{Assignment: assignment, Status: status})
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	all := query(mine, "all", "", "")
	if all["totalCount"] != 47 {
		t.Fatal(all)
	}
	first := query(mine, "mine", "等待客户", "")
	if first["totalCount"] != 8 || first["totalPages"] != 2 {
		t.Fatal(first)
	}
	second := query(mine, "mine", "等待客户", domain.Str(first["nextCursor"]))
	if len(domain.Rows(second, "items")) != 3 {
		t.Fatal(second)
	}
	for _, page := range []M{first, second} {
		for _, item := range domain.Rows(page, "items") {
			ticket := legacyTicket(item)
			if fmt.Sprint(ticket["assignee_id"]) != "11" || ticket["status"] != "等待客户" {
				t.Fatal("filter applied after pagination", ticket)
			}
		}
	}
	if len(first["availableStatuses"].([]string)) != 2 {
		t.Fatal("statuses lost after filtering")
	}
	// A missing/disabled mapping returns no personal results, never the shared list.
	unlinked := query(admin, "mine", "", "")
	if unlinked["totalCount"] != 0 || unlinked["myAccountLinked"] != false {
		t.Fatal(unlinked)
	}
	if e := db.DB.Model(&tickets.Mapping{}).Where("user_id=?", mine["id"]).Update("enabled", false).Error; e != nil {
		t.Fatal(e)
	}
	disabled := query(mine, "mine", "", "")
	if disabled["totalCount"] != 0 {
		t.Fatal(disabled)
	}
	shared := query(mine, "all", "", "")
	if shared["totalCount"] != 47 {
		t.Fatal("personal filter changed authorization", shared)
	}
	if len(f.calls) != calls {
		t.Fatal("local filters called Udesk")
	}
	if _, e := s.Search(ctx, mine, "", "", 20, "", "", tickets.ListSelection{Assignment: "other-user"}); e == nil {
		t.Fatal("arbitrary assignee selection accepted")
	}
}
