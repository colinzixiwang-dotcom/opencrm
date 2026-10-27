// Package support implements configurable RMA workflows with owner-scoped records.
package support

import (
	"fmt"
	"harbor/internal/domain"
	"regexp"
	"strings"
	"time"
)

type M = domain.M

var primary = []string{"device_issue", "user_issue", "logistics_issue"}

func Admin(u M) bool   { return domain.In("admin", domain.Strings(u["roles"])...) }
func Config(s M) M     { return domain.Obj(s["supportConfig"]) }
func enabled(m M) bool { return domain.Bool(m["enabled"]) }
func lookup(rows []M, id string) M {
	for _, r := range rows {
		if domain.Str(r["id"]) == id {
			return r
		}
	}
	domain.Fail("Record not found.", 404)
	return nil
}
func active(rows []M, id string) M {
	r := lookup(rows, id)
	if !enabled(r) {
		domain.Fail("This option is disabled.", 409)
	}
	return r
}
func Ensure(s M) {
	defer normalize(s)
	defer ensureReship(s)
	defer ensureWarranty(s)
	for _, k := range []string{"rmas", "rmaTasks", "supportOrders", "serials", "benefitHistory"} {
		if s[k] == nil {
			s[k] = []M{}
		}
	}
	if s["supportConfig"] != nil {
		return
	}
	types := []M{}
	for _, x := range []struct {
		id, name, direction string
		amount, code        bool
	}{{"gift_card", "Send gift card", "none", true, true}, {"send_parts", "Send part(s)", "outbound", false, false}, {"send_device", "Send device", "outbound", false, false}, {"return_device", "Return device", "inbound", false, false}, {"refund", "Refund", "none", true, false}, {"promo_code", "Send promo code", "none", false, true}} {
		types = append(types, M{"id": x.id, "name": x.name, "enabled": true, "direction": x.direction, "hasAmount": x.amount, "requiresCode": x.code, "requiresProduct": x.direction != "none", "builtIn": true})
	}
	node := func(key, kind string, deps ...string) M {
		return M{"key": key, "typeId": kind, "dependsOn": append([]string{}, deps...), "amountCents": int64(0), "qty": int64(1), "productId": ""}
	}
	s["supportConfig"] = M{"revision": int64(1), "taskTypes": types, "platforms": []M{{"id": "Amazon", "name": "Amazon", "enabled": true}, {"id": "Shopify", "name": "Shopify", "enabled": true}, {"id": "Direct", "name": "Direct", "enabled": true}, {"id": "Wholesale", "name": "Wholesale", "enabled": true}}, "rootCauses": []M{{"id": "device_fault", "name": "Device malfunction", "primary": "device_issue", "enabled": true, "productIds": []string{}}, {"id": "setup_help", "name": "Setup or usage issue", "primary": "user_issue", "enabled": true, "productIds": []string{}}, {"id": "transit_damage", "name": "Damaged in transit", "primary": "logistics_issue", "enabled": true, "productIds": []string{}}}, "solutions": []M{{"id": "replacement", "name": "Return and replace", "enabled": true, "nodes": []M{node("return", "return_device"), node("replacement", "send_device", "return")}}, {"id": "refund", "name": "Return and refund", "enabled": true, "nodes": []M{node("return", "return_device"), node("refund", "refund", "return")}}, {"id": "parts", "name": "Send replacement parts", "enabled": true, "nodes": []M{node("parts", "send_parts")}}, {"id": "goodwill", "name": "Gift card and promo code", "enabled": true, "nodes": []M{node("gift", "gift_card"), node("promo", "promo_code")}}}, "rules": []M{{"id": "gift_over_100", "name": "Gift card above $100", "enabled": true, "typeId": "gift_card", "field": "amountCents", "operator": "gt", "value": int64(10000)}}, "fields": []M{}}
}
func own(r, u M) {
	if !Admin(u) && r["ownerId"] != u["id"] {
		domain.Fail("RMA not found.", 404)
	}
}
func canView(u M, module string) bool {
	return Admin(u) || domain.In("erp:"+module+":view", domain.Strings(u["permissionCodes"])...)
}

