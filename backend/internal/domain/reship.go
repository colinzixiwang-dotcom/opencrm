package domain

// ReshipApprovalRequired preserves a review gate for previously unopened ERP SKUs.
// An explicit administrator setting takes precedence over the retired allowReship flag.
func ReshipApprovalRequired(p M) bool {
	if value, ok := p["reshipRequiresApproval"].(bool); ok {
		return value
	}
	return p["source"] == "mabang" && !Bool(p["allowReship"])
}
