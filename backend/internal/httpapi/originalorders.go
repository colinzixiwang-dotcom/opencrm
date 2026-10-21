package httpapi

import (
	"context"
	"errors"
	"github.com/gin-gonic/gin"
	"harbor/internal/domain"
	"harbor/internal/integrations/mabang"
	"harbor/internal/ordersource"
	"harbor/internal/originalorders"
	"harbor/internal/ruoyi"
	"time"
)

func (s *Server) orderRoutes(api *gin.RouterGroup) {
	for _, operation := range []string{"lookup", "confirm", "manual"} {
		op := operation
		api.POST("/original-orders/"+op, func(c *gin.Context) {
			s.require(c, ruoyi.Permission("rma.create"))
			b := s.body(c)
			actor := s.actor(c)
			if _, e := s.Tickets.Draft(c.Request.Context(), actor, domain.Str(b["draftId"])); e != nil {
				s.respond(c, e)
				return
			}
			state, e := s.Store.State()
			if e != nil {
				s.respond(c, e)
				return
			}
			client := mabang.FromEnv()
			svc := originalorders.Service{DB: s.Store.DB, Source: client, Tenant: client.Key}
			var result M
			if op == "lookup" {
				ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
				defer cancel()
				result, e = svc.Lookup(ctx, actor, state, b)
			} else if op == "manual" {
				result, e = svc.Manual(actor, state, b)
			} else {
				result, e = svc.Confirm(actor, state, b)
			}
			if e != nil {
				var upstream *ordersource.Error
				if errors.As(e, &upstream) {
					c.JSON(upstream.Status, M{"error": upstream.Message, "code": upstream.Code})
					return
				}
				s.respond(c, e)
				return
			}
			c.JSON(200, result)
		})
	}
}

func (s *Server) assessOriginalOrder(c *gin.Context, b, state M) error {
	if domain.Str(b["draftId"]) == "" {
		return nil
	}
	if _, e := s.Tickets.Draft(c.Request.Context(), s.actor(c), domain.Str(b["draftId"])); e != nil {
		return e
	}
	return originalorders.Bind(s.Store.DB, s.actor(c), state, b)
}
