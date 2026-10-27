// Package originalorders owns queried references and immutable confirmation evidence,
// not an ERP replica. Warranty decisions and RMA lifecycle remain in support.
package originalorders

import (
	"context"
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"harbor/internal/domain"
	"harbor/internal/orderindex"
	source "harbor/internal/ordersource"
	"strings"
	"time"
)

type M = domain.M
type OrderEvidence struct {
	ID             string `gorm:"primaryKey"`
	Tenant         string `gorm:"index;index:order_identity,priority:1"`
	UserID         string `gorm:"index"`
	ActorName      string
	MappingVersion int    `gorm:"not null;default:1"`
	DraftID        string `gorm:"index"`
	PlatformNumber string `gorm:"index;index:order_identity,priority:2"`
	SourceNumber   string
	Kind           string
	ItemID         string
	ProductID      string
	ParentID       string
	Normalized     string    `gorm:"type:jsonb"`
	Raw            string    `gorm:"type:jsonb" json:"-"`
	CreatedAt      time.Time `gorm:"index:order_identity,priority:3,sort:desc"`
}
type Service struct {
	DB     *gorm.DB
	Source source.Source
	Tenant string
}

func Init(db *gorm.DB) error            { return db.AutoMigrate(&OrderEvidence{}) }
func fail(msg string, status int) error { return &domain.Error{Message: msg, Status: status} }
func encode(v any) string               { b, _ := json.Marshal(v); return string(b) }
func decode(v string) source.Order      { var o source.Order; json.Unmarshal([]byte(v), &o); return o }
func Match(state M, item source.Item) M {
	// The order establishes the purchased item; catalog policy cannot negate it.
	// Prefer an exact SKU identity, then require an unambiguous alias match.
	if strings.TrimSpace(item.SKU) == "" {
		return nil
	}
	for _, exact := range []bool{true, false} {
		var found M
		for _, p := range domain.Rows(state, "products") {
			matches := false
			if exact {
				matches = strings.EqualFold(domain.Str(p["sku"]), item.SKU)
			} else {
				for _, alias := range domain.Strings(p["aliases"]) {
					matches = matches || strings.EqualFold(alias, item.SKU)
				}
			}
			if matches {
				if found != nil {
					return nil
				}
				found = p
			}
		}
		if found != nil {
			return found
		}
	}
	return nil
}

