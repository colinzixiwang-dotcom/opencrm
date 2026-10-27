package support

import (
	"harbor/internal/domain"
	"harbor/internal/warrantytypes"
	"time"
)

// Warranty rules are versioned independently. Existing cases retain their assessment.
func ensureWarranty(s M) {
	c := Config(s)
	if c["warrantyPolicy"] == nil {
		c["warrantyPolicy"] = M{"revision": int64(1), "graceDays": int64(14), "rules": []M{
			{"id": "device", "name": "New device", "coverage": "device", "months": int64(12), "enabled": true, "productIds": []string{}, "market": "", "platform": ""},
			{"id": "head1080", "name": "Printhead 1080", "coverage": "printhead_1080", "months": int64(3), "enabled": true, "productIds": []string{}, "market": "", "platform": ""},
			{"id": "head3200", "name": "Printhead 3200", "coverage": "printhead_3200", "months": int64(6), "enabled": true, "productIds": []string{}, "market": "", "platform": ""},
		}}
	}
	policy := domain.Obj(c["warrantyPolicy"])
	if policy["classes"] == nil {
		policy["classes"] = warrantytypes.Definitions(policy)
	}
}

func requiresWarranty(solution M) bool {
	if v, ok := solution["requiresWarranty"].(bool); ok {
		return v
	}
	// Safe defaults for legacy and custom solutions. An administrator can set an explicit policy.
	outbound, refund, inbound := false, false, false
	for _, n := range domain.Rows(solution, "nodes") {
		outbound = outbound || domain.In(domain.Str(n["typeId"]), "send_device", "send_parts")
		refund = refund || n["typeId"] == "refund"
		inbound = inbound || n["typeId"] == "return_device"
	}
	return outbound || (refund && inbound)
}

func coverage(p M) string {
	if kind := domain.Str(p["warrantyClass"]); kind != "" && kind != "none" {
		return kind
	}
	if p["source"] != "mabang" && p["productType"] == "device" {
		return "device"
	}
	return "none"
}

func warrantyDate(v any, label string) time.Time {
	str := domain.Required(v, label, 10)
	d, e := time.Parse("2006-01-02", str)
	if e != nil || d.Year() < 1900 || d.Year() > 2200 {
		domain.Fail("Enter a valid warranty date (YYYY-MM-DD).")
	}
	return d
}

// addMonths clamps month ends rather than Go's overflow normalization (Jan 31 -> Feb 28).
func addMonths(d time.Time, months int) time.Time {
	first := time.Date(d.Year(), d.Month()+time.Month(months), 1, 0, 0, 0, 0, time.UTC)
	last := first.AddDate(0, 1, -1).Day()
	day := d.Day()
	if day > last {
		day = last
	}
	return time.Date(first.Year(), first.Month(), day, 0, 0, 0, 0, time.UTC)
}

