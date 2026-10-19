package tickets_test

import (
	"context"
	"reflect"
	"sync"
	"testing"

	"harbor/internal/domain"
	"harbor/internal/store"
	"harbor/internal/tickets"
)

func scopeBody(revision int, groups ...string) M {
	return M{"revision": revision, "groupIds": groups, "includeUnassigned": false}
}
func TestScopeDefaultsConfigurationPreviewAndAudit(t *testing.T) {
	db, s, f, a := fixture(t)
	ctx := context.Background()
	config, e := s.ScopeConfig(ctx, a)
	if e != nil {
		t.Fatal(e)
	}
	p := config["policy"].(tickets.TicketScope)
	if !reflect.DeepEqual(p.GroupIDs, []string{"4918", "4974", "5041", "5042", "5043", "5044"}) || p.IncludeUnassigned || p.Revision != 1 {
		t.Fatal(p)
	}
	_, e = s.SaveScope(ctx, actor(t, db, "one@example.com"), scopeBody(1, "5042"))
	checkError(t, e, 403)
	_, e = s.SaveScope(ctx, a, scopeBody(1, "999999"))
	checkError(t, e, 400)
	if _, e = s.SyncGroups(ctx, a); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) == 0 || f.calls[len(f.calls)-1] != "user_groups" {
		t.Fatal("directory update must only fetch groups")
	}
	preview, e := s.PreviewScope(ctx, a, scopeBody(1, "5042"))
	if e != nil || preview["initializing"] != true {
		t.Fatal(preview, e)
	}
	if e = s.Sync(ctx); e != nil {
		t.Fatal(e)
	}
	before := len(f.calls)
	preview, e = s.PreviewScope(ctx, a, scopeBody(1, "5042"))
	if e != nil || preview["totalCount"] != int64(2) || preview["indexedCount"] != int64(3) || len(f.calls) != before {
		t.Fatal(preview, e)
	}
	saved, e := s.SaveScope(ctx, a, scopeBody(1, "5042"))
	if e != nil {
		t.Fatal(e)
	}
	if saved["policy"].(tickets.TicketScope).Revision != 2 || len(saved["history"].([]tickets.TicketScopeChange)) != 2 {
		t.Fatal(saved)
	}
	history := saved["history"].([]tickets.TicketScopeChange)
	if history[0].Before == nil || history[0].After == nil ||
		!reflect.DeepEqual(history[0].Before.GroupIDs, []string{"4918", "4974", "5041", "5042", "5043", "5044"}) ||
		!reflect.DeepEqual(history[0].After.GroupIDs, []string{"5042"}) ||
		history[0].ActorID != domain.Str(a["id"]) || history[0].ChangedAt == "" ||
		history[1].Before != nil || history[1].After == nil {
		t.Fatal("audit must expose accurate before/after snapshots, actor and timestamp", history)
	}
	_, e = s.SaveScope(ctx, a, scopeBody(1, "5060"))
	checkError(t, e, 409)
	if e = store.Migrate(db.DB); e != nil {
		t.Fatal(e)
	}
	config, e = s.ScopeConfig(ctx, a)
	if e != nil || !reflect.DeepEqual(config["policy"].(tickets.TicketScope).GroupIDs, []string{"5042"}) {
		t.Fatal("restart reset scope", config, e)
	}
	// Empty selection is a valid, explicit empty scope and stays empty on restart.
	body := scopeBody(2)
	body["groupIds"] = []string{}
	if _, e = s.SaveScope(ctx, a, body); e != nil {
		t.Fatal(e)
	}
	config, e = s.ScopeConfig(ctx, a)
	if e != nil || len(config["policy"].(tickets.TicketScope).GroupIDs) != 0 {
		t.Fatal(config, e)
	}
}
func TestScopeConcurrentSaveHasOneWinner(t *testing.T) {
	_, s, _, a := fixture(t)
	ctx := context.Background()
	if _, e := s.ScopeConfig(ctx, a); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, g := range []string{"5042", "5060"} {
		wg.Add(1)
		go func(g string) { defer wg.Done(); _, e := s.SaveScope(ctx, a, scopeBody(1, g)); results <- e }(g)
	}
	wg.Wait()
	close(results)
	wins, conflicts := 0, 0
	for e := range results {
		if e == nil {
			wins++
		} else if d, ok := e.(*domain.Error); ok && d.Status == 409 {
			conflicts++
		} else {
			t.Fatal(e)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatal(wins, conflicts)
	}
}
