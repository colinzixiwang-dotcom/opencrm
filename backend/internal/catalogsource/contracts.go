// Package catalogsource owns the read-only ERP catalog and inventory contract.
package catalogsource

import (
	"context"
	"harbor/internal/sourceinfo"
)

const (
	StatusAutomatic    = "Automatic"
	StatusDevelopment  = "Development"
	StatusSelling      = "Selling"
	StatusClearance    = "Clearance"
	StatusDiscontinued = "Discontinued"
	StatusUnknown      = "Unknown"
)

type Product struct {
	Source    sourceinfo.Metadata `json:"source"`
	ID        string              `json:"sourceId"`
	SKU       string              `json:"sku"`
	Name      string              `json:"name"`
	NameEN    string              `json:"nameEn"`
	MasterSKU string              `json:"masterSku"`
	Aliases   []string            `json:"aliases"`
	Status    string              `json:"sourceStatus"`
	Category  string              `json:"category"`
	Image     string              `json:"image"`
	Raw       map[string]any      `json:"-"`
}
type Position struct {
	SKU         string         `json:"sku"`
	WarehouseID string         `json:"warehouseId"`
	Warehouse   string         `json:"warehouse"`
	OnHand      string         `json:"onHand"`
	Available   string         `json:"available"`
	Waiting     string         `json:"waiting"`
	Purchasing  string         `json:"purchasing"`
	Transfer    string         `json:"transfer"`
	Grid        string         `json:"grid"`
	Raw         map[string]any `json:"-"`
}
type Snapshot struct {
	Products      []Product
	Positions     []Position
	From, Through string
}
type Source interface {
	Catalog(context.Context, string, func(int)) (Snapshot, error)
}

// InventoryReader is the optional read-only capability for an exact stock SKU.
type InventoryReader interface {
	Inventory(context.Context, string) ([]Position, error)
}
