package support

import (
	"encoding/json"
	"harbor/internal/domain"
	"strings"
	"testing"
	"time"
)

func fixture() M {
	s := domain.Seed()
	Ensure(s)
	domain.Find(s, "products", "PRD-1")["productType"] = "device"
	p := domain.Find(s, "products", "PRD-2")
	p["productType"] = "part"
	p["partKind"] = "printhead"
	p["deviceIds"] = []string{"PRD-1"}
	return s
}
func actor(id string, admin bool) M {
	roles := []string{"operator"}
	if admin {
		roles = []string{"admin"}
	}
	return M{"id": id, "name": id, "roles": roles, "permissions": []string{"*:*:*"}, "permissionCodes": []string{"erp:rma:view", "erp:serials:view", "erp:supportorders:view"}}
}
func run(t *testing.T, s *M, u M, a string, b M) M {
	t.Helper()
	if strings.HasPrefix(a, "rmatask.") && b["expectedRevision"] == nil {
		b["expectedRevision"] = domain.Find(*s, "rmaTasks", domain.Str(b["id"]))["revision"]
	}
	next, r, e := Mutate(*s, a, b, u)
	if e != nil {
		t.Fatal(a, e)
	}
	*s = next
	return r
}
func reject(t *testing.T, s M, u M, a string, b M, match string) {
	t.Helper()
	before, _ := json.Marshal(s)
	if strings.HasPrefix(a, "rmatask.") && b["expectedRevision"] == nil {
		b["expectedRevision"] = domain.Find(s, "rmaTasks", domain.Str(b["id"]))["revision"]
	}
	_, _, e := Mutate(s, a, b, u)
	if e == nil || !strings.Contains(e.Error(), match) {
		t.Fatalf("wanted %q got %v", match, e)
	}
	after, _ := json.Marshal(s)
	if string(before) != string(after) {
		t.Fatal("failed mutation modified state")
	}
}
func input(solution string) M {
	return M{"warrantyEvidence": M{"deliveredAt": time.Now().AddDate(0, 0, -30).Format("2006-01-02")}, "ticketNumber": "TICKET-001", "orderNumber": "ORDER-001", "platform": "Amazon", "productId": "PRD-1", "rootCauseId": "device_fault", "solutionId": solution, "description": "Device needs support", "taskInputs": M{"gift": M{"amountCents": int64(15000)}, "refund": M{"amountCents": int64(20000)}, "parts": M{"productId": "PRD-2"}}}
}
func task(s M, r M, kind string) M {
	for _, t := range domain.Rows(s, "rmaTasks") {
		if t["rmaId"] == r["id"] && t["typeId"] == kind {
			return t
		}
	}
	panic("task not found")
}
func TestSolutionsGenerateFixedTasksAndTrustedOwner(t *testing.T) {
	s := fixture()
	u := actor("owner", false)
	b := input("goodwill")
	b["ownerId"] = "someone-else"
	b["tasks"] = []M{{"typeId": "refund"}}
	r := run(t, &s, u, "rma.create", b)
	if r["ownerId"] != "owner" || len(domain.Rows(s, "rmaTasks")) != 2 {
		t.Fatal("client controls owner or task list")
	}
	g := task(s, r, "gift_card")
	p := task(s, r, "promo_code")
	if g["status"] != "pending_approval" || p["status"] != "ready" {
		t.Fatal("independent task approvals")
	}
}
func TestThresholdBoundaryAndMandatoryApprovals(t *testing.T) {
	for _, amount := range []int64{10000, 10001} {
		s := fixture()
		b := input("goodwill")
		domain.Obj(b["taskInputs"])["gift"] = M{"amountCents": amount}
		r := run(t, &s, actor("a", false), "rma.create", b)
		pending := task(s, r, "gift_card")["approval"] == "pending"
		if pending != (amount > 10000) {
			t.Fatal("threshold boundary")
		}
	}
	s := fixture()
	Config(s)["rules"] = []M{}
	r := run(t, &s, actor("a", false), "rma.create", input("refund"))
	for _, kind := range []string{"refund", "return_device"} {
		if task(s, r, kind)["approval"] != "pending" {
			t.Fatal("mandatory approval was bypassed")
		}
	}
}
func TestIndependentReviewsAndDependencyExecution(t *testing.T) {
	s := fixture()
	a, u := actor("admin", true), actor("owner", false)
	r := run(t, &s, u, "rma.create", input("refund"))
	refund, ret := task(s, r, "refund"), task(s, r, "return_device")
	reject(t, s, a, "rmatask.execute", M{"id": refund["id"], "operation": "complete", "reference": "txn"}, "approved")
	run(t, &s, a, "rmatask.review", M{"id": refund["id"], "decision": "approved", "note": "Refund approved independently"})
	if task(s, r, "refund")["status"] != "blocked" {
		t.Fatal("refund must still wait for return")
	}
	run(t, &s, a, "rmatask.review", M{"id": ret["id"], "decision": "approved", "note": "Return approved"})
	run(t, &s, a, "rmatask.execute", M{"id": ret["id"], "operation": "dispatch", "carrier": "Test carrier", "tracking": "RET-1"})
	if task(s, r, "refund")["status"] != "blocked" {
		t.Fatal("dispatch is not receipt")
	}
	run(t, &s, a, "rmatask.execute", M{"id": ret["id"], "operation": "complete"})
	if task(s, r, "refund")["status"] != "ready" {
		t.Fatal("dependency not unlocked")
	}
	reject(t, s, a, "rmatask.execute", M{"id": refund["id"], "operation": "complete"}, "reference")
	run(t, &s, a, "rmatask.execute", M{"id": refund["id"], "operation": "complete", "reference": "REFUND-TXN"})
	if domain.Find(s, "rmas", domain.Str(r["id"]))["status"] != "completed" {
		t.Fatal("case not completed")
	}
}
func TestEditsInvalidateApprovalAndReviewsAreAdminOnly(t *testing.T) {
	s := fixture()
	a, u := actor("admin", true), actor("owner", false)
	r := run(t, &s, u, "rma.create", input("goodwill"))
	g := task(s, r, "gift_card")
	reject(t, s, u, "rmatask.review", M{"id": g["id"], "decision": "approved", "note": "Self approve"}, "Only administrators")
	run(t, &s, a, "rmatask.review", M{"id": g["id"], "decision": "approved", "note": "Approved"})
	run(t, &s, u, "rmatask.update", M{"id": g["id"], "amountCents": int64(25000), "qty": 1})
	if task(s, r, "gift_card")["approval"] != "pending" {
		t.Fatal("stale approval reused")
	}
	reject(t, s, u, "rmatask.execute", M{"id": g["id"], "operation": "complete", "code": "x"}, "Only administrators")
	reject(t, s, actor("other", false), "rmatask.update", M{"id": g["id"], "amountCents": 1}, "not found")
}
func TestGiftAndPromoHistoryCannotDuplicate(t *testing.T) {
	s := fixture()
	a, u := actor("admin", true), actor("owner", false)
	r := run(t, &s, u, "rma.create", input("goodwill"))
	g, p := task(s, r, "gift_card"), task(s, r, "promo_code")
	run(t, &s, a, "rmatask.review", M{"id": g["id"], "decision": "approved", "note": "Goodwill"})
	reject(t, s, a, "rmatask.execute", M{"id": g["id"], "operation": "complete"}, "code")
	for _, t2 := range []M{g, p} {
		run(t, &s, a, "rmatask.execute", M{"id": t2["id"], "operation": "complete", "code": "SENT-" + domain.Str(t2["id"])})
		reject(t, s, a, "rmatask.execute", M{"id": t2["id"], "operation": "complete", "code": "AGAIN"}, "Completed")
	}
	if len(domain.Rows(s, "benefitHistory")) != 2 {
		t.Fatal("history not exactly once")
	}
}
func TestOwnerScopingIncludesTasksHistoryAndAdmin(t *testing.T) {
	s := fixture()
	a, u, v := actor("admin", true), actor("owner", false), actor("other", false)
	r := run(t, &s, u, "rma.create", input("goodwill"))
	run(t, &s, v, "rma.create", input("replacement"))
	p := task(s, r, "promo_code")
	run(t, &s, a, "rmatask.execute", M{"id": p["id"], "operation": "complete", "code": "PROMO"})
	visible := Public(domain.Clone(s), v)
	if len(domain.Rows(visible, "rmas")) != 1 || len(domain.Rows(visible, "benefitHistory")) != 0 {
		t.Fatal("owner leak")
	}
	for _, task := range domain.Rows(visible, "rmaTasks") {
		if task["rmaId"] == r["id"] {
			t.Fatal("task leak")
		}
	}
	if len(domain.Rows(Public(domain.Clone(s), a), "rmas")) != 2 {
		t.Fatal("admin cannot see all")
	}
}
func TestDAGValidationAndSnapshotStability(t *testing.T) {
	s := fixture()
	a := actor("admin", true)
	for _, nodes := range [][]M{{{"key": "a", "typeId": "promo_code", "dependsOn": []string{"b"}}, {"key": "b", "typeId": "gift_card", "dependsOn": []string{"a"}}}, {{"key": "a", "typeId": "promo_code", "dependsOn": []string{"missing"}}}, {{"key": "a", "typeId": "promo_code"}, {"key": "a", "typeId": "promo_code"}}} {
		reject(t, s, a, "rmaconfig.save", M{"entity": "solutions", "record": M{"name": "Bad DAG", "enabled": true, "nodes": nodes}}, "")
	}
	r := run(t, &s, actor("owner", false), "rma.create", input("goodwill"))
	sol := domain.Clone(lookup(domain.Rows(Config(s), "solutions"), "goodwill"))
	sol["nodes"] = []M{{"key": "only", "typeId": "promo_code", "dependsOn": []string{}}}
	run(t, &s, a, "rmaconfig.save", M{"entity": "solutions", "record": sol})

	if len(domain.Rows(domain.Obj(domain.Find(s, "rmas", domain.Str(r["id"]))["solutionSnapshot"]), "nodes")) != 2 {
		t.Fatal("historical DAG changed")
	}
	if len(domain.Rows(s, "rmaTasks")) != 2 {
		t.Fatal("existing tasks changed")
	}
}
func TestRootCauseApplicabilityAndDisabledChoices(t *testing.T) {
	s := fixture()
	a, u := actor("admin", true), actor("owner", false)
	root := domain.Clone(lookup(domain.Rows(Config(s), "rootCauses"), "device_fault"))
	root["productIds"] = []string{"PRD-2"}
	run(t, &s, a, "rmaconfig.save", M{"entity": "rootCauses", "record": root})
	reject(t, s, u, "rma.create", input("goodwill"), "does not apply")
	root["productIds"] = []string{}
	root["enabled"] = false
	run(t, &s, a, "rmaconfig.save", M{"entity": "rootCauses", "record": root})
	reject(t, s, u, "rma.create", input("goodwill"), "disabled")
	reject(t, s, u, "rmaconfig.save", M{}, "Only administrators")
}
func TestConfigurableFieldsAndCustomTaskTypes(t *testing.T) {
	s := fixture()
	a, u := actor("admin", true), actor("owner", false)
	run(t, &s, a, "rmaconfig.save", M{"entity": "fields", "record": M{"id": "region", "name": "Region", "enabled": true, "required": true, "scope": "rma", "fieldType": "select", "options": []string{"US", "EU"}}})
	reject(t, s, u, "rma.create", input("goodwill"), "Region is required")
	b := input("goodwill")
	b["customFields"] = M{"region": "OTHER"}
	reject(t, s, u, "rma.create", b, "Invalid option")
	b["customFields"] = M{"region": "US"}
	r := run(t, &s, u, "rma.create", b)
	if domain.Obj(r["customFields"])["region"] != "US" {
		t.Fatal("custom value lost")
	}
	run(t, &s, a, "rmaconfig.save", M{"entity": "taskTypes", "record": M{"id": "call_customer", "name": "Call customer", "enabled": true, "direction": "none", "hasAmount": false, "requiresCode": false, "requiresProduct": false}})
	run(t, &s, a, "rmaconfig.save", M{"entity": "solutions", "record": M{"id": "call_solution", "name": "Call to resolve", "enabled": true, "nodes": []M{{"key": "call", "typeId": "call_customer", "dependsOn": []string{}}}}})
}
func TestSerialValidationAndUniqueness(t *testing.T) {
	s := fixture()
	a := actor("admin", true)
	run(t, &s, a, "serial.save", M{"sn": "DEVICE-001", "kind": "device", "productId": "PRD-1", "status": "sold"})
	reject(t, s, a, "serial.save", M{"sn": "device-001", "kind": "device", "productId": "PRD-1", "status": "sold"}, "already")
	run(t, &s, a, "serial.save", M{"sn": "HEAD-001", "kind": "printhead", "productId": "PRD-2", "parentSn": "DEVICE-001", "status": "sold"})
	reject(t, s, a, "serial.save", M{"sn": "HEAD-002", "kind": "printhead", "productId": "PRD-1", "status": "sold"}, "must match")
	b := input("replacement")
	b["sn"] = "HEAD-001"
	reject(t, s, actor("owner", false), "rma.create", b, "does not match")
}

