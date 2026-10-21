package mabang

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	source "harbor/internal/ordersource"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSignedRecentThenHistoryAndExactPlatformIdentity(t *testing.T) {
	calls := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, []byte("token"))
		mac.Write(raw)
		if r.Header.Get("Authorization") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("signature does not match actual body")
		}
		var b map[string]any
		json.Unmarshal(raw, &b)
		api := str(b["api"])
		p := b["data"].(map[string]any)
		calls = append(calls, api+":"+str(p["status"])+":"+str(p["canSend"]))
		if api == "order-get-order-list-new" {
			if p["salesRecordNumbers"] != "8821619" {
				t.Error("not querying platform trade number")
			}
			json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"hasNext": false, "data": []any{}}})
			return
		}
		if p["platformOrderId"] != "8086064201975" {
			t.Error("history must use resolved Mabang number")
		}
		rows := []any{}
		if p["canSend"] == "1" {
			rows = []any{map[string]any{"id": "original", "salesRecordNumber": "8821619", "platformOrderId": "8086064201975", "orderItem": []any{map[string]any{"id": "item", "stockSku": "MORPHO-1", "quantity": "1"}}}, map[string]any{"id": "wrong", "salesRecordNumber": "OTHER", "platformOrderId": "8086064201975", "orderItem": []any{}}}
		}
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"list": rows}})
	}))
	defer srv.Close()
	c := &Client{URL: srv.URL, Key: "key", Token: "token", HTTP: srv.Client()}
	rows, e := c.Lookup(context.Background(), source.Query{PlatformNumber: "8821619", SourceNumber: "8086064201975"})
	if e != nil {
		t.Fatal(e)
	}
	if len(rows) != 1 || rows[0].SourceID != "original" || rows[0].QuerySource != "history" || rows[0].PlatformNumber == rows[0].SourceNumber {
		t.Fatalf("wrong mapping: %+v", rows)
	}
	if len(calls) != 4 || calls[0] != "order-get-order-list-new:7:3" || calls[1] != "order-get-order-list-new:6:3" {
		t.Fatal(calls)
	}
}
func TestMalformedAndRejectedAreNotNotFound(t *testing.T) {
	for _, body := range []string{`{"code":200,"data":{}}`, `{"code":500,"message":"private upstream details"}`} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
		c := &Client{URL: srv.URL, Key: "key", Token: "token", HTTP: srv.Client()}
		_, e := c.Lookup(context.Background(), source.Query{PlatformNumber: "one"})
		if e == nil {
			t.Fatal("bad source accepted")
		}
		if e.(*source.Error).Status != 502 {
			t.Fatal(e)
		}
		srv.Close()
	}
}
func TestUnknownHistoryRequiresDateNotGuessedIdentifier(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		io.WriteString(w, `{"code":200,"data":{"data":[],"hasNext":false}}`)
	}))
	defer srv.Close()
	c := &Client{URL: srv.URL, Key: "key", Token: "token", HTTP: srv.Client()}
	_, e := c.Lookup(context.Background(), source.Query{PlatformNumber: "8821619"})
	if e == nil || e.(*source.Error).Code != "history_identifier_required" || calls != 2 {
		t.Fatal(calls, e)
	}
}