func (s Service) Lookup(ctx context.Context, actor, state, b M) (M, error) {
	number := strings.TrimSpace(domain.Str(b["orderNumber"]))
	if number == "" || len(number) > 160 || strings.ContainsAny(number, ",\r\n") {
		return nil, fail("Enter one platform order number.", 400)
	}
	date := domain.Str(b["paidDate"])
	if date != "" {
		d, e := time.Parse("2006-01-02", date)
		if e != nil || d.After(time.Now()) {
			return nil, fail("Enter a valid payment date.", 400)
		}
	}
	draft := domain.Str(b["draftId"])
	if draft == "" {
		return nil, fail("Create a ticket RMA draft before looking up an order.", 422)
	}
	// Avoid importing the ticket context's ORM model: it owns its draft validation at HTTP boundary.
	var refs []OrderEvidence
	e := s.DB.Where("tenant=? AND platform_number=? AND source_number<>?", s.Tenant, number, "").Order("created_at desc").Find(&refs).Error
	if e != nil {
		return nil, e
	}
	shop := strings.TrimSpace(domain.Str(b["shop"]))
	queries := map[string]source.Query{}
	add := func(sourceNumber, matchedShop string) {
		if shop != "" && matchedShop != shop {
			return
		}
		queries[sourceNumber+"\x00"+matchedShop] = source.Query{PlatformNumber: number, SourceNumber: sourceNumber, PaidDate: date, Shop: matchedShop}
	}
	for _, r := range refs {
		add(r.SourceNumber, decode(r.Normalized).Shop)
	}
	indexed, e := (orderindex.Service{DB: s.DB, Tenant: s.Tenant}).Records(number, shop)
	if e != nil {
		return nil, e
	}
	for _, r := range indexed {
		add(r.SourceNumber, r.Shop)
	}
	if len(queries) == 0 {
		queries[""] = source.Query{PlatformNumber: number, PaidDate: date, Shop: shop}
	}
	if len(queries) > 20 {
		return nil, &source.Error{Code: "order_ambiguous", Message: "Too many matching orders. Specify a shop.", Status: 422}
	}
	orders := []source.Order{}
	for _, query := range queries {
		rows, lookupErr := s.Source.Lookup(ctx, query)
		if lookupErr != nil {
			var upstream *source.Error
			if errors.As(lookupErr, &upstream) && upstream.Code == "not_found" {
				continue
			}
			return nil, lookupErr
		}
		orders = append(orders, rows...)
	}
	if len(orders) == 0 {
		return nil, &source.Error{Code: "not_found", Message: "No order matches this platform order number.", Status: 404}
	}
	out := []M{}
	e = s.DB.Transaction(func(tx *gorm.DB) error {
		seen := map[string]bool{}
		for _, o := range orders {
			if e := (orderindex.Service{DB: tx, Tenant: s.Tenant}).Save(tx, o, ""); e != nil {
				return e
			}
			key := o.SourceID
			if seen[key] {
				continue
			}
			seen[key] = true
			r := OrderEvidence{ID: domain.ID("ORDER"), Tenant: s.Tenant, UserID: domain.Str(actor["id"]), DraftID: draft, PlatformNumber: o.PlatformNumber, SourceNumber: o.SourceNumber, Kind: "candidate", Normalized: encode(o), Raw: string(o.Evidence), MappingVersion: o.Source.MappingVersion, CreatedAt: time.Now().UTC()}
			if r.Raw == "" {
				r.Raw = "null"
			}
			if e := tx.Create(&r).Error; e != nil {
				return e
			}
			items := []M{}
			for _, i := range o.Items {
				p := Match(state, i)
				items = append(items, M{"id": i.ID, "sku": i.SKU, "name": i.Name, "quantity": i.Quantity, "productId": domain.Str(p["id"]), "matched": p != nil})
			}
			out = append(out, M{"id": r.ID, "order": o, "items": items})
		}
		return nil
	})
	return M{"items": out}, e
}
func (s Service) Confirm(actor, state, b M) (M, error) {
	var r OrderEvidence
	if e := s.DB.Where("id=? AND tenant=? AND user_id=? AND draft_id=? AND kind='candidate'", domain.Str(b["candidateId"]), s.Tenant, actor["id"], b["draftId"]).First(&r).Error; e != nil {
		return nil, fail("Order candidate is unavailable. Look up the order again.", 409)
	}
	if time.Since(r.CreatedAt) > 30*time.Minute {
		return nil, fail("Order candidate expired. Look up the order again.", 409)
	}
	o := decode(r.Normalized)
	var selected *source.Item
	for i := range o.Items {
		if o.Items[i].ID == domain.Str(b["itemId"]) {
			selected = &o.Items[i]
			break
		}
	}
	if selected == nil {
		return nil, fail("Choose an original order item.", 422)
	}
	p := Match(state, *selected)
	if p == nil {
		return nil, fail("No unique catalog match for this order item. Check SKU mapping.", 422)
	}
	if !domain.In(o.Status, source.StatusShipped, source.StatusCompleted) {
		return nil, fail("Only shipped or completed original orders can be used for this RMA.", 422)
	}
	if o.Platform == "" {
		return nil, fail("Order platform has no verified mapping. Ask an administrator to configure the integration.", 422)
	}
	platformKnown := false
	for _, platform := range domain.Rows(domain.Obj(state["supportConfig"]), "platforms") {
		if platform["id"] == o.Platform && domain.Bool(platform["enabled"]) {
			platformKnown = true
		}
	}
	if !platformKnown {
		return nil, fail("Order platform is not enabled in after-sales configuration. Ask an administrator to configure it.", 422)
	}
	r.ActorName = domain.Str(actor["name"])
	r.ParentID = r.ID
	r.ID = domain.ID("OCONF")
	r.Kind = "confirmed"
	r.ItemID = selected.ID
	r.ProductID = domain.Str(p["id"])
	r.CreatedAt = time.Now().UTC()
	if e := s.DB.Create(&r).Error; e != nil {
		return nil, e
	}
	return M{"confirmationId": r.ID, "order": o, "itemId": r.ItemID, "productId": r.ProductID, "confirmedAt": r.CreatedAt, "confirmedBy": actor["name"]}, nil
}

// Bind executes inside the RMA transaction, before domain mutation; all browser claims are rechecked.
func Bind(tx *gorm.DB, actor, state, b M) error {
	delete(b, "originalOrder")
	if domain.Str(b["draftId"]) == "" && domain.Str(b["solutionId"]) != "reship_device" {
		return nil
	}
	if !domain.In(domain.Str(b["solutionId"]), "reship_device", "parts") {
		return fail("Ticket RMAs support only whole-unit or parts reshipment.", 422)
	}
	var r OrderEvidence
	if e := tx.Where("id=? AND user_id=? AND draft_id=? AND kind='confirmed'", domain.Str(b["orderConfirmationId"]), actor["id"], b["draftId"]).First(&r).Error; e != nil {
		return fail("Confirm the original order and affected item before creating the RMA.", 422)
	}
	o := decode(r.Normalized)
	if o.PlatformNumber != domain.Str(b["orderNumber"]) || r.ProductID != domain.Str(b["productId"]) || o.Platform != domain.Str(b["platform"]) {
		return fail("Order details changed. Confirm the original order again.", 409)
	}
	matched := false
	for _, i := range o.Items {
		if i.ID == r.ItemID {
			p := Match(state, i)
			matched = p != nil && domain.Str(p["id"]) == r.ProductID
		}
	}
	if !matched {
		return fail("No unique catalog match for this order item. Check SKU mapping.", 422)
	}
	b["originalOrder"] = M{"confirmationId": r.ID, "candidateId": r.ParentID, "order": o, "itemId": r.ItemID, "productId": r.ProductID, "confirmedAt": r.CreatedAt, "confirmedBy": r.ActorName, "confirmedById": actor["id"]}
	if o.Provider == "manual" {
		var evidence M
		if e := json.Unmarshal([]byte(r.Raw), &evidence); e != nil {
			return e
		}
		domain.Obj(b["originalOrder"])["manualEvidence"] = evidence
	}
	return nil
}