func TestStaleReviewRejectedAndPartCompatibility(t *testing.T) {
	s := fixture()
	a, u := actor("admin", true), actor("owner", false)
	r := run(t, &s, u, "rma.create", input("goodwill"))
	g := task(s, r, "gift_card")
	revision := g["revision"]
	run(t, &s, u, "rmatask.update", M{"id": g["id"], "amountCents": 20000, "qty": 1})
	reject(t, s, a, "rmatask.review", M{"id": g["id"], "expectedRevision": revision, "decision": "approved", "note": "Stale approval"}, "changed")
	b := input("parts")
	b["productId"] = "PRD-3"
	domain.Find(s, "products", "PRD-3")["productType"] = "device"
	reject(t, s, u, "rma.create", b, "not compatible")
}

func TestCustomExecutionFieldsAndInboundApproval(t *testing.T) {
	s := fixture()
	a, u := actor("admin", true), actor("owner", false)
	run(t, &s, a, "rmaconfig.save", M{"entity": "fields", "record": M{"id": "delivery", "name": "Delivery confirmation", "enabled": true, "required": true, "scope": "execution", "typeId": "promo_code", "fieldType": "select", "options": []string{"Sent", "Confirmed"}}})
	r := run(t, &s, u, "rma.create", input("goodwill"))
	p := task(s, r, "promo_code")
	reject(t, s, a, "rmatask.execute", M{"id": p["id"], "operation": "complete", "code": "CODE"}, "Delivery confirmation is required")
	run(t, &s, a, "rmatask.execute", M{"id": p["id"], "operation": "complete", "code": "CODE", "executionFields": M{"delivery": "Confirmed"}})
	if domain.Obj(task(s, r, "promo_code")["executionFields"])["delivery"] != "Confirmed" {
		t.Fatal("execution fields not retained")
	}
	run(t, &s, a, "rmaconfig.save", M{"entity": "taskTypes", "record": M{"id": "return_part", "name": "Return custom part", "enabled": true, "direction": "inbound", "hasAmount": false, "requiresCode": false, "requiresProduct": true}})
	run(t, &s, a, "rmaconfig.save", M{"entity": "solutions", "record": M{"id": "return_part_solution", "name": "Return custom part solution", "enabled": true, "nodes": []M{{"key": "return", "typeId": "return_part", "productId": "PRD-2"}}}})
	b := input("return_part_solution")
	r = run(t, &s, u, "rma.create", b)
	if task(s, r, "return_part")["approval"] != "pending" {
		t.Fatal("custom inbound return bypassed mandatory approval")
	}
}

