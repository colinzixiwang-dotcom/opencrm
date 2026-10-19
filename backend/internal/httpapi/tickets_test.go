package httpapi

import (
	"context"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"harbor/internal/ruoyi"
	"harbor/internal/tickets"
	"net/url"
	"strings"
	"testing"
)

type ticketAPI struct{}

func (ticketAPI) Get(_ context.Context, path string, q url.Values) (map[string]any, error) {
	own := M{"id": 1, "field_num": "#1", "subject": "MY-TICKET", "assignee_id": 11, "user_group_id": 5042}
	shared := M{"id": 3, "field_num": "#3", "subject": "OTHER-MORPHO", "assignee_id": 33, "user_group_id": 5043}
	foreign := M{"id": 2, "field_num": "#2", "subject": "FOREIGN-TICKET", "assignee_id": 22, "user_group_id": 5060}
	switch path {
	case "tickets":
		return M{"contents": []M{own, foreign, shared}, "meta": M{"total_pages": 1}}, nil
	case "tickets/detail":
		if q.Get("id") == "3" || q.Get("num") == "#3" {
			return M{"ticket": shared}, nil
		}
		if q.Get("id") == "1" || q.Get("num") == "#1" {
			return M{"ticket": own}, nil
		}
		return M{"ticket": foreign}, nil
	case "tickets/1/replies", "tickets/3/replies":
		return M{"replies": []M{{"id": 1, "content": "Own reply"}}}, nil
	}
	return M{}, nil
}
func TestTicketAuthorizationAcrossAllHTTPPaths(t *testing.T) {
	x := setup(t)
	server := New(x.s, t.TempDir())
	server.Tickets.Tenant = "test"
	server.Tickets.API = udesk.NewAdapter(ticketAPI{}, "test")
	x.r = server.Router()
	u := x.user("operator")
	uid := domain.Str(u["id"])
	if e := x.s.DB.Create(&tickets.Mapping{Tenant: "test", UserID: uid, AgentID: "11", Scope: "own", Groups: "[]", Enabled: true}).Error; e != nil {
		t.Fatal(e)
	}
	token := x.login("qa@example.com", "SecurePass!2026")
	for _, path := range []string{"/api/tickets", "/api/export/tickets", "/api/bootstrap"} {
		status, _, w := x.req("GET", path, token, nil, "")
		if status != 200 || strings.Contains(w.Body.String(), "FOREIGN-TICKET") {
			t.Fatal("foreign data leaked", path, status, w.Body.String())
		}
	}
	for _, path := range []string{"/api/tickets/2", "/api/tickets/2/replies", "/api/tickets/lookup?number=%232"} {
		status, _, _ := x.req("GET", path, token, nil, "")
		if status != 404 {
			t.Fatal("foreign read accepted", path, status)
		}
	}
	status, _, _ := x.req("POST", "/api/tickets/2/drafts", token, M{}, "")
	if status != 404 {
		t.Fatal("foreign draft", status)
	}
	status, _, _ = x.req("POST", "/api/integrations/udesk/accounts/configure", token, M{}, "")
	if status != 403 {
		t.Fatal("scope escalation", status)
	}
	status, _, _ = x.req("GET", "/api/tickets/1/replies", token, nil, "")
	if status != 200 {
		t.Fatal("own replies", status)
	}
	if e := x.s.DB.Model(&tickets.Mapping{}).Where("user_id=?", uid).Update("enabled", false).Error; e != nil {
		t.Fatal(e)
	}
	status, _, _ = x.req("GET", "/api/tickets", token, nil, "")
	if status != 200 {
		t.Fatal("mapping must not restrict an active CRM account", status)
	}
}

