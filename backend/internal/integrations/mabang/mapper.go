package mabang

import (
	"crypto/sha256"
	"fmt"
	"harbor/internal/catalogsource"
	"harbor/internal/ordersource"
	"harbor/internal/sourceinfo"
	"strings"
	"time"
)

const MappingVersion = 2

func provenance(tenant, api, fetched string) sourceinfo.Metadata {
	return sourceinfo.Metadata{ConnectionID: fmt.Sprintf("mabang:%x", sha256.Sum256([]byte(tenant))), API: api, MappingVersion: MappingVersion, FetchedAt: fetched}
}

// Only observed, verified aliases are accepted. Unknown values never gain policy rights.
func platform(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "16", "shopify":
		return "Shopify"
	case "2", "amazon":
		return "Amazon"
	case "104", "tiktokshop":
		return "TikTokShop"
	default:
		return ""
	}
}

func orderStatus(value string) string {
	switch value {
	case "2":
		return ordersource.StatusAwaitingShipment
	case "3":
		return ordersource.StatusShipped
	case "4":
		return ordersource.StatusCompleted
	case "5":
		return ordersource.StatusVoided
	default:
		return ordersource.StatusUnknown
	}
}

func productStatus(value string) string {
	switch value {
	case "1":
		return catalogsource.StatusAutomatic
	case "2":
		return catalogsource.StatusDevelopment
	case "3":
		return catalogsource.StatusSelling
	case "4":
		return catalogsource.StatusClearance
	case "5":
		return catalogsource.StatusDiscontinued
	default:
		return catalogsource.StatusUnknown
	}
}

func sourceTime(raw string) sourceinfo.Timestamp {
	out := sourceinfo.Timestamp{Raw: raw, TimeZone: "unspecified"}
	if t, e := time.Parse(time.RFC3339Nano, raw); e == nil {
		out.UTC = t.UTC().Format(time.RFC3339Nano)
		out.TimeZone = t.Format("Z07:00")
	}
	return out
}

func mapCustomer(r map[string]any) ordersource.Customer {
	c := ordersource.Customer{Name: str(r["buyerName"]), Email: str(r["buyerEmail"]), City: str(r["buyerCity"]), Phones: []string{}}
	for _, key := range []string{"buyerPhone", "buyerMobile"} {
		phone := strings.TrimSpace(str(r[key]))
		exists := false
		for _, previous := range c.Phones {
			exists = exists || previous == phone
		}
		if phone != "" && !exists {
			c.Phones = append(c.Phones, phone)
		}
	}
	return c
}

// MapStoredOrder rebuilds replaceable projections without fetching or changing source facts.
func MapStoredOrder(raw map[string]any, tenant string, history bool, fetchedAt string) (ordersource.Order, error) {
	o, e := mapOrder(raw, tenant, history)
	if fetchedAt != "" {
		o.FetchedAt = fetchedAt
		o.Source.FetchedAt = fetchedAt
	}
	return o, e
}

func catalogProvenance(tenant string, raw map[string]any) sourceinfo.Metadata {
	m := provenance(tenant, "stock-do-search-sku-list-new", time.Now().UTC().Format(time.RFC3339Nano))
	m.RawStatus = str(raw["status"])
	if productStatus(m.RawStatus) == catalogsource.StatusUnknown {
		m.Warnings = append(m.Warnings, "unmapped_product_status")
	}
	return m
}