func TestDisabledFieldsRetainSavedValuesAndIgnoreNewInput(t *testing.T) {
	c := M{"fields": []M{{"id": "old", "name": "Old field", "enabled": false, "scope": "product", "fieldType": "text"}}}
	value := custom(c, "product", "", M{"old": "untrusted change"}, M{"old": "saved value"})
	if value["old"] != "saved value" {
		t.Fatal("disabled field modified or deleted")
	}
	value = custom(c, "product", "", M{"old": "new hidden value"})
	if value["old"] != nil {
		t.Fatal("disabled field accepted new data")
	}
}

func TestStarterJSONAndLegacyDependencyMigration(t *testing.T) {
	s := fixture()
	for _, sol := range domain.Rows(Config(s), "solutions") {
		for _, n := range domain.Rows(sol, "nodes") {
			if n["dependsOn"] == nil {
				t.Fatal("starter dependencies must be []")
			}
		}
	}
	sol := lookup(domain.Rows(Config(s), "solutions"), "goodwill")
	domain.Rows(sol, "nodes")[0]["dependsOn"] = nil
	r := M{"id": "old", "solutionSnapshot": domain.Clone(sol)}
	s["rmas"] = []M{r}
	before := domain.N(Config(s)["revision"])
	Ensure(s)
	encoded, _ := json.Marshal(s)
	if strings.Contains(string(encoded), `"dependsOn":null`) {
		t.Fatal("persisted legacy null dependency was not repaired")
	}
	if domain.N(Config(s)["revision"]) != before {
		t.Fatal("normalization changed revision")
	}
}
func TestConfigurationValidationAndConcurrency(t *testing.T) {
	s := fixture()
	a := actor("admin", true)
	for _, key := range []string{"constructor", "__proto__", "prototype"} {
		reject(t, s, a, "rmaconfig.save", M{"entity": "platforms", "record": M{"id": key, "name": "Bad key", "enabled": true}}, "keys")
	}
	for _, deps := range []any{"not-an-array", []any{12}, []any{"x", "x"}} {
		reject(t, s, a, "rmaconfig.save", M{"entity": "solutions", "record": M{"id": "invalid", "name": "Invalid", "enabled": true, "nodes": []M{{"key": "one", "typeId": "promo_code", "dependsOn": deps}}}}, "")
	}
	revision := Config(s)["revision"]
	run(t, &s, a, "rmaconfig.save", M{"entity": "platforms", "record": M{"id": "new", "name": "New", "enabled": true}, "expectedConfigRevision": revision})
	reject(t, s, a, "rmaconfig.save", M{"entity": "platforms", "record": M{"id": "stale", "name": "Stale", "enabled": true}, "expectedConfigRevision": revision}, "configuration changed")
	b := input("goodwill")
	b["expectedConfigRevision"] = revision
	reject(t, s, actor("owner", false), "rma.create", b, "configuration changed")
}
func TestSerialEditsPreserveLinksAndExecutionRechecksSKU(t *testing.T) {
	s := fixture()
	a, u := actor("admin", true), actor("owner", false)
	dev := run(t, &s, a, "serial.save", M{"sn": "DEVICE-LINK", "kind": "device", "productId": "PRD-1", "status": "sold"})
	run(t, &s, a, "serial.save", M{"sn": "HEAD-LINK", "kind": "printhead", "productId": "PRD-2", "parentSn": "DEVICE-LINK", "status": "sold"})
	reject(t, s, a, "serial.save", M{"id": dev["id"], "sn": "CHANGED", "kind": "device", "productId": "PRD-1", "status": "sold"}, "identity is linked")
	run(t, &s, a, "serial.save", M{"id": dev["id"], "sn": "DEVICE-LINK", "kind": "device", "productId": "PRD-1", "status": "returned"})
	r := run(t, &s, u, "rma.create", input("parts"))
	part := task(s, r, "send_parts")
	domain.Find(s, "products", "PRD-2")["productType"] = "general"
	reject(t, s, a, "rmatask.execute", M{"id": part["id"], "operation": "complete", "carrier": "x", "tracking": "x"}, "support part SKU")
}
