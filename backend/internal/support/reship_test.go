package support

import (
	"harbor/internal/domain"
	"testing"
)

func TestReshipLinesAndAlternateDevice(t *testing.T) {
	for _, solution := range []string{"parts", "reship_device"} {
		s := fixture()
		u := actor("owner", true)
		p := domain.Find(s, "products", "PRD-2")
		if solution == "reship_device" {
			p["productType"] = "device"
		}
		p["source"] = "mabang"
		p["allowReship"] = true
		p["sourcePresent"] = true
		p["deviceIds"] = []string{"PRD-1"}
		other := domain.Clone(p)
		other["id"] = "OTHER"
		other["sku"] = "OTHER"
		domain.Prepend(s, "products", other)
		b := input(solution)
		b["draftId"] = "draft"
		b["originalOrder"] = M{"confirmationId": "confirmed"}
		b["solutionReason"] = "Replacement items"
		domain.Obj(b["warrantyEvidence"])["evidenceReference"] = "Delivery proof"
		b["reshipItems"] = []any{M{"productId": "PRD-2", "qty": 1}, M{"productId": "OTHER", "qty": 2}}
		next, r, e := Mutate(s, "rma.create", b, u)
		if e != nil {
			t.Fatal(e)
		}
		if r["productId"] != "PRD-1" || len(domain.Rows(r, "reshipItems")) != 2 {
			t.Fatal(r)
		}
		n := 0
		for _, task := range domain.Rows(next, "rmaTasks") {
			if task["rmaId"] == r["id"] {
				n++
				if task["affectedProductId"] != "PRD-1" {
					t.Fatal(task)
				}
			}
		}
		if n != 2 {
			t.Fatal(n)
		}
		p["sourcePresent"] = false
		reject(t, s, u, "rma.create", b, "no longer present")
		p["sourcePresent"] = true
		p["allowReship"] = true
		b["reshipItems"] = []any{M{"productId": "PRD-2", "qty": 1}, M{"productId": "PRD-2", "qty": 2}}
		reject(t, s, u, "rma.create", b, "Duplicate")
	}
}

func TestConsumableCompatibilityAndSKUApproval(t *testing.T) {
	s := fixture()
	u := actor("owner", true)
	p := domain.Find(s, "products", "PRD-2")
	p["productType"] = "consumable"
	p["source"] = "mabang"
	p["sourcePresent"] = true
	p["allowReship"] = false // Retired flag must not prevent a valid application.
	p["reshipRequiresApproval"] = true
	b := input("parts")
	next, r, e := Mutate(s, "rma.create", b, u)
	if e != nil {
		t.Fatal(e)
	}
	item := task(next, r, "send_parts")
	if item["approval"] != "pending" {
		t.Fatal(item)
	}
	reject(t, next, u, "rmatask.execute", M{"id": item["id"], "operation": "start"}, "approved")
	run(t, &next, u, "rmatask.review", M{"id": item["id"], "decision": "approved", "note": "Verified replacement"})
	run(t, &next, u, "rmatask.execute", M{"id": item["id"], "operation": "start"})
	// Removing a relation blocks further execution even after approval.
	domain.Find(next, "products", "PRD-2")["deviceIds"] = []string{}
	reject(t, next, u, "rmatask.execute", M{"id": item["id"], "operation": "dispatch"}, "not compatible")
	p["deviceIds"] = []string{}
	reject(t, s, u, "rma.create", b, "not compatible")
	p["deviceIds"] = []string{"OTHER-DEVICE"}
	reject(t, s, u, "rma.create", b, "not compatible")
}

func TestReshipApprovalPolicyChangeBeforeExecution(t *testing.T) {
	s := fixture()
	u := actor("owner", true)
	p := domain.Find(s, "products", "PRD-2")
	p["reshipRequiresApproval"] = false
	r := run(t, &s, u, "rma.create", input("parts"))
	item := task(s, r, "send_parts")
	if item["approval"] != "not_required" {
		t.Fatal(item)
	}
	domain.Find(s, "products", "PRD-2")["reshipRequiresApproval"] = true
	reject(t, s, u, "rmatask.execute", M{"id": item["id"], "operation": "start"}, "now requires approval")
	run(t, &s, u, "rmatask.update", M{"id": item["id"], "productId": "PRD-2", "qty": 1})
	if task(s, r, "send_parts")["approval"] != "pending" {
		t.Fatal("updated task bypassed approval")
	}
}
