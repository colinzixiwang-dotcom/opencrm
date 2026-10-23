// Package originalorders owns queried references and immutable confirmation evidence,
// not an ERP replica. Warranty decisions and RMA lifecycle remain in support.
package originalorders

import (
	"context"
	"encoding/json"
	"gorm.io/gorm"
	"harbor/internal/domain"
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
	// Identity and business eligibility are separate. Retired catalog SKUs remain identifiable.
	var found M
	for _, p := range domain.Rows(state, "products") {
		matches := strings.EqualFold(domain.Str(p["sku"]), item.SKU)
		for _, alias := range domain.Strings(p["aliases"]) {
			matches = matches || strings.EqualFold(alias, item.SKU)
		}
		allowed := p["productType"] == "device"
		if p["source"] == "mabang" {
			allowed = domain.Bool(p["allowOriginal"])
		}
		if matches && item.SKU != "" && allowed {
			if found != nil {
				return nil
			}
			found = p
		}
	}

	return found
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
	sourceNumber := ""
	identities := map[string]bool{}
	shop := strings.TrimSpace(domain.Str(b["shop"]))
	for _, r := range refs {
		o := decode(r.Normalized)
		if shop != "" && o.Shop != shop {
			continue
		}
		identities[r.SourceNumber] = true
	}
	if len(identities) == 1 {
		for id := range identities {
			sourceNumber = id
		}
	}
	orders, e := s.Source.Lookup(ctx, source.Query{PlatformNumber: number, SourceNumber: sourceNumber, PaidDate: date, Shop: shop})
	if e != nil {
		return nil, e
	}
	out := []M{}
	e = s.DB.Transaction(func(tx *gorm.DB) error {
		seen := map[string]bool{}
		for _, o := range orders {
			key := o.SourceID
			if seen[key] {
				continue
			}
			seen[key] = true
			r := OrderEvidence{ID: domain.ID("ORDER"), Tenant: s.Tenant, UserID: domain.Str(actor["id"]), DraftID: draft, PlatformNumber: o.PlatformNumber, SourceNumber: o.SourceNumber, Kind: "candidate", Normalized: encode(o), Raw: string(o.Evidence), CreatedAt: time.Now().UTC()}
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
		return nil, fail("Original item is not enabled for order confirmation. Ask an administrator to check the product catalog.", 422)
	}
	if !domain.In(o.Status, "3", "4") {
		return nil, fail("Only shipped or completed original orders can be used for this RMA.", 422)
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
		return fail("Original item is not enabled for order confirmation. Ask an administrator to check the product catalog.", 422)
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