func Assess(s, b M, now time.Time) M {
	c := Config(s)
	sol := active(domain.Rows(c, "solutions"), domain.Str(b["solutionId"]))
	p := domain.Find(s, "products", domain.Str(b["productId"]))
	active(domain.Rows(c, "platforms"), domain.Str(b["platform"]))
	policy := domain.Obj(c["warrantyPolicy"])
	loc, e := time.LoadLocation(domain.Str(domain.Obj(s["settings"])["timezone"]))
	if e != nil {
		loc = time.UTC
	}
	today, _ := time.Parse("2006-01-02", now.In(loc).Format("2006-01-02"))
	result := M{"eligible": true, "status": "not_required", "reason": "This solution does not require warranty coverage.", "requiresWarranty": requiresWarranty(sol), "solutionId": sol["id"], "configRevision": c["revision"], "policyRevision": policy["revision"], "assessedAt": now.UTC().Format(time.RFC3339Nano), "assessmentDate": today.Format("2006-01-02"), "source": "agent_entered", "productId": p["id"]}
	deny := func(status, reason string) M {
		result["eligible"] = false
		result["status"] = status
		result["reason"] = reason
		return result
	}
	if ids := domain.Strings(sol["productIds"]); len(ids) > 0 && !domain.In(domain.Str(p["id"]), ids...) {
		return deny("ineligible", "This solution does not apply to the affected SKU.")
	}
	if ids := domain.Strings(sol["platforms"]); len(ids) > 0 && !domain.In(domain.Str(b["platform"]), ids...) {
		return deny("ineligible", "This solution does not apply to the purchased platform.")
	}
	if !requiresWarranty(sol) {
		return result
	}
	kind := coverage(p)
	result["coverage"] = kind
	if kind == "none" {
		return deny("incomplete", "Configure the affected SKU warranty class before using a warranty-required solution.")
	}
	evidence := domain.Obj(b["warrantyEvidence"])
	market := domain.Text(evidence["market"], 64)
	if market == "" {
		for _, r := range domain.Rows(policy, "rules") {
			ids := domain.Strings(r["productIds"])
			if enabled(r) && r["coverage"] == kind && domain.Str(r["market"]) != "" && (len(ids) == 0 || domain.In(domain.Str(p["id"]), ids...)) && (domain.Str(r["platform"]) == "" || r["platform"] == b["platform"]) {
				return deny("incomplete", "Market is required because this SKU has market-specific warranty rules.")
			}
		}
	}

	var selected M
	score := -1
	ambiguous := false
	for _, r := range domain.Rows(policy, "rules") {
		if !enabled(r) || r["coverage"] != kind {
			continue
		}
		ids := domain.Strings(r["productIds"])
		if len(ids) > 0 && !domain.In(domain.Str(p["id"]), ids...) {
			continue
		}
		if domain.Str(r["market"]) != "" && r["market"] != market {
			continue
		}
		if domain.Str(r["platform"]) != "" && r["platform"] != b["platform"] {
			continue
		}
		n := 0
		if len(ids) > 0 {
			n++
		}
		if domain.Str(r["market"]) != "" {
			n++
		}
		if domain.Str(r["platform"]) != "" {
			n++
		}
		if n > score {
			selected = r
			score = n
			ambiguous = false
		} else if n == score {
			ambiguous = true
		}
	}
	if selected == nil {
		for _, r := range domain.Rows(policy, "rules") {
			if r["coverage"] == kind && !enabled(r) {
				return deny("incomplete", "Warranty policy for this type is pending confirmation.")
			}
		}
		return deny("incomplete", "No enabled warranty rule matches this SKU, market and platform.")
	}
	if ambiguous {
		return deny("incomplete", "Multiple warranty rules match equally. Ask an administrator to resolve the policy conflict.")
	}
	result["ruleSnapshot"] = domain.Clone(selected)
	result["graceDays"] = policy["graceDays"]
	requireEvidence := domain.Bool(selected["requireEvidence"])
	if selected["requireEvidence"] == nil && (domain.Str(b["draftId"]) != "" || sol["id"] == "reship_device") {
		requireEvidence = true
	}
	if requireEvidence && domain.Str(evidence["evidenceReference"]) == "" {
		return deny("incomplete", "Warranty evidence reference is required by this rule.")
	}
	if selected["eligibilityMode"] == "exempt" {
		result["status"] = "exempt"
		result["reason"] = "This warranty type is explicitly exempt from time coverage checks."
		result["evidence"] = domain.Clone(evidence)
		return result
	}
	mode := domain.Str(selected["startMode"])
	if mode == "" {
		mode = "purchase_type"
	} // Preserve existing policy semantics.
	grace := domain.N(policy["graceDays"])
	if selected["graceDays"] != nil {
		grace = domain.N(selected["graceDays"])
	}
	result["graceDays"] = grace
	purchase := domain.Str(evidence["purchaseType"])
	if mode == "purchase_type" {
		if kind == "device" {
			purchase = "new_device"
			mode = "activation_grace"
		} else {
			if !domain.In(purchase, "bundled_printhead", "standalone_printhead") {
				return deny("incomplete", "Choose whether the printhead was bundled or purchased separately.")
			}
			if purchase == "standalone_printhead" {
				mode = "delivery_next_day"
			} else {
				mode = "activation_grace"
			}
		}
	}
	key, label := "deliveredAt", "Delivery date"
	if mode == "payment" {
		key, label = "paidAt", "Payment date"
	}
	if mode == "activation" {
		key, label = "activatedAt", "Activation date"
	}
	if domain.Str(evidence[key]) == "" {
		return deny("incomplete", label+" is required to assess warranty eligibility.")
	}
	base := warrantyDate(evidence[key], label)
	if base.After(today) {
		return deny("incomplete", label+" cannot be in the future.")
	}
	start := base
	if mode == "delivery_next_day" {
		start = base.AddDate(0, 0, 1)
	}
	if mode == "activation_grace" {
		start = base.AddDate(0, 0, int(grace))
		if domain.Str(evidence["activatedAt"]) != "" {
			activated := warrantyDate(evidence["activatedAt"], "Activation date")
			if activated.Before(base) || activated.After(today) {
				return deny("incomplete", "Activation date must be between delivery and today.")
			}
			if activated.Before(start) {
				start = activated
			}
		} else if today.Before(start) {
			return deny("incomplete", "Activation date is required during the activation grace period.")
		}
	}
	start = start.AddDate(0, 0, int(domain.N(selected["startOffsetDays"])))
	end := addMonths(start, int(domain.N(selected["months"])))
	if selected["durationUnit"] == "days" {
		end = start.AddDate(0, 0, int(domain.N(selected["days"])))
	}
	result["startMode"] = mode
	result["evidence"] = M{"deliveredAt": domain.Str(evidence["deliveredAt"]), "paidAt": domain.Str(evidence["paidAt"]), "activatedAt": domain.Str(evidence["activatedAt"]), "purchaseType": purchase, "market": market, "inheritedFromSn": domain.Text(evidence["inheritedFromSn"], 120), "evidenceReference": domain.Text(evidence["evidenceReference"], 1000)}
	result["startsAt"] = start.Format("2006-01-02")
	result["endsAt"] = end.Format("2006-01-02")
	result["pauseIntervals"] = []M{}
	if today.Before(start) {
		return deny("not_started", "Warranty coverage has not started yet.")
	}
	if !today.Before(end) {
		return deny("expired", "Warranty has expired. Choose a solution that does not require warranty coverage.")
	}
	result["status"] = "covered"
	result["reason"] = "Warranty is active. This solution is eligible."
	return result
}

