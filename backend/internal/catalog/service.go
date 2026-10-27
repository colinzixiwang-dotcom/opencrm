// Package catalog owns CRM SKU identity and reship policy. ERP values are
// projections; policy edits never write back to the ERP.
package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"gorm.io/gorm"
	source "harbor/internal/catalogsource"
	"harbor/internal/domain"
	"harbor/internal/persistence"
	"strings"
	"time"
)

type M = domain.M
type ImportBatch struct {
	ID            string     `gorm:"primaryKey" json:"id"`
	Tenant        string     `gorm:"index" json:"-"`
	Status        string     `json:"status"`
	ActorID       string     `json:"actorId"`
	ActorName     string     `json:"actorName"`
	FromDate      string     `json:"fromDate"`
	CreatedAt     time.Time  `json:"createdAt"`
	FinishedAt    *time.Time `json:"finishedAt"`
	Calls         int        `json:"calls"`
	Error         string     `json:"error"`
	Before        string     `gorm:"type:jsonb" json:"-"`
	After         string     `gorm:"type:jsonb" json:"-"`
	ProductCount  int        `json:"productCount"`
	PositionCount int        `json:"positionCount"`
}
type Service struct {
	DB     *gorm.DB
	Source source.Source
	Tenant string
}

func Init(db *gorm.DB) error            { return db.AutoMigrate(&ImportBatch{}) }
func fail(msg string, status int) error { return &domain.Error{Message: msg, Status: status} }
func enc(v any) string                  { b, _ := json.Marshal(v); return string(b) }
func capture(state M) M {
	m := M{}
	for _, k := range []string{"products", "stocks", "movements", "warehouses", "catalogInventory"} {
		m[k] = state[k]
	}
	return m
}
func (s Service) Status() (M, error) {
	var runs []ImportBatch
	e := s.DB.Where("tenant=?", s.Tenant).Order("created_at desc").Limit(10).Find(&runs).Error
	return M{"runs": runs}, e
}
func (s Service) Begin(actor M, from string) (ImportBatch, error) {
	r := ImportBatch{ID: domain.ID("CAT"), Tenant: s.Tenant, Status: "running", ActorID: domain.Str(actor["id"]), ActorName: domain.Str(actor["name"]), FromDate: from, CreatedAt: time.Now().UTC(), Before: "null", After: "null"}
	d, e := time.Parse("2006-01-02", from)
	if e != nil || d.Year() < 1970 || d.After(time.Now()) {
		return r, fail("Enter a valid catalog start date.", 422)
	}
	e = s.DB.Transaction(func(tx *gorm.DB) error {
		if e := persistence.Lock(tx); e != nil {
			return e
		}
		// A lost worker's lease expires; failed jobs never publish partial data.
		if e := tx.Model(&ImportBatch{}).Where("tenant=? AND status='running' AND created_at<?", s.Tenant, time.Now().Add(-time.Hour)).Updates(map[string]any{"status": "failed", "error": "Catalog worker lease expired."}).Error; e != nil {
			return e
		}
		var n int64
		if e := tx.Model(&ImportBatch{}).Where("tenant=? AND status='running'", s.Tenant).Count(&n).Error; e != nil {
			return e
		}
		if n > 0 {
			return fail("Catalog synchronization is already running.", 409)
		}
		return tx.Create(&r).Error
	})
	return r, e
}
func (s Service) Run(ctx context.Context, r ImportBatch) error {
	snapshot, e := s.Source.Catalog(ctx, r.FromDate, func(n int) { s.DB.Model(&ImportBatch{}).Where("id=? AND status='running'", r.ID).Update("calls", n) })
	if e == nil {
		e = s.publish(r, snapshot)
	}
	if e != nil {
		now := time.Now().UTC()
		s.DB.Model(&ImportBatch{}).Where("id=? AND status='running'", r.ID).Updates(map[string]any{"status": "failed", "error": e.Error(), "finished_at": now})
	}
	return e
}
func (s Service) publish(r ImportBatch, snap source.Snapshot) error {
	if len(snap.Products) == 0 {
		return fail("Empty catalog was not published; existing data was retained.", 422)
	}
	return s.DB.Transaction(func(tx *gorm.DB) error {
		if e := persistence.Lock(tx); e != nil {
			return e
		}
		var batch ImportBatch
		if e := tx.Where("id=? AND status='running'", r.ID).First(&batch).Error; e != nil {
			return e
		}
		state, e := persistence.Read(tx)
		if e != nil {
			return e
		}
		before := enc(capture(state))
		products := domain.Rows(state, "products")
		by := map[string]M{}
		for _, p := range products {
			by[domain.Str(p["id"])] = p
		}
		seen := map[string]bool{}
		skus := map[string]bool{}
		for _, p := range snap.Products {
			if skus[p.SKU] {
				return fail("Duplicate stock SKU; catalog was not published.", 422)
			}
			skus[p.SKU] = true
			id := "MB-" + s.Tenant[:min(8, len(s.Tenant))] + "-" + p.ID
			seen[id] = true
			v := by[id]
			if v == nil {
				v = M{"id": id, "productType": "general", "partKind": "other", "deviceIds": []string{}, "customFields": M{}, "unit": "pcs", "costCents": 0, "priceCents": 0, "reorderPoint": 0, "reshipRequiresApproval": true, "policyRevision": 1}
				products = append(products, v)
			}
			v["sku"] = p.SKU
			v["name"] = p.Name
			v["nameEn"] = p.NameEN
			v["category"] = p.Category
			v["image"] = safeImage(p.Image)
			v["source"] = "mabang"
			v["sourceId"] = p.ID
			v["sourceTenant"] = s.Tenant
			v["sourceStatus"] = p.Status
			v["sourceMetadata"] = p.Source
			v["masterSku"] = p.MasterSKU
			v["aliases"] = p.Aliases
			v["sourcePresent"] = true
			v["syncedAt"] = snap.Through
			v["sourceSnapshot"] = p.Raw
			// ERP status/name is advisory, never automatically grants reship permission.
			v["reshipCandidate"] = p.Status == source.StatusSelling && !nonPhysical(p.SKU+" "+p.Name)
		}
		for _, p := range products {
			if p["source"] == "mabang" && p["sourceTenant"] == s.Tenant && !seen[domain.Str(p["id"])] {
				p["sourcePresent"] = false
			}
		}
		state["products"] = products
		positions := []M{}
		for i, p := range snap.Positions {
			positions = append(positions, M{"id": fmt.Sprintf("MBINV-%d", i), "sku": p.SKU, "warehouseId": p.WarehouseID, "warehouse": p.Warehouse, "onHand": p.OnHand, "available": p.Available, "waiting": p.Waiting, "purchasing": p.Purchasing, "transfer": p.Transfer, "grid": p.Grid, "syncedAt": snap.Through})
		}
		state["catalogInventory"] = positions
		cleanupDemo(state)
		domain.Prepend(state, "audit", M{"id": domain.ID("AUD"), "action": "catalog.sync", "actor": r.ActorName, "actorId": r.ActorID, "at": domain.Now(), "reference": r.ID, "productCount": len(snap.Products), "positionCount": len(positions)})
		if e := persistence.Write(tx, state); e != nil {
			return e
		}
		now := time.Now().UTC()
		return tx.Model(&batch).Updates(map[string]any{"status": "completed", "finished_at": now, "before": before, "after": enc(capture(state)), "product_count": len(snap.Products), "position_count": len(positions)}).Error
	})
}
func safeImage(v string) string {
	if strings.HasPrefix(v, "https://") {
		return v
	}
	return ""
}
func nonPhysical(v string) bool {
	v = strings.ToLower(v)
	for _, k := range []string{"运费", "维修费", "差价", "待匹配", "测试", "shipping fee", "repair fee", "test", "postage"} {
		if strings.Contains(v, k) {
			return true
		}
	}
	return false
}

