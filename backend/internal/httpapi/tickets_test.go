package httpapi

import (
	"context"
	"harbor/internal/domain"
	"harbor/internal/tickets"
	"net/url"
	"strings"
	"testing"
)

type ticketAPI struct{}

func (ticketAPI) Get(_ context.Context, path string, q url.Values) (map[string]any, error) {
	own := M{"id": 1, "field_num": "#1", "subject": "MY-TICKET", "assignee_id": 11}
	foreign := M{"id": 2, "field_num": "#2", "subject": "FOREIGN-TICKET", "assignee_id": 22}
	switch path {
	case "tickets":
		return M{"contents": []M{own, foreign}, "meta": M{"total_pages": 1}}, nil
	case "tickets/detail":
		if q.Get("id") == "1" || q.Get("num") == "#1" {
			return M{"ticket": own}, nil
		}
		return M{"ticket": foreign}, nil
	case "tickets/1/replies":
		return M{"replies": []M{{"id": 1, "content": "Own reply"}}}, nil
	}
	return M{}, nil
}
func TestTicketAuthorizationAcrossAllHTTPPaths(t *testing.T) {
	x := setup(t)
	server := New(x.s, t.TempDir())
	server.Tickets.Tenant = "test"
	server.Tickets.API = ticketAPI{}
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
	if status != 403 {
		t.Fatal("disabled mapping", status)
	}
}
