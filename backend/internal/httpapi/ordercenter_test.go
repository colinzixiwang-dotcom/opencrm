package httpapi

import (
	"encoding/json"
	"harbor/internal/domain"
	"harbor/internal/integrations/mabang"
	"harbor/internal/orderindex"
	"harbor/internal/ordersource"
	"strings"
	"testing"
)

func TestOrderCenterFourIndependentPermissions(t *testing.T) {
	x := setup(t)
	svc := orderindex.Service{DB: x.s.DB, Tenant: mabang.FromEnv().Key}
	if e := svc.Save(x.s.DB, ordersource.Order{SourceID: "test-order", SourceNumber: "ERP-123", PlatformNumber: "PLATFORM-123", Shop: "Shop", SourceFields: map[string]any{"buyerName": "Private customer"}}, ""); e != nil {
		t.Fatal(e)
	}
	role := x.role("order-qa", []any{}, "0", 0)
	x.user("order-qa")
	token := x.login("qa@example.com", "SecurePass!2026")
	for _, tc := range []struct {
		name                 string
		caps                 []string
		menu                 bool
		list, search, detail int
	}{
		{"none", nil, false, 403, 403, 403},
		{"menu only", []string{"view"}, false, 403, 403, 403},
		{"detail only", []string{"view", "detail"}, false, 403, 403, 403},
		{"list only", []string{"view", "list"}, true, 200, 403, 403},
		{"search only", []string{"view", "search"}, true, 403, 200, 403},
		{"no menu grant", []string{"list", "search", "detail"}, false, 403, 403, 403},
		{"list and detail", []string{"view", "list", "detail"}, true, 200, 403, 404},
		{"search and detail", []string{"view", "search", "detail"}, true, 403, 200, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			perms := []string{}
			for _, cap := range tc.caps {
				perms = append(perms, "erp:orders:"+cap)
			}
			x.role("order-qa", x.menus(perms...), "0", role["id"])
			for _, route := range []struct {
				path   string
				status int
			}{{"/api/orders", tc.list}, {"/api/orders/search?number=PLATFORM-123", tc.search}, {"/api/orders/unknown", tc.detail}} {
				code, body, _ := x.req("GET", route.path, token, nil, "")
				if code != route.status {
					t.Fatalf("%s got %d: %v", route.path, code, body)
				}
				b, _ := json.Marshal(body)
				if code == 200 && strings.Contains(string(b), "Private customer") {
					t.Fatal("list/search leaked detail data")
				}
			}
			_, state, _ := x.req("GET", "/api/bootstrap", token, nil, "")
			found := false
			for _, m := range domain.Rows(state, "menus") {
				if m["url"] == "orders" {
					found = true
				}
			}
			if found != tc.menu {
				t.Fatalf("menu=%v want=%v", found, tc.menu)
			}
			if tc.list == 200 && tc.search != 200 {
				code, _, _ := x.req("GET", "/api/orders?number=PLATFORM-123", token, nil, "")
				if code != 403 {
					t.Fatal("list endpoint bypassed search permission")
				}
			}
		})
	}
	code, _, _ := x.req("GET", "/api/orders/search?number=", x.admin, nil, "")
	if code != 400 {
		t.Fatal("empty search permitted")
	}
}
