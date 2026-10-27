package mabang

import (
	"context"
	catalog "harbor/internal/catalogsource"
	"strconv"
	"strings"
	"time"
)

// Catalog uses bounded creation windows, then fetches inventory for exact SKUs.
// It publishes nothing if any page or inventory batch fails.
func (c *Client) Catalog(ctx context.Context, from string, progress func(int)) (catalog.Snapshot, error) {
	out := catalog.Snapshot{Products: []catalog.Product{}, Positions: []catalog.Position{}, From: from, Through: time.Now().UTC().Format(time.RFC3339)}
	loc, _ := time.LoadLocation("Asia/Shanghai")
	start, e := time.ParseInLocation("2006-01-02", from, loc)
	if e != nil || start.After(time.Now()) {
		return out, failure("invalid_range", "Enter a valid catalog start date.", 422)
	}
	end := time.Now().In(loc)
	seen := map[string]bool{}
	calls := 0
	for !start.After(end) {
		until := start.AddDate(0, 0, 29)
		if until.After(end) {
			until = end
		}
		p := map[string]string{"timeCreatedStart": start.Format("2006-01-02 15:04:05"), "timeCreatedEnd": until.Format("2006-01-02 15:04:05"), "maxRows": "1000", "way": "2", "showVirtualSku": "1", "showWarehouse": "1", "showLabel": "1"}
		cursors := map[string]bool{}
		for page := 0; ; page++ {
			if page >= 1000 {
				return out, failure("incomplete", "Catalog pagination did not finish.", 502)
			}
			d, e := c.call(ctx, "stock-do-search-sku-list-new", p)
			if e != nil {
				return out, e
			}
			calls++
			if progress != nil {
				progress(calls)
			}
			rows, ok := d["data"].([]any)
			if value, present := d["data"]; present && value == nil && str(d["nextCursor"]) == "" {
				rows = []any{}
				ok = true
			}
			if !ok {
				return out, failure("malformed", "Mabang returned an invalid catalog response.", 502)
			}
			for _, v := range rows {
				r, ok := v.(map[string]any)
				if !ok || str(r["stockSku"]) == "" || str(r["id"]) == "" {
					return out, failure("malformed", "Mabang returned an invalid catalog response.", 502)
				}
				id := str(r["id"])
				if seen[id] {
					continue
				}
				seen[id] = true
				aliases := []string{}
				if a, ok := r["virtualSku"].([]any); ok {
					for _, v := range a {
						if s, ok := v.(string); ok && s != "" {
							aliases = append(aliases, s)
						}
					}
				}
				cats := []string{}
				for _, k := range []string{"parentCategoryName", "categoryName", "thirdCategoryName"} {
					if s := str(r[k]); s != "" {
						cats = append(cats, s)
					}
				}
				image := str(r["stockPicture"])
				if image == "" {
					image = str(r["salePicture"])
				}
				out.Products = append(out.Products, catalog.Product{ID: id, SKU: str(r["stockSku"]), Name: str(r["nameCN"]), NameEN: str(r["nameEN"]), MasterSKU: str(r["salesSku"]), Aliases: aliases, Status: productStatus(str(r["status"])), Category: strings.Join(cats, " / "), Image: image, Source: catalogProvenance(c.Key, r), Raw: r})
			}
			next := str(d["nextCursor"])
			if next == "" {
				break
			}
			if cursors[next] {
				return out, failure("malformed", "Repeated catalog cursor.", 502)
			}
			cursors[next] = true
			p["cursor"] = next
		}
		// Inclusive second-resolution windows: overlap boundaries and deduplicate IDs.
		if until.Equal(end) {
			break
		}
		start = until
	}
	skus := []string{}
	for _, p := range out.Products {
		skus = append(skus, p.SKU)
	}
	out.Positions, e = c.inventory(ctx, skus, func(n int) {
		if progress != nil {
			progress(calls + n)
		}
	})
	if e != nil {
		return out, e
	}
	out.Through = time.Now().UTC().Format(time.RFC3339)
	return out, nil
}

func itoa(v int) string         { return strconv.Itoa(v) }
func integer(v any) (int, bool) { n, e := strconv.Atoi(str(v)); return n, e == nil && n >= 0 }

// Inventory reads exact stock SKUs without importing or modifying the catalog.
func (c *Client) Inventory(ctx context.Context, sku string) ([]catalog.Position, error) {
	if strings.TrimSpace(sku) == "" || strings.Contains(sku, ",") {
		return nil, failure("invalid_sku", "Invalid inventory SKU.", 422)
	}
	return c.inventory(ctx, []string{sku}, nil)
}
func (c *Client) inventory(ctx context.Context, skus []string, progress func(int)) ([]catalog.Position, error) {
	positions := []catalog.Position{}
	calls := 0
	for i := 0; i < len(skus); i += 100 {
		last := min(i+100, len(skus))
		batch := []string{}
		wanted := map[string]bool{}
		for _, p := range skus[i:last] {
			batch = append(batch, p)
			wanted[p] = true
		}
		found := map[string]bool{}
		for page := 1; ; page++ {
			if page > 1000 {
				return nil, failure("incomplete", "Inventory pagination did not finish.", 502)
			}
			d, e := c.call(ctx, "stock-get-stock-quantity", map[string]string{"stockSkus": strings.Join(batch, ","), "page": itoa(page)})
			if e != nil {
				return nil, e
			}
			calls++
			if progress != nil {
				progress(calls)
			}
			rows, ok := d["data"].([]any)
			if !ok {
				return nil, failure("malformed", "Mabang returned an invalid inventory response.", 502)
			}
			for _, v := range rows {
				r, ok := v.(map[string]any)
				if !ok || !wanted[str(r["stockSku"])] {
					return nil, failure("malformed", "Unexpected inventory SKU.", 502)
				}
				sku := str(r["stockSku"])
				if found[sku] {
					return nil, failure("malformed", "Repeated inventory SKU.", 502)
				}
				found[sku] = true
				warehouses, ok := r["warehouse"].([]any)
				if !ok {
					return nil, failure("malformed", "Missing warehouse inventory.", 502)
				}
				for _, v := range warehouses {
					w, ok := v.(map[string]any)
					if !ok || str(w["warehouseId"]) == "" {
						return nil, failure("malformed", "Invalid warehouse inventory.", 502)
					}
					positions = append(positions, catalog.Position{SKU: sku, WarehouseID: str(w["warehouseId"]), Warehouse: str(w["warehouseName"]), OnHand: str(w["stockQuantity"]), Available: str(w["availableStockQuantity"]), Waiting: str(w["waitingQuantity"]), Purchasing: str(w["shippingQuantity"]), Transfer: str(w["allotShippingQuantity"]), Grid: str(w["gridCode"]), Raw: w})
				}
			}
			total, ok := integer(d["count"])
			if !ok {
				return nil, failure("malformed", "Missing inventory total.", 502)
			}
			if len(found) >= total {
				break
			}
			if len(rows) == 0 {
				return nil, failure("incomplete", "Inventory results are incomplete.", 502)
			}
		}
		if len(found) != len(wanted) {
			return nil, failure("incomplete", "Some catalog SKUs have no inventory response.", 502)
		}
	}
	return positions, nil
}
