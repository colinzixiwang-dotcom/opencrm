package support

import (
	"harbor/internal/domain"
	"testing"
	"time"
)

func assessmentAt(t *testing.T, s, b M, date string) M {
	t.Helper()
	now, e := time.Parse(time.RFC3339, date+"T12:00:00Z")
	if e != nil {
		t.Fatal(e)
	}
	return Assess(s, b, now)
}
func evidence(delivery, activation string) M {
	return M{"deliveredAt": delivery, "activatedAt": activation}
}
func TestWarrantyDeviceStartAndExclusiveEnd(t *testing.T) {
	s := fixture()
	b := input("parts")
	for _, tt := range []struct {
		delivery, activation, date, start, end string
		eligible                               bool
	}{
		{"2025-01-01", "2025-01-05", "2025-01-05", "2025-01-05", "2026-01-05", true},
		{"2025-01-01", "2025-01-30", "2025-02-01", "2025-01-15", "2026-01-15", true},
		{"2025-01-01", "", "2026-01-14", "2025-01-15", "2026-01-15", true},
		{"2025-01-01", "", "2026-01-15", "2025-01-15", "2026-01-15", false},
	} {
		b["warrantyEvidence"] = evidence(tt.delivery, tt.activation)
		a := assessmentAt(t, s, b, tt.date)
		if a["startsAt"] != tt.start || a["endsAt"] != tt.end || a["eligible"] != tt.eligible {
			t.Fatalf("%+v: %+v", tt, a)
		}
	}
	b["warrantyEvidence"] = evidence("2025-01-01", "")
	if a := assessmentAt(t, s, b, "2025-01-02"); a["status"] != "incomplete" {
		t.Fatal(a)
	}
}
func TestWarrantyPrintheadModesAndCalendarBoundaries(t *testing.T) {
	s := fixture()
	p := domain.Find(s, "products", "PRD-2")
	p["warrantyClass"] = "printhead_1080"
	b := input("parts")
	b["productId"] = "PRD-2"
	b["warrantyEvidence"] = M{"deliveredAt": "2025-01-30", "purchaseType": "standalone_printhead"}
	a := assessmentAt(t, s, b, "2025-02-01")
	if a["startsAt"] != "2025-01-31" || a["endsAt"] != "2025-04-30" {
		t.Fatal(a)
	}
	p["warrantyClass"] = "printhead_3200"
	a = assessmentAt(t, s, b, "2025-02-01")
	if a["endsAt"] != "2025-07-31" {
		t.Fatal(a)
	}
	b["warrantyEvidence"] = M{"deliveredAt": "2025-01-01", "activatedAt": "2025-01-03", "purchaseType": "bundled_printhead"}
	a = assessmentAt(t, s, b, "2025-02-01")
	if a["startsAt"] != "2025-01-03" || a["endsAt"] != "2025-07-03" {
		t.Fatal(a)
	}
	if addMonths(warrantyDate("2024-02-29", "date"), 12).Format("2006-01-02") != "2025-02-28" {
		t.Fatal("leap year")
	}
}
func TestWarrantyCreationIsAtomicAndSnapshotPersists(t *testing.T) {
	s := fixture()
	u := actor("owner", false)
	b := input("parts")
	b["warrantyEvidence"] = M{}
	reject(t, s, u, "rma.create", b, "Delivery date is required")
	b["warrantyEvidence"] = evidence("2000-01-01", "")
	reject(t, s, u, "rma.create", b, "expired")
	b["warrantyEvidence"] = evidence(time.Now().AddDate(0, 0, -30).Format("2006-01-02"), "")
	r := run(t, &s, u, "rma.create", b)
	a := domain.Obj(r["eligibilityAssessment"])
	if a["status"] != "covered" || a["policyRevision"] == nil {
		t.Fatal(a)
	}
	policy := domain.Clone(domain.Obj(Config(s)["warrantyPolicy"]))
	domain.Rows(policy, "rules")[0]["months"] = 1
	run(t, &s, actor("admin", true), "warranty.save", M{"policy": policy, "expectedRevision": policy["revision"]})
	saved := domain.Obj(domain.Find(s, "rmas", domain.Str(r["id"]))["eligibilityAssessment"])
	if domain.N(domain.Obj(saved["ruleSnapshot"])["months"]) != 12 {
		t.Fatal("history was rewritten")
	}
	reject(t, s, actor("admin", true), "warranty.save", M{"policy": policy, "expectedRevision": 1}, "changed")
	reject(t, s, u, "warranty.save", M{"policy": policy, "expectedRevision": 2}, "administrators")
}
func TestSolutionRestrictionsAndWarrantyExemption(t *testing.T) {
	s := fixture()
	b := input("goodwill")
	delete(b, "warrantyEvidence")
	a := assessmentAt(t, s, b, "2026-10-16")
	if a["eligible"] != true || a["status"] != "not_required" {
		t.Fatal(a)
	}
	sol := lookup(domain.Rows(Config(s), "solutions"), "goodwill")
	sol["productIds"] = []string{"PRD-2"}
	if a = assessmentAt(t, s, b, "2026-10-16"); a["eligible"] != false {
		t.Fatal(a)
	}
	sol["productIds"] = []string{}
	sol["platforms"] = []string{"Shopify"}
	if a = assessmentAt(t, s, b, "2026-10-16"); a["eligible"] != false {
		t.Fatal(a)
	}
	sol["platforms"] = []string{}
	sol["requiresWarranty"] = true
	if a = assessmentAt(t, s, b, "2026-10-16"); a["eligible"] != false {
		t.Fatal(a)
	}
}
func TestScopedWarrantyRulesAndAmbiguity(t *testing.T) {
	s := fixture()
	p := domain.Obj(Config(s)["warrantyPolicy"])
	override := M{"id": "us_device", "name": "US device", "coverage": "device", "months": 24, "enabled": true, "productIds": []string{}, "market": "US", "platform": "Amazon"}
	p["rules"] = append(domain.Rows(p, "rules"), override)
	b := input("parts")
	b["warrantyEvidence"] = M{"deliveredAt": "2025-01-01", "market": "US"}
	a := assessmentAt(t, s, b, "2026-06-01")
	if a["eligible"] != true || domain.Obj(a["ruleSnapshot"])["id"] != "us_device" {
		t.Fatal(a)
	}
	p["rules"] = append(domain.Rows(p, "rules"), domain.Clone(override))
	a = assessmentAt(t, s, b, "2026-06-01")
	if a["status"] != "incomplete" {
		t.Fatal(a)
	}
}
func TestWarrantyMissingFutureAndStaleInputs(t *testing.T) {
	s := fixture()
	b := input("parts")
	for _, ev := range []M{evidence("2027-01-01", ""), evidence("2026-01-01", "2025-12-01"), evidence("2026-01-01", "2027-01-01")} {
		b["warrantyEvidence"] = ev
		a := assessmentAt(t, s, b, "2026-10-16")
		if a["eligible"] != false {
			t.Fatal(a)
		}
	}
	b = input("parts")
	b["expectedWarrantyRevision"] = 999
	reject(t, s, actor("a", false), "rma.create", b, "changed")
	p := domain.Clone(domain.Obj(Config(s)["warrantyPolicy"]))
	p["graceDays"] = -1
	reject(t, s, actor("admin", true), "warranty.save", M{"policy": p, "expectedRevision": 1}, "Activation grace days")
}

