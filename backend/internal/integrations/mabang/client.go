// Package mabang is a read-only anti-corruption layer. No fulfillment commands exist here.
package mabang

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	source "harbor/internal/ordersource"
	"io"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

type Client struct {
	URL, Key, Token string
	HTTP            *http.Client
}

var gate = make(chan struct{}, 1)
var rateMu sync.Mutex
var lastRequest time.Time

func FromEnv() *Client {
	endpoint := "https://gwapi.mabangerp.com/api/v2"
	// Fixture routing is available only in isolated PostgreSQL test namespaces.
	if os.Getenv("PG_TEST_NAMESPACE") != "" && os.Getenv("MABANG_TEST_URL") != "" {
		endpoint = os.Getenv("MABANG_TEST_URL")
	}
	return &Client{URL: endpoint, Key: os.Getenv("MABANG_APPKEY"), Token: os.Getenv("MABANG_APPTOKEN"), HTTP: &http.Client{Timeout: 25 * time.Second}}
}
func failure(code, msg string, status int) error {
	return &source.Error{Code: code, Message: msg, Status: status}
}
func str(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func (c *Client) call(ctx context.Context, api string, params map[string]string) (map[string]any, error) {
	if c.Key == "" || c.Token == "" {
		return nil, failure("not_configured", "Mabang credentials are not configured.", 503)
	}
	select {
	case gate <- struct{}{}:
		defer func() { <-gate }()
	case <-ctx.Done():
		return nil, failure("timeout", "Order lookup timed out. Please retry.", 504)
	}
	rateMu.Lock()
	delay := time.Until(lastRequest.Add(time.Second))
	rateMu.Unlock()
	if delay > 0 {
		t := time.NewTimer(delay)
		defer t.Stop()
		select {
		case <-t.C:
		case <-ctx.Done():
			return nil, failure("timeout", "Order lookup timed out. Please retry.", 504)
		}
	}
	rateMu.Lock()
	lastRequest = time.Now()
	rateMu.Unlock()
	body, _ := json.Marshal(map[string]any{"api": api, "appkey": c.Key, "data": params, "timestamp": strconv.FormatInt(time.Now().Unix(), 10), "version": "1"})
	sig := hmac.New(sha256.New, []byte(c.Token))
	sig.Write(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", c.URL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", hex.EncodeToString(sig.Sum(nil)))
	res, e := c.HTTP.Do(req)
	if e != nil {
		return nil, failure("unavailable", "Mabang is unavailable. Please retry.", 503)
	}
	defer res.Body.Close()
	if res.StatusCode == 429 {
		return nil, failure("rate_limited", "Mabang rate limit reached. Please retry later.", 503)
	}
	if res.StatusCode != 200 {
		return nil, failure("rejected", "Mabang rejected the lookup request.", 502)
	}
	var envelope map[string]any
	dec := json.NewDecoder(io.LimitReader(res.Body, 8<<20))
	dec.UseNumber()
	if dec.Decode(&envelope) != nil {
		return nil, failure("malformed", "Mabang returned an invalid order response.", 502)
	}
	if str(envelope["code"]) != "200" {
		return nil, failure("rejected", "Mabang rejected the lookup request.", 502)
	}
	data, ok := envelope["data"].(map[string]any)
	if !ok {
		return nil, failure("malformed", "Mabang returned an invalid order response.", 502)
	}
	if code := str(data["code"]); code != "" && code != "000" && code != "200" {
		return nil, failure("rejected", "Mabang rejected the lookup request.", 502)
	}
	return data, nil
}
func (c *Client) scan(ctx context.Context, api string, p map[string]string, q source.Query, history bool) ([]source.Order, error) {
	out := []source.Order{}
	seen := map[string]bool{}
	for page := 0; page < 5; page++ {
		d, e := c.call(ctx, api, p)
		if e != nil {
			return nil, e
		}
		key := "data"
		if history {
			key = "list"
		}
		rows, ok := d[key].([]any)
		if !ok {
			return nil, failure("malformed", "Mabang returned an invalid order response.", 502)
		}
		for _, v := range rows {
			r, ok := v.(map[string]any)
			if !ok {
				return nil, failure("malformed", "Mabang returned an invalid order response.", 502)
			}
			if str(r["salesRecordNumber"]) != q.PlatformNumber {
				continue
			}
			if q.Shop != "" && str(r["shopName"]) != q.Shop {
				continue
			}
			o, e := mapOrder(r, c.Key, history)
			if e != nil {
				return nil, e
			}
			out = append(out, o)
		}
		next := str(d["nextCursor"])
		has := d["hasNext"] == true || (history && next != "")
		if !has {
			return out, nil
		}
		if next == "" || seen[next] {
			return nil, failure("malformed", "Mabang returned an invalid order response.", 502)
		}
		seen[next] = true
		p["cursor"] = next
	}
	return nil, failure("query_too_broad", "Too many historical results. Add an exact shop and payment date.", 422)
}
func (c *Client) Lookup(ctx context.Context, q source.Query) ([]source.Order, error) {
	// Both status ranges are necessary: salesRecordNumbers does not support allstatus.
	out, e := c.scan(ctx, "order-get-order-list-new", map[string]string{"salesRecordNumbers": q.PlatformNumber, "status": "7", "canSend": "3", "maxRows": "100"}, q, false)
	if e != nil || len(out) > 0 {
		return out, e
	}
	out, e = c.scan(ctx, "order-get-order-list-new", map[string]string{"salesRecordNumbers": q.PlatformNumber, "status": "6", "canSend": "3", "maxRows": "100"}, q, false)
	if e != nil || len(out) > 0 {
		return out, e
	}
	if q.SourceNumber == "" && q.PaidDate == "" {
		return nil, failure("history_identifier_required", "Recent order not found. Historical lookup requires a payment date and optional shop, or a saved Mabang number mapping.", 422)
	}
	p := map[string]string{"pageSize": "100"}
	if q.SourceNumber != "" {
		p["platformOrderId"] = q.SourceNumber
	} else {
		p["paidTime"] = q.PaidDate
	}
	if q.Shop != "" {
		p["shopName"] = q.Shop
	}
	// History documents canSend 1/2 only; explicitly cover both.
	for _, state := range []string{"1", "2"} {
		p["canSend"] = state
		delete(p, "cursor")
		rows, e := c.scan(ctx, "get-history-order-list", p, q, true)
		if e != nil {
			return nil, e
		}
		out = append(out, rows...)
	}
	if len(out) == 0 {
		return nil, failure("not_found", "No order matches this platform order number.", 404)
	}
	return out, nil
}
func mapOrder(r map[string]any, tenant string, history bool) (source.Order, error) {
	o := source.Order{Provider: "mabang", Tenant: tenant, PlatformNumber: str(r["salesRecordNumber"]), SourceNumber: str(r["platformOrderId"]), SourceID: str(r["erpOrderId"]), Platform: str(r["platformId"]), Shop: str(r["shopName"]), Status: str(r["orderStatus"]), PaidAt: str(r["paidTime"]), ShippedAt: str(r["expressTime"]), Country: str(r["countryCode"]), Currency: str(r["currencyId"]), Amount: str(r["itemTotalOrigin"]), FetchedAt: time.Now().UTC().Format(time.RFC3339Nano), QuerySource: "recent", Items: []source.Item{}}
	if history {
		o.QuerySource = "history"
		if o.SourceID == "" {
			o.SourceID = str(r["id"])
		}
	}
	items, ok := r["orderItem"].([]any)
	if !ok || o.SourceNumber == "" || o.SourceID == "" {
		return o, failure("malformed", "Mabang returned an invalid order response.", 502)
	}
	for i, v := range items {
		x, ok := v.(map[string]any)
		if !ok {
			return o, failure("malformed", "Mabang returned an invalid order response.", 502)
		}
		id := str(x["orderItemId"])
		if id == "" {
			id = strconv.Itoa(i)
		}
		sku := str(x["stockSku"])
		if sku == "" {
			sku = str(x["platformSku"])
		}
		o.Items = append(o.Items, source.Item{ID: id, SKU: sku, Name: str(x["title"]), Quantity: str(x["quantity"])})
	}
	o.Evidence, _ = json.Marshal(r)
	// Never infer delivery or activation from shipTime, paidTime or expressTime.
	return o, nil
}
