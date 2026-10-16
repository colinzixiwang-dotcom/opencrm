package httpapi

import (
	"context"
	"fmt"
	"github.com/gin-gonic/gin"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func (s *Server) ticketAttachment(c *gin.Context) {
	page, _ := strconv.Atoi(c.Query("replyPage"))
	raw, e := s.Tickets.AttachmentURL(c.Request.Context(), s.actor(c), c.Param("id"), c.Query("ref"), page)
	if e != nil {
		s.ticketResponse(c, nil, e)
		return
	}
	target, e := url.Parse(raw)
	tenant, _ := url.Parse(s.Tickets.Tenant)
	if e != nil || target.Hostname() == "" {
		c.AbortWithStatus(502)
		return
	}
	host := strings.ToLower(target.Hostname())
	ownHost := strings.EqualFold(target.Hostname(), tenant.Hostname())
	if !ownHost && !strings.HasSuffix(host, ".aliyuncs.com") && !strings.HasSuffix(host, ".amazonaws.com") && !strings.HasSuffix(host, ".udesk.cn") && !strings.HasSuffix(host, ".udeskglobal.com") {
		c.JSON(502, M{"error": "Attachment storage host is not supported."})
		return
	}
	// Loopback is allowed only for an explicitly configured loopback tenant (tests).
	allowLoopback := ownHost && net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		hostname, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, hostname)
		if err != nil {
			return nil, err
		}
		for _, addr := range addresses {
			if !allowLoopback && (!addr.IP.IsGlobalUnicast() || addr.IP.IsPrivate() || addr.IP.IsLoopback() || addr.IP.IsLinkLocalUnicast()) {
				return nil, fmt.Errorf("private attachment address")
			}
		}
		var last error
		for _, addr := range addresses {
			conn, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(addr.IP.String(), port))
			if err == nil {
				return conn, nil
			}
			last = err
		}
		if last == nil {
			last = fmt.Errorf("attachment host unavailable")
		}
		return nil, last
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, _ := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, raw, nil)
	response, e := client.Do(req)
	if e != nil {
		c.JSON(502, M{"error": "Attachment could not be loaded from Udesk storage."})
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.JSON(502, M{"error": "Attachment is unavailable from Udesk storage."})
		return
	}
	const maxAttachment = 25 * 1024 * 1024
	body, e := io.ReadAll(io.LimitReader(response.Body, maxAttachment+1))
	if e != nil || len(body) > maxAttachment {
		c.AbortWithStatus(http.StatusBadGateway)
		return
	}
	mime := strings.Split(response.Header.Get("Content-Type"), ";")[0]
	if mime == "" || mime == "application/octet-stream" {
		mime = http.DetectContentType(body)
	}
	if !strings.HasPrefix(mime, "image/") && !strings.HasPrefix(mime, "video/") && !strings.HasPrefix(mime, "audio/") && mime != "application/pdf" {
		c.JSON(415, M{"error": "Attachment preview is not supported for this file type."})
		return
	}
	c.Header("X-Frame-Options", "SAMEORIGIN")
	c.Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'")
	c.Header("Cache-Control", "private, no-store")
	c.Data(200, mime, body)
}
