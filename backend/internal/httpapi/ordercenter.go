package httpapi

import (
	"context"
	"errors"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"harbor/internal/domain"
	"harbor/internal/integrations/mabang"
	"harbor/internal/orderindex"
	"harbor/internal/ordersource"
	"strconv"
	"strings"
	"time"
)

func (s *Server) orderCenterService() orderindex.Service {
	c := mabang.FromEnv()
	return orderindex.Service{DB: s.Store.DB, Source: c, Tenant: c.Key}
}
func (s *Server) orderCenterAccess(c *gin.Context) {
	s.require(c, "erp:orders:view")
	if !s.allowed(c, "erp:orders:list") && !s.allowed(c, "erp:orders:search") {
		domain.Fail("Order center requires list or search permission.", 403)
	}
}
func orderSummary(r orderindex.Record) M {
	return M{"id": r.ID, "platformNumber": r.PlatformNumber, "sourceNumber": r.SourceNumber, "shop": r.Shop, "platform": r.Platform, "paidAt": r.PaidAt, "status": r.Status, "querySource": r.QuerySource, "indexedAt": r.IndexedAt}
}
func (s *Server) orderError(c *gin.Context, e error) {
	var upstream *ordersource.Error
	if errors.As(e, &upstream) {
		c.JSON(upstream.Status, M{"error": upstream.Message, "code": upstream.Code})
		return
	}
	s.respond(c, e)
}
func (s *Server) orderCenterRoutes(api *gin.RouterGroup) {
	group := api.Group("/orders", s.orderCenterAccess)
	group.GET("", func(c *gin.Context) {
		s.require(c, "erp:orders:list")
		// Searching via the listing endpoint is never an alternative permission path.
		if c.Query("q") != "" || c.Query("number") != "" {
			s.require(c, "erp:orders:search")
			domain.Fail("Use exact order search.", 400)
		}
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		if page < 1 {
			page = 1
		}
		if page > 1000000 {
			domain.Fail("Invalid page.", 400)
		}
		sort := map[string]string{"paid_desc": "paid_at DESC, id", "paid_asc": "paid_at ASC, id", "indexed_desc": "indexed_at DESC, id"}[c.DefaultQuery("sort", "paid_desc")]
		if sort == "" {
			domain.Fail("Invalid order sort.", 400)
		}
		svc := s.orderCenterService()
		q := svc.DB.Model(&orderindex.Record{}).Where("tenant=?", svc.Tenant)
		var total int64
		if e := q.Count(&total).Error; e != nil {
			s.respond(c, e)
			return
		}
		records := []orderindex.Record{}
		if e := q.Order(sort).Limit(20).Offset((page - 1) * 20).Find(&records).Error; e != nil {
			s.respond(c, e)
			return
		}
		items := []M{}
		for _, r := range records {
			items = append(items, orderSummary(r))
		}
		c.JSON(200, M{"items": items, "page": page, "total": total, "totalPages": (total + 19) / 20})
	})
	group.GET("/status", func(c *gin.Context) {
		svc := s.orderCenterService()
		jobs := []orderindex.Job{}
		if e := svc.DB.Where("tenant=?", svc.Tenant).Order("created_at DESC").Limit(5).Find(&jobs).Error; e != nil {
			s.respond(c, e)
			return
		}
		c.JSON(200, M{"jobs": jobs})
	})
	group.GET("/search", func(c *gin.Context) {
		s.require(c, "erp:orders:search")
		number := strings.TrimSpace(c.Query("number"))
		if number == "" || len(number) > 160 || strings.ContainsAny(number, ",\r\n") {
			domain.Fail("Enter one exact platform order number.", 400)
		}
		svc := s.orderCenterService()
		records, e := svc.Records(number, strings.TrimSpace(c.Query("shop")))
		if e != nil {
			s.respond(c, e)
			return
		}
		// The index is a locator, not proof that the order is still valid.
		// Search returns summaries only, even for users without detail permission.
		if len(records) == 0 {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
			defer cancel()
			rows, e := mabang.FromEnv().Lookup(ctx, ordersource.Query{PlatformNumber: number, Shop: strings.TrimSpace(c.Query("shop")), PaidDate: c.Query("paidDate")})
			if e != nil {
				s.orderError(c, e)
				return
			}
			if e = svc.DB.Transaction(func(tx *gorm.DB) error {
				for _, o := range rows {
					if e := svc.Save(tx, o, ""); e != nil {
						return e
					}
				}
				return nil
			}); e != nil {
				s.respond(c, e)
				return
			}
			records, e = svc.Records(number, strings.TrimSpace(c.Query("shop")))
			if e != nil {
				s.respond(c, e)
				return
			}
		}
		items := []M{}
		for _, r := range records {
			items = append(items, orderSummary(r))
		}
		c.JSON(200, M{"items": items, "total": len(items)})
	})
	group.GET("/:id", func(c *gin.Context) {
		s.require(c, "erp:orders:detail")
		svc := s.orderCenterService()
		var record orderindex.Record
		if e := svc.DB.Where("id=? AND tenant=?", c.Param("id"), svc.Tenant).First(&record).Error; e != nil {
			if errors.Is(e, gorm.ErrRecordNotFound) {
				domain.Fail("Order not found.", 404)
			}
			s.respond(c, e)
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
		defer cancel()
		rows, e := mabang.FromEnv().Lookup(ctx, ordersource.Query{PlatformNumber: record.PlatformNumber, SourceNumber: record.SourceNumber, Shop: record.Shop})
		if e != nil {
			s.orderError(c, e)
			return
		}
		for _, o := range rows {
			if o.SourceNumber == record.SourceNumber && o.Shop == record.Shop {
				if e := svc.Save(svc.DB, o, record.JobID); e != nil {
					s.respond(c, e)
					return
				}
				c.JSON(200, M{"order": o, "indexedAt": record.IndexedAt, "live": true})
				return
			}
		}
		domain.Fail("Order not found.", 404)
	})
	group.POST("/backfill", func(c *gin.Context) {
		if !domain.In("admin", domain.Strings(s.actor(c)["roles"])...) {
			domain.Fail("Only administrators can run order backfills.", 403)
		}
		b := s.body(c)
		svc := s.orderCenterService()
		id := domain.Str(b["resumeId"])
		if id == "" {
			j, e := svc.Begin(s.actor(c), domain.Str(b["fromDate"]), domain.Str(b["toDate"]))
			if e != nil {
				c.JSON(409, M{"error": e.Error()})
				return
			}
			id = j.ID
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Hour)
			defer cancel()
			svc.Run(ctx, id)
		}()
		c.JSON(202, M{"id": id})
	})
}
