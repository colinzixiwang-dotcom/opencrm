package store_test

import (
	"encoding/json"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"harbor/internal/persistence"
	"harbor/internal/store"
	"path/filepath"
	"sync"
	"testing"
)

func TestPostgresCrossInstanceIdempotencyAndOwnership(t *testing.T) {
	if e := udesk.LoadEnv("../../../.env"); e != nil {
		t.Fatal(e)
	}
	namespace := filepath.Join(t.TempDir(), "concurrency")
	one, e := store.Open(namespace)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { one.Destroy() })
	two, e := store.Open(namespace)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { two.Close() })
	payload := domain.M{"title": "One database-owned task", "owner": "QA", "dueDate": "2026-10-16", "priority": "normal"}
	results := make(chan domain.M, 16)
	errors := make(chan error, 16)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s := one
			if i%2 == 1 {
				s = two
			}
			v, e := s.Apply("USR-ADMIN", "task.create", payload, "same-command")
			results <- v
			errors <- e
		}(i)
	}
	wg.Wait()
	close(results)
	close(errors)
	for e := range errors {
		if e != nil {
			t.Fatal(e)
		}
	}
	id := ""
	replays := 0
	for r := range results {
		current := domain.Str(domain.Obj(r["result"])["id"])
		if id == "" {
			id = current
		}
		if current != id {
			t.Fatal("same command produced different entities")
		}
		if domain.Bool(r["replayed"]) {
			replays++
		}
	}
	if id == "" || replays != 15 {
		t.Fatalf("expected one result and fifteen replays, got %d replays", replays)
	}
	state, e := one.State()
	if e != nil {
		t.Fatal(e)
	}
	found := 0
	for _, task := range domain.Rows(state, "tasks") {
		if task["id"] == id {
			found++
		}
	}
	if found != 1 {
		t.Fatal("duplicate task persisted")
	}
	_, e = two.Apply("USR-ADMIN", "task.create", domain.M{"title": "Different"}, "same-command")
	d, ok := e.(*domain.Error)
	if !ok || d.Status != 409 {
		t.Fatal("changed idempotent payload accepted")
	}
	for model, owner := range map[string]string{"SysUser": "access_control", "Ticket": "support_access", "Draft": "rma", "Run": "integration"} {
		name := one.DB.NamingStrategy.TableName(model)
		if name != persistence.Prefix(one.DB)+owner+"."+map[string]string{"SysUser": "sys_user", "Ticket": "tickets", "Draft": "drafts", "Run": "runs"}[model] {
			t.Fatalf("wrong context for %s", model)
		}
	}
	var n int64
	if e := one.DB.Raw("SELECT count(*) FROM information_schema.tables WHERE table_schema LIKE ? AND table_name='app_state'", persistence.Prefix(one.DB)+"%").Scan(&n).Error; e != nil || n != 0 {
		t.Fatal("monolithic app_state table exists")
	}
}

func TestAdministratorLabelMigration(t *testing.T) {
	if e := udesk.LoadEnv("../../../.env"); e != nil {
		t.Fatal(e)
	}
	s, e := store.Open(filepath.Join(t.TempDir(), "administrator-label"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Destroy() })
	ledger := persistence.Table(s.DB, "schema_migrations")
	users := persistence.Table(s.DB, "sys_user")
	audit := persistence.OwnerTable(s.DB, "audit", "entries")
	for _, query := range []string{
		"DELETE FROM " + ledger + " WHERE version=4",
		"UPDATE " + users + " SET user_name='Alex Morgan' WHERE user_id='USR-ADMIN'",
		"UPDATE " + users + " SET user_name='Custom name' WHERE user_id='USR-OPERATOR'",
		"INSERT INTO " + audit + ` (id,position,data) VALUES ('rename-check',0,'{"actor":"Alex Morgan","description":"Alex Morgan","history":[{"actor":"Alex Morgan"}]}')`,
	} {
		if e := s.DB.Exec(query).Error; e != nil {
			t.Fatal(e)
		}
	}
	var passwordBefore string
	if e := s.DB.Table(users).Select("password").Where("user_id=?", "USR-ADMIN").Scan(&passwordBefore).Error; e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 2; i++ {
		if e := store.Migrate(s.DB); e != nil {
			t.Fatal(e)
		}
	}
	var admin struct{ UserName, Password string }
	if e := s.DB.Table(users).Where("user_id=?", "USR-ADMIN").Take(&admin).Error; e != nil {
		t.Fatal(e)
	}
	if admin.UserName != "Administrator" || admin.Password != passwordBefore {
		t.Fatal("rename must preserve credentials", admin.UserName)
	}
	var row struct{ Data string }
	if e := s.DB.Table(audit).Where("id=?", "rename-check").Take(&row).Error; e != nil {
		t.Fatal(e)
	}
	var event domain.M
	if e := json.Unmarshal([]byte(row.Data), &event); e != nil {
		t.Fatal(e)
	}
	if event["actor"] != "Administrator" || event["description"] != "Alex Morgan" || domain.Obj(event["history"].([]any)[0])["actor"] != "Administrator" {
		t.Fatal(event)
	}
	// Later administrator edits are not reset on subsequent starts.
	if e := s.DB.Exec("UPDATE " + users + " SET user_name='My administrator' WHERE user_id='USR-ADMIN'").Error; e != nil {
		t.Fatal(e)
	}
	if e := store.Migrate(s.DB); e != nil {
		t.Fatal(e)
	}
	if e := s.DB.Table(users).Where("user_id=?", "USR-ADMIN").Take(&admin).Error; e != nil || admin.UserName != "My administrator" {
		t.Fatal(admin.UserName, e)
	}
}
