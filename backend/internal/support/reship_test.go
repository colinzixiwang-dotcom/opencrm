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
		p["deviceIds"] = []string{}
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
		p["allowReship"] = false
		reject(t, s, u, "rma.create", b, "not enabled for reshipment")
		p["allowReship"] = true
		b["reshipItems"] = []any{M{"productId": "PRD-2", "qty": 1}, M{"productId": "PRD-2", "qty": 2}}
		reject(t, s, u, "rma.create", b, "Duplicate")
	}
}
