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
	return source.Snapshot{Products: []source.Product{{ID: "100", SKU: "Retired-A", Name: "Historical device", Status: "5", Raw: map[string]any{}}}, Positions: []source.Position{{SKU: "Retired-A", WarehouseID: "1", OnHand: "2", Available: "1"}}, Through: time.Now().UTC().Format(time.RFC3339)}, nil
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
	if len(products) != 1 || products[0]["sku"] != "Retired-A" || products[0]["allowReship"] != false || products[0]["allowOriginal"] != true {
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
