package orderindex_test

import (
	"context"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"harbor/internal/orderindex"
	source "harbor/internal/ordersource"
	"harbor/internal/store"
	"path/filepath"
	"testing"
)

type fakePages struct {
	fail  bool
	calls []source.BatchQuery
}

func (f *fakePages) ReadPage(ctx context.Context, q source.BatchQuery) (source.Page, error) {
	f.calls = append(f.calls, q)
	if q.CanSend == "2" && f.fail {
		return source.Page{}, &source.Error{Code: "fixture", Message: "interrupted", Status: 422}
	}
	rows := []source.Order{}
	if q.CanSend == "1" {
		rows = append(rows, source.Order{SourceID: "1", SourceNumber: "ERP-1", PlatformNumber: "P-1", PaidAt: q.Date, QuerySource: "history", SourceFields: map[string]any{"buyerName": "retained"}})
	}
	if q.Cursor == "" && q.CanSend == "1" {
		return source.Page{Orders: rows, NextCursor: "second"}, nil
	}
	return source.Page{Orders: rows}, nil
}
func TestCheckpointResumeAndIdempotentIndex(t *testing.T) {
	udesk.LoadEnv("../../../.env")
	db, e := store.Open(filepath.Join(t.TempDir(), "index"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Destroy()
	f := &fakePages{fail: true}
	s := orderindex.Service{DB: db.DB, Source: f, Tenant: "fixture"}
	job, e := s.Begin(domain.M{"id": "admin"}, "2026-01-01", "2026-01-01")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Begin(domain.M{}, "2026-01-01", "2026-01-01"); e == nil {
		t.Fatal("duplicate active job")
	}
	if e = s.Run(context.Background(), job.ID); e == nil {
		t.Fatal("expected failure")
	}
	var saved orderindex.Job
	db.DB.Where("id=?", job.ID).First(&saved)
	if saved.Status != "failed" || saved.CompletedDays != 0 || saved.Branch != 1 {
		t.Fatalf("wrong checkpoint %+v", saved)
	}
	f.fail = false
	if e = s.Run(context.Background(), job.ID); e != nil {
		t.Fatal(e)
	}
	db.DB.Where("id=?", job.ID).First(&saved)
	if saved.Status != "completed" || saved.CompletedDays != 1 {
		t.Fatal(saved.Status, saved.CompletedDays)
	}
	rows, e := s.Records("P-1", "")
	if e != nil || len(rows) != 1 {
		t.Fatal(e, len(rows))
	}
	if orderindex.Decode(rows[0]).SourceFields["buyerName"] != "retained" {
		t.Fatal("lost source data")
	}
	other := s
	other.Tenant = "other"
	rows, e = other.Records("P-1", "")
	if e != nil || len(rows) != 0 {
		t.Fatal("tenant leak")
	}
}
