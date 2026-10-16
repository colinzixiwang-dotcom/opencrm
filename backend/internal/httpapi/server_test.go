package httpapi

import (
	"encoding/json"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"harbor/internal/ruoyi"
	"harbor/internal/store"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type suite struct {
	t     *testing.T
	s     *store.Store
	r     http.Handler
	admin string
}

func setup(t *testing.T) *suite {
	if e := udesk.LoadEnv("../../../.env"); e != nil {
		t.Fatal(e)
	}
	t.Helper()
	s, e := store.Open(filepath.Join(t.TempDir(), "test-workspace"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Destroy() })
	x := &suite{t: t, s: s, r: New(s, t.TempDir()).Router()}
	x.admin = x.login("admin@harbor.local", "HarborDemo!2026")
	return x
}
func (x *suite) req(method, path, token string, b M, key string) (int, M, *httptest.ResponseRecorder) {
	x.t.Helper()
	raw := ""
	if b != nil {
		v, _ := json.Marshal(b)
		raw = string(v)
	}
	r := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.AddCookie(&http.Cookie{Name: "harbor_session", Value: token})
	}
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	x.r.ServeHTTP(w, r)
	v := M{}
	json.Unmarshal(w.Body.Bytes(), &v)
	return w.Code, v, w
}
func (x *suite) login(email, password string) string {
	x.t.Helper()
	c, v, w := x.req("POST", "/api/login", "", M{"email": email, "password": password}, "")
	if c != 200 {
		x.t.Fatal(c, v)
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == "harbor_session" {
			if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
				x.t.Fatal("unsafe cookie")
			}
			return c.Value
		}
	}
	x.t.Fatal("missing cookie")
	return ""
}
func (x *suite) action(token, a string, b M, want int, key ...string) M {
	x.t.Helper()
	k := ""
	if len(key) > 0 {
		k = key[0]
	}
	c, v, _ := x.req("POST", "/api/action", token, M{"action": a, "payload": b}, k)
	if c != want {
		x.t.Fatalf("%s: status %d want %d: %v", a, c, want, v)
	}
	return domain.Obj(v["result"])
}
func (x *suite) menus(perms ...string) []any {
	out := []any{}
	for _, m := range (ruoyi.Service{DB: x.s.DB}).AllMenus() {
		for _, p := range perms {
			if m.Perms == p {
				out = append(out, m.MenuID)
			}
		}
	}
	return out
}
func (x *suite) role(key string, menus []any, status string, id any) M {
	return x.action(x.admin, "role.save", M{"roleId": id, "roleName": key, "roleKey": key, "status": status, "menuIds": menus}, 200)
}
func (x *suite) user(role string) M {
	return x.action(x.admin, "user.create", M{"name": "Permission QA", "email": "qa@example.com", "password": "SecurePass!2026", "role": role}, 200)
}
func TestAuthenticationAndNoSecretDisclosure(t *testing.T) {
	x := setup(t)
	c, _, _ := x.req("GET", "/api/bootstrap", "", nil, "")
	if c != 401 {
		t.Fatal(c)
	}
	c, _, _ = x.req("POST", "/api/login", "", M{"email": "admin@harbor.local", "password": "wrong"}, "")
	if c != 401 {
		t.Fatal(c)
	}
	c, _, w := x.req("GET", "/api/bootstrap", x.admin, nil, "")
	if c != 200 || strings.Contains(w.Body.String(), "passwordHash") || strings.Contains(w.Body.String(), "$2a$") {
		t.Fatal("bootstrap leaks password or failed")
	}
	c, _, w = x.req("GET", "/api/backup", x.admin, nil, "")
	if c != 200 || strings.Contains(w.Body.String(), "passwordHash") || strings.Contains(w.Body.String(), "\"users\"") {
		t.Fatal("backup leaks auth data")
	}
	x.req("POST", "/api/logout", x.admin, M{}, "")
	c, _, _ = x.req("GET", "/api/bootstrap", x.admin, nil, "")
	if c != 401 {
		t.Fatal("logout session still valid")
	}
}
func TestBuiltInRolesAndReadRejection(t *testing.T) {
	x := setup(t)
	token := x.login("analyst@harbor.local", "HarborDemo!2026")
	x.action(token, "product.create", M{}, 403)
	_, v, _ := x.req("GET", "/api/bootstrap", token, nil, "")
	if len(domain.Rows(v, "users")) != 0 || len(domain.Rows(v, "roles")) != 0 {
		t.Fatal("analyst sees admin data")
	}
	operator := x.login("operator@harbor.local", "HarborDemo!2026")
	x.action(operator, "expense.create", M{}, 403)
	x.action(operator, "role.save", M{}, 403)
}
func TestCustomRoleUnionAndImmediateRevocation(t *testing.T) {
	x := setup(t)
	r := x.role("catalog", x.menus("erp:product:view", "erp:product:add"), "0", 0)
	u := x.user("catalog")
	token := x.login("qa@example.com", "SecurePass!2026")
	_, v, _ := x.req("GET", "/api/bootstrap", token, nil, "")
	if len(domain.Rows(v, "menus")) != 1 || len(domain.Rows(v, "sales")) != 0 || len(domain.Rows(v, "audit")) != 0 || len(domain.Rows(v, "users")) != 0 {
		t.Fatal("module data not redacted")
	}
	for _, path := range []string{"/api/report", "/api/export/sales", "/api/backup"} {
		c, _, _ := x.req("GET", path, token, nil, "")
		if c != 403 {
			t.Fatal(path, c)
		}
	}
	x.action(token, "product.create", M{"sku": "RBAC-ONE", "name": "Permission QA", "category": "Test", "costCents": 100, "priceCents": 200, "reorderPoint": 1, "leadDays": 1, "unit": "pcs"}, 200)
	x.action(token, "product.update", M{}, 403)
	r2 := x.role("tasks", x.menus("erp:tools:view", "erp:task:add"), "0", 0)
	x.action(x.admin, "user.assignRoles", M{"id": u["id"], "roleIds": []any{r["id"], r2["id"]}}, 200)
	x.action(token, "task.create", M{"title": "Union permission", "owner": "QA", "dueDate": "2026-10-15", "priority": "normal"}, 200)
	x.role("catalog", x.menus("erp:product:view", "erp:product:add"), "1", r["id"])
	x.action(token, "product.create", M{}, 403)
	_, v, _ = x.req("GET", "/api/getInfo", token, nil, "")
	if !domain.In("tasks", domain.Strings(domain.Obj(v["user"])["roles"])...) {
		t.Fatal("second role lost")
	}
	x.action(x.admin, "user.update", M{"id": u["id"], "role": "tasks", "active": false}, 200)
	c, _, _ := x.req("GET", "/api/bootstrap", token, nil, "")
	if c != 401 {
		t.Fatal("disabled account retains session")
	}
}
func TestMenuVisibilityAndDisabledPermission(t *testing.T) {
	x := setup(t)
	x.role("catalog", x.menus("erp:product:view"), "0", 0)
	x.user("catalog")
	token := x.login("qa@example.com", "SecurePass!2026")
	id := x.menus("erp:product:view")[0]
	x.action(x.admin, "menu.save", M{"menuId": id, "menuName": "Catalog QA", "orderNum": 20, "status": "0", "visible": "1"}, 200)
	_, v, _ := x.req("GET", "/api/bootstrap", token, nil, "")
	if len(domain.Rows(v, "menus")) != 0 {
		t.Fatal("hidden menu visible")
	}
	c, _, _ := x.req("GET", "/api/export/products", token, nil, "")
	if c != 200 {
		t.Fatal("hidden menu should retain access")
	}
	x.action(x.admin, "menu.save", M{"menuId": id, "menuName": "Catalog QA", "orderNum": 20, "status": "1", "visible": "0"}, 200)
	c, _, _ = x.req("GET", "/api/export/products", token, nil, "")
	if c != 403 {
		t.Fatal("disabled page still accessible")
	}
}
func TestAdministratorProtectionAndRollback(t *testing.T) {
	x := setup(t)
	_, v, _ := x.req("GET", "/api/bootstrap", x.admin, nil, "")
	uid := domain.Obj(v["currentUser"])["id"]
	x.action(x.admin, "user.assignRoles", M{"id": uid, "roleIds": []any{3}}, 409)
	x.action(x.admin, "user.update", M{"id": uid, "role": "analyst", "active": true}, 409)
	x.action(x.admin, "role.save", M{"roleId": 1, "roleKey": "admin", "roleName": "Changed", "status": "1", "menuIds": []any{}}, 409)
	before := domain.N(v["version"])
	x.action(x.admin, "role.save", M{"roleKey": "bad", "roleName": "bad", "status": "0", "menuIds": []any{999999}}, 400)
	_, v, _ = x.req("GET", "/api/bootstrap", x.admin, nil, "")
	if domain.N(v["version"]) != before {
		t.Fatal("rejected changes persisted")
	}
}
func TestIdempotencyAndConcurrentWrites(t *testing.T) {
	x := setup(t)
	b := M{"title": "Once", "owner": "QA", "dueDate": "2026-10-15", "priority": "normal"}
	a := x.action(x.admin, "task.create", b, 200, "unique-task")
	again := x.action(x.admin, "task.create", b, 200, "unique-task")
	if a["id"] != again["id"] {
		t.Fatal("duplicate replay")
	}
	b["title"] = "Different"
	x.action(x.admin, "task.create", b, 409, "unique-task")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); x.action(x.admin, "task.create", b, 200) }()
	}
	wg.Wait()
	s, _ := x.s.State()
	count := 0
	for _, r := range domain.Rows(s, "tasks") {
		if r["title"] == "Different" {
			count++
		}
	}
	if count != 8 {
		t.Fatal("lost update", count)
	}
}
func TestOriginHostAndReportValidation(t *testing.T) {
	x := setup(t)
	for _, path := range []string{"/api/report?from=bad", "/api/report?from=2026-10-15&to=2026-10-14", "/api/report?channel=bad"} {
		c, _, _ := x.req("GET", path, x.admin, nil, "")
		if c != 400 {
			t.Fatal(path, c)
		}
	}
	r := httptest.NewRequest("POST", "http://127.0.0.1/api/action", strings.NewReader(`{}`))
	r.Header.Set("Origin", "https://example.com")
	w := httptest.NewRecorder()
	x.r.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross origin write")
	}
	r = httptest.NewRequest("GET", "http://evil.example/api/health", nil)
	w = httptest.NewRecorder()
	x.r.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("unexpected host")
	}
}
func TestPersistentPermissionsAfterReopen(t *testing.T) {
	if e := udesk.LoadEnv("../../../.env"); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(t.TempDir(), "persist-workspace")
	s, e := store.Open(path)
	if e != nil {
		t.Fatal(e)
	}
	x := &suite{t: t, s: s, r: New(s, t.TempDir()).Router()}
	x.admin = x.login("admin@harbor.local", "HarborDemo!2026")
	x.role("persist", x.menus("erp:product:view"), "0", 0)
	x.user("persist")
	token := x.login("qa@example.com", "SecurePass!2026")
	s.Close()
	s, e = store.Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Destroy()
	x.s = s
	x.r = New(s, t.TempDir()).Router()
	c, v, _ := x.req("GET", "/api/bootstrap", token, nil, "")
	if c != 200 || !domain.In("persist", domain.Strings(domain.Obj(v["currentUser"])["roles"])...) {
		t.Fatal("permission/session persistence", c, v)
	}
}

func TestCSVFormulaSafetyAndRateLimit(t *testing.T) {
	x := setup(t)
	x.action(x.admin, "task.create", M{"title": "=1+1", "owner": "QA", "dueDate": "2026-10-15", "priority": "normal"}, 200)
	c, _, w := x.req("GET", "/api/export/tasks", x.admin, nil, "")
	if c != 200 || !strings.Contains(w.Body.String(), "'=1+1") {
		t.Fatal("CSV formula was not neutralized")
	}
	for i := 0; i < 15; i++ {
		c, _, _ = x.req("POST", "/api/login", "", M{"email": "unknown@example.com", "password": "wrong"}, "")
		if c != 401 {
			t.Fatal(c)
		}
	}
	c, _, _ = x.req("POST", "/api/login", "", M{"email": "unknown@example.com", "password": "wrong"}, "")
	if c != 429 {
		t.Fatal("rate limit", c)
	}
}