func TestConfiguredWarrantyDateModesAndExplicitExemption(t *testing.T) {
	for _, tt := range []struct {
		mode, unit, field, value, start, end string
		duration, offset                     int
	}{
		{"delivery", "months", "deliveredAt", "2025-01-31", "2025-01-31", "2025-02-28", 1, 0},
		{"payment", "days", "paidAt", "2025-01-01", "2025-01-03", "2025-02-02", 30, 2},
		{"activation", "months", "activatedAt", "2025-01-02", "2025-01-02", "2026-01-02", 12, 0},
		{"delivery_next_day", "days", "deliveredAt", "2025-01-01", "2025-01-02", "2025-04-02", 90, 0},
		{"activation_grace", "months", "deliveredAt", "2025-01-01", "2025-01-08", "2026-01-08", 12, 0},
	} {
		t.Run(tt.mode, func(t *testing.T) {
			s := fixture()
			domain.Find(s, "products", "PRD-1")["warrantyClass"] = "halo_device"
			rule := M{"id": "halo", "name": "Halo", "coverage": "halo_device", "enabled": true, "productIds": []string{}, "market": "", "platform": "", "startMode": tt.mode, "durationUnit": tt.unit, "months": tt.duration, "days": tt.duration, "graceDays": 7, "startOffsetDays": tt.offset, "requireEvidence": true}
			policy := domain.Clone(domain.Obj(Config(s)["warrantyPolicy"]))
			policy["rules"] = append(domain.Rows(policy, "rules"), rule)
			run(t, &s, actor("admin", true), "warranty.save", M{"policy": policy, "expectedRevision": policy["revision"]})
			b := input("parts")
			b["warrantyEvidence"] = M{tt.field: tt.value, "evidenceReference": "Customer receipt"}
			a := assessmentAt(t, s, b, "2025-02-01")
			if a["eligible"] != true || a["startsAt"] != tt.start || a["endsAt"] != tt.end {
				t.Fatal(a)
			}
			delete(domain.Obj(b["warrantyEvidence"]), "evidenceReference")
			if a = assessmentAt(t, s, b, "2025-02-01"); a["eligible"] != false {
				t.Fatal("missing evidence accepted", a)
			}
			saved := domain.Rows(domain.Obj(Config(s)["warrantyPolicy"]), "rules")
			r := saved[len(saved)-1]
			r["eligibilityMode"] = "exempt"
			r["requireEvidence"] = false
			b["warrantyEvidence"] = M{}
			if a = assessmentAt(t, s, b, "2025-02-01"); a["status"] != "exempt" || a["eligible"] != true {
				t.Fatal(a)
			}
			r["enabled"] = false
			if a = assessmentAt(t, s, b, "2025-02-01"); a["eligible"] != false {
				t.Fatal("disabled rule granted exemption", a)
			}
		})
	}
}

