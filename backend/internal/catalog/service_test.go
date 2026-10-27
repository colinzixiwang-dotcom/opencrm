package catalog_test

import (
	"context"
	"harbor/internal/catalog"
	source "harbor/internal/catalogsource"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"harbor/internal/store"
	"testing"
	"time"
)

type fake struct{}

func (fake) Catalog(context.Context, string, func(int)) (source.Snapshot, error) {
	return source.Snapshot{Products: []source.Product{{ID: "100", SKU: "Retired-A", Name: "Historical device", Status: source.StatusDiscontinued, Raw: map[string]any{}}}, Positions: []source.Position{{SKU: "Retired-A", WarehouseID: "1", OnHand: "2", Available: "1"}}, Through: time.Now().UTC().Format(time.RFC3339)}, nil
}
func TestImportPolicyCleanupRollback(t *testing.T) {
	if e := udesk.LoadEnv("../../../.env"); e != nil {
		t.Fatal(e)
	}
	db, e := store.Open(":memory:")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Destroy()
	svc := catalog.Service{DB: db.DB, Source: fake{}, Tenant: "test-tenant"}
	actor := catalog.M{"id": "USR-ADMIN", "name": "Administrator"}
	before, e := db.State()
	if e != nil {
		t.Fatal(e)
	}
	run, e := svc.Begin(actor, "2015-01-01")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = svc.Begin(actor, "2015-01-01"); e == nil {
		t.Fatal("concurrent import allowed")
	}
	if e = svc.Run(context.Background(), run); e != nil {
		t.Fatal(e)
	}
	state, _ := db.State()
	products := domain.Rows(state, "products")
	if len(products) != 1 || products[0]["sku"] != "Retired-A" || products[0]["reshipRequiresApproval"] != true || products[0]["allowOriginal"] != true {
		t.Fatal(products)
	}
	if len(domain.Rows(state, "stocks")) != 0 {
		t.Fatal("demo inventory survived")
	}
	if e = svc.Rollback(actor, run.ID); e != nil {
		t.Fatal(e)
	}
	state, _ = db.State()
	if len(domain.Rows(state, "products")) != len(domain.Rows(before, "products")) {
		t.Fatal("rollback lost catalog")
	}
	run, e = svc.Begin(actor, "2015-01-01")
	if e != nil {
		t.Fatal(e)
	}
	if e = svc.Run(context.Background(), run); e != nil {
		t.Fatal(e)
	}
	b := catalog.M{"id": products[0]["id"], "expectedRevision": 1, "allowOriginal": true, "allowReship": true, "productType": "device", "warrantyClass": "device", "reason": "Approved for controlled testing"}
	if e = svc.Configure(actor, b); e != nil {
		t.Fatal(e)
	}
	if e = svc.Configure(actor, b); e == nil {
		t.Fatal("stale policy accepted")
	}
	if e = svc.Rollback(actor, run.ID); e == nil {
		t.Fatal("rollback overwrote changed policy")
	}
}

type relationCatalog struct{}

func (relationCatalog) Catalog(ctx context.Context, from string, progress func(int)) (source.Snapshot, error) {
	snap, err := (fake{}).Catalog(ctx, from, progress)
	snap.Products = append(snap.Products, source.Product{ID: "101", SKU: "Consumable"}, source.Product{ID: "102", SKU: "Other device"})
	return snap, err
}
func TestConfigureCompatibilityAndApproval(t *testing.T) {
	if e := udesk.LoadEnv("../../../.env"); e != nil {
		t.Fatal(e)
	}
	db, e := store.Open(":memory:")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Destroy()
	svc := catalog.Service{DB: db.DB, Source: relationCatalog{}, Tenant: "relation-tenant"}
	actor := catalog.M{"id": "USR-ADMIN", "name": "Administrator"}
	batch, e := svc.Begin(actor, "2015-01-01")
	if e != nil {
		t.Fatal(e)
	}
	if e = svc.Run(context.Background(), batch); e != nil {
		t.Fatal(e)
	}
	state, _ := db.State()
	bySKU := map[string]catalog.M{}
	for _, p := range domain.Rows(state, "products") {
		bySKU[domain.Str(p["sku"])] = p
	}
	device, part := bySKU["Retired-A"], bySKU["Consumable"]
	config := func(p catalog.M, typ string, ids []any) catalog.M {
		return catalog.M{"id": p["id"], "expectedRevision": p["policyRevision"], "productType": typ, "warrantyClass": "none", "allowOriginal": true, "reshipRequiresApproval": true, "deviceIds": ids, "reason": "Verified product relationships"}
	}
	if e = svc.Configure(actor, config(device, "device", []any{})); e != nil {
		t.Fatal(e)
	}
	b := config(part, "consumable", []any{device["id"]})
	if e = svc.Configure(actor, b); e != nil {
		t.Fatal(e)
	}
	if e = svc.Configure(actor, b); e == nil {
		t.Fatal("stale relationship update accepted")
	}
	state, _ = db.State()
	saved := domain.Find(state, "products", domain.Str(part["id"]))
	if saved["productType"] != "consumable" || !domain.ReshipApprovalRequired(saved) || len(domain.Strings(saved["deviceIds"])) != 1 {
		t.Fatal(saved)
	}
	b = config(saved, "consumable", []any{part["id"]})
	if e = svc.Configure(actor, b); e == nil {
		t.Fatal("self compatibility accepted")
	}
	currentDevice := domain.Find(state, "products", domain.Str(device["id"]))
	if e = svc.Configure(actor, config(currentDevice, "part", []any{})); e == nil {
		t.Fatal("referenced device was reclassified")
	}
}
