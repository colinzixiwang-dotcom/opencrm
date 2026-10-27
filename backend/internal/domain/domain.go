package domain

import (
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/crypto/scrypt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

type M = map[string]any
type Error struct {
	Message string
	Status  int
}

func (e *Error) Error() string { return e.Message }
func Fail(message string, status ...int) {
	code := 400
	if len(status) > 0 {
		code = status[0]
	}
	panic(&Error{message, code})
}
func ID(prefix string) string {
	b := make([]byte, 6)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return prefix + "-" + hex.EncodeToString(b)
}
func Now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func Str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func N(v any) int64 {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case int64:
		return x
	case int:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	}
	return 0
}
func Bool(v any) bool { x, _ := v.(bool); return x }
func Obj(v any) M {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return M{}
}
func Rows(s M, k string) []M { return Items(s[k]) }
func Items(v any) []M {
	out := []M{}
	switch a := v.(type) {
	case []any:
		for _, x := range a {
			out = append(out, Obj(x))
		}
	case []M:
		out = a
	}
	return out
}
func Strings(v any) []string {
	a := []string{}
	switch x := v.(type) {
	case []any:
		for _, i := range x {
			a = append(a, Str(i))
		}
	case []string:
		a = x
	}
	return a
}
func Put(s M, k string, rows []M) { s[k] = rows }
func Prepend(s M, k string, v M)  { s[k] = append([]M{v}, Rows(s, k)...) }
func Find(s M, k, key string) M {
	for _, x := range Rows(s, k) {
		if Str(x["id"]) == key {
			return x
		}
	}
	Fail(k+" record not found.", 404)
	return nil
}
func Text(v any, max int) string {
	if v == nil {
		return ""
	}
	x, ok := v.(string)
	if !ok || len([]rune(x)) > max {
		Fail(fmt.Sprintf("Text must be at most %d characters.", max))
	}
	return strings.TrimSpace(x)
}
func Required(v any, label string, max int) string {
	x := Text(v, max)
	if x == "" {
		Fail(label + " is required.")
	}
	return x
}
func Int(v any, label string, min, max int64) int64 {
	f := float64(0)
	switch n := v.(type) {
	case float64:
		f = n
	case int:
		f = float64(n)
	case int64:
		f = float64(n)
	default:
		Fail(label + " must be a whole number.")
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f < float64(min) || f > float64(max) {
		Fail(fmt.Sprintf("%s must be a whole number between %d and %d.", label, min, max))
	}
	return int64(f)
}
func Default(v, def any) any {
	if v == nil {
		return def
	}
	return v
}
func In(value string, opts ...string) bool {
	for _, x := range opts {
		if value == x {
			return true
		}
	}
	return false
}
func Choice(v any, opts ...string) string {
	x := Str(v)
	if !In(x, opts...) {
		Fail("Invalid value: " + x)
	}
	return x
}
func Date(v any) string {
	if v == nil || v == "" {
		return time.Now().UTC().Format("2006-01-02")
	}
	s, ok := v.(string)
	if !ok {
		Fail("Enter a valid date.")
	}
	d, e := time.Parse("2006-01-02", s)
	if e != nil || d.Format("2006-01-02") != s {
		Fail("Enter a valid date.")
	}
	return s
}
func Unique(rows []M, field, value, exclude string) {
	for _, r := range rows {
		if strings.EqualFold(Str(r[field]), value) && Str(r["id"]) != exclude {
			Fail(strings.ToUpper(field)+" already exists.", 409)
		}
	}
}
func Clone(s M) M {
	b, _ := json.Marshal(s)
	var out M
	if e := json.Unmarshal(b, &out); e != nil {
		panic(e)
	}
	return out
}
func HasAction(user M, action string) bool {
	for _, p := range Strings(user["permissions"]) {
		if p == action || p == "*:*:*" {
			return true
		}
	}
	return false
}
func HashPassword(p string) string {
	b, e := bcrypt.GenerateFromPassword([]byte(p), bcrypt.DefaultCost)
	if e != nil {
		panic(e)
	}
	return string(b)
}
func VerifyPassword(p, hash string) bool {
	if strings.HasPrefix(hash, "$2") {
		return bcrypt.CompareHashAndPassword([]byte(hash), []byte(p)) == nil
	}
	parts := strings.Split(hash, ":")
	if len(parts) != 2 {
		return false
	}
	expected, e := hex.DecodeString(parts[1])
	if e != nil {
		return false
	}
	key, e := scrypt.Key([]byte(p), []byte(parts[0]), 16384, 8, 1, 64)
	return e == nil && subtle.ConstantTimeCompare(key, expected) == 1
}

func Stock(s M, p, w string) M {
	Find(s, "products", p)
	Find(s, "warehouses", w)
	for _, r := range Rows(s, "stocks") {
		if r["productId"] == p && r["warehouseId"] == w {
			return r
		}
	}
	r := M{"id": ID("STK"), "productId": p, "warehouseId": w, "onHand": int64(0), "locked": int64(0), "averageCostCents": int64(0), "valueCents": int64(0)}
	s["stocks"] = append(Rows(s, "stocks"), r)
	return r
}
func Allocate(v, q, total int64) int64 { return (v/total)*q + ((v%total)*q+total/2)/total }
func movement(s, row M, delta, cost, total int64, kind, ref string, user M) {
	Prepend(s, "movements", M{"id": ID("MOV"), "productId": row["productId"], "warehouseId": row["warehouseId"], "delta": delta, "kind": kind, "reference": ref, "unitCostCents": cost, "totalCostCents": total, "onHandAfter": row["onHand"], "valueCentsAfter": row["valueCents"], "actor": user["name"], "createdAt": Now()})
}
func AddStock(s, row M, qty, cost int64, kind, ref string, user M, amount ...int64) {
	value := qty * cost
	if len(amount) > 0 {
		value = amount[0]
	}
	next := N(row["onHand"]) + qty
	if next > 100000000 {
		Fail("Inventory exceeds the supported quantity limit.")
	}
	row["valueCents"] = N(row["valueCents"]) + value
	row["onHand"] = next
	row["averageCostCents"] = Allocate(N(row["valueCents"]), 1, next)
	movement(s, row, qty, cost, value, kind, ref, user)
}
func RemoveStock(s, row M, qty int64, kind, ref string, user M, reserved bool) (int64, int64) {
	available := N(row["onHand"]) - N(row["locked"])
	if reserved {
		available = N(row["locked"])
	}
	if qty > available || qty > N(row["onHand"]) {
		Fail("Insufficient available stock.", 409)
	}
	amount := Allocate(N(row["valueCents"]), qty, N(row["onHand"]))
	cost := Allocate(amount, 1, qty)
	row["onHand"] = N(row["onHand"]) - qty
	row["valueCents"] = N(row["valueCents"]) - amount
	if reserved {
		row["locked"] = N(row["locked"]) - qty
	}
	row["averageCostCents"] = int64(0)
	if N(row["onHand"]) > 0 {
		row["averageCostCents"] = Allocate(N(row["valueCents"]), 1, N(row["onHand"]))
	}
	movement(s, row, -qty, cost, amount, kind, ref, user)
	return cost, amount
}
func Lines(s M, input any) []M {
	items := Items(input)
	if len(items) < 1 || len(items) > 50 {
		Fail("Add between 1 and 50 line items.")
	}
	seen := map[string]bool{}
	out := []M{}
	for _, l := range items {
		p := Required(l["productId"], "Product", 100)
		Find(s, "products", p)
		if seen[p] {
			Fail("A product may appear only once per document.")
		}
		seen[p] = true
		out = append(out, M{"productId": p, "qty": Int(l["qty"], "Quantity", 1, 1000000), "unitCents": Int(l["unitCents"], "Unit price", 0, 10000000), "received": int64(0), "returned": int64(0)})
	}
	return out
}
func Total(doc M) int64 {
	var n int64
	for _, l := range Rows(doc, "lines") {
		n += N(l["qty"]) * N(l["unitCents"])
	}
	return n
}
func Reserve(s M, doc M, warehouse string, release bool) {
	for _, l := range Rows(doc, "lines") {
		r := Stock(s, Str(l["productId"]), warehouse)
		q := N(l["qty"])
		if release {
			r["locked"] = N(r["locked"]) - q
		} else {
			if N(r["onHand"])-N(r["locked"]) < q {
				Fail("Insufficient available stock for "+Str(Find(s, "products", Str(l["productId"]))["sku"])+".", 409)
			}
			r["locked"] = N(r["locked"]) + q
		}
	}
}

type receipt struct {
	Line M
	Qty  int64
}

func Receipt(input any, doc M, field string) []receipt {
	a := Items(input)
	if len(a) == 0 {
		Fail("Select at least one line to receive.")
	}
	seen := map[string]bool{}
	out := []receipt{}
	for _, item := range a {
		var line M
		for _, l := range Rows(doc, "lines") {
			if l["productId"] == item["productId"] {
				line = l
				break
			}
		}
		if line == nil {
			Fail("Unknown line item.")
		}
		p := Str(item["productId"])
		if seen[p] {
			Fail("Duplicate receipt line.")
		}
		seen[p] = true
		q := Int(item["qty"], "Quantity", 1, 1000000)
		if q > N(line["qty"])-N(line[field]) {
			Fail("Quantity exceeds the remaining amount.", 409)
		}
		out = append(out, receipt{line, q})
	}
	return out
}
func Payment(s, doc, b, user M, purchase bool) M {
	if In(Str(doc["status"]), "cancelled", "draft", "pending") {
		Fail("Approve or confirm the document before recording a payment.", 409)
	}
	amount := Int(b["amountCents"], "Payment amount", 1, 500000000)
	if amount > Total(doc)-N(doc["refundCents"])-N(doc["paidCents"]) {
		Fail("Payment exceeds the outstanding balance.", 409)
	}
	doc["paidCents"] = N(doc["paidCents"]) + amount
	kind := "inflow"
	if purchase {
		kind = "outflow"
	}
	p := M{"id": ID("PAY"), "kind": kind, "reference": doc["id"], "amountCents": amount, "date": Date(b["date"]), "note": Text(b["note"], 500), "actor": user["name"], "createdAt": Now()}
	Prepend(s, "payments", p)
	return p
}
func Mutate(original M, action string, b, user M) (state, result M, err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("%v", r)
			}
			state = nil
			result = nil
		}
	}()
	if !HasAction(user, action) {
		Fail("Your role does not permit this action.", 403)
	}
	s := Clone(original)
	var r M
	switch action {
	case "product.create", "product.update":
		var p M
		if action == "product.update" {
			p = Find(s, "products", Str(b["id"]))
			if p["source"] == "mabang" {
				Fail("ERP fields are read-only. Use SKU policy configuration.", 422)
			}
		}
		sku := Required(b["sku"], "SKU", 64)
		Unique(Rows(s, "products"), "sku", sku, Str(b["id"]))
		supplier := Str(b["supplierId"])
		if supplier != "" {
			Find(s, "suppliers", supplier)
		}
		values := M{"sku": sku, "name": Required(b["name"], "Product name", 160), "spu": Text(b["spu"], 64), "category": Required(b["category"], "Category", 64), "unit": Text(Default(b["unit"], "pcs"), 16), "costCents": Int(b["costCents"], "Cost", 0, 10000000), "priceCents": Int(b["priceCents"], "Price", 0, 10000000), "reorderPoint": Int(b["reorderPoint"], "Reorder point", 0, 1000000), "supplierId": supplier, "leadDays": Int(Default(b["leadDays"], 14), "Lead time", 0, 365), "updatedAt": Now()}
		if p == nil {
			p = M{"id": ID("PRD"), "createdAt": Now()}
			Prepend(s, "products", p)
		}

		if v, ok := b["productType"]; ok {
			values["productType"] = Choice(v, "general", "device", "part", "consumable")
		} else if p["productType"] == nil {
			values["productType"] = "general"
		}
		if v, ok := b["warrantyClass"]; ok {
			values["warrantyClass"] = Choice(v, "none", "printhead_1080", "printhead_3200")
		}
		if v, ok := b["partKind"]; ok {
			values["partKind"] = Choice(v, "other", "printhead", "accessory", "component")
		}
		if v, ok := b["deviceIds"]; ok {
			ids := []string{}
			switch x := v.(type) {
			case nil:
			case []string:
				ids = append(ids, x...)
			case []any:
				for _, item := range x {
					id, ok := item.(string)
					if !ok || id == "" {
						Fail("Compatible SKUs must be an array of device IDs.")
					}
					ids = append(ids, id)
				}
			default:
				Fail("Compatible SKUs must be an array of device IDs.")
			}
			for _, id := range ids {
				device := Find(s, "products", id)
				if device["productType"] != "device" || device["id"] == p["id"] {
					Fail("Compatible SKUs must be devices.")
				}
			}
			values["deviceIds"] = ids
		}
		for k, v := range values {
			p[k] = v
		}
		r = p
	case "supplier.create":
		email := Text(b["email"], 160)
		if email != "" && !regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`).MatchString(email) {
			Fail("Enter a valid supplier email.")
		}
		r = M{"id": ID("SUP"), "name": Required(b["name"], "Supplier name", 160), "contact": Text(b["contact"], 500), "email": email, "terms": Text(Default(b["terms"], "Net 30"), 500), "createdAt": Now()}
		Prepend(s, "suppliers", r)
	case "warehouse.create":
		name := Required(b["name"], "Warehouse name", 160)
		Unique(Rows(s, "warehouses"), "name", name, "")
		r = M{"id": ID("WH"), "name": name, "location": Required(b["location"], "Location", 160), "type": Choice(b["type"], "local", "fba", "overseas")}
		s["warehouses"] = append(Rows(s, "warehouses"), r)
	case "purchase.create", "sale.create":
		Find(s, "warehouses", Str(b["warehouseId"]))
		lines := Lines(s, b["lines"])
		r = M{"id": ID("SO"), "warehouseId": b["warehouseId"], "lines": lines, "status": "draft", "paidCents": int64(0), "note": Text(b["note"], 500), "createdAt": Now(), "updatedAt": Now()}
		if Total(r) > 500000000 {
			Fail("Document total exceeds the supported limit.")
		}
		if action == "purchase.create" {
			Find(s, "suppliers", Str(b["supplierId"]))
			r["id"] = ID("PO")
			r["supplierId"] = b["supplierId"]
			r["expectedDate"] = Date(b["expectedDate"])
			Prepend(s, "purchases", r)
		} else {
			r["customer"] = Required(b["customer"], "Customer", 160)
			r["channel"] = Choice(b["channel"], "Amazon", "Shopify", "Direct", "Wholesale")
			r["refundCents"] = int64(0)
			Prepend(s, "sales", r)
		}
	case "purchase.transition":
		r = Find(s, "purchases", Str(b["id"]))
		rules := map[string][]string{"draft": {"pending", "cancelled"}, "pending": {"approved", "draft", "cancelled"}, "approved": {"ordered", "cancelled"}, "ordered": {"cancelled"}}
		if !In(Str(b["status"]), rules[Str(r["status"])]...) {
			Fail("Invalid purchase order transition.", 409)
		}
		if b["status"] == "cancelled" {
			if N(r["paidCents"]) > 0 {
				Fail("Paid or received orders cannot be cancelled.", 409)
			}
			for _, l := range Rows(r, "lines") {
				if N(l["received"]) > 0 {
					Fail("Paid or received orders cannot be cancelled.", 409)
				}
			}
		}
		r["status"] = b["status"]
		r["updatedAt"] = Now()
	case "purchase.receive":
		r = Find(s, "purchases", Str(b["id"]))
		if !In(Str(r["status"]), "ordered", "partial") {
			Fail("Only ordered or partially received purchases can be received.", 409)
		}
		for _, v := range Receipt(b["lines"], r, "received") {
			AddStock(s, Stock(s, Str(v.Line["productId"]), Str(r["warehouseId"])), v.Qty, N(v.Line["unitCents"]), "purchase_receipt", Str(r["id"]), user)
			v.Line["received"] = N(v.Line["received"]) + v.Qty
		}
		complete := true
		for _, l := range Rows(r, "lines") {
			if N(l["received"]) != N(l["qty"]) {
				complete = false
			}
		}
		r["status"] = "partial"
		if complete {
			r["status"] = "received"
		}
		r["updatedAt"] = Now()
	case "purchase.pay":
		r = Payment(s, Find(s, "purchases", Str(b["id"])), b, user, true)
	case "inventory.adjust":
		if Find(s, "products", Str(b["productId"]))["source"] == "mabang" {
			Fail("ERP inventory is read-only.", 422)
		}
		r = Stock(s, Str(b["productId"]), Str(b["warehouseId"]))
		delta := Int(b["delta"], "Adjustment quantity", -1000000, 1000000)
		if delta == 0 {
			Fail("Adjustment cannot be zero.")
		}
		reason := Required(b["reason"], "Adjustment reason", 300)
		if delta > 0 {
			AddStock(s, r, delta, Int(b["unitCents"], "Unit cost", 0, 10000000), "adjustment", reason, user)
		} else {
			RemoveStock(s, r, -delta, "adjustment", reason, user, false)
		}
	case "shipment.create":
		Find(s, "warehouses", Str(b["sourceId"]))
		Find(s, "warehouses", Str(b["destinationId"]))
		if b["sourceId"] == b["destinationId"] {
			Fail("Source and destination must be different.")
		}
		r = M{"id": ID("SHP"), "sourceId": b["sourceId"], "destinationId": b["destinationId"], "lines": Lines(s, b["lines"]), "status": "draft", "carrier": Required(b["carrier"], "Carrier", 160), "tracking": Text(b["tracking"], 500), "expectedDate": Date(b["expectedDate"]), "note": Text(b["note"], 500), "freightCents": Int(Default(b["freightCents"], 0), "Freight", 0, 100000000), "createdAt": Now(), "updatedAt": Now()}
		Prepend(s, "shipments", r)
	case "shipment.transition":
		r = Find(s, "shipments", Str(b["id"]))
		status := Str(b["status"])
		old := Str(r["status"])
		rules := map[string][]string{"draft": {"reserved", "cancelled"}, "reserved": {"in_transit", "cancelled"}, "in_transit": {"received"}}
		if !In(status, rules[old]...) {
			Fail("Invalid shipment transition.", 409)
		}
		if status == "reserved" {
			Reserve(s, r, Str(r["sourceId"]), false)
		}
		if old == "reserved" && status == "cancelled" {
			Reserve(s, r, Str(r["sourceId"]), true)
		}
		if status == "in_transit" {
			for _, l := range Rows(r, "lines") {
				cost, value := RemoveStock(s, Stock(s, Str(l["productId"]), Str(r["sourceId"])), N(l["qty"]), "transfer_out", Str(r["id"]), user, true)
				l["costCents"] = cost
				l["costTotalCents"] = value
			}
		}
		if status == "received" {
			for _, l := range Rows(r, "lines") {
				AddStock(s, Stock(s, Str(l["productId"]), Str(r["destinationId"])), N(l["qty"]), N(l["costCents"]), "transfer_in", Str(r["id"]), user, N(l["costTotalCents"]))
			}
		}
		r["status"] = status
		r["updatedAt"] = Now()
	case "sale.transition":
		r = Find(s, "sales", Str(b["id"]))
		status := Str(b["status"])
		old := Str(r["status"])
		rules := map[string][]string{"draft": {"confirmed", "cancelled"}, "confirmed": {"shipped", "cancelled"}, "shipped": {"completed"}}
		if !In(status, rules[old]...) {
			Fail("Invalid sales order transition.", 409)
		}
		if status == "confirmed" {
			Reserve(s, r, Str(r["warehouseId"]), false)
		}
		if status == "cancelled" {
			if N(r["paidCents"]) > 0 {
				Fail("Paid orders cannot be cancelled; use a shipped return.", 409)
			}
			if old == "confirmed" {
				Reserve(s, r, Str(r["warehouseId"]), true)
			}
		}
		if status == "shipped" {
			for _, l := range Rows(r, "lines") {
				cost, value := RemoveStock(s, Stock(s, Str(l["productId"]), Str(r["warehouseId"])), N(l["qty"]), "sale", Str(r["id"]), user, true)
				l["costCents"] = cost
				l["costTotalCents"] = value
				l["returnedCostCents"] = int64(0)
			}
			r["shippedAt"] = Now()
		}
		r["status"] = status
		r["updatedAt"] = Now()
	case "sale.return":
		r = Find(s, "sales", Str(b["id"]))
		if !In(Str(r["status"]), "shipped", "completed") {
			Fail("Only shipped orders can be returned.", 409)
		}
		var refund int64
		for _, v := range Receipt(b["lines"], r, "returned") {
			l := v.Line
			returned := Allocate(N(l["costTotalCents"]), N(l["returned"])+v.Qty, N(l["qty"]))
			delta := returned - N(l["returnedCostCents"])
			AddStock(s, Stock(s, Str(l["productId"]), Str(r["warehouseId"])), v.Qty, Allocate(delta, 1, v.Qty), "sales_return", Str(r["id"]), user, delta)
			l["returned"] = N(l["returned"]) + v.Qty
			l["returnedCostCents"] = returned
			refund += v.Qty * N(l["unitCents"])
		}
		r["refundCents"] = N(r["refundCents"]) + refund
		cash := N(r["paidCents"]) - (Total(r) - N(r["refundCents"]))
		if cash > 0 {
			r["paidCents"] = N(r["paidCents"]) - cash
			Prepend(s, "payments", M{"id": ID("REF"), "kind": "outflow", "reference": r["id"], "amountCents": cash, "date": Date(nil), "note": "Sales return refund", "actor": user["name"], "createdAt": Now()})
		}
		r["updatedAt"] = Now()
	case "sale.pay":
		r = Payment(s, Find(s, "sales", Str(b["id"])), b, user, false)
	case "expense.create":
		r = M{"id": ID("EXP"), "category": Choice(b["category"], "Advertising", "Logistics", "Software", "Operations", "Other"), "amountCents": Int(b["amountCents"], "Expense amount", 1, 100000000), "date": Date(b["date"]), "description": Required(b["description"], "Description", 300), "createdAt": Now()}
		Prepend(s, "expenses", r)
	case "campaign.create":
		r = M{"id": ID("AD"), "name": Required(b["name"], "Campaign name", 160), "channel": Choice(b["channel"], "Amazon", "Shopify", "Direct"), "budgetCents": Int(b["budgetCents"], "Budget", 0, 100000000), "spendCents": Int(b["spendCents"], "Spend", 0, 100000000), "attributedSalesCents": Int(b["attributedSalesCents"], "Attributed sales", 0, 100000000), "status": "active", "createdAt": Now()}
		Prepend(s, "campaigns", r)
	case "campaign.update":
		r = Find(s, "campaigns", Str(b["id"]))
		r["status"] = Choice(b["status"], "active", "paused")
	case "ticket.create":
		if Str(b["orderId"]) != "" {
			Find(s, "sales", Str(b["orderId"]))
		}
		r = M{"id": ID("TKT"), "customer": Required(b["customer"], "Customer", 160), "subject": Required(b["subject"], "Subject", 160), "category": Choice(b["category"], "Order", "Return", "Quality", "Other"), "priority": Choice(b["priority"], "normal", "high"), "orderId": Str(b["orderId"]), "status": "open", "notes": []M{{"text": Required(b["message"], "Message", 2000), "actor": user["name"], "at": Now()}}, "createdAt": Now()}
		Prepend(s, "tickets", r)
	case "ticket.transition":
		r = Find(s, "tickets", Str(b["id"]))
		if b["status"] != nil {
			r["status"] = Choice(b["status"], "open", "in_progress", "resolved")
		}
		if Str(b["note"]) != "" {
			r["notes"] = append(Rows(r, "notes"), M{"text": Required(b["note"], "Note", 2000), "actor": user["name"], "at": Now()})
		}
	case "task.create":
		r = M{"id": ID("TASK"), "title": Required(b["title"], "Task title", 160), "owner": Text(Default(b["owner"], user["name"]), 160), "dueDate": Date(b["dueDate"]), "priority": Choice(Default(b["priority"], "normal"), "normal", "high"), "status": "open", "createdAt": Now()}
		Prepend(s, "tasks", r)
	case "task.transition":
		r = Find(s, "tasks", Str(b["id"]))
		r["status"] = Choice(b["status"], "open", "done")
	case "settings.update":
		r = Obj(s["settings"])
		r["company"] = Required(b["company"], "Company name", 160)
		r["timezone"] = Choice(b["timezone"], "Asia/Shanghai", "America/New_York", "Europe/London", "UTC")
		r["lowStockDays"] = Int(b["lowStockDays"], "Stock coverage threshold", 1, 90)
	case "user.create":
		email := strings.ToLower(Required(b["email"], "Email", 160))
		if !regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`).MatchString(email) {
			Fail("Enter a valid email.")
		}
		Unique(Rows(s, "users"), "email", email, "")
		password := Required(b["password"], "Password", 72)
		if len(password) < 10 {
			Fail("Passwords must contain at least 10 characters.")
		}
		r = M{"id": ID("USR"), "name": Required(b["name"], "Name", 160), "email": email, "role": Required(b["role"], "Role", 64), "passwordHash": HashPassword(password), "active": true}
		s["users"] = append(Rows(s, "users"), r)
	case "user.update":
		r = Find(s, "users", Str(b["id"]))
		if _, ok := b["active"].(bool); !ok {
			Fail("Active state must be a boolean.")
		}
		role := Required(b["role"], "Role", 64)
		if r["id"] == user["id"] && In("admin", Strings(user["roles"])...) && (role != "admin" || !Bool(b["active"])) {
			Fail("You cannot remove your own administrator access.", 409)
		}
		r["role"] = role
		r["active"] = b["active"]
	default:
		Fail("Unknown action.", 404)
	}
	for _, row := range Rows(s, "stocks") {
		if N(row["onHand"]) < 0 || N(row["locked"]) < 0 || N(row["locked"]) > N(row["onHand"]) || N(row["valueCents"]) < 0 || (N(row["onHand"]) == 0 && N(row["valueCents"]) != 0) {
			Fail("Inventory invariant violated.", 409)
		}
	}
	s["version"] = N(s["version"]) + 1
	Prepend(s, "audit", M{"id": ID("AUD"), "action": action, "reference": Str(r["id"]), "actor": user["name"], "at": Now()})
	if len(Rows(s, "audit")) > 5000 {
		s["audit"] = Rows(s, "audit")[:5000]
	}
	return s, r, nil
}

