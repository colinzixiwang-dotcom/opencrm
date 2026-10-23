package httpapi

import (
	"context"
	"crypto/sha256"
	"fmt"
	"github.com/gin-gonic/gin"
	"harbor/internal/catalog"
	"harbor/internal/domain"
	"harbor/internal/integrations/mabang"
	"harbor/internal/ruoyi"
	"time"
)

func (s *Server) catalogService() catalog.Service {
	c := mabang.FromEnv()
	return catalog.Service{DB: s.Store.DB, Source: c, Tenant: fmt.Sprintf("%x", sha256.Sum256([]byte(c.Key)))}
}
func (s *Server) catalogRoutes(api *gin.RouterGroup) {
	admin := func(c *gin.Context) {
		if !domain.In("admin", domain.Strings(s.actor(c)["roles"])...) {
			domain.Fail("Only administrators can configure the ERP catalog.", 403)
		}
	}
	api.GET("/catalog/status", func(c *gin.Context) {
		s.require(c, ruoyi.ViewPermission("product"))
		v, e := s.catalogService().Status()
		if e != nil {
			s.respond(c, e)
			return
		}
		c.JSON(200, v)
	})
	api.POST("/catalog/sync", admin, func(c *gin.Context) {
		b := s.body(c)
		svc := s.catalogService()
		r, e := svc.Begin(s.actor(c), domain.Str(b["fromDate"]))
		if e != nil {
			s.respond(c, e)
			return
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
			defer cancel()
			svc.Run(ctx, r)
		}()
		c.JSON(202, r)
	})
	api.POST("/catalog/policy", admin, func(c *gin.Context) {
		if e := s.catalogService().Configure(s.actor(c), s.body(c)); e != nil {
			s.respond(c, e)
			return
		}
		c.JSON(200, M{"ok": true})
	})
	api.POST("/catalog/rollback", admin, func(c *gin.Context) {
		if e := s.catalogService().Rollback(s.actor(c), domain.Str(s.body(c)["batchId"])); e != nil {
			s.respond(c, e)
			return
		}
		c.JSON(200, M{"ok": true})
	})
}
