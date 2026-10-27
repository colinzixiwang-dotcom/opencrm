package mabang

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestExactSKUInventoryRead(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		if b["api"] != "stock-get-stock-quantity" {
			t.Errorf("unexpected API: %v", b["api"])
		}
		// The request must carry the exact stock SKU, not its name or alias.
		if b["data"].(map[string]any)["stockSkus"] != "KIT-A" {
			t.Errorf("unexpected SKU: %v", b)
		}
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"count": 1, "data": []any{map[string]any{"stockSku": "KIT-A", "warehouse": []any{map[string]any{"warehouseId": 10, "stockQuantity": 5, "availableStockQuantity": 0}, map[string]any{"warehouseId": 11, "stockQuantity": 8}}}}}})
	}))
	defer srv.Close()
	c := Client{URL: srv.URL, Key: "key", Token: "token", HTTP: srv.Client()}
	positions, e := c.Inventory(context.Background(), "KIT-A")
	if e != nil {
		t.Fatal(e)
	}
	if len(positions) != 2 || positions[0].Available != "0" || positions[1].Available != "" {
		t.Fatal(positions)
	}
	if _, e = c.Inventory(context.Background(), "KIT-A,OTHER"); e == nil {
		t.Fatal("accepted multiple SKUs")
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}

func TestCatalogReadOnlyBoundary(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		data := map[string]any{}
		if b["api"] == "stock-do-search-sku-list-new" {
			data = map[string]any{"data": []any{map[string]any{"id": 1, "stockSku": "OLD-A", "status": 5, "virtualSku": []string{"ALIAS-A"}}}, "nextCursor": ""}
		} else {
			data = map[string]any{"count": 1, "data": []any{map[string]any{"stockSku": "OLD-A", "warehouse": []any{map[string]any{"warehouseId": 10, "stockQuantity": 5, "availableStockQuantity": 2}}}}}
		}
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": data})
	}))
	defer srv.Close()
	c := Client{URL: srv.URL, Key: "key", Token: "token", HTTP: srv.Client()}
	snap, e := c.Catalog(context.Background(), time.Now().UTC().Format("2006-01-02"), nil)
	if e != nil {
		t.Fatal(e)
	}
	if len(snap.Products) != 1 || snap.Products[0].Aliases[0] != "ALIAS-A" || len(snap.Positions) != 1 || snap.Positions[0].Available != "2" {
		t.Fatal(snap)
	}
	if _, e = c.call(context.Background(), "order-do-create-order", nil); e == nil {
		t.Fatal("upstream write allowed")
	}
	if calls != 2 {
		t.Fatal(calls)
	}
}