//go:embed seed.json
var seedJSON []byte

func Seed() M {
	var s M
	if e := json.Unmarshal(seedJSON, &s); e != nil {
		panic(e)
	}
	dates := []string{}
	for _, o := range Rows(s, "sales") {
		dates = append(dates, Str(o["shippedAt"]))
	}
	sort.Strings(dates)
	if len(dates) > 0 {
		last, _ := time.Parse(time.RFC3339Nano, dates[len(dates)-1])
		delta := time.Since(last).Truncate(24 * time.Hour)
		for _, o := range Rows(s, "sales") {
			for _, k := range []string{"shippedAt", "createdAt"} {
				if d, e := time.Parse(time.RFC3339Nano, Str(o[k])); e == nil {
					o[k] = d.Add(delta).Format(time.RFC3339Nano)
				}
			}
		}
	}
	return s
}
func Migrate(s M) {
	for _, r := range Rows(s, "stocks") {
		if r["valueCents"] == nil {
			r["valueCents"] = N(r["onHand"]) * N(r["averageCostCents"])
		}
	}
	for _, col := range []string{"sales", "shipments"} {
		for _, o := range Rows(s, col) {
			for _, l := range Rows(o, "lines") {
				if l["costCents"] != nil && l["costTotalCents"] == nil {
					l["costTotalCents"] = N(l["qty"]) * N(l["costCents"])
					l["returnedCostCents"] = N(l["returned"]) * N(l["costCents"])
				}
			}
		}
	}
}
