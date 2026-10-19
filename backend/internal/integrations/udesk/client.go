package udesk

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	source "harbor/internal/supportsource"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type M = map[string]any
type API interface {
	Get(context.Context, string, url.Values) (M, error)
}
type Client struct {
	Base, Email, Token string
	HTTP               *http.Client
	mu                 sync.Mutex
	next               time.Time
	foreground         int
}

// LoadEnv only supplies missing variables; credentials never reach the frontend.
func LoadEnv(path string) error {
	f, e := os.Open(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if len(v) >= 2 && ((v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'')) {
			v = v[1 : len(v)-1]
		}
		if _, exists := os.LookupEnv(k); !exists {
			os.Setenv(k, v)
		}
	}
	return scanner.Err()
}
func FromEnv() *Client {
	return &Client{Base: strings.TrimRight(os.Getenv("UDESK_BASE_URL"), "/"), Email: os.Getenv("UDESK_ADMIN_EMAIL"), Token: os.Getenv("UDESK_OPEN_API_TOKEN"), HTTP: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (c *Client) Tenant() string   { return c.Base }
func (c *Client) Configured() bool { return c.Base != "" && c.Email != "" && c.Token != "" }
func (c *Client) Get(ctx context.Context, path string, params url.Values) (M, error) {
	if !c.Configured() {
		return nil, &source.Error{Kind: source.Rejected, Message: "Udesk connection is not configured."}
	}
	base, e := url.Parse(c.Base)
	if e != nil || base.Host == "" || (base.Scheme != "https" && base.Scheme != "http") {
		return nil, invalid("Invalid Udesk base URL.")
	}
	for attempt := 0; attempt < 3; attempt++ {
		if e = c.acquire(ctx); e != nil {
			return nil, e
		}
		nonce := make([]byte, 16)
		if _, e = rand.Read(nonce); e != nil {
			return nil, e
		}
		stamp := strconv.FormatInt(time.Now().Unix(), 10)
		n := hex.EncodeToString(nonce)
		sum := sha256.Sum256([]byte(strings.Join([]string{c.Email, c.Token, stamp, n, "v2"}, "&")))
		q := url.Values{}
		for k, v := range params {
			q[k] = append([]string{}, v...)
		}
		q.Set("email", c.Email)
		q.Set("timestamp", stamp)
		q.Set("nonce", n)
		q.Set("sign_version", "v2")
		q.Set("sign", hex.EncodeToString(sum[:]))
		endpoint := strings.TrimRight(c.Base, "/")
		if !strings.HasSuffix(endpoint, "/open_api_v1") {
			endpoint += "/open_api_v1"
		}
		endpoint += "/" + strings.TrimLeft(path, "/") + "?" + q.Encode()
		req, e := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
		if e != nil {
			return nil, invalid("Invalid Udesk request.")
		}
		req.Header.Set("Accept", "application/json")
		response, e := c.HTTP.Do(req)
		if e != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, &source.Error{Kind: source.Unavailable, Message: "Udesk request failed or timed out."}
		}
		data, e := io.ReadAll(io.LimitReader(response.Body, 16<<20))
		response.Body.Close()
		if (response.StatusCode == 429 || response.StatusCode >= 500) && attempt < 2 {
			timer := time.NewTimer(time.Duration(attempt+1) * 2 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
			continue
		}
		if response.StatusCode != 200 {
			kind := source.Rejected
			switch {
			case response.StatusCode == 404:
				kind = source.NotFound
			case response.StatusCode == 429:
				kind = source.RateLimited
			case response.StatusCode >= 500:
				kind = source.Unavailable
			}
			return nil, &source.Error{Kind: kind, Message: fmt.Sprintf("Udesk returned HTTP %d.", response.StatusCode)}
		}
		if e != nil {
			return nil, invalid("Cannot read Udesk response.")
		}
		var out M
		if json.Unmarshal(data, &out) != nil {
			return nil, invalid("Invalid Udesk response.")
		}
		if out["code"] != float64(1000) {
			return nil, &source.Error{Kind: source.Rejected, Message: fmt.Sprintf("Udesk rejected the request (code %v).", out["code"])}
		}
		return out, nil
	}
	return nil, &source.Error{Kind: source.Unavailable, Message: "Udesk is temporarily unavailable."}
}
