// Package orderindex owns the searchable, replaceable order projection and
// durable backfill checkpoints. RMA evidence remains owned by originalorders.
package orderindex

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"harbor/internal/domain"
	source "harbor/internal/ordersource"
	"strings"
	"time"
)

type OrderIndexRecord struct {
	ID             string    `gorm:"primaryKey" json:"id"`
	Tenant         string    `gorm:"index:order_lookup,priority:1;index" json:"-"`
	SourceID       string    `json:"sourceId"`
	PlatformNumber string    `gorm:"index:order_lookup,priority:2" json:"platformNumber"`
	SourceNumber   string    `json:"sourceNumber"`
	Shop           string    `json:"shop"`
	Platform       string    `json:"platform"`
	PaidAt         string    `gorm:"index" json:"paidAt"`
	Status         string    `json:"status"`
	QuerySource    string    `json:"querySource"`
	Normalized     string    `gorm:"type:jsonb" json:"-"`
	Raw            string    `gorm:"type:jsonb" json:"-"`
	JobID          string    `gorm:"index" json:"jobId"`
	IndexedAt      time.Time `json:"indexedAt"`
}
type Record = OrderIndexRecord
type OrderIndexJob struct {
	ID            string    `gorm:"primaryKey" json:"id"`
	Tenant        string    `gorm:"index" json:"-"`
	FromDate      string    `json:"fromDate"`
	ToDate        string    `json:"toDate"`
	Date          string    `json:"currentDate"`
	Branch        int       `json:"branch"`
	Cursor        string    `json:"-"`
	HistoryBefore string    `json:"historyBefore"`
	Status        string    `json:"status"`
	Error         string    `json:"error,omitempty"`
	Pages         int       `json:"pages"`
	Rows          int       `json:"rows"`
	CompletedDays int       `json:"completedDays"`
	ActorID       string    `json:"actorId"`
	ActorName     string    `json:"actorName"`
	Lease         string    `json:"-"`
	LeaseUntil    time.Time `json:"-"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}
type Job = OrderIndexJob
type Service struct {
	DB     *gorm.DB
	Source source.BatchSource
	Tenant string
}

func Init(db *gorm.DB) error { return db.AutoMigrate(&Record{}, &Job{}) }
func enc(v any) string       { b, _ := json.Marshal(v); return string(b) }
func Decode(r Record) source.Order {
	var o source.Order
	json.Unmarshal([]byte(r.Normalized), &o)
	json.Unmarshal([]byte(r.Raw), &o.SourceFields)
	return o
}
func (s Service) Save(tx *gorm.DB, o source.Order, job string) error {
	if o.SourceID == "" || o.SourceNumber == "" {
		return fmt.Errorf("order identity is missing")
	}
	id := fmt.Sprintf("%x", sha256.Sum256([]byte(s.Tenant+"\x00"+o.SourceID)))
	raw := string(o.Evidence)
	if raw == "" {
		raw = enc(o.SourceFields)
	}
	projection := o
	projection.SourceFields = nil
	r := Record{ID: id, Tenant: s.Tenant, SourceID: o.SourceID, PlatformNumber: o.PlatformNumber, SourceNumber: o.SourceNumber, Shop: o.Shop, Platform: o.Platform, PaidAt: o.PaidAt, Status: o.Status, QuerySource: o.QuerySource, Normalized: enc(projection), Raw: raw, JobID: job, IndexedAt: time.Now().UTC()}
	return tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "id"}}, DoUpdates: clause.AssignmentColumns([]string{"platform_number", "source_number", "shop", "platform", "paid_at", "status", "query_source", "normalized", "raw", "job_id", "indexed_at"})}).Create(&r).Error
}
func (s Service) Begin(actor domain.M, from, to string) (Job, error) {
	loc, _ := time.LoadLocation("Asia/Shanghai")
	now := time.Now().In(loc)
	a, e := time.Parse("2006-01-02", from)
	if e != nil {
		return Job{}, fmt.Errorf("invalid start date")
	}
	b, e := time.Parse("2006-01-02", to)
	if e != nil || b.Before(a) || to > now.Format("2006-01-02") {
		return Job{}, fmt.Errorf("invalid end date")
	}
	r := Job{ID: domain.ID("OIDX"), Tenant: s.Tenant, FromDate: from, ToDate: to, Date: to, HistoryBefore: now.AddDate(0, -4, 0).Format("2006-01-02"), Status: "pending", ActorID: domain.Str(actor["id"]), ActorName: domain.Str(actor["name"]), CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	e = s.DB.Transaction(func(tx *gorm.DB) error {
		// Short transaction only; no upstream I/O while holding the tenant lock.
		if e := tx.Exec("SELECT pg_advisory_xact_lock(hashtext(?))", "order-index:"+s.Tenant).Error; e != nil {
			return e
		}
		var n int64
		if e := tx.Model(&Job{}).Where("tenant=? AND status IN ?", s.Tenant, []string{"running", "pending"}).Count(&n).Error; e != nil {
			return e
		}
		if n > 0 {
			return fmt.Errorf("an order backfill already exists; resume the existing job")
		}
		return tx.Create(&r).Error
	})
	return r, e
}
func (s Service) Run(ctx context.Context, id string) error {
	lease := domain.ID("LEASE")
	now := time.Now().UTC()
	c := s.DB.Model(&Job{}).Where("id=? AND tenant=? AND status<>? AND (lease_until<? OR lease='' OR lease IS NULL)", id, s.Tenant, "completed", now).Updates(map[string]any{"status": "running", "error": "", "lease": lease, "lease_until": now.Add(5 * time.Minute), "updated_at": now})
	if c.Error != nil {
		return c.Error
	}
	if c.RowsAffected != 1 {
		return fmt.Errorf("job not found or already leased")
	}
	var j Job
	if e := s.DB.Where("id=? AND tenant=?", id, s.Tenant).First(&j).Error; e != nil {
		return e
	}
	fail := func(e error) error {
		s.DB.Model(&Job{}).Where("id=? AND lease=?", id, lease).Updates(map[string]any{"status": "failed", "error": e.Error(), "lease": "", "lease_until": time.Now().UTC(), "updated_at": time.Now().UTC()})
		return e
	}
	for j.Date >= j.FromDate {
		history := j.Date < j.HistoryBefore
		q := source.BatchQuery{Date: j.Date, History: history, Cursor: j.Cursor, Status: []string{"7", "6"}[j.Branch], CanSend: []string{"1", "2"}[j.Branch]}
		var page source.Page
		var e error
		for retry := 0; retry < 4; retry++ {
			page, e = s.Source.ReadPage(ctx, q)
			if e == nil {
				break
			}
			if ctx.Err() != nil {
				return fail(ctx.Err())
			}
			var se *source.Error
			if errors.As(e, &se) && se.Status < 500 {
				break
			}
			t := time.NewTimer(time.Duration(2<<retry) * time.Second)
			select {
			case <-t.C:
			case <-ctx.Done():
				t.Stop()
				return fail(ctx.Err())
			}
		}
		if e != nil {
			return fail(e)
		}
		if page.NextCursor != "" && page.NextCursor == j.Cursor {
			return fail(fmt.Errorf("repeated cursor; day is incomplete"))
		}
		previous := j.Cursor
		j.Cursor = page.NextCursor
		j.Pages++
		j.Rows += len(page.Orders)
		if j.Cursor == "" {
			j.Branch++
			if j.Branch == 2 {
				j.Branch = 0
				j.CompletedDays++
				d, _ := time.Parse("2006-01-02", j.Date)
				j.Date = d.AddDate(0, 0, -1).Format("2006-01-02")
			}
		}
		if j.Date < j.FromDate {
			j.Status = "completed"
			j.Lease = ""
		} else {
			j.Status = "running"
			j.Lease = lease
		}
		j.UpdatedAt = time.Now().UTC()
		j.LeaseUntil = j.UpdatedAt.Add(5 * time.Minute)
		e = s.DB.Transaction(func(tx *gorm.DB) error {
			for _, o := range page.Orders {
				if e := s.Save(tx, o, id); e != nil {
					return e
				}
			}
			// Prevent a lease takeover from advancing an obsolete worker's checkpoint.
			result := tx.Model(&Job{}).Where("id=? AND lease=? AND cursor=?", id, lease, previous).Select("*").Updates(&j)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return fmt.Errorf("backfill lease lost")
			}
			return nil
		})
		if e != nil {
			return fail(e)
		}
	}
	return nil
}
func (s Service) Records(number, shop string) ([]Record, error) {
	out := []Record{}
	q := s.DB.Where("tenant=? AND platform_number=?", s.Tenant, strings.TrimSpace(number))
	if shop != "" {
		q = q.Where("shop=?", shop)
	}
	e := q.Order("paid_at DESC, id").Limit(100).Find(&out).Error
	return out, e
}
