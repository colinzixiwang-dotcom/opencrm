package udesk

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	source "harbor/internal/supportsource"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSigningEncodingAndNoCredentialErrors(t *testing.T) {
	seen := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.URL.Path != "/open_api_v1/tickets/detail" || q.Get("num") != "#848" {
			t.Error("incorrect API path or encoded number")
		}
		expected := sha256.Sum256([]byte(strings.Join([]string{"admin@example.com", "test-token", q.Get("timestamp"), q.Get("nonce"), "v2"}, "&")))
		if q.Get("sign") != hex.EncodeToString(expected[:]) {
			t.Error("bad signature")
		}
		if seen[q.Get("nonce")] {
			t.Error("nonce reused")
		}
		seen[q.Get("nonce")] = true
		fmt.Fprint(w, `{"code":1000,"ticket":{"id":848}}`)
	}))
	defer server.Close()
	c := &Client{Base: server.URL, Email: "admin@example.com", Token: "test-token", HTTP: server.Client()}
	for i := 0; i < 2; i++ {
		if _, e := c.Get(context.Background(), "tickets/detail", url.Values{"num": {"#848"}}); e != nil {
			t.Fatal(e)
		}
	}
	server.Close()
	_, e := c.Get(context.Background(), "tickets/detail", nil)
	if e == nil || strings.Contains(e.Error(), "test-token") || strings.Contains(e.Error(), "sign=") {
		t.Fatal("unsafe client error", e)
	}
}
func TestLoadEnvPreservesProcessSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	os.WriteFile(path, []byte("UDESK_TEST_VALUE='from-file'\nUDESK_TEST_EXISTING=wrong\n"), 0600)
	t.Setenv("UDESK_TEST_EXISTING", "correct")
	os.Unsetenv("UDESK_TEST_VALUE")
	t.Cleanup(func() { os.Unsetenv("UDESK_TEST_VALUE") })
	if e := LoadEnv(path); e != nil {
		t.Fatal(e)
	}
	if os.Getenv("UDESK_TEST_VALUE") != "from-file" || os.Getenv("UDESK_TEST_EXISTING") != "correct" {
		t.Fatal("dotenv precedence")
	}
}

func TestSourceErrorsAreClassifiedWithoutCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		fmt.Fprint(w, "sensitive provider error body")
	}))
	defer server.Close()
	c := &Client{Base: server.URL, Email: "admin@example.com", Token: "secret", HTTP: server.Client()}
	_, err := c.Get(context.Background(), "tickets/detail", nil)
	var upstream *source.Error
	if !errors.As(err, &upstream) || upstream.Kind != source.NotFound || strings.Contains(err.Error(), "sensitive") || strings.Contains(err.Error(), "secret") {
		t.Fatal(err)
	}
}
func TestInteractiveBudgetOvertakesBackgroundAndCancellation(t *testing.T) {
	c := &Client{next: time.Now().Add(100 * time.Millisecond)}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan string, 2)
	go func() {
		if c.acquire(source.Background(ctx)) == nil {
			done <- "background"
		}
	}()
	go func() {
		if c.acquire(ctx) == nil {
			done <- "foreground"
		}
	}()
	select {
	case first := <-done:
		if first != "foreground" {
			t.Fatal("background took interactive slot")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	if !errors.Is(c.acquire(cancelled), context.Canceled) {
		t.Fatal("canceled wait granted a slot")
	}
	select {
	case second := <-done:
		if second != "background" {
			t.Fatal(second)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
