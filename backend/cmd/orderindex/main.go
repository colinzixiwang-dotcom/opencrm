package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"harbor/internal/domain"
	"harbor/internal/integrations/mabang"
	"harbor/internal/integrations/udesk"
	"harbor/internal/orderindex"
	"harbor/internal/store"
	"log"
	"time"
)

func main() {
	loc, _ := time.LoadLocation("Asia/Shanghai")
	now := time.Now().In(loc)
	from := flag.String("from", fmt.Sprintf("%d-01-01", now.Year()), "inclusive payment date")
	to := flag.String("to", now.Format("2006-01-02"), "inclusive payment date")
	resume := flag.String("resume", "", "resume a failed/interrupted job")
	status := flag.Bool("status", false, "show safe backfill progress and counts")
	examples := flag.Bool("examples", false, "show history order references only, without customer information")
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
	s := orderindex.Service{DB: db.DB, Source: c, Tenant: c.Key}
	if *status {
		var jobs []orderindex.Job
		var n int64
		s.DB.Where("tenant=?", s.Tenant).Order("created_at desc").Limit(5).Find(&jobs)
		s.DB.Model(&orderindex.Record{}).Where("tenant=?", s.Tenant).Count(&n)
		b, _ := json.Marshal(map[string]any{"jobs": jobs, "uniqueOrders": n})
		fmt.Println(string(b))
		return
	}
	if *examples {
		rows := []map[string]any{}
		for month := 1; month <= 6; month++ {
			var r orderindex.Record
			start := fmt.Sprintf("%d-%02d-01", now.Year(), month)
			end := fmt.Sprintf("%d-%02d-01", now.Year(), month+1)
			if db.DB.Where("tenant=? AND query_source=? AND paid_at>=? AND paid_at<? AND status IN ?", s.Tenant, "history", start, end, []string{"3", "4"}).Order("paid_at, id").First(&r).Error == nil {
				rows = append(rows, map[string]any{"platformNumber": r.PlatformNumber, "sourceNumber": r.SourceNumber, "paidAt": r.PaidAt, "shop": r.Shop})
			}
		}
		b, _ := json.Marshal(rows)
		fmt.Println(string(b))
		return
	}
	id := *resume
	if id == "" {
		j, e := s.Begin(domain.M{"id": "USR-ADMIN", "name": "Administrator"}, *from, *to)
		if e != nil {
			log.Fatal(e)
		}
		id = j.ID
	}
	fmt.Println("backfill", id, *from, *to)
	if e = s.Run(context.Background(), id); e != nil {
		log.Fatal(e)
	}
	var j orderindex.Job
	db.DB.Where("id=?", id).First(&j)
	fmt.Printf("completed %s days=%d pages=%d rows=%d\n", id, j.CompletedDays, j.Pages, j.Rows)
}
