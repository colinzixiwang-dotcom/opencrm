package originalorders_test

import (
	"context"
	"encoding/json"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"harbor/internal/orderindex"
	source "harbor/internal/ordersource"
	"harbor/internal/originalorders"
	"harbor/internal/store"
	"harbor/internal/support"
	"path/filepath"
	"testing"
	"time"
)

type fake struct {
	orders []source.Order
	query  source.Query
}

func (f *fake) Lookup(_ context.Context, q source.Query) ([]source.Order, error) {
	f.query = q
	return f.orders, nil
}
func TestConfirmationBindingAndWarrantyGates(t *testing.T) {
	if e := udesk.LoadEnv("../../../.env"); e != nil {
		t.Fatal(e)
	}
	db, e := store.Open(filepath.Join(t.TempDir(), "order-evidence"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Destroy()
	state, _ := db.State()
	p := domain.Find(state, "products", "PRD-1")
	p["productType"] = "device"
	actor := domain.M{"id": "USR-ADMIN", "name": "Administrator", "roles": []string{"admin"}, "permissions": []string{"*:*:*"}}
	f := &fake{orders: []source.Order{{Provider: "mabang", Tenant: "test", PlatformNumber: "PLATFORM", SourceNumber: "ERP", SourceID: "1", Platform: "Amazon", Status: "Shipped", Items: []source.Item{{ID: "item", SKU: domain.Str(p["sku"]), Quantity: "1"}}, Evidence: []byte(`{"private":"source"}`)}}}
	svc := originalorders.Service{DB: db.DB, Source: f, Tenant: "test"}
	query := domain.M{"draftId": "draft", "orderNumber": "PLATFORM"}
	result, e := svc.Lookup(context.Background(), actor, state, query)
	if e != nil {
		t.Fatal(e)
	}
	candidate := domain.Rows(result, "items")[0]
	confirm := domain.M{"draftId": "draft", "candidateId": candidate["id"], "itemId": "item"}
	wrong := domain.Clone(actor)
	wrong["id"] = "OTHER"
	if _, e = svc.Confirm(wrong, state, confirm); e == nil {
		t.Fatal("foreign candidate confirmed")
	}
	confirmed, e := svc.Confirm(actor, state, confirm)
	if e != nil {
		t.Fatal(e)
	}
	b := domain.M{"draftId": "draft", "orderConfirmationId": confirmed["confirmationId"], "orderNumber": "PLATFORM", "platform": "Amazon", "productId": "PRD-1", "solutionId": "reship_device", "ticketNumber": "T-1", "rootCauseId": "device_fault", "description": "Broken device", "solutionReason": "Motor stopped", "warrantyEvidence": domain.M{"deliveredAt": time.Now().AddDate(0, 0, -30).Format("2006-01-02"), "evidenceReference": "delivery receipt verified by agent"}, "taskInputs": domain.M{}}
	if e = originalorders.Bind(db.DB, actor, state, b); e != nil {
		t.Fatal(e)
	}
	_, r, e := support.Mutate(state, "rma.create", b, actor)
	if e != nil {
		t.Fatal(e)
	}
	if r["solutionReason"] != "Motor stopped" || domain.Obj(r["originalOrder"])["confirmationId"] != confirmed["confirmationId"] {
		t.Fatal("evidence not attached")
	}
	a := domain.Obj(r["eligibilityAssessment"])
	if a["status"] != "covered" || domain.Obj(a["evidenceProvenance"])["recordedById"] != actor["id"] {
		t.Fatal("missing warranty provenance")
	}
	for _, mutate := range []func(domain.M){func(x domain.M) { x["orderNumber"] = "OTHER" }, func(x domain.M) { x["productId"] = "PRD-2" }, func(x domain.M) { x["orderConfirmationId"] = "forged" }, func(x domain.M) { x["solutionId"] = "replacement" }} {
		bad := domain.Clone(b)
		mutate(bad)
		if e = originalorders.Bind(db.DB, actor, state, bad); e == nil {
			t.Fatal("tampered order accepted")
		}
	}
	for _, mutate := range []func(domain.M){func(x domain.M) { x["solutionReason"] = "" }, func(x domain.M) { x["warrantyEvidence"] = domain.M{"evidenceReference": "receipt"} }, func(x domain.M) {
		x["warrantyEvidence"] = domain.M{"deliveredAt": "2020-01-01", "evidenceReference": "receipt"}
	}, func(x domain.M) { x["solutionId"] = "parts"; x["taskInputs"] = domain.M{} }} {
		bad := domain.Clone(b)
		mutate(bad)
		if _, _, e = support.Mutate(state, "rma.create", bad, actor); e == nil {
			t.Fatal("incomplete/expired RMA accepted")
		}
	}
	f.orders[0].Items[0].SKU = "ColorBox_2Base_StarterKit_Vivid"
	f.orders[0].Items[0].Name = "ColorBox"
	p["sku"] = "ColorBox_2Base_StarterKit_Vivid"
	p["source"] = "mabang"
	p["allowOriginal"] = false
	result, e = svc.Lookup(context.Background(), actor, state, query)
	if e != nil {
		t.Fatal(e)
	}
	confirm["candidateId"] = domain.Rows(result, "items")[0]["id"]
	if _, e = svc.Confirm(actor, state, confirm); e == nil {
		t.Fatal("catalog-disabled order accepted")
	}
	var stored originalorders.OrderEvidence
	db.DB.First(&stored, "id=?", confirmed["confirmationId"])
	var snapshot source.Order
	json.Unmarshal([]byte(stored.Normalized), &snapshot)
	if snapshot.Items[0].SKU == p["sku"] {
		t.Fatal("confirmed snapshot changed")
	}
}

func TestManualOrderEvidenceAndCatalogGates(t *testing.T) {
	if e := udesk.LoadEnv("../../../.env"); e != nil {
		t.Fatal(e)
	}
	db, e := store.Open(filepath.Join(t.TempDir(), "manual-order"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Destroy()
	state, _ := db.State()
	p := domain.Find(state, "products", "PRD-1")
	p["productType"] = "device"
	actor := domain.M{"id": "USR-ADMIN", "name": "Administrator"}
	svc := originalorders.Service{DB: db.DB, Tenant: "tenant"}
	input := domain.M{"draftId": "draft", "orderNumber": "MANUAL-1", "platform": "Amazon", "productId": "PRD-1", "quantity": float64(2), "paidDate": "2026-01-01", "evidenceReference": "Receipt INV-123", "entryReason": "Legacy order missing from ERP"}
	for _, patch := range []domain.M{{"quantity": 1.5}, {"quantity": 0}, {"evidenceReference": ""}, {"entryReason": ""}, {"paidDate": "2099-01-01"}, {"platform": "UNKNOWN"}, {"productId": "PRD-2"}, {"draftId": ""}, {"orderNumber": "ONE,TWO"}} {
		bad := domain.Clone(input)
		for k, v := range patch {
			bad[k] = v
		}
		if _, e = svc.Manual(actor, state, bad); e == nil {
			t.Fatalf("invalid manual order accepted: %v", patch)
		}
	}
	result, e := svc.Manual(actor, state, input)
	if e != nil {
		t.Fatal(e)
	}
	bound := domain.Clone(input)
	bound["solutionId"] = "reship_device"
	bound["orderConfirmationId"] = result["confirmationId"]
	if e = originalorders.Bind(db.DB, actor, state, bound); e != nil {
		t.Fatal(e)
	}
	original := domain.Obj(bound["originalOrder"])
	order := original["order"].(source.Order)
	if order.Provider != "manual" || order.SourceNumber != "" || order.Status != "" {
		t.Fatal("manual evidence falsely marked as ERP/shipping verification", order)
	}
	proof := domain.Obj(original["manualEvidence"])
	if proof["reference"] != input["evidenceReference"] || proof["recordedById"] != actor["id"] {
		t.Fatal("manual provenance missing", proof)
	}
	foreign := domain.Clone(actor)
	foreign["id"] = "other"
	if e = originalorders.Bind(db.DB, foreign, state, bound); e == nil {
		t.Fatal("foreign manual confirmation accepted")
	}
	p["sku"] = "ColorBox_2Base_StarterKit_Vivid"
	p["source"] = "mabang"
	p["allowOriginal"] = false
	if _, e = svc.Manual(actor, state, input); e == nil {
		t.Fatal("manual catalog policy bypass accepted")
	}
}

type indexedHistory struct{ queries []source.Query }

func (f *indexedHistory) Lookup(_ context.Context, q source.Query) ([]source.Order, error) {
	f.queries = append(f.queries, q)
	return []source.Order{{Provider: "mabang", SourceID: q.SourceNumber, SourceNumber: q.SourceNumber, PlatformNumber: q.PlatformNumber, Shop: q.Shop, QuerySource: "history", Items: []source.Item{{ID: "line", SKU: "historical-sku", Quantity: "1"}}}}, nil
}
func TestHistoricalIndexResolvesMultipleShopsWithoutPaymentDate(t *testing.T) {
	udesk.LoadEnv("../../../.env")
	db, e := store.Open(filepath.Join(t.TempDir(), "history-map"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Destroy()
	state, _ := db.State()
	index := orderindex.Service{DB: db.DB, Tenant: "fixture"}
	for _, shop := range []string{"A", "B"} {
		if e := index.Save(db.DB, source.Order{SourceID: shop, SourceNumber: "ERP-" + shop, PlatformNumber: "SAME-NUMBER", Shop: shop}, ""); e != nil {
			t.Fatal(e)
		}
	}
	f := &indexedHistory{}
	svc := originalorders.Service{DB: db.DB, Source: f, Tenant: "fixture"}
	actor := domain.M{"id": "USR-ADMIN"}
	result, e := svc.Lookup(context.Background(), actor, state, domain.M{"draftId": "draft", "orderNumber": "SAME-NUMBER"})
	if e != nil {
		t.Fatal(e)
	}
	if len(domain.Rows(result, "items")) != 2 || len(f.queries) != 2 {
		t.Fatal("ambiguous mapping was collapsed")
	}
	for _, q := range f.queries {
		if q.SourceNumber == "" || q.PaidDate != "" || q.Shop == "" {
			t.Fatal("historical query lacks indexed identity")
		}
	}
	f.queries = nil
	result, e = svc.Lookup(context.Background(), actor, state, domain.M{"draftId": "draft", "orderNumber": "SAME-NUMBER", "shop": "A"})
	if e != nil || len(domain.Rows(result, "items")) != 1 || len(f.queries) != 1 {
		t.Fatal("shop scope ignored", e)
	}
}
