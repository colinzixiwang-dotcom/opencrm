package mabang

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

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
