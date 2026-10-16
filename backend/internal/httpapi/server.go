package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"harbor/internal/domain"
	"harbor/internal/integrations/udesk"
	"harbor/internal/persistence"
	"harbor/internal/ruoyi"
	"harbor/internal/store"
	"harbor/internal/support"
	"harbor/internal/tickets"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type M = domain.M
type Server struct {
	Store    *store.Store
	Tickets  *tickets.Service
	Dist     string
	mu       sync.Mutex
	attempts map[string][]time.Time
}

func New(s *store.Store, dist string) *Server {
	return &Server{Store: s, Tickets: tickets.New(s.DB, udesk.FromEnv()), Dist: dist, attempts: map[string][]time.Time{}}
}
func (s *Server) Router() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		defer func() {
			if v := recover(); v != nil {
				if e, ok := v.(*domain.Error); ok {
					c.AbortWithStatusJSON(e.Status, M{"error": e.Message})
				} else {
					fmt.Fprintln(os.Stderr, v)
					c.AbortWithStatusJSON(500, M{"error": "An unexpected server error occurred."})
				}
			}
		}()
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Referrer-Policy", "same-origin")
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		if !regexp.MustCompile(`^(127\.0\.0\.1|localhost)(:\d+)?$`).MatchString(c.Request.Host) {
			domain.Fail("Invalid host.", 403)
		}
		if c.Request.Method == "POST" {
			if origin := c.GetHeader("Origin"); origin != "" && origin != "http://"+c.Request.Host {
				domain.Fail("Cross-origin writes are not permitted.", 403)
			}
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1048576)
		}
		c.Next()
	})
	r.GET("/api/health", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		pool, e := s.Store.DB.DB()
		if e != nil || pool.PingContext(ctx) != nil {
			c.JSON(503, M{"ok": false, "storage": "postgresql"})
			return
		}
		c.JSON(200, M{"ok": true, "version": "3.0.0", "backend": "Go + Gin", "frontend": "React", "permissions": "RuoYi-Go adapted RBAC", "storage": "postgresql"})
	})
	r.POST("/api/login", s.login)
	api := r.Group("/api")
	api.Use(s.auth)
	s.ticketRoutes(api)
	api.GET("/bootstrap", s.bootstrap)
	api.GET("/rmas/:id", func(c *gin.Context) {
		state, e := s.Store.State()
		if e != nil {
			s.respond(c, e)
			return
		}
		c.JSON(200, support.Get(state, s.actor(c), c.Param("id")))
	})
	api.POST("/logout", s.logout)
	api.POST("/action", s.action)
	api.POST("/rma-assessment", func(c *gin.Context) {
		if !(ruoyi.Service{DB: s.Store.DB}).Allowed(s.user(c).UserID, "rma.create") {
			domain.Fail("Your role does not permit this action.", 403)
		}
		b := s.body(c)
		state, e := s.Store.State()
		if e != nil {
			s.respond(c, e)
			return
		}
		c.JSON(200, support.Assess(state, b, time.Now()))
	})
	api.GET("/report", s.report)
	api.GET("/export/:collection", s.export)
	api.GET("/backup", s.backup)
	api.GET("/getInfo", func(c *gin.Context) {
		actor := s.actor(c)
		c.JSON(200, M{"code": 200, "user": actor, "roles": actor["roles"], "permissions": actor["permissionCodes"]})
	})
	api.GET("/getRouters", func(c *gin.Context) { c.JSON(200, M{"code": 200, "data": s.visibleMenus(c)}) })
	r.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.JSON(404, M{"error": "API route not found."})
			return
		}
		if c.Request.Method != "GET" && c.Request.Method != "HEAD" {
			c.Status(405)
			return
		}
		name := strings.TrimPrefix(filepath.Clean(c.Request.URL.Path), "/")
		if name == "." || name == "" {
			name = "index.html"
		}
		path := filepath.Join(s.Dist, name)
		if _, e := os.Stat(path); e != nil {
			if strings.HasPrefix(name, "assets/") {
				c.Status(404)
				return
			}
			path = filepath.Join(s.Dist, "index.html")
		}
		c.File(path)
	})
	return r
}
func (s *Server) body(c *gin.Context) M {
	if !strings.HasPrefix(c.ContentType(), "application/json") {
		domain.Fail("Use application/json.", 415)
	}
	var b M
	if e := c.ShouldBindJSON(&b); e != nil || b == nil {
		domain.Fail("Invalid JSON request.")
	}
	return b
}
func (s *Server) respond(c *gin.Context, e error) {
	if e == nil {
		return
	}
	if x, ok := e.(*domain.Error); ok {
		c.AbortWithStatusJSON(x.Status, M{"error": x.Message})
	} else {
		fmt.Fprintln(os.Stderr, e)
		c.AbortWithStatusJSON(500, M{"error": "An unexpected server error occurred."})
	}
}
func (s *Server) login(c *gin.Context) {
	b := s.body(c)
	email := strings.ToLower(strings.TrimSpace(domain.Str(b["email"])))
	password := domain.Str(b["password"])
	if len(password) > 200 {
		domain.Fail("Invalid credentials.", 401)
	}
	ip := c.ClientIP()
	s.mu.Lock()
	recent := []time.Time{}
	for _, t := range s.attempts[ip] {
		if time.Since(t) < time.Minute {
			recent = append(recent, t)
		}
	}
	blocked := len(recent) >= 15
	s.attempts[ip] = recent
	s.mu.Unlock()
	if blocked {
		domain.Fail("Too many sign-in attempts. Try again in one minute.", 429)
	}
	var u ruoyi.SysUser
	if s.Store.DB.Where("email=? AND status='0'", email).First(&u).Error != nil || !domain.VerifyPassword(password, u.Password) {
		s.mu.Lock()
		s.attempts[ip] = append(s.attempts[ip], time.Now())
		s.mu.Unlock()
		domain.Fail("Email or password is incorrect.", 401)
	}
	s.mu.Lock()
	delete(s.attempts, ip)
	s.mu.Unlock()
	tokenBytes := make([]byte, 32)
	if _, e := rand.Read(tokenBytes); e != nil {
		s.respond(c, e)
		return
	}
	token := hex.EncodeToString(tokenBytes)
	s.Store.DB.Exec(persistence.SQL(s.Store.DB, "DELETE FROM sessions WHERE expires<=?"), time.Now().UnixMilli())
	if e := s.Store.DB.Exec(persistence.SQL(s.Store.DB, "INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)"), store.Digest(token), u.UserID, time.Now().Add(12*time.Hour).UnixMilli()).Error; e != nil {
		s.respond(c, e)
		return
	}
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie("harbor_session", token, 43200, "/", "", false, true)
	c.JSON(200, M{"user": (ruoyi.Service{DB: s.Store.DB}).Actor(u)})
}
func (s *Server) auth(c *gin.Context) {
	token, e := c.Cookie("harbor_session")
	if e != nil {
		domain.Fail("Sign in to continue.", 401)
	}
	var session struct{ UserID string }
	query := s.Store.DB.Raw(persistence.SQL(s.Store.DB, "SELECT user_id FROM sessions WHERE hash=? AND expires>?"), store.Digest(token), time.Now().UnixMilli()).Scan(&session)
	if query.Error != nil {
		s.respond(c, query.Error)
		return
	}
	var u ruoyi.SysUser
	if session.UserID == "" || s.Store.DB.First(&u, "user_id=? AND status='0'", session.UserID).Error != nil {
		domain.Fail("Your session has expired. Sign in again.", 401)
	}
	c.Set("user", u)
	c.Next()
}
func (s *Server) user(c *gin.Context) ruoyi.SysUser { return c.MustGet("user").(ruoyi.SysUser) }
func (s *Server) actor(c *gin.Context) M            { return (ruoyi.Service{DB: s.Store.DB}).Actor(s.user(c)) }
func (s *Server) allowed(c *gin.Context, permission string) bool {
	return (ruoyi.Service{DB: s.Store.DB}).HasPermi(s.user(c).UserID, permission)
}
func (s *Server) require(c *gin.Context, permissions ...string) {
	for _, p := range permissions {
		if s.allowed(c, p) {
			return
		}
	}
	domain.Fail("Your role does not permit this view.", 403)
}
func (s *Server) visibleMenus(c *gin.Context) []ruoyi.SysMenu {
	out := []ruoyi.SysMenu{}
	for _, m := range (ruoyi.Service{DB: s.Store.DB}).Menus(s.user(c).UserID) {
		if m.MenuType != "F" && m.Visible == "0" {
			out = append(out, m)
		}
	}
	return out
}
func (s *Server) bootstrap(c *gin.Context) {
	state, e := s.Store.State()
	if e != nil {
		s.respond(c, e)
		return
	}
	actor := s.actor(c)
	state["currentUser"] = actor
	state["permissions"] = actor["permissions"]
	state["permissionCodes"] = actor["permissionCodes"]
	state["menus"] = s.visibleMenus(c)
	state["tickets"] = []M{}
	state["report"] = domain.Report(state, "", "", "")
	svc := ruoyi.Service{DB: s.Store.DB}
	users := []M{}
	if s.allowed(c, "system:user:list") || s.allowed(c, "system:user:edit") {
		rows := []ruoyi.SysUser{}
		s.Store.DB.Find(&rows)
		for _, u := range rows {
			v := svc.Actor(u)
			ids := []int64{}
			s.Store.DB.Model(&ruoyi.UserRole{}).Where("user_id=?", u.UserID).Pluck("role_id", &ids)
			assigned := []ruoyi.SysRole{}
			s.Store.DB.Table(persistence.SQL(s.Store.DB, "sys_role r")).Select("r.*").Joins(persistence.SQL(s.Store.DB, "JOIN sys_user_role ur ON ur.role_id=r.role_id")).Where("ur.user_id=?", u.UserID).Order("r.role_sort,r.role_id").Scan(&assigned)
			keys := []string{}
			for _, r := range assigned {
				keys = append(keys, r.RoleKey)
			}
			v["roles"] = keys
			if len(keys) > 0 {
				v["role"] = keys[0]
			}
			v["roleIds"] = ids
			users = append(users, v)
		}
	}
	state["users"] = users
	if s.allowed(c, "system:role:edit") {
		state["roles"] = svc.RoleData()
	} else {
		state["roles"] = []M{}
	}
	if s.allowed(c, "system:role:edit") || s.allowed(c, "system:menu:edit") {
		state["permissionMenus"] = svc.AllMenus()
	} else {
		state["permissionMenus"] = []M{}
	}
	// Apply data visibility on the server, including direct bootstrap requests.
	for col, module := range map[string]string{"sales": "sales", "purchases": "purchase", "suppliers": "purchase", "shipments": "logistics", "expenses": "finance", "payments": "finance", "campaigns": "advertising", "tickets": "service", "tasks": "tools", "audit": "settings"} {
		if !s.allowed(c, ruoyi.ViewPermission(module)) {
			state[col] = []M{}
		}
	}
	if !s.allowed(c, ruoyi.ViewPermission("warehouse")) && !s.allowed(c, ruoyi.ViewPermission("fba")) {
		state["stocks"] = []M{}
		state["movements"] = []M{}
	}
	if !s.allowed(c, ruoyi.ViewPermission("home")) && !s.allowed(c, ruoyi.ViewPermission("statistics")) && !s.allowed(c, ruoyi.ViewPermission("finance")) {
		state["report"] = domain.Report(M{"settings": state["settings"]}, "", "", "")
	}
	c.JSON(200, support.Public(state, actor))
}
func (s *Server) logout(c *gin.Context) {
	token, _ := c.Cookie("harbor_session")
	s.Store.DB.Exec(persistence.SQL(s.Store.DB, "DELETE FROM sessions WHERE hash=?"), store.Digest(token))
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie("harbor_session", "", -1, "/", "", false, true)
	c.JSON(200, M{"ok": true})
}
func (s *Server) action(c *gin.Context) {
	b := s.body(c)
	payload, ok := b["payload"].(map[string]any)
	if !ok {
		domain.Fail("An action and payload are required.")
	}
	if domain.Str(b["action"]) == "rma.create" && domain.Str(payload["draftId"]) != "" {
		if e := s.Tickets.ValidateSubmission(c.Request.Context(), s.actor(c), domain.Str(payload["draftId"])); e != nil {
			s.respond(c, e)
			return
		}
	}
	key := c.GetHeader("Idempotency-Key")
	if len(key) > 150 || (key != "" && !regexp.MustCompile(`^[-a-zA-Z0-9]+$`).MatchString(key)) {
		domain.Fail("Invalid idempotency key.")
	}
	r, e := s.Store.Apply(s.user(c).UserID, domain.Str(b["action"]), payload, key)
	if e != nil {
		s.respond(c, e)
		return
	}
	c.JSON(200, r)
}
func (s *Server) report(c *gin.Context) {
	s.require(c, ruoyi.ViewPermission("home"), ruoyi.ViewPermission("statistics"), ruoyi.ViewPermission("finance"))
	from, to, channel := c.Query("from"), c.Query("to"), c.DefaultQuery("channel", "all")
	for _, v := range []string{from, to} {
		if v != "" {
			if _, e := time.Parse("2006-01-02", v); e != nil {
				domain.Fail("Invalid reporting date range.")
			}
		}
	}
	if from != "" && to != "" && from > to {
		domain.Fail("Invalid reporting date range.")
	}
	if !domain.In(channel, "all", "Amazon", "Shopify", "Direct", "Wholesale") {
		domain.Fail("Unknown channel.")
	}
	state, e := s.Store.State()
	if e != nil {
		s.respond(c, e)
		return
	}
	c.JSON(200, domain.Report(state, from, to, channel))
}
func (s *Server) export(c *gin.Context) {
	col := c.Param("collection")
	if col == "tickets" {
		s.exportTickets(c)
		return
	}
	module := map[string]string{"products": "product", "suppliers": "purchase", "warehouses": "warehouse", "purchases": "purchase", "sales": "sales", "shipments": "logistics", "stocks": "warehouse", "movements": "warehouse", "payments": "finance", "expenses": "finance", "campaigns": "advertising", "tickets": "service", "tasks": "tools", "audit": "settings", "rmas": "rma", "rmaTasks": "rmatasks", "supportOrders": "supportorders", "serials": "serials", "benefitHistory": "benefits"}[col]
	if module == "" {
		domain.Fail("Unknown export.", 404)
	}
	s.require(c, ruoyi.ViewPermission(module))
	state, e := s.Store.State()
	if e != nil {
		s.respond(c, e)
		return
	}
	state = support.Public(state, s.actor(c))
	rows := domain.Rows(state, col)
	set := map[string]bool{}
	for _, row := range rows {
		for k := range row {
			set[k] = true
		}
	}
	keys := []string{}
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"harbor-%s.csv\"", col))
	c.Writer.WriteString("\uFEFF")
	w := csv.NewWriter(c.Writer)
	w.UseCRLF = true
	w.Write(keys)
	for _, row := range rows {
		cells := []string{}
		for _, k := range keys {
			v := row[k]
			value := ""
			switch x := v.(type) {
			case nil:
			case string:
				value = x
			case float64:
				value = strconv.FormatFloat(x, 'f', -1, 64)
			case int64:
				value = strconv.FormatInt(x, 10)
			default:
				b, _ := json.Marshal(v)
				value = string(b)
			}
			if len(value) > 0 && strings.ContainsRune("=+-@\t\r", rune(value[0])) {
				value = "'" + value
			}
			cells = append(cells, value)
		}
		w.Write(cells)
	}
	w.Flush()
}
func (s *Server) backup(c *gin.Context) {
	s.require(c, "system:role:edit")
	if !support.Admin(s.actor(c)) {
		domain.Fail("Only administrators may export a complete business snapshot.", 403)
	}
	state, e := s.Store.State()
	if e != nil {
		s.respond(c, e)
		return
	}
	delete(state, "users")
	c.Header("Content-Disposition", "attachment; filename=\"harbor-backup.json\"")
	c.JSON(200, M{"format": "harbor-business-snapshot-v2", "exportedAt": domain.Now(), "state": state})
}
