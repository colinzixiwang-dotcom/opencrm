package originalorders

import (
	"fmt"
	"harbor/internal/domain"
	source "harbor/internal/ordersource"
	"strconv"
	"strings"
	"time"
)

// Manual confirms agent-supplied evidence, explicitly distinct from ERP verification.
// It shares catalog, platform and final warranty gates with imported originals.
func (s Service) Manual(actor, state, b M) (M, error) {
	values := map[string]string{}
	for _, field := range []struct {
		key      string
		limit    int
		required bool
	}{{"draftId", 160, true}, {"orderNumber", 160, true}, {"platform", 160, true}, {"productId", 160, true}, {"evidenceReference", 1000, true}, {"entryReason", 2000, true}, {"paidDate", 10, true}, {"shop", 160, false}} {
		raw, ok := b[field.key].(string)
		v := strings.TrimSpace(raw)
		if (!ok && b[field.key] != nil) || len([]rune(v)) > field.limit || (field.required && v == "") {
			return nil, fail("Complete the manual order information, purchase evidence and entry reason.", 422)
		}
		values[field.key] = v
	}
	if strings.ContainsAny(values["orderNumber"], ",\r\n") {
		return nil, fail("Enter one platform order number.", 400)
	}
	date, e := time.Parse("2006-01-02", values["paidDate"])
	if e != nil || date.Year() < 1900 || date.After(time.Now()) {
		return nil, fail("Enter a valid payment date.", 422)
	}
	quantity, e := strconv.Atoi(strings.TrimSpace(fmt.Sprint(b["quantity"])))
	if e != nil || quantity < 1 || quantity > 1000000 {
		return nil, fail("Order quantity must be a positive whole number.", 422)
	}
	platformKnown := false
	for _, p := range domain.Rows(domain.Obj(state["supportConfig"]), "platforms") {
		if p["id"] == values["platform"] && domain.Bool(p["enabled"]) {
			platformKnown = true
		}
	}
	if !platformKnown {
		return nil, fail("Order platform is not enabled in after-sales configuration. Ask an administrator to configure it.", 422)
	}
	var product M
	for _, p := range domain.Rows(state, "products") {
		if p["id"] == values["productId"] {
			product = p
		}
	}
	item := source.Item{ID: "manual-item", SKU: domain.Str(product["sku"]), Name: domain.Str(product["name"]), Quantity: strconv.Itoa(quantity)}
	if p := Match(state, item); p == nil || p["id"] != values["productId"] {
		return nil, fail("No unique catalog match for this order item. Check SKU mapping.", 422)
	}
	now := time.Now().UTC()
	id := domain.ID("OCONF")
	order := source.Order{Provider: "manual", PlatformNumber: values["orderNumber"], Platform: values["platform"], Shop: values["shop"], PaidAt: values["paidDate"], Items: []source.Item{item}, FetchedAt: now.Format(time.RFC3339Nano), QuerySource: "manual"}
	evidence := M{"source": "agent_entered", "reference": values["evidenceReference"], "reason": values["entryReason"], "recordedById": actor["id"], "recordedBy": actor["name"], "recordedAt": now.Format(time.RFC3339Nano)}
	r := OrderEvidence{ID: id, Tenant: s.Tenant, UserID: domain.Str(actor["id"]), ActorName: domain.Str(actor["name"]), DraftID: values["draftId"], PlatformNumber: values["orderNumber"], Kind: "confirmed", ItemID: item.ID, ProductID: values["productId"], Normalized: encode(order), Raw: encode(evidence), CreatedAt: now}
	if e = s.DB.Create(&r).Error; e != nil {
		return nil, e
	}
	return M{"confirmationId": id, "order": order, "itemId": item.ID, "productId": values["productId"], "confirmedAt": now, "confirmedBy": actor["name"], "manualEvidence": evidence}, nil
}