// Removes only known starter identities, not user-created rows. Historical RMA
// and commercial records remain untouched; the import before-image restores them.
func cleanupDemo(state M) {
	ids := map[string]bool{}
	for _, p := range domain.Rows(domain.Seed(), "products") {
		for _, v := range domain.Rows(state, "products") {
			if v["id"] == p["id"] && v["sku"] == p["sku"] && v["name"] == p["name"] {
				ids[domain.Str(v["id"])] = true
			}
		}
	}
	for _, key := range []string{"products", "stocks", "movements"} {
		keep := []M{}
		for _, v := range domain.Rows(state, key) {
			id := domain.Str(v["productId"])
			if key == "products" {
				id = domain.Str(v["id"])
			}
			if !ids[id] {
				keep = append(keep, v)
			}
		}
		state[key] = keep
	}
}
func (s Service) Rollback(actor M, id string) error {
	return s.DB.Transaction(func(tx *gorm.DB) error {
		if e := persistence.Lock(tx); e != nil {
			return e
		}
		var r ImportBatch
		if e := tx.Where("id=? AND tenant=? AND status='completed'", id, s.Tenant).First(&r).Error; e != nil {
			return fail("Completed catalog import not found.", 404)
		}
		state, e := persistence.Read(tx)
		if e != nil {
			return e
		}
		var after M
		if e = json.Unmarshal([]byte(r.After), &after); e != nil {
			return e
		}
		if enc(capture(state)) != enc(after) {
			return fail("Catalog or inventory changed after this import. Rollback would overwrite newer changes; restore selectively from the saved before-image.", 409)
		}
		// Newly created RMAs/confirmations may depend on imported identities.
		var beforeCatalog M
		if e = json.Unmarshal([]byte(r.Before), &beforeCatalog); e != nil {
			return e
		}
		oldIDs := map[string]bool{}
		for _, p := range domain.Rows(beforeCatalog, "products") {
			oldIDs[domain.Str(p["id"])] = true
		}
		removed := []string{}
		for _, p := range domain.Rows(state, "products") {
			if !oldIDs[domain.Str(p["id"])] {
				removed = append(removed, domain.Str(p["id"]))
			}
		}
		for _, c := range persistence.Collections {
			if domain.In(c.Key, "products", "stocks", "movements", "warehouses", "audit") {
				continue
			}
			for _, row := range domain.Rows(state, c.Key) {
				for _, id := range removed {
					if strings.Contains(enc(row), `"`+id+`"`) {
						return fail("Imported SKUs are referenced by business records. Resolve references before rollback.", 409)
					}
				}
			}
		}
		if len(removed) > 0 {
			var n int64
			if e := tx.Table(persistence.Table(tx, "order_evidences")).Where("product_id IN ? AND kind='confirmed'", removed).Count(&n).Error; e != nil {
				return e
			}
			if n > 0 {
				return fail("Imported SKUs are referenced by order confirmations. Resolve references before rollback.", 409)
			}
		}
		var before M
		if e = json.Unmarshal([]byte(r.Before), &before); e != nil {
			return e
		}
		for k, v := range before {
			state[k] = v
		}
		domain.Prepend(state, "audit", M{"id": domain.ID("AUD"), "action": "catalog.rollback", "actorId": actor["id"], "actor": actor["name"], "at": domain.Now(), "reference": id})
		if e = persistence.Write(tx, state); e != nil {
			return e
		}
		return tx.Model(&r).Update("status", "rolled_back").Error
	})
}
func (s Service) Configure(actor, b M) error {
	return s.DB.Transaction(func(tx *gorm.DB) error {
		if e := persistence.Lock(tx); e != nil {
			return e
		}
		state, e := persistence.Read(tx)
		if e != nil {
			return e
		}
		var p M
		for _, v := range domain.Rows(state, "products") {
			if v["id"] == b["id"] {
				p = v
			}
		}
		if p == nil || p["source"] != "mabang" {
			return fail("Imported SKU not found.", 404)
		}
		if domain.N(b["expectedRevision"]) != domain.N(p["policyRevision"]) {
			return fail("SKU policy changed. Reload before saving.", 409)
		}
		typ := domain.Str(b["productType"])
		if !domain.In(typ, "general", "device", "part", "consumable", "other") {
			return fail("Choose a valid SKU type.", 422)
		}
		kind := domain.Str(b["warrantyClass"])
		if !domain.In(kind, "none", "device", "printhead_1080", "printhead_3200") {
			return fail("Choose a valid warranty class.", 422)
		}
		if _, exists := b["reshipRequiresApproval"]; !exists {
			b["reshipRequiresApproval"] = domain.ReshipApprovalRequired(p)
		}
		for _, k := range []string{"reshipRequiresApproval"} {
			if _, ok := b[k].(bool); !ok {
				return fail("Approval flag must be explicit.", 422)
			}
		}
		ids := domain.Strings(p["deviceIds"])
		if raw, exists := b["deviceIds"]; exists {
			rows, ok := raw.([]any)
			if !ok {
				return fail("Compatible devices must be an array.", 422)
			}
			ids = []string{}
			seen := map[string]bool{}
			for _, row := range rows {
				id, ok := row.(string)
				if !ok || id == "" || seen[id] {
					return fail("Choose unique compatible devices.", 422)
				}
				found := false
				for _, device := range domain.Rows(state, "products") {
					if device["id"] == id && device["productType"] == "device" && id != domain.Str(p["id"]) {
						found = true
					}
				}
				if !found {
					return fail("Compatible SKUs must be devices.", 422)
				}
				seen[id] = true
				ids = append(ids, id)
			}
		}
		for _, key := range []string{"isBundle"} {
			if value, exists := b[key]; exists {
				if _, valid := value.(bool); !valid {
					return fail("Bundle flag must be a boolean.", 422)
				}
			} else {
				b[key] = domain.Bool(p[key])
			}
		}
		note := domain.Str(p["classificationNote"])
		if value, exists := b["classificationNote"]; exists {
			text, ok := value.(string)
			if !ok || len([]rune(text)) > 1000 {
				return fail("Classification note must be at most 1000 characters.", 422)
			}
			note = strings.TrimSpace(text)
		}
		b["classificationNote"] = note
		if typ == "device" || typ == "general" || typ == "other" {
			ids = []string{}
		}
		if p["productType"] == "device" && typ != "device" {
			for _, other := range domain.Rows(state, "products") {
				if domain.In(domain.Str(p["id"]), domain.Strings(other["deviceIds"])...) {
					return fail("Remove compatible part references before changing this device type.", 409)
				}
			}
		}
		if domain.In(typ, "part", "consumable") && len(ids) == 0 {
			return fail("Bind at least one compatible device for this accessory or consumable.", 422)
		}
		b["deviceIds"] = ids
		reason := strings.TrimSpace(domain.Str(b["reason"]))
		if reason == "" || len(reason) > 1000 {
			return fail("A configuration reason is required.", 422)
		}
		before := domain.Clone(p)
		for _, k := range []string{"productType", "warrantyClass", "reshipRequiresApproval", "deviceIds", "isBundle", "classificationNote"} {
			p[k] = b[k]
		}
		p["partKind"] = "other"
		if strings.HasPrefix(kind, "printhead_") {
			p["partKind"] = "printhead"
		}
		p["policyRevision"] = domain.N(p["policyRevision"]) + 1
		domain.Prepend(state, "audit", M{"id": domain.ID("AUD"), "action": "catalog.policy", "reference": p["id"], "actorId": actor["id"], "actor": actor["name"], "at": domain.Now(), "reason": reason, "before": before, "after": domain.Clone(p)})
		return persistence.Write(tx, state)
	})
}