func TestEveryActiveRoleCanReadSharedMorphoAndCreateRMA(t *testing.T) {
	x := prepareRMA(t)
	server := New(x.s, t.TempDir())
	server.Tickets.Tenant = "test"
	server.Tickets.API = udesk.NewAdapter(ticketAPI{}, "test")
	x.r = server.Router()
	// Directory mappings are deliberately absent for all of these accounts.
	x.role("no_grants", []any{}, "0", 0)
	for _, role := range []string{"operator", "analyst", "no_grants"} {
		email := role + "@shared.test"
		x.action(x.admin, "user.create", M{"name": role, "email": email, "password": "SecurePass!2026", "role": role}, 200)
		token := x.login(email, "SecurePass!2026")
		if role == "no_grants" {
			var u ruoyi.SysUser
			x.s.DB.Where("email=?", email).First(&u)
			if e := x.s.DB.Where("user_id=?", u.UserID).Delete(&ruoyi.UserRole{}).Error; e != nil {
				t.Fatal(e)
			}
		}
		_, state, _ := x.req("GET", "/api/bootstrap", token, nil, "")
		actor := domain.Obj(state["currentUser"])
		if !domain.In("rma.create", domain.Strings(actor["permissions"])...) {
			t.Fatal("no shared creation grant", actor)
		}
		if e := server.Tickets.Sync(context.Background()); e != nil {
			t.Fatal(e)
		}
		for _, path := range []string{"/api/tickets", "/api/export/tickets", "/api/tickets/3", "/api/tickets/3/replies", "/api/tickets/lookup?number=%233"} {
			status, _, _ := x.req("GET", path, token, nil, "")
			if status != 200 {
				t.Fatal(role, path, status)
			}
		}
		status, draft, _ := x.req("POST", "/api/tickets/3/drafts", token, M{"description": "Shared ticket"}, "")
		if status != 200 {
			t.Fatal(role, status, draft)
		}
		input := rmaInput()
		input["ticketNumber"] = "#3"
		input["draftId"] = domain.Obj(draft["draft"])["id"]
		input["ticketSnapshotId"] = domain.Obj(draft["payload"])["ticketSnapshotId"]
		result := x.action(token, "rma.create", input, 200)
		if domain.Obj(result["ticketReference"])["id"] != "3" {
			t.Fatal(result)
		}
		for _, path := range []string{"/api/tickets/2", "/api/tickets/lookup?number=%232"} {
			status, _, _ := x.req("GET", path, token, nil, "")
			if status != 404 {
				t.Fatal(role, path, status)
			}
		}
		status, _, _ = x.req("POST", "/api/integrations/udesk/ticket-scope", token, M{}, "")
		if status != 403 {
			t.Fatal("nonadmin changed shared policy", status)
		}
		status, _, _ = x.req("GET", "/api/integrations/udesk/ticket-scope", token, nil, "")
		if status != 403 {
			t.Fatal("nonadmin read admin configuration", status)
		}
		// Shared creation does not grant approvals or execution.
		x.action(token, "rmatask.review", M{}, 403)
	}
}

func TestCRMContractDoesNotExposeProviderDTO(t *testing.T) {
	x := setup(t)
	server := New(x.s, t.TempDir())
	server.Tickets.Tenant = "test"
	server.Tickets.API = udesk.NewAdapter(ticketAPI{}, "test")
	x.r = server.Router()
	x.user("operator")
	token := x.login("qa@example.com", "SecurePass!2026")
	status, body, w := x.req("GET", "/api/tickets/1?contract=2", token, nil, "")
	if status != 200 {
		t.Fatal(status, w.Body.String())
	}
	ticket := domain.Obj(body["ticket"])
	if ticket["number"] != "#1" || ticket["groupId"] != "5042" || body["source"] != nil || strings.Contains(w.Body.String(), "field_num") || strings.Contains(w.Body.String(), "Evidence") {
		t.Fatal("provider DTO escaped", body)
	}
	status, body, _ = x.req("GET", "/api/tickets/1", token, nil, "")
	if status != 200 || domain.Obj(body["source"])["field_num"] != "#1" {
		t.Fatal("v1 compatibility lost", body)
	}
	status, body, w = x.req("GET", "/api/tickets/1/replies?contract=2", token, nil, "")
	if status != 200 || body["messages"] == nil || body["replies"] != nil || strings.Contains(w.Body.String(), "function_type") {
		t.Fatal("conversation contract", body)
	}
	status, _, _ = x.req("GET", "/api/tickets/2?contract=2", token, nil, "")
	if status != 404 {
		t.Fatal("v2 bypassed product policy")
	}
}
