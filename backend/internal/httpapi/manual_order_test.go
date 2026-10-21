package httpapi

import (
	"context"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"testing"
)

func TestManualOrderEndpointRequiresOwnedLiveDraft(t *testing.T) {
	x := prepareRMA(t)
	server := New(x.s, t.TempDir())
	server.Tickets.Tenant = "test"
	server.Tickets.API = udesk.NewAdapter(ticketAPI{}, "test")
	x.r = server.Router()
	if e := server.Tickets.Sync(context.Background()); e != nil {
		t.Fatal(e)
	}
	_, draft, _ := x.req("POST", "/api/tickets/3/drafts", x.admin, M{"description": "Broken device"}, "")
	input := M{"draftId": domain.Obj(draft["draft"])["id"], "orderNumber": "MANUAL-1", "platform": "Amazon", "productId": "PRD-1", "quantity": 1, "paidDate": "2026-01-01", "evidenceReference": "Receipt INV-1", "entryReason": "Legacy order"}
	status, result, _ := x.req("POST", "/api/original-orders/manual", x.admin, input, "")
	if status != 200 {
		t.Fatal(status, result)
	}
	if domain.Obj(result["order"])["provider"] != "manual" || domain.Str(result["confirmationId"]) == "" {
		t.Fatal(result)
	}
	x.user("operator")
	token := x.login("qa@example.com", "SecurePass!2026")
	status, _, _ = x.req("POST", "/api/original-orders/manual", token, input, "")
	if status != 404 {
		t.Fatal("foreign draft accepted", status)
	}
	input["draftId"] = "missing"
	status, _, _ = x.req("POST", "/api/original-orders/manual", x.admin, input, "")
	if status != 404 {
		t.Fatal("missing draft accepted", status)
	}
}
