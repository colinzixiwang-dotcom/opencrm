// Package ordersource owns the CRM contract for read-only original-order evidence.
package ordersource

import "context"

type Item struct {
	ID       string `json:"id"`
	SKU      string `json:"sku"`
	Name     string `json:"name"`
	Quantity string `json:"quantity"`
}
type Order struct {
	Provider       string `json:"provider"`
	Tenant         string `json:"-"`
	PlatformNumber string `json:"platformNumber"`
	SourceNumber   string `json:"sourceNumber"`
	SourceID       string `json:"sourceId"`
	Platform       string `json:"platform"`
	Shop           string `json:"shop"`
	Status         string `json:"status"`
	PaidAt         string `json:"paidAt"`
	ShippedAt      string `json:"shippedAt"`
	Country        string `json:"country"`
	Currency       string `json:"currency"`
	Amount         string `json:"amount"`
	Items          []Item `json:"items"`
	FetchedAt      string `json:"fetchedAt"`
	QuerySource    string `json:"querySource"`
	Evidence       []byte `json:"-"`
}
type Query struct{ PlatformNumber, SourceNumber, PaidDate, Shop string }
type Source interface {
	Lookup(context.Context, Query) ([]Order, error)
}
type Error struct {
	Code, Message string
	Status        int
}

func (e *Error) Error() string { return e.Message }
