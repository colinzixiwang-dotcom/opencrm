package httpapi

import (
	"encoding/json"
	"harbor/internal/domain"
	"harbor/internal/ruoyi"
	"strings"
	"testing"
)

func prepareRMA(t *testing.T) *suite {
	x := setup(t)
	s, _ := x.s.State()
	domain.Find(s, "products", "PRD-1")["productType"] = "device"
	domain.Find(s, "products", "PRD-2")["productType"] = "part"
	if e := storeState(x, s); e != nil {
		t.Fatal(e)
	}
	return x
}
func storeState(x *suite, s M) error {
	b, _ := json.Marshal(s)
	return x.s.DB.Exec("UPDATE app_state SET data=? WHERE id=1", string(b)).Error
}
func rmaInput() M {
	return M{"ticketNumber": "PRIVATE-TICKET", "orderNumber": "PRIVATE-ORDER", "platform": "Amazon", "productId": "PRD-1", "rootCauseId": "device_fault", "solutionId": "goodwill", "description": "PRIVATE-DESCRIPTION", "taskInputs": M{"gift": M{"amountCents": 15000}}}
}
func TestRMAOwnershipEnforcedAcrossBootstrapDetailAndExports(t *testing.T) {
	x := prepareRMA(t)
	x.user("operator")
	one := x.login("qa@example.com", "SecurePass!2026")
	x.action(x.admin, "user.create", M{"name": "Other agent", "email": "other@example.com", "password": "SecurePass!2026", "role": "operator"}, 200)
	two := x.login("other@example.com", "SecurePass!2026")
	r := x.action(one, "rma.create", rmaInput(), 200)
	id := domain.Str(r["id"])
	for _, token := range []string{one, x.admin} {
		c, _, _ := x.req("GET", "/api/rmas/"+id, token, nil, "")
		if c != 200 {
			t.Fatal(c)
		}
	}
	c, _, _ := x.req("GET", "/api/rmas/"+id, two, nil, "")
	if c != 404 {
		t.Fatal("foreign detail", c)
	}
	for _, path := range []string{"/api/bootstrap", "/api/export/rmas", "/api/export/benefitHistory"} {
		c, _, w := x.req("GET", path, two, nil, "")
		if c != 200 || strings.Contains(w.Body.String(), "PRIVATE-") || strings.Contains(w.Body.String(), id) {
			t.Fatal("foreign RMA leaked", path, c)
		}
	}
	_, data, _ := x.req("GET", "/api/bootstrap", one, nil, "")
	if len(domain.Rows(data, "rmas")) != 1 || len(domain.Rows(data, "rmaTasks")) != 2 {
		t.Fatal("creator cannot see generated tasks")
	}
	task := domain.Rows(data, "rmaTasks")[0]
	x.action(two, "rmatask.update", M{"id": task["id"], "expectedRevision": task["revision"], "amountCents": 500, "qty": 1}, 404)
	x.action(one, "rmatask.review", M{"id": task["id"], "expectedRevision": task["revision"], "decision": "approved", "note": "No"}, 403)
	x.action(one, "rmaconfig.save", M{}, 403)
}
func TestRMAExecutionIdempotencyAndNoForeignBenefitHistory(t *testing.T) {
	x := prepareRMA(t)
	x.user("operator")
	token := x.login("qa@example.com", "SecurePass!2026")
	r := x.action(token, "rma.create", rmaInput(), 200, "rma-create-once")
	again := x.action(token, "rma.create", rmaInput(), 200, "rma-create-once")
	if r["id"] != again["id"] {
		t.Fatal("RMA duplicated")
	}
	_, s, _ := x.req("GET", "/api/bootstrap", x.admin, nil, "")
	var promo M
	for _, t2 := range domain.Rows(s, "rmaTasks") {
		if t2["typeId"] == "promo_code" {
			promo = t2
		}
	}
	payload := M{"id": promo["id"], "expectedRevision": promo["revision"], "operation": "complete", "code": "ONLY-ONCE"}
	x.action(x.admin, "rmatask.execute", payload, 200, "promo-execute-once")
	x.action(x.admin, "rmatask.execute", payload, 200, "promo-execute-once")
	_, s, _ = x.req("GET", "/api/bootstrap", token, nil, "")
	if len(domain.Rows(s, "benefitHistory")) != 1 {
		t.Fatal("benefit history duplicated")
	}
	x.action(token, "rmatask.execute", payload, 403)
	x.action(token, "rma.note", M{"id": r["id"], "text": "A saved owner note"}, 200)
}
func TestSupportMigrationIdempotentAndLegacyGrantsPreserved(t *testing.T) {
	x := prepareRMA(t)
	_, before, _ := x.req("GET", "/api/bootstrap", x.admin, nil, "")
	if len(domain.Rows(before, "menus")) != 20 {
		t.Fatal("missing new pages")
	}
	if e := (ruoyi.Service{DB: x.s.DB}).EnsureSupportMenus(); e != nil {
		t.Fatal(e)
	}
	_, after, _ := x.req("GET", "/api/bootstrap", x.admin, nil, "")
	if len(domain.Rows(after, "permissionMenus")) != len(domain.Rows(before, "permissionMenus")) {
		t.Fatal("duplicate migration menus")
	}
	op := x.login("operator@harbor.local", "HarborDemo!2026")
	_, s, _ := x.req("GET", "/api/bootstrap", op, nil, "")
	if !domain.In("rma.create", domain.Strings(s["permissions"])...) || domain.In("rmatask.review", domain.Strings(s["permissions"])...) {
		t.Fatal("incorrect default operator grants")
	}
}
