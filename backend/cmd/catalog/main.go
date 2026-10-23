// A controlled, read-only ERP importer. Rollback never calls ERP APIs.
package main

import (
	"context"
	"crypto/sha256"
	"flag"
	"fmt"
	"harbor/internal/catalog"
	"harbor/internal/integrations/mabang"
	"harbor/internal/integrations/udesk"
	"harbor/internal/store"
	"log"
	"time"
)

func main() {
	from := flag.String("from", "2015-01-01", "inclusive catalog creation date")
	rollback := flag.String("rollback", "", "completed import ID to roll back")
	flag.Parse()
	if e := udesk.LoadEnv(".env"); e != nil {
		log.Fatal(e)
	}
	db, e := store.Open("")
	if e != nil {
		log.Fatal(e)
	}
	defer db.Close()
	c := mabang.FromEnv()
	s := catalog.Service{DB: db.DB, Source: c, Tenant: fmt.Sprintf("%x", sha256.Sum256([]byte(c.Key)))}
	actor := catalog.M{"id": "USR-ADMIN", "name": "Administrator"}
	if *rollback != "" {
		if e = s.Rollback(actor, *rollback); e != nil {
			log.Fatal(e)
		}
		fmt.Println("rolled back", *rollback)
		return
	}
	r, e := s.Begin(actor, *from)
	if e != nil {
		log.Fatal(e)
	}
	fmt.Println("started", r.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	if e = s.Run(ctx, r); e != nil {
		log.Fatal(e)
	}
	result, e := s.Status()
	if e != nil {
		log.Fatal(e)
	}
	fmt.Println("completed", result["runs"].([]catalog.ImportBatch)[0].ProductCount, "SKUs")
}