// Public is applied to every support read, including CSV exports and detail requests.
func Public(s, u M) M {
	visible := map[string]bool{}
	rmas := []M{}
	if canView(u, "rma") {
		for _, r := range domain.Rows(s, "rmas") {
			if Admin(u) || r["ownerId"] == u["id"] {
				rmas = append(rmas, r)
				visible[domain.Str(r["id"])] = true
			}
		}
	}
	s["rmas"] = rmas
	for _, col := range []string{"rmaTasks", "benefitHistory"} {
		rows := []M{}
		for _, r := range domain.Rows(s, col) {
			if visible[domain.Str(r["rmaId"])] {
				rows = append(rows, r)
			}
		}
		s[col] = rows
	}
	if !canView(u, "supportorders") {
		s["supportOrders"] = []M{}
	}
	if !canView(u, "serials") {
		s["serials"] = []M{}
	}
	if !Admin(u) {
		c := domain.Clone(Config(s))
		for _, col := range []string{"solutions", "rootCauses", "platforms", "taskTypes", "fields"} {
			rows := []M{}
			for _, r := range domain.Rows(c, col) {
				if enabled(r) {
					rows = append(rows, r)
				}
			}
			c[col] = rows
		}
		c["rules"] = []M{}
		s["supportConfig"] = c
		rows := []M{}
		for _, r := range domain.Rows(s, "audit") {
			if !strings.HasPrefix(domain.Str(r["action"]), "rma") && !strings.HasPrefix(domain.Str(r["action"]), "support") {
				rows = append(rows, r)
			}
		}
		s["audit"] = rows
	}
	return s
}
func Get(s, u M, id string) M {
	r := lookup(domain.Rows(s, "rmas"), id)
	own(r, u)
	if !canView(u, "rma") {
		domain.Fail("Access denied.", 403)
	}
	tasks := []M{}
	for _, t := range domain.Rows(s, "rmaTasks") {
		if t["rmaId"] == id {
			tasks = append(tasks, t)
		}
	}
	return M{"rma": r, "tasks": tasks}
}
func custom(c M, scope, kind string, input any, prior ...any) M {
	in := domain.Obj(input)
	out := M{}
	if len(prior) > 0 {
		out = domain.Clone(domain.Obj(prior[0]))
	}
	for _, f := range domain.Rows(c, "fields") {
		if !enabled(f) || domain.Str(f["scope"]) != scope || (domain.Str(f["typeId"]) != "" && domain.Str(f["typeId"]) != kind) {
			continue
		}
		key := domain.Str(f["id"])
		delete(out, key)
		v := in[key]
		if v == nil || v == "" {
			if domain.Bool(f["required"]) {
				domain.Fail(domain.Str(f["name"]) + " is required.")
			}
			continue
		}
		switch f["fieldType"] {
		case "number":
			out[key] = domain.Int(v, domain.Str(f["name"]), 0, 100000000)
		case "select":
			str := domain.Required(v, domain.Str(f["name"]), 200)
			if !domain.In(str, domain.Strings(f["options"])...) {
				domain.Fail("Invalid option for " + domain.Str(f["name"]) + ".")
			}
			out[key] = str
		case "date":
			out[key] = domain.Date(v)
		default:
			out[key] = domain.Required(v, domain.Str(f["name"]), 2000)
		}
	}
	return out
}
func taskStatus(t M, tasks []M) string {
	if domain.In(domain.Str(t["status"]), "completed", "cancelled") {
		return domain.Str(t["status"])
	}
	if t["approval"] == "rejected" {
		return "rejected"
	}
	if t["approval"] == "pending" {
		return "pending_approval"
	}
	for _, id := range domain.Strings(t["dependsOn"]) {
		if lookup(tasks, id)["status"] != "completed" {
			return "blocked"
		}
	}
	if t["startedAt"] != nil {
		return "in_progress"
	}
	return "ready"
}
func refresh(s M) {
	tasks := domain.Rows(s, "rmaTasks")
	for _, t := range tasks {
		t["status"] = taskStatus(t, tasks)
	}
	for _, r := range domain.Rows(s, "rmas") {
		done, total, rejected, pending := 0, 0, false, false
		for _, t := range tasks {
			if t["rmaId"] != r["id"] {
				continue
			}
			total++
			if t["status"] == "completed" {
				done++
			}
			rejected = rejected || t["approval"] == "rejected"
			pending = pending || t["approval"] == "pending"
		}
		status := "in_progress"
		if done == total && total > 0 {
			status = "completed"
		} else if rejected {
			status = "needs_attention"
		} else if pending {
			status = "pending_approval"
		}
		r["status"] = status
		r["completedTasks"] = done
		r["taskCount"] = total
	}
}
func approval(c, t, r M) (bool, []string) {
	mandatory := domain.In(domain.Str(t["typeId"]), "refund", "return_device") || t["direction"] == "inbound"
	always := domain.Bool(domain.Obj(t["typeSnapshot"])["alwaysApprove"])
	required := mandatory || always || domain.Bool(t["reshipRequiresApproval"])
	reasons := []string{}
	if domain.Bool(t["reshipRequiresApproval"]) {
		reasons = append(reasons, "SKU requires reshipment approval")
	}
	if always {
		reasons = append(reasons, "Task type always requires approval")
	}
	if mandatory {
		reasons = append(reasons, "Returns and refunds always require approval")
	}
	for _, rule := range domain.Rows(c, "rules") {
		if !enabled(rule) || (rule["typeId"] != "*" && rule["typeId"] != t["typeId"]) {
			continue
		}
		var v any
		switch rule["field"] {
		case "amountCents", "qty":
			v = t[domain.Str(rule["field"])]
		default:
			v = r[domain.Str(rule["field"])]
		}
		match := false
		switch rule["operator"] {
		case "always":
			match = true
		case "gt":
			match = domain.N(v) > domain.N(rule["value"])
		case "gte":
			match = domain.N(v) >= domain.N(rule["value"])
		case "eq":
			match = fmt.Sprint(v) == fmt.Sprint(rule["value"])
		}
		if match {
			required = true
			reasons = append(reasons, domain.Str(rule["name"]))
		}
	}
	return required, reasons
}
func values(s, c, t, b M) {
	t["amountCents"] = domain.Int(domain.Default(b["amountCents"], 0), "Amount", 0, 500000000)
	t["qty"] = domain.Int(domain.Default(b["qty"], 1), "Quantity", 1, 1000000)
	p := domain.Str(b["productId"])
	validateProduct(s, t, p)
	t["productId"] = p
	if p != "" && domain.In(domain.Str(t["typeId"]), "send_device", "send_parts") {
		product := domain.Find(s, "products", p)
		t["reshipRequiresApproval"] = domain.ReshipApprovalRequired(product)
		t["productPolicySnapshot"] = domain.Clone(product)
	}
	t["customFields"] = custom(c, "task", domain.Str(t["typeId"]), b["customFields"], t["customFields"])
}
func Mutate(original M, action string, b, u M) (s, result M, err error) {
	defer func() {
		if v := recover(); v != nil {
			if e, ok := v.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("%v", v)
			}
			s = nil
			result = nil
		}
	}()
	s = domain.Clone(original)
	Ensure(s)
	c := Config(s)
	if !domain.HasAction(u, action) {
		domain.Fail("Your role does not permit this action.", 403)
	}
	if domain.In(action, "rmaconfig.save", "rma.create") && b["expectedConfigRevision"] != nil && domain.Int(b["expectedConfigRevision"], "Configuration revision", 1, 1000000000) != domain.N(c["revision"]) {
		domain.Fail("Support configuration changed. Close this form and reopen it before saving.", 409)
	}
	switch action {
	case "warranty.save":
		if !Admin(u) {
			domain.Fail("Only administrators may configure warranty rules.", 403)
		}
		result = saveWarranty(s, b)
	case "rmaconfig.save":
		if !Admin(u) {
			domain.Fail("Only administrators may configure support workflows.", 403)
		}
		result = saveConfig(s, b)
	case "supportorder.save":
		if !Admin(u) {
			domain.Fail("Only administrators may manage support orders.", 403)
		}
		id := domain.Str(b["id"])
		number := domain.Required(b["orderNumber"], "Order number", 160)
		platform := active(domain.Rows(c, "platforms"), domain.Str(b["platform"]))
		for _, o := range domain.Rows(s, "supportOrders") {
			if o["id"] != id && strings.EqualFold(domain.Str(o["orderNumber"]), number) && o["platform"] == platform["id"] {
				domain.Fail("Order number already exists on this platform.", 409)
			}
		}
		product := domain.Str(b["productId"])
		domain.Find(s, "products", product)
		result = M{"id": id, "orderNumber": number, "platform": platform["id"], "customer": domain.Required(b["customer"], "Customer", 160), "productId": product, "status": domain.Choice(b["status"], "placed", "paid", "shipped", "delivered", "cancelled"), "purchasedAt": domain.Date(b["purchasedAt"]), "customFields": custom(c, "order", "", b["customFields"], priorFields(s, "supportOrders", id)), "updatedAt": domain.Now()}
		upsert(s, "supportOrders", result, "ORD")
	case "serial.save":
		if !Admin(u) {
			domain.Fail("Only administrators may manage serial numbers.", 403)
		}
		id := domain.Str(b["id"])
		sn := domain.Required(b["sn"], "Serial number", 120)
		domain.Unique(domain.Rows(s, "serials"), "sn", sn, id)
		product := domain.Find(s, "products", domain.Str(b["productId"]))
		kind := domain.Choice(b["kind"], "device", "printhead")
		if (kind == "device" && product["productType"] != "device") || (kind == "printhead" && (product["productType"] != "part" || product["partKind"] != "printhead")) {
			domain.Fail("Serial type must match the selected device or printhead SKU.")
		}
		if id != "" {
			old := lookup(domain.Rows(s, "serials"), id)
			changed := old["sn"] != sn || old["kind"] != kind || old["productId"] != product["id"]
			if changed {
				linked := false
				for _, r := range domain.Rows(s, "rmas") {
					linked = linked || strings.EqualFold(domain.Str(r["sn"]), domain.Str(old["sn"]))
				}
				for _, r := range domain.Rows(s, "serials") {
					linked = linked || strings.EqualFold(domain.Str(r["parentSn"]), domain.Str(old["sn"]))
				}
				if linked {
					domain.Fail("Serial identity is linked to a device or RMA and cannot be changed. Status, order and parent links remain editable.", 409)
				}
			}
		}
		parent := domain.Str(b["parentSn"])
		if parent != "" {
			if strings.EqualFold(parent, sn) {
				domain.Fail("A serial cannot contain itself.")
			}
			found := false
			for _, r := range domain.Rows(s, "serials") {
				if strings.EqualFold(domain.Str(r["sn"]), parent) && r["kind"] == "device" {
					found = true
				}
			}
			if !found {
				domain.Fail("Parent device serial not found.")
			}
			if kind != "printhead" {
				domain.Fail("Only printheads can link to a parent device.")
			}
		}
		result = M{"id": id, "sn": sn, "kind": kind, "productId": product["id"], "parentSn": parent, "orderNumber": domain.Text(b["orderNumber"], 160), "status": domain.Choice(b["status"], "in_stock", "sold", "returned", "replaced", "retired"), "customFields": custom(c, "serial", "", b["customFields"], priorFields(s, "serials", id)), "updatedAt": domain.Now()}
		upsert(s, "serials", result, "SN")
	case "rma.create":
		platform := active(domain.Rows(c, "platforms"), domain.Str(b["platform"]))
		product := domain.Find(s, "products", domain.Str(b["productId"]))
		root := active(domain.Rows(c, "rootCauses"), domain.Str(b["rootCauseId"]))
		ids := domain.Strings(root["productIds"])
		if len(ids) > 0 && !domain.In(domain.Str(product["id"]), ids...) {
			domain.Fail("This root cause does not apply to the selected SKU.")
		}
		solution := active(domain.Rows(c, "solutions"), domain.Str(b["solutionId"]))
		if domain.Str(b["draftId"]) != "" || solution["id"] == "reship_device" {
			if !domain.In(domain.Str(solution["id"]), "reship_device", "parts") {
				domain.Fail("Ticket RMAs support only whole-unit or parts reshipment.", 422)
			}
			if len(domain.Obj(b["originalOrder"])) == 0 {
				domain.Fail("Confirm the original order and affected item before creating the RMA.", 422)
			}
			domain.Required(b["solutionReason"], "Solution reason", 2000)
			domain.Required(domain.Obj(b["warrantyEvidence"])["evidenceReference"], "Delivery evidence reference", 1000)
			for _, n := range domain.Rows(solution, "nodes") {
				expected := "send_device"
				if solution["id"] == "parts" {
					expected = "send_parts"
				}
				if n["typeId"] != expected {
					domain.Fail("Reship solution configuration is invalid.", 422)
				}
				input := domain.Obj(domain.Obj(b["taskInputs"])[domain.Str(n["key"])])

				if solution["id"] == "parts" && b["reshipItems"] == nil {
					domain.Required(input["productId"], "Replacement part", 160)
					domain.Int(input["qty"], "Quantity", 1, 1000000)
				}
			}
		}
		// Ticket reship requests own explicit lines, independent of the purchased item.
		lines := []M{}
		if domain.Str(b["draftId"]) != "" || solution["id"] == "reship_device" {
			if raw, exists := b["reshipItems"]; exists {
				rows, ok := raw.([]any)
				if !ok || len(rows) == 0 || len(rows) > 50 {
					domain.Fail("Add between 1 and 50 reshipment lines.", 422)
				}
				if len(domain.Rows(solution, "nodes")) != 1 {
					domain.Fail("Reship solution configuration is invalid.", 422)
				}
				template := domain.Rows(solution, "nodes")[0]
				nodes := []M{}
				inputs := M{}
				seen := map[string]bool{}
				for i, v := range rows {
					line, ok := v.(map[string]any)
					if !ok {
						domain.Fail("Invalid reshipment line.", 422)
					}
					id := domain.Required(line["productId"], "Reship SKU", 160)
					if seen[id] {
						domain.Fail("Duplicate reship SKU. Combine quantities.", 422)
					}
					seen[id] = true
					p := domain.Find(s, "products", id)
					if p["source"] == "mabang" && (p["sourcePresent"] == false) {
						domain.Fail("This SKU is no longer present in the source catalog.", 422)
					}
					qty := domain.Int(line["qty"], "Quantity", 1, 1000000)
					node := domain.Clone(template)
					key := fmt.Sprintf("%s-%d", domain.Str(template["key"]), i+1)
					node["key"] = key
					node["productId"] = id
					node["qty"] = qty
					nodes = append(nodes, node)
					inputs[key] = M{"productId": id, "qty": qty}
					lines = append(lines, M{"productId": id, "sku": p["sku"], "name": p["name"], "qty": qty, "productType": p["productType"], "policyRevision": p["policyRevision"]})
				}
				solution = domain.Clone(solution)
				solution["nodes"] = nodes
				b["taskInputs"] = inputs
			}
		}
		assessment := Assess(s, b, time.Now())
		if domain.Str(b["draftId"]) != "" || solution["id"] == "reship_device" {
			if assessment["status"] != "covered" && domain.Bool(assessment["eligible"]) {
				domain.Fail("Warranty coverage must be confirmed before creating this RMA.", 422)
			}
			assessment["evidenceProvenance"] = M{"source": "agent_entered", "reference": domain.Obj(b["warrantyEvidence"])["evidenceReference"], "recordedById": u["id"], "recordedBy": u["name"], "recordedAt": domain.Now()}
		}
		if !domain.Bool(assessment["eligible"]) {
			domain.Fail(domain.Str(assessment["reason"]), 422)
		}
		if b["expectedWarrantyRevision"] != nil && domain.N(b["expectedWarrantyRevision"]) != domain.N(assessment["policyRevision"]) {
			domain.Fail("Warranty policy changed. Reload before creating the RMA.", 409)
		}
		sn := domain.Text(b["sn"], 120)
		if sn != "" {
			found := false
			for _, serial := range domain.Rows(s, "serials") {
				if strings.EqualFold(domain.Str(serial["sn"]), sn) && serial["productId"] == product["id"] {
					found = true
				}
			}
			if !found {
				domain.Fail("Serial number does not match the selected SKU.")
			}
		}
		result = M{"id": domain.ID("RMA"), "ownerId": u["id"], "ownerName": u["name"], "ticketNumber": domain.Required(b["ticketNumber"], "Support ticket number", 160), "orderNumber": domain.Required(b["orderNumber"], "Order number", 160), "platform": platform["id"], "platformName": platform["name"], "productId": product["id"], "sn": sn, "rootCauseId": root["id"], "rootCauseName": root["name"], "primaryCause": root["primary"], "description": domain.Required(b["description"], "Description", 4000), "solutionId": solution["id"], "solutionName": solution["name"], "eligibilityAssessment": assessment, "solutionSnapshot": domain.Clone(solution), "configRevision": c["revision"], "customFields": custom(c, "rma", "", b["customFields"]), "createdAt": domain.Now(), "updatedAt": domain.Now()}
		result["originalOrder"] = b["originalOrder"]
		result["solutionReason"] = domain.Text(b["solutionReason"], 2000)
		result["reshipItems"] = lines
		result["originalProductSnapshot"] = M{"id": product["id"], "sku": product["sku"], "name": product["name"], "policyRevision": product["policyRevision"]}
		inputs := domain.Obj(b["taskInputs"])
		taskIDs := map[string]string{}
		for _, n := range domain.Rows(solution, "nodes") {
			taskIDs[domain.Str(n["key"])] = domain.ID("RT")
		}
		for _, n := range domain.Rows(solution, "nodes") {
			typ := active(domain.Rows(c, "taskTypes"), domain.Str(n["typeId"]))
			input := domain.Clone(n)
			for k, v := range domain.Obj(inputs[domain.Str(n["key"])]) {
				if domain.In(k, "amountCents", "qty", "productId", "customFields") {
					input[k] = v
				}
			}
			if domain.Str(input["productId"]) == "" && typ["requiresProduct"] == true && product["productType"] == "device" && typ["id"] != "send_parts" {
				input["productId"] = product["id"]
			}
			t := M{"id": taskIDs[domain.Str(n["key"])], "key": n["key"], "rmaId": result["id"], "ownerId": u["id"], "revision": int64(1), "affectedProductId": product["id"], "typeId": typ["id"], "typeName": typ["name"], "typeSnapshot": domain.Clone(typ), "direction": typ["direction"], "approval": "not_required", "status": "ready", "createdAt": domain.Now(), "updatedAt": domain.Now(), "events": []M{}}
			values(s, c, t, input)
			deps := []string{}
			for _, key := range domain.Strings(n["dependsOn"]) {
				deps = append(deps, taskIDs[key])
			}
			t["dependsOn"] = deps
			needed, reasons := approval(c, t, result)
			t["approvalRequired"] = needed
			t["approvalReasons"] = reasons
			if needed {
				t["approval"] = "pending"
			}
			domain.Prepend(s, "rmaTasks", t)
		}
		domain.Prepend(s, "rmas", result)
	case "rma.note":
		r := lookup(domain.Rows(s, "rmas"), domain.Str(b["id"]))
		own(r, u)
		notes := domain.Rows(r, "notes")
		notes = append(notes, M{"id": domain.ID("NOTE"), "text": domain.Required(b["text"], "Note", 2000), "actor": u["name"], "at": domain.Now()})
		r["notes"] = notes
		r["updatedAt"] = domain.Now()
		result = r
	case "rmatask.update", "rmatask.review", "rmatask.execute":
		t := lookup(domain.Rows(s, "rmaTasks"), domain.Str(b["id"]))
		r := lookup(domain.Rows(s, "rmas"), domain.Str(t["rmaId"]))
		own(r, u)
		if domain.N(b["expectedRevision"]) != domain.N(t["revision"]) {
			domain.Fail("This task changed. Refresh the workspace before saving or reviewing it.", 409)
		}
		if action != "rmatask.update" && !Admin(u) {
			domain.Fail("Only administrators may review or execute support tasks.", 403)
		}
		if t["status"] == "completed" {
			domain.Fail("Completed tasks cannot be changed.", 409)
		}
		event := M{"actor": u["name"], "actorId": u["id"], "at": domain.Now(), "action": action}
		if action == "rmatask.update" {
			if t["startedAt"] != nil {
				domain.Fail("Started tasks cannot be reconfigured.", 409)
			}
			values(s, c, t, b)
			needed, reasons := approval(c, t, r)
			t["approvalRequired"] = needed
			t["approvalReasons"] = reasons
			t["approval"] = "not_required"
			if needed {
				t["approval"] = "pending"
			}
			delete(t, "reviewedBy")
			delete(t, "reviewedAt")
			event["note"] = domain.Text(b["note"], 2000)
		} else if action == "rmatask.review" {
			if t["approval"] != "pending" {
				domain.Fail("Only pending approvals can be reviewed.", 409)
			}
			decision := domain.Choice(b["decision"], "approved", "rejected")
			note := domain.Required(b["note"], "Review reason", 2000)
			t["approval"] = decision
			t["reviewedBy"] = u["id"]
			t["reviewedAt"] = domain.Now()
			event["note"] = note
			event["decision"] = decision
		} else {
			status := taskStatus(t, domain.Rows(s, "rmaTasks"))
			if !domain.In(status, "ready", "in_progress") {
				domain.Fail("Task must be approved and all prerequisites completed before execution.", 409)
			}
			op := domain.Choice(b["operation"], "start", "dispatch", "complete")
			typ := domain.Obj(t["typeSnapshot"])
			if domain.Bool(typ["hasAmount"]) && domain.N(t["amountCents"]) <= 0 {
				domain.Fail("Enter a positive task amount before execution.")
			}
			validateProduct(s, t, domain.Str(t["productId"]))
			if domain.In(domain.Str(t["typeId"]), "send_device", "send_parts") && domain.Str(t["productId"]) != "" && domain.ReshipApprovalRequired(domain.Find(s, "products", domain.Str(t["productId"]))) && t["approval"] != "approved" {
				domain.Fail("SKU now requires approval. Update the task and obtain approval before execution.", 409)
			}
			if domain.Bool(typ["requiresProduct"]) && domain.Str(t["productId"]) == "" {
				domain.Fail("Choose a task SKU before execution.")
			}
			reference := domain.Text(b["reference"], 200)
			tracking := domain.Text(b["tracking"], 200)
			carrier := domain.Text(b["carrier"], 120)
			code := domain.Text(b["code"], 200)
			if op == "dispatch" && t["direction"] == "none" {
				domain.Fail("This task has no logistics.")
			}
			if op == "dispatch" || (op == "complete" && t["direction"] != "none" && t["dispatchedAt"] == nil) {
				if tracking == "" || carrier == "" {
					domain.Fail("Carrier and tracking number are required.")
				}
				t["tracking"] = tracking
				t["carrier"] = carrier
				t["dispatchedAt"] = domain.Now()
			}
			if op == "complete" && domain.Bool(typ["requiresCode"]) && code == "" {
				domain.Fail("A sent code or gift card reference is required.")
			}
			if op == "complete" && t["typeId"] == "refund" && reference == "" {
				domain.Fail("A refund transaction reference is required.")
			}
			t["startedAt"] = domain.Now()
			if op == "complete" {
				t["executionFields"] = custom(c, "execution", domain.Str(t["typeId"]), b["executionFields"])
				t["status"] = "completed"
				t["completedAt"] = domain.Now()
				t["completedBy"] = u["name"]
				t["reference"] = reference
				t["code"] = code
				if domain.In(domain.Str(t["typeId"]), "gift_card", "promo_code") {
					domain.Prepend(s, "benefitHistory", M{"id": domain.ID("BEN"), "rmaId": r["id"], "taskId": t["id"], "ownerId": r["ownerId"], "typeId": t["typeId"], "code": code, "amountCents": t["amountCents"], "platform": r["platform"], "orderNumber": r["orderNumber"], "sentBy": u["name"], "sentAt": domain.Now()})
				}
			}
			event["operation"] = op
			event["note"] = domain.Text(b["note"], 2000)
		}
		event["snapshot"] = M{"amountCents": t["amountCents"], "qty": t["qty"], "productId": t["productId"], "customFields": domain.Clone(domain.Obj(t["customFields"])), "approval": t["approval"], "revision": t["revision"]}
		t["revision"] = domain.N(t["revision"]) + 1
		t["events"] = append(domain.Rows(t, "events"), event)
		t["updatedAt"] = domain.Now()
		r["updatedAt"] = domain.Now()
		result = t
	default:
		domain.Fail("Unknown support action.", 404)
	}
	refresh(s)
	s["version"] = domain.N(s["version"]) + 1
	domain.Prepend(s, "audit", M{"id": domain.ID("AUD"), "action": action, "reference": result["id"], "actor": u["name"], "at": domain.Now()})
	if len(domain.Rows(s, "audit")) > 5000 {
		s["audit"] = domain.Rows(s, "audit")[:5000]
	}
	return s, result, nil
}
func upsert(s M, col string, r M, prefix string) {
	id := domain.Str(r["id"])
	if id == "" {
		r["id"] = domain.ID(prefix)
		r["createdAt"] = domain.Now()
		domain.Prepend(s, col, r)
		return
	}
	old := lookup(domain.Rows(s, col), id)
	r["createdAt"] = old["createdAt"]
	for k := range old {
		delete(old, k)
	}
	for k, v := range r {
		old[k] = v
	}
}
func saveConfig(s, b M) M {
	c := Config(s)
	entity := domain.Choice(b["entity"], "solutions", "rules", "rootCauses", "platforms", "fields", "taskTypes")
	r := domain.Clone(domain.Obj(b["record"]))
	r["name"] = domain.Required(r["name"], "Name", 120)
	if _, ok := r["enabled"].(bool); !ok {
		domain.Fail("Enabled must be a boolean.")
	}
	id := domain.Str(r["id"])
	if id == "" {
		id = domain.ID("CFG")
		r["id"] = id
	}
	if !safeKey(id) {
		domain.Fail("Use letters, digits, underscores or hyphens for keys.")
	}
	switch entity {
	case "rootCauses":
		r["primary"] = domain.Choice(r["primary"], primary...)
		ids := stringList(r["productIds"], "Product IDs")
		for _, id := range ids {
			domain.Find(s, "products", id)
		}
		r["productIds"] = ids
	case "solutions":
		if r["requiresWarranty"] != nil {
			if _, ok := r["requiresWarranty"].(bool); !ok {
				domain.Fail("Warranty requirement must be a boolean.")
			}
		}
		r["productIds"] = stringList(r["productIds"], "Product IDs")
		for _, id := range domain.Strings(r["productIds"]) {
			domain.Find(s, "products", id)
		}
		r["platforms"] = stringList(r["platforms"], "Platforms")
		for _, id := range domain.Strings(r["platforms"]) {
			lookup(domain.Rows(c, "platforms"), id)
		}
		nodes := domain.Rows(r, "nodes")
		if len(nodes) < 1 || len(nodes) > 30 {
			domain.Fail("A solution needs 1–30 task nodes.")
		}
		keys := map[string]bool{}
		for _, n := range nodes {
			key := domain.Required(n["key"], "Node key", 64)
			if !safeKey(key) || keys[key] {
				domain.Fail("Task node keys must be unique letters, digits, underscores or hyphens.")
			}
			n["key"] = key
			n["dependsOn"] = stringList(n["dependsOn"], "Dependencies")
			keys[key] = true
			active(domain.Rows(c, "taskTypes"), domain.Str(n["typeId"]))
			n["amountCents"] = domain.Int(domain.Default(n["amountCents"], 0), "Default amount", 0, 500000000)
			n["qty"] = domain.Int(domain.Default(n["qty"], 1), "Default quantity", 1, 1000000)
			if p := domain.Str(n["productId"]); p != "" {
				domain.Find(s, "products", p)
			}
		}
		visiting, done := map[string]bool{}, map[string]bool{}
		var visit func(string)
		visit = func(k string) {
			if visiting[k] {
				domain.Fail("Solution dependencies must not contain a cycle.")
			}
			if done[k] {
				return
			}
			if !keys[k] {
				domain.Fail("Dependency references an unknown task node.")
			}
			visiting[k] = true
			for _, n := range nodes {
				if n["key"] == k {
					for _, dep := range domain.Strings(n["dependsOn"]) {
						visit(dep)
					}
				}
			}
			visiting[k] = false
			done[k] = true
		}
		for key := range keys {
			visit(key)
		}
		r["nodes"] = nodes
	case "rules":
		if r["typeId"] != "*" {
			lookup(domain.Rows(c, "taskTypes"), domain.Str(r["typeId"]))
		}
		r["field"] = domain.Choice(r["field"], "amountCents", "qty", "platform", "rootCauseId", "primaryCause", "productId")
		r["operator"] = domain.Choice(r["operator"], "always", "gt", "gte", "eq")
		if domain.In(domain.Str(r["field"]), "amountCents", "qty") {
			r["value"] = domain.Int(domain.Default(r["value"], 0), "Rule value", 0, 500000000)
		} else {
			if !domain.In(domain.Str(r["operator"]), "eq", "always") {
				domain.Fail("Text conditions support equals or always.")
			}
			r["value"] = domain.Text(r["value"], 160)
		}
	case "fields":
		if !domain.In(domain.Str(r["scope"]), "task", "execution") {
			r["typeId"] = ""
		}
		r["scope"] = domain.Choice(r["scope"], "rma", "task", "order", "serial", "product", "execution")
		r["fieldType"] = domain.Choice(r["fieldType"], "text", "textarea", "select", "number", "date")
		if _, ok := r["required"].(bool); !ok {
			domain.Fail("Required must be a boolean.")
		}
		if r["fieldType"] == "select" {
			r["options"] = stringList(r["options"], "Field options")
		}
		if r["fieldType"] == "select" && len(domain.Strings(r["options"])) == 0 {
			domain.Fail("Select fields need options.")
		}
		if k := domain.Str(r["typeId"]); k != "" {
			lookup(domain.Rows(c, "taskTypes"), k)
		}
	case "taskTypes":
		r["direction"] = domain.Choice(r["direction"], "none", "outbound", "inbound")
		if v, ok := r["alwaysApprove"]; ok {
			if _, valid := v.(bool); !valid {
				domain.Fail("alwaysApprove must be a boolean.")
			}
		}
		for _, key := range []string{"hasAmount", "requiresCode", "requiresProduct"} {
			if _, ok := r[key].(bool); !ok {
				domain.Fail(key + " must be a boolean.")
			}
		}
		for _, old := range domain.Rows(c, "taskTypes") {
			if old["id"] == id && domain.Bool(old["builtIn"]) {
				for _, k := range []string{"direction", "hasAmount", "requiresCode", "requiresProduct"} {
					if old[k] != r[k] {
						domain.Fail("Built-in task behavior is protected; add a custom type for different behavior.")
					}
				}
				r["builtIn"] = true
			}
		}
	}
	r["updatedAt"] = domain.Now()
	found := false
	for _, old := range domain.Rows(c, entity) {
		if old["id"] == id {
			for k := range old {
				delete(old, k)
			}
			for k, v := range r {
				old[k] = v
			}
			found = true
		}
	}
	if !found {
		c[entity] = append(domain.Rows(c, entity), r)
	}
	c["revision"] = domain.N(c["revision"]) + 1
	r["updatedAt"] = domain.Now()
	return r
}