func saveWarranty(s, b M) M {
	c := Config(s)
	old := domain.Obj(c["warrantyPolicy"])
	if domain.N(b["expectedRevision"]) != domain.N(old["revision"]) {
		domain.Fail("Warranty policy changed. Reload before saving.", 409)
	}
	in := domain.Obj(b["policy"])
	p := M{"id": "warranty", "revision": domain.N(old["revision"]) + 1, "graceDays": domain.Int(in["graceDays"], "Activation grace days", 0, 90)}
	classes := warrantytypes.Definitions(in)
	if len(classes) < 1 || len(classes) > 100 {
		domain.Fail("Configure between 1 and 100 warranty types.")
	}
	classIDs := map[string]bool{}
	definitions := []M{}
	for _, cls := range classes {
		id := domain.Required(cls["id"], "Warranty type key", 64)
		if !safeKey(id) || id == "none" || classIDs[id] {
			domain.Fail("Warranty type keys must be unique and cannot be none.")
		}
		classIDs[id] = true
		definitions = append(definitions, M{"id": id, "name": domain.Required(cls["name"], "Warranty type name", 120)})
	}
	for _, product := range domain.Rows(s, "products") {
		id := domain.Str(product["warrantyClass"])
		if id != "" && id != "none" && !classIDs[id] {
			domain.Fail("A warranty type assigned to products cannot be removed.")
		}
	}
	p["classes"] = definitions
	rows := domain.Rows(in, "rules")
	if len(rows) < 1 || len(rows) > 100 {
		domain.Fail("Configure between 1 and 100 warranty rules.")
	}
	out := []M{}
	ids := map[string]bool{}
	scopes := map[string]bool{}
	for _, r := range rows {
		id := domain.Required(r["id"], "Rule key", 64)
		if !safeKey(id) || ids[id] {
			domain.Fail("Warranty rule keys must be unique letters, digits, underscores or hyphens.")
		}
		ids[id] = true
		if _, ok := r["enabled"].(bool); !ok {
			domain.Fail("Enabled must be a boolean.")
		}
		products := stringList(r["productIds"], "Product IDs")
		kind := domain.Str(r["coverage"])
		if !classIDs[kind] {
			domain.Fail("Choose a configured warranty type.")
		}
		for _, id := range products {
			product := domain.Find(s, "products", id)
			if coverage(product) != kind {
				domain.Fail("Warranty rule coverage must match every selected SKU warranty class.")
			}
		}
		platform := domain.Text(r["platform"], 64)
		if platform != "" {
			lookup(domain.Rows(c, "platforms"), platform)
		}
		market := domain.Text(r["market"], 64)
		// Exact duplicate global scopes are almost always an accidental conflicting rule.
		key := kind + "|" + market + "|" + platform
		if len(products) == 0 && domain.Bool(r["enabled"]) {
			if scopes[key] {
				domain.Fail("Enabled warranty rules must not duplicate the same scope.")
			}
			scopes[key] = true
		}
		eligibilityMode := domain.Str(r["eligibilityMode"])
		if eligibilityMode == "" {
			eligibilityMode = "timed"
		}
		domain.Choice(eligibilityMode, "timed", "exempt")
		mode := domain.Str(r["startMode"])
		if mode == "" {
			mode = "purchase_type"
		}
		domain.Choice(mode, "purchase_type", "activation_grace", "delivery", "payment", "activation", "delivery_next_day")
		if mode == "purchase_type" && !domain.In(kind, "device", "printhead_1080", "printhead_3200") {
			domain.Fail("Choose an explicit start basis for this warranty type.")
		}
		unit := domain.Str(r["durationUnit"])
		if unit == "" {
			unit = "months"
		}
		domain.Choice(unit, "months", "days")
		min := int64(0)
		if domain.Bool(r["enabled"]) && r["eligibilityMode"] != "exempt" {
			min = 1
		}
		duration := M{"months": int64(0), "days": int64(0)}
		if unit == "months" {
			duration["months"] = domain.Int(domain.Default(r["months"], 0), "Warranty months", min, 120)
		} else {
			duration["days"] = domain.Int(domain.Default(r["days"], 0), "Warranty days", min, 36500)
		}
		grace := domain.N(in["graceDays"])
		if r["graceDays"] != nil {
			grace = domain.Int(r["graceDays"], "Activation grace days", 0, 90)
		}
		if r["requireEvidence"] != nil {
			if _, ok := r["requireEvidence"].(bool); !ok {
				domain.Fail("Evidence flag must be a boolean.")
			}
		}
		out = append(out, M{"id": id, "name": domain.Required(r["name"], "Rule name", 120), "coverage": kind, "months": duration["months"], "days": duration["days"], "durationUnit": unit, "startMode": mode, "startOffsetDays": domain.Int(domain.Default(r["startOffsetDays"], 0), "Start offset days", 0, 365), "graceDays": grace, "requireEvidence": r["requireEvidence"], "sourceReference": domain.Text(r["sourceReference"], 2000), "eligibilityMode": eligibilityMode, "enabled": r["enabled"], "productIds": products, "market": market, "platform": platform})
	}
	p["rules"] = out
	c["warrantyPolicy"] = p
	c["revision"] = domain.N(c["revision"]) + 1
	return p
}