func TestWarrantyTypeLifecycleAndPendingRules(t *testing.T) {
	s := fixture()
	policy := domain.Clone(domain.Obj(Config(s)["warrantyPolicy"]))
	policy["classes"] = append(domain.Rows(policy, "classes"), M{"id": "future_part", "name": "Future accessory"})
	rule := M{"id": "future", "name": "Future policy pending", "coverage": "future_part", "months": 0, "enabled": false, "startMode": "delivery", "productIds": []string{}}
	policy["rules"] = append(domain.Rows(policy, "rules"), rule)
	run(t, &s, actor("admin", true), "warranty.save", M{"policy": policy, "expectedRevision": policy["revision"]})
	domain.Find(s, "products", "PRD-1")["warrantyClass"] = "future_part"
	b := input("parts")
	if a := assessmentAt(t, s, b, "2025-02-01"); a["eligible"] != false {
		t.Fatal(a)
	}
	policy = domain.Clone(domain.Obj(Config(s)["warrantyPolicy"]))
	definitions := domain.Rows(policy, "classes")
	policy["classes"] = definitions[:len(definitions)-1]
	reject(t, s, actor("admin", true), "warranty.save", M{"policy": policy, "expectedRevision": policy["revision"]}, "assigned to products")
	policy = domain.Clone(domain.Obj(Config(s)["warrantyPolicy"]))
	rows := domain.Rows(policy, "rules")
	rows[len(rows)-1]["enabled"] = true
	reject(t, s, actor("admin", true), "warranty.save", M{"policy": policy, "expectedRevision": policy["revision"]}, "Warranty months")
}
