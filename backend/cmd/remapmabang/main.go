// remapmabang reprojects stored source facts. Confirmed evidence is never rewritten.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"harbor/internal/integrations/mabang"
	"harbor/internal/integrations/udesk"
	"harbor/internal/orderindex"
	"harbor/internal/persistence"
	"log"
	"os"
)

func main() {
	apply := flag.Bool("apply", false, "apply checked projection updates; default is validation only")
	flag.Parse()
	if e := udesk.LoadEnv(".env"); e != nil {
		log.Fatal(e)
	}
	tenant := os.Getenv("MABANG_APPKEY")
	if tenant == "" {
		log.Fatal("Mabang connection is not configured")
	}
	db, e := persistence.Open("")
	if e != nil {
		log.Fatal(e)
	}
	pool, _ := db.DB()
	defer pool.Close()
	orders, products := 0, 0
	e = db.Transaction(func(tx *gorm.DB) error {
		if e := persistence.Lock(tx); e != nil {
			return e
		}
		var records []orderindex.Record
		if e := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("tenant=?", tenant).Find(&records).Error; e != nil {
			return e
		}
		for _, r := range records {
			var raw map[string]any
			if e := json.Unmarshal([]byte(r.Raw), &raw); e != nil {
				return fmt.Errorf("invalid stored order payload")
			}
			original := orderindex.Decode(r)
			o, e := mabang.MapStoredOrder(raw, tenant, r.QuerySource == "history", original.FetchedAt)
			if e != nil {
				return fmt.Errorf("cannot map order %s: %w", r.ID, e)
			}
			o.SourceFields = nil
			b, _ := json.Marshal(o)
			if *apply {
				if e = tx.Model(&orderindex.Record{}).Where("id=? AND tenant=?", r.ID, tenant).Updates(map[string]any{"normalized": string(b), "platform": o.Platform, "status": o.Status}).Error; e != nil {
					return e
				}
			}
			orders++
		}
		type product struct {
			ID   string
			Data string
		}
		var rows []product
		table := persistence.OwnerTable(tx, "catalog", "products")
		catalogTenant := fmt.Sprintf("%x", sha256.Sum256([]byte(tenant)))
		if e := tx.Table(table).Clauses(clause.Locking{Strength: "UPDATE"}).Where("data->>'source'='mabang' AND data->>'sourceTenant'=?", catalogTenant).Find(&rows).Error; e != nil {
			return e
		}
		for _, r := range rows {
			var p map[string]any
			if e := json.Unmarshal([]byte(r.Data), &p); e != nil {
				return e
			}
			raw, ok := p["sourceSnapshot"].(map[string]any)
			if !ok {
				return fmt.Errorf("missing stored product source")
			}
			fetched, _ := p["syncedAt"].(string)
			status, meta := mabang.MapStoredProductStatus(raw, tenant, fetched)
			p["sourceStatus"] = status
			p["sourceMetadata"] = meta
			b, _ := json.Marshal(p)
			if *apply {
				if e := tx.Table(table).Where("id=?", r.ID).Update("data", string(b)).Error; e != nil {
					return e
				}
			}
			products++
		}
		return nil
	})
	if e != nil {
		log.Fatal(e)
	}
	fmt.Printf("validated orders=%d products=%d mappingVersion=%d applied=%t; source payloads, fetch times, policies and confirmed evidence preserved\n", orders, products, mabang.MappingVersion, *apply)
}
