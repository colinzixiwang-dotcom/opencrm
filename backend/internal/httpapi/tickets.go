package httpapi

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"github.com/gin-gonic/gin"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"harbor/internal/ruoyi"
	source "harbor/internal/supportsource"
	"harbor/internal/tickets"
	"net/http"
	"strconv"
	"strings"
)

func (s *Server) ticketResponse(c *gin.Context, v any, e error) {
	if e != nil {
		var d *domain.Error
		if errors.As(e, &d) {
			s.respond(c, e)
		} else {
			status, code := 502, "source_error"
			var upstream *source.Error
			if errors.As(e, &upstream) {
				code = "source_" + string(upstream.Kind)
				switch upstream.Kind {
				case source.NotFound:
					status = 404
				case source.InvalidQuery:
					status = 400
				case source.Unavailable, source.RateLimited:
					status = 503
				}
			}
			if errors.Is(e, context.DeadlineExceeded) {
				status = 504
				code = "source_timeout"
			}
			c.JSON(status, M{"error": e.Error(), "code": code, "lastSyncAt": s.Tickets.LastSync(s.actor(c))})
		}
		return
	}
	if strings.Contains(c.GetHeader("Accept"), "application/vnd.morpho.support.v2+json") || c.Query("contract") == "2" {
		c.Header("Vary", "Accept")
		c.JSON(200, source.PublicResponse(v))
	} else {
		c.Header("Vary", "Accept")
		c.JSON(200, udesk.CompatibilityResponse(v))
	}
}
func (s *Server) ticketRoutes(api *gin.RouterGroup) {
	api.GET("/integrations/udesk/ticket-scope", func(c *gin.Context) {
		v, e := s.Tickets.ScopeConfig(c.Request.Context(), s.actor(c))
		s.ticketResponse(c, v, e)
	})
	api.POST("/integrations/udesk/ticket-scope", func(c *gin.Context) {
		v, e := s.Tickets.SaveScope(c.Request.Context(), s.actor(c), s.body(c))
		s.ticketResponse(c, v, e)
	})
	api.POST("/integrations/udesk/ticket-scope/preview", func(c *gin.Context) {
		v, e := s.Tickets.PreviewScope(c.Request.Context(), s.actor(c), s.body(c))
		s.ticketResponse(c, v, e)
	})
	api.POST("/integrations/udesk/ticket-scope/groups/sync", func(c *gin.Context) {
		v, e := s.Tickets.SyncGroups(c.Request.Context(), s.actor(c))
		s.ticketResponse(c, v, e)
	})

	view := func(c *gin.Context) { s.require(c, ruoyi.ViewPermission("service")); c.Next() }
	t := api.Group("/tickets", view)
	t.GET("", func(c *gin.Context) {
		size := 20
		if q := c.Query("limit"); q != "" {
			n, e := strconv.Atoi(q)
			if e != nil {
				domain.Fail("Invalid page size.")
			}
			size = n
		}
		v, e := s.Tickets.Search(c.Request.Context(), s.actor(c), c.Query("filterId"), c.Query("cursor"), size, c.Query("sort"), c.Query("q"), tickets.ListSelection{Assignment: c.Query("assignment"), Status: c.Query("status")})
		s.ticketResponse(c, v, e)
	})
	t.GET("/metadata", func(c *gin.Context) {
		v, e := s.Tickets.Metadata(c.Request.Context(), s.actor(c), c.Query("refresh") == "true")
		s.ticketResponse(c, v, e)
	})
	t.GET("/lookup", func(c *gin.Context) {
		number := domain.Required(c.Query("number"), "Ticket number", 160)
		v, e := s.Tickets.Detail(c.Request.Context(), s.actor(c), number, true)
		s.ticketResponse(c, v, e)
	})
	t.GET("/:id", func(c *gin.Context) {
		v, e := s.Tickets.Detail(c.Request.Context(), s.actor(c), c.Param("id"), false)
		s.ticketResponse(c, v, e)
	})
	t.GET("/:id/attachment", s.ticketAttachment)
	t.GET("/:id/replies", func(c *gin.Context) {
		page := 1
		if q := c.Query("page"); q != "" {
			n, e := strconv.Atoi(q)
			if e != nil {
				domain.Fail("Invalid replies page.")
			}
			page = n
		}
		v, e := s.Tickets.Replies(c.Request.Context(), s.actor(c), c.Param("id"), page)
		s.ticketResponse(c, v, e)
	})
	t.POST("/:id/drafts", func(c *gin.Context) {
		s.require(c, ruoyi.Permission("rma.create"))
		v, e := s.Tickets.SaveDraft(c.Request.Context(), s.actor(c), c.Param("id"), s.body(c))
		s.ticketResponse(c, v, e)
	})
	api.GET("/intake-drafts", func(c *gin.Context) {
		s.require(c, ruoyi.Permission("rma.create"))
		v, e := s.Tickets.Drafts(s.actor(c))
		s.ticketResponse(c, M{"items": v}, e)
	})
	api.GET("/intake-drafts/:id", func(c *gin.Context) {
		s.require(c, ruoyi.Permission("rma.create"))
		v, e := s.Tickets.Draft(c.Request.Context(), s.actor(c), c.Param("id"))
		s.ticketResponse(c, v, e)
	})
	api.GET("/integrations/udesk/accounts", func(c *gin.Context) { v, e := s.Tickets.Accounts(s.actor(c)); s.ticketResponse(c, v, e) })
	api.POST("/integrations/udesk/accounts/sync", func(c *gin.Context) {
		b := s.body(c)
		v, e := s.Tickets.SyncAccounts(c.Request.Context(), s.actor(c), domain.Bool(b["resetPasswords"]))
		s.ticketResponse(c, v, e)
	})
	api.POST("/integrations/udesk/accounts/configure", func(c *gin.Context) {
		if !domain.In("admin", domain.Strings(s.actor(c)["roles"])...) {
			c.JSON(403, M{"error": "Only administrators can configure ticket group membership."})
			return
		}
		c.JSON(410, M{"error": "Individual ticket scopes have been replaced by shared Morpho group membership."})
	})
	api.GET("/integrations/udesk/runs/:id", func(c *gin.Context) { v, e := s.Tickets.AuditRun(s.actor(c), c.Param("id")); s.ticketResponse(c, v, e) })
}
func (s *Server) exportTickets(c *gin.Context) {
	s.require(c, ruoyi.ViewPermission("service"))
	v, e := s.Tickets.Search(c.Request.Context(), s.actor(c), c.Query("filterId"), c.Query("cursor"), 100, c.Query("sort"), c.Query("q"), tickets.ListSelection{Assignment: c.Query("assignment"), Status: c.Query("status")})
	if e != nil {
		s.ticketResponse(c, nil, e)
		return
	}
	c.Header("Content-Disposition", "attachment; filename=\"udesk-ticket-page.csv\"")
	c.Header("X-Next-Cursor", domain.Str(v["nextCursor"]))
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Status(http.StatusOK)
	w := csv.NewWriter(c.Writer)
	defer w.Flush()
	canonical := c.Query("contract") == "2"
	header := []string{"id", "number", "subject", "status", "assigneeName", "fetchedAt", "ticket_json"}
	if !canonical {
		header = []string{"id", "field_num", "subject", "status", "assignee_name", "fetched_at", "source_json"}
	}
	w.Write(header)
	for _, item := range domain.Rows(v, "items") {
		ticket := item["ticket"].(source.Ticket)
		raw, _ := json.Marshal(ticket)
		if !canonical {
			legacy := udesk.CompatibilityResponse(item).(M)
			raw, _ = json.Marshal(legacy["source"])
		}
		cells := []string{ticket.ID, ticket.Number, ticket.Subject, ticket.Status, ticket.AssigneeName, domain.Str(item["fetchedAt"]), string(raw)}
		for i, cell := range cells {
			if len(cell) > 0 && (cell[0] == '=' || cell[0] == '+' || cell[0] == '-' || cell[0] == '@') {
				cells[i] = "'" + cell
			}
		}
		w.Write(cells)
	}
}
