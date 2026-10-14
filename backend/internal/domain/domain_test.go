package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func fixture() M {
	s := Seed()
	for _, k := range []string{"purchases", "sales", "shipments", "movements", "payments", "expenses", "campaigns", "tickets", "tasks", "audit"} {
		s[k] = []M{}
	}
	for _, x := range Rows(s, "stocks") {
		x["onHand"] = int64(100)
		x["locked"] = int64(0)
		x["averageCostCents"] = int64(1000)
		x["valueCents"] = int64(100000)
	}
	return s
}

type flow struct {
	t *testing.T
	s M
	u M
}

func newFlow(t *testing.T) *flow {
	s := fixture()
	return &flow{t, s, M{"id": Rows(s, "users")[0]["id"], "name": "QA", "permissions": []string{"*:*:*"}, "roles": []string{"admin"}}}
}
func (f *flow) run(a string, b M) M {
	f.t.Helper()
	s, r, e := Mutate(f.s, a, b, f.u)
	if e != nil {
		f.t.Fatal(a, e)
	}
	f.s = s
	return r
}
func (f *flow) reject(a string, b M, match string) {
	f.t.Helper()
	before, _ := json.Marshal(f.s)
	_, _, e := Mutate(f.s, a, b, f.u)
	if e == nil || !strings.Contains(e.Error(), match) {
		f.t.Fatalf("%s wanted %q, got %v", a, match, e)
	}
	after, _ := json.Marshal(f.s)
	if string(before) != string(after) {
		f.t.Fatal("failed operation mutated input")
	}
}
func eq(t *testing.T, v any, n int64) {
	t.Helper()
	if N(v) != n {
		t.Fatalf("got %v want %d", v, n)
	}
}
func poInput() M {
	return M{"supplierId": "SUP-1", "warehouseId": "WH-1", "lines": []M{{"productId": "PRD-1", "qty": 10, "unitCents": 2000}, {"productId": "PRD-2", "qty": 5, "unitCents": 500}}}
}
func saleInput() M {
	return M{"customer": "QA buyer", "channel": "Direct", "warehouseId": "WH-1", "lines": []M{{"productId": "PRD-1", "qty": 4, "unitCents": 3000}}}
}
func (f *flow) ordered() M {
	p := f.run("purchase.create", poInput())
	for _, v := range []string{"pending", "approved", "ordered"} {
		f.run("purchase.transition", M{"id": p["id"], "status": v})
	}
	return p
}
func (f *flow) shipped() M {
	o := f.run("sale.create", saleInput())
	for _, v := range []string{"confirmed", "shipped"} {
		f.run("sale.transition", M{"id": o["id"], "status": v})
	}
	return o
}
func TestSeedAndLegacyPassword(t *testing.T) {
	s := Seed()
	if len(Rows(s, "products")) != 6 || len(Rows(s, "sales")) != 18 {
		t.Fatal("missing seed")
	}
	if !VerifyPassword("HarborDemo!2026", Str(Rows(s, "users")[0]["passwordHash"])) {
		t.Fatal("legacy password failed")
	}
	if VerifyPassword("wrong", HashPassword("HarborDemo!2026")) {
		t.Fatal("incorrect bcrypt password accepted")
	}
}
func TestPurchasePartialAndFullReceipt(t *testing.T) {
	f := newFlow(t)
	p := f.ordered()
	f.run("purchase.receive", M{"id": p["id"], "lines": []M{{"productId": "PRD-1", "qty": 5}}})
	if Rows(f.s, "purchases")[0]["status"] != "partial" {
		t.Fatal("partial")
	}
	eq(t, Stock(f.s, "PRD-1", "WH-1")["averageCostCents"], 1048)
	f.run("purchase.receive", M{"id": p["id"], "lines": []M{{"productId": "PRD-1", "qty": 5}, {"productId": "PRD-2", "qty": 5}}})
	if Rows(f.s, "purchases")[0]["status"] != "received" {
		t.Fatal("receipt")
	}
	eq(t, Stock(f.s, "PRD-1", "WH-1")["onHand"], 110)
	f.reject("purchase.receive", M{"id": p["id"], "lines": []M{{"productId": "PRD-1", "qty": 1}}}, "Only ordered")
}
func TestReceiptFailuresAreAtomic(t *testing.T) {
	f := newFlow(t)
	p := f.ordered()
	for _, lines := range [][]M{{{"productId": "PRD-1", "qty": 3}, {"productId": "PRD-2", "qty": 6}}, {{"productId": "PRD-1", "qty": 3}, {"productId": "PRD-1", "qty": 1}}, {{"productId": "PRD-1", "qty": 1.5}}} {
		f.reject("purchase.receive", M{"id": p["id"], "lines": lines}, "")
	}
}
func TestPaidPurchaseCannotCancelOrOverpay(t *testing.T) {
	f := newFlow(t)
	p := f.ordered()
	f.run("purchase.pay", M{"id": p["id"], "amountCents": 100})
	f.reject("purchase.transition", M{"id": p["id"], "status": "cancelled"}, "Paid or received")
	f.reject("purchase.pay", M{"id": p["id"], "amountCents": 22501}, "outstanding")
}
func TestSaleReservesThenRecognizesExactRevenue(t *testing.T) {
	f := newFlow(t)
	o := f.run("sale.create", saleInput())
	eq(t, Report(f.s, "", "", "")["revenueCents"], 0)
	f.run("sale.transition", M{"id": o["id"], "status": "confirmed"})
	eq(t, Stock(f.s, "PRD-1", "WH-1")["locked"], 4)
	f.run("sale.transition", M{"id": o["id"], "status": "shipped"})
	eq(t, Stock(f.s, "PRD-1", "WH-1")["locked"], 0)
	eq(t, Stock(f.s, "PRD-1", "WH-1")["onHand"], 96)
	r := Report(f.s, "", "", "")
	eq(t, r["revenueCents"], 12000)
	eq(t, r["cogsCents"], 4000)
}
func TestInsufficientStockRollsBackAllReservations(t *testing.T) {
	f := newFlow(t)
	b := saleInput()
	b["lines"] = []M{{"productId": "PRD-1", "qty": 4, "unitCents": 100}, {"productId": "PRD-2", "qty": 101, "unitCents": 100}}
	o := f.run("sale.create", b)
	f.reject("sale.transition", M{"id": o["id"], "status": "confirmed"}, "Insufficient")
	eq(t, Stock(f.s, "PRD-1", "WH-1")["locked"], 0)
}
func TestCancelReleasesOnlyReservation(t *testing.T) {
	f := newFlow(t)
	o := f.run("sale.create", saleInput())
	for _, v := range []string{"confirmed", "cancelled"} {
		f.run("sale.transition", M{"id": o["id"], "status": v})
	}
	eq(t, Stock(f.s, "PRD-1", "WH-1")["onHand"], 100)
	eq(t, Stock(f.s, "PRD-1", "WH-1")["locked"], 0)
}
func TestReturnRestoresCostAndRefundsExcess(t *testing.T) {
	f := newFlow(t)
	o := f.shipped()
	f.run("sale.pay", M{"id": o["id"], "amountCents": 12000})
	f.run("sale.return", M{"id": o["id"], "lines": []M{{"productId": "PRD-1", "qty": 2}}})
	r := Report(f.s, "", "", "")
	eq(t, r["revenueCents"], 6000)
	eq(t, r["cogsCents"], 2000)
	eq(t, Stock(f.s, "PRD-1", "WH-1")["onHand"], 98)
	eq(t, Rows(f.s, "sales")[0]["paidCents"], 6000)
	eq(t, Rows(f.s, "payments")[0]["amountCents"], 6000)
	f.reject("sale.return", M{"id": o["id"], "lines": []M{{"productId": "PRD-1", "qty": 3}}}, "remaining")
}
func TestTransfersPreserveExactCost(t *testing.T) {
	f := newFlow(t)
	f.run("inventory.adjust", M{"productId": "PRD-1", "warehouseId": "WH-1", "delta": 1, "unitCents": 2000, "reason": "Mixed costs"})
	before := N(Report(f.s, "", "", "")["stockValueCents"])
	tr := f.run("shipment.create", M{"sourceId": "WH-1", "destinationId": "WH-2", "carrier": "QA", "lines": []M{{"productId": "PRD-1", "qty": 3, "unitCents": 0}}})
	for _, v := range []string{"reserved", "in_transit"} {
		f.run("shipment.transition", M{"id": tr["id"], "status": v})
	}
	r := Report(f.s, "", "", "")
	if N(r["stockValueCents"])+N(r["transitValueCents"]) != before {
		t.Fatal("transit loses cents")
	}
	f.run("shipment.transition", M{"id": tr["id"], "status": "received"})
	eq(t, Report(f.s, "", "", "")["stockValueCents"], before)
	o := f.shipped()
	for i := 0; i < 4; i++ {
		f.run("sale.return", M{"id": o["id"], "lines": []M{{"productId": "PRD-1", "qty": 1}}})
	}
	eq(t, Report(f.s, "", "", "")["stockValueCents"], before)
	eq(t, Report(f.s, "", "", "")["cogsCents"], 0)
}
func TestInventoryCannotConsumeReservedStock(t *testing.T) {
	f := newFlow(t)
	o := f.run("sale.create", saleInput())
	f.run("sale.transition", M{"id": o["id"], "status": "confirmed"})
	f.reject("inventory.adjust", M{"productId": "PRD-1", "warehouseId": "WH-1", "delta": -97, "reason": "Count"}, "")
	f.reject("inventory.adjust", M{"productId": "PRD-1", "warehouseId": "WH-1", "delta": 1.5, "unitCents": 1, "reason": "Count"}, "whole number")
}
func TestExpenseAndReportFilters(t *testing.T) {
	f := newFlow(t)
	f.shipped()
	r := Report(f.s, "", "", "")
	profit := N(r["netProfitCents"])
	f.run("expense.create", M{"category": "Software", "amountCents": 2500, "description": "Test"})
	r = Report(f.s, "", "", "")
	eq(t, r["netProfitCents"], profit-2500)
	eq(t, r["revenueCents"], 12000)
	eq(t, Report(f.s, "", "", "Shopify")["revenueCents"], 0)
	eq(t, Report(f.s, "2020-01-01", "2020-01-02", "Direct")["revenueCents"], 0)
}
func TestValidationAndDenial(t *testing.T) {
	f := newFlow(t)
	f.reject("purchase.create", M{"supplierId": "unknown"}, "")
	f.reject("sale.create", M{"customer": "QA", "channel": "Direct", "warehouseId": "WH-1", "lines": []M{{"productId": "PRD-1", "qty": 1, "unitCents": 1}, {"productId": "PRD-1", "qty": 1, "unitCents": 1}}}, "only once")
	f.reject("expense.create", M{"date": "2026-02-30", "amountCents": 1, "category": "Software", "description": "Test"}, "")
	f.u["permissions"] = []string{}
	f.reject("product.create", M{}, "does not permit")
}