// ProductFields validates configurable product fields without coupling the ERP domain to RMA code.
func ProductFields(s, r, b M) (value M, err error) {
	defer func() {
		if v := recover(); v != nil {
			if e, ok := v.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("%v", v)
			}
		}
	}()
	for _, serial := range domain.Rows(s, "serials") {
		if serial["productId"] == r["id"] && ((serial["kind"] == "device" && r["productType"] != "device") || (serial["kind"] == "printhead" && (r["productType"] != "part" || r["partKind"] != "printhead"))) {
			domain.Fail("This SKU has registered serials. Its device/printhead classification cannot be changed.", 409)
		}
	}
	input := b["customFields"]
	if input == nil {
		input = r["customFields"]
	}
	value = custom(Config(s), "product", "", input, r["customFields"])
	return
}

func priorFields(s M, col, id string) M {
	if id == "" {
		return M{}
	}
	return domain.Obj(lookup(domain.Rows(s, col), id)["customFields"])
}

func safeKey(key string) bool {
	return len(key) <= 128 && !domain.In(key, "__proto__", "prototype", "constructor") && regexp.MustCompile(`^[a-zA-Z0-9_-]+$`).MatchString(key)
}
func stringList(value any, label string) []string {
	out := []string{}
	if value == nil {
		return out
	}
	switch values := value.(type) {
	case []string:
		for _, v := range values {
			out = append(out, domain.Required(v, label, 200))
		}
	case []any:
		for _, v := range values {
			out = append(out, domain.Required(v, label, 200))
		}
	default:
		domain.Fail(label + " must be an array of nonempty strings.")
	}
	seen := map[string]bool{}
	for _, v := range out {
		if seen[v] {
			domain.Fail(label + " must not contain duplicates.")
		}
		seen[v] = true
	}
	return out
}
func normalize(s M) {
	c := Config(s)
	for _, key := range []string{"solutions", "rootCauses", "rules", "platforms", "taskTypes", "fields"} {
		if c[key] == nil {
			c[key] = []M{}
		}
	}
	normalizeSolution := func(sol M) {
		for _, n := range domain.Rows(sol, "nodes") {
			n["dependsOn"] = append([]string{}, domain.Strings(n["dependsOn"])...)
		}
	}
	for _, sol := range domain.Rows(c, "solutions") {
		normalizeSolution(sol)
	}
	for _, r := range domain.Rows(c, "rootCauses") {
		if r["productIds"] == nil {
			r["productIds"] = []string{}
		}
	}
	for _, f := range domain.Rows(c, "fields") {
		if f["options"] == nil {
			f["options"] = []string{}
		}
	}
	for _, r := range domain.Rows(s, "rmas") {
		normalizeSolution(domain.Obj(r["solutionSnapshot"]))
	}
	for _, t := range domain.Rows(s, "rmaTasks") {
		for _, key := range []string{"dependsOn", "events", "approvalReasons"} {
			if t[key] == nil {
				t[key] = []any{}
			}
		}
	}
}

