package mabang

import (
	"harbor/internal/catalogsource"
	"harbor/internal/ordersource"
	"strings"
	"testing"
)

func TestRecentAndHistoryHaveSameBusinessSemantics(t *testing.T) {
	for _, history := range []bool{false, true} {
		rawPlatform := any("Shopify")
		if history {
			rawPlatform = 16
		}
		raw := map[string]any{"erpOrderId": "ID", "platformOrderId": "ERP", "salesRecordNumber": "P", "platformId": rawPlatform, "orderStatus": 3, "paidTime": "2026-01-03 12:38:10", "updateTime": "2026-10-23T06:21:49+08:00", "buyerName": "Buyer", "buyerEmail": "buyer@example.test", "buyerPhone": "123", "buyerMobile": "123", "buyerCity": "City", "orderItem": []any{}}
		o, e := mapOrder(raw, "secret-key", history)
		if e != nil {
			t.Fatal(e)
		}
		if o.Platform != "Shopify" || o.Status != ordersource.StatusShipped || o.Customer.Name != "Buyer" || len(o.Customer.Phones) != 1 || o.Source.MappingVersion != 2 {
			t.Fatalf("wrong normalized facts: %+v", o)
		}
		if strings.Contains(o.Source.ConnectionID, "secret-key") {
			t.Fatal("credential leaked")
		}
		if o.Times["paidAt"].UTC != "" || o.Times["paidAt"].TimeZone != "unspecified" {
			t.Fatal("invented source timezone")
		}
		if o.Times["updatedAt"].UTC != "2026-10-22T22:21:49Z" {
			t.Fatal("lost explicit offset")
		}
		if o.SourceFields["platformId"] != rawPlatform {
			t.Fatal("raw evidence changed")
		}
	}
}

func TestUnknownAndConflictingCodesDoNotAcquireBusinessMeaning(t *testing.T) {
	for _, r := range []map[string]any{
		{"platformId": "999", "orderStatus": "6"},
		{"platformId": "Shopify", "platformCode": "2", "orderStatus": "new-state"},
	} {
		r["erpOrderId"] = "id"
		r["platformOrderId"] = "ERP"
		r["orderItem"] = []any{}
		o, e := mapOrder(r, "tenant", false)
		if e != nil {
			t.Fatal(e)
		}
		if o.Platform != "" || o.Status != ordersource.StatusUnknown || len(o.Source.Warnings) < 2 {
			t.Fatal("unknown values gained meaning", o)
		}
	}
	if platform("104") != "TikTokShop" || platform("2") != "Amazon" {
		t.Fatal("known platforms unmapped")
	}
	if productStatus("3") != catalogsource.StatusSelling || productStatus("99") != catalogsource.StatusUnknown {
		t.Fatal("product semantics wrong")
	}
}