func TestHistoricalCostAndTimezoneReporting(t *testing.T) {
	f := newFlow(t)
	o := f.shipped()
	Find(f.s, "sales", Str(o["id"]))["shippedAt"] = "2026-10-14T23:30:00Z"
	Obj(f.s["settings"])["timezone"] = "Asia/Shanghai"
	eq(t, Report(f.s, "2026-10-15", "2026-10-15", "Direct")["cogsCents"], 4000)
	eq(t, Report(f.s, "2026-10-14", "2026-10-14", "Direct")["revenueCents"], 0)
	Obj(f.s["settings"])["timezone"] = "America/New_York"
	eq(t, Report(f.s, "2026-10-14", "2026-10-14", "Direct")["revenueCents"], 12000)
	f.run("inventory.adjust", M{"productId": "PRD-1", "warehouseId": "WH-1", "delta": 20, "unitCents": 9000, "reason": "Expensive batch"})
	eq(t, Report(f.s, "", "", "")["cogsCents"], 4000)
	f.run("sale.return", M{"id": o["id"], "lines": []M{{"productId": "PRD-1", "qty": 1}}})
	eq(t, Report(f.s, "2026-10-14", "2026-10-14", "Direct")["cogsCents"], 3000)
	eq(t, Report(f.s, "2026-10-14", "2026-10-14", "Direct")["revenueCents"], 9000)
}

func TestMalformedDatesAndCompatibilityAreRejectedAtomically(t *testing.T) {
	f := newFlow(t)
	for _, date := range []any{42, true, []any{"2026-10-15"}, M{"date": "2026-10-15"}} {
		b := poInput()
		b["expectedDate"] = date
		f.reject("purchase.create", b, "valid date")
	}
	for _, ids := range []any{"PRD-1", []any{42}, M{"id": "PRD-1"}} {
		f.reject("product.create", M{"sku": "BAD-SKU", "name": "Bad", "category": "Test", "costCents": 100, "priceCents": 200, "reorderPoint": 1, "leadDays": 7, "deviceIds": ids}, "array of device IDs")
	}
}