func validateProduct(s, t M, p string) {
	if p != "" {
		prod := domain.Find(s, "products", p)
		if domain.In(domain.Str(t["typeId"]), "send_device", "send_parts") && prod["source"] == "mabang" && (prod["sourcePresent"] == false) {
			domain.Fail("This SKU is no longer present in the source catalog.", 422)
		}
		if t["typeId"] == "send_parts" && !domain.In(domain.Str(prod["productType"]), "part", "consumable") {
			domain.Fail("Choose a support part SKU.")
		}
		if domain.In(domain.Str(t["typeId"]), "send_device", "return_device") && prod["productType"] != "device" {
			domain.Fail("Choose a device SKU.")
		}
	}
	if p != "" && t["typeId"] == "send_parts" {
		part := domain.Find(s, "products", p)
		ids := domain.Strings(part["deviceIds"])
		if p != domain.Str(t["affectedProductId"]) && !domain.In(domain.Str(t["affectedProductId"]), ids...) {
			domain.Fail("This part is not compatible with the affected device.")
		}
	}

}

func ensureReship(s M) {
	c := Config(s)
	foundPlatform := false
	for _, p := range domain.Rows(c, "platforms") {
		if p["id"] == "TikTokShop" {
			foundPlatform = true
		}
	}
	if !foundPlatform {
		c["platforms"] = append(domain.Rows(c, "platforms"), M{"id": "TikTokShop", "name": "TikTok Shop", "enabled": true})
		c["revision"] = domain.N(c["revision"]) + 1
	}
	for _, sol := range domain.Rows(c, "solutions") {
		if sol["id"] == "reship_device" {
			return
		}
	}
	rows := domain.Rows(c, "solutions")
	c["solutions"] = append(rows, M{"id": "reship_device", "name": "Send replacement device", "enabled": true, "requiresWarranty": true, "nodes": []M{{"key": "device", "typeId": "send_device", "dependsOn": []string{}, "amountCents": int64(0), "qty": int64(1), "productId": ""}}})
	c["revision"] = domain.N(c["revision"]) + 1
}
