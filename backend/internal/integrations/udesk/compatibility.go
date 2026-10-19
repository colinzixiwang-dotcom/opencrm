package udesk

import (
	"encoding/json"
	"harbor/internal/domain"
	source "harbor/internal/supportsource"
)

// CompatibilityResponse is the temporary v1 HTTP presenter. Only this file
// restores the historical Udesk-shaped API; application services return CRM DTOs.
// Remove after consumers have migrated to application/vnd.morpho.support.v2+json.
func CompatibilityResponse(value any) any {
	v, ok := value.(map[string]any)
	if !ok {
		return value
	}
	out := M{}
	for k, val := range v {
		if len(k) > 0 && k[0] != '_' {
			out[k] = val
		}
	}
	if t, ok := v["ticket"].(source.Ticket); ok {
		var record M
		_ = json.Unmarshal(t.Evidence, &record)
		if record == nil {
			record = M{}
		}
		// Match the policy-filtered canonical view; raw evidence is never itself an
		// authorization decision, including for the compatibility API.
		for k, val := range map[string]string{"user_email": t.CustomerEmail, "user_cellphone": t.CustomerPhone, "customer_telephone": t.CustomerTelephone} {
			if _, exists := record[k]; exists {
				record[k] = val
			}
		}
		out["source"] = record
		out["udeskUrl"] = v["sourceUrl"]
		delete(out, "ticket")
		delete(out, "sourceUrl")
	}
	if items, ok := v["items"].([]M); ok {
		list := []M{}
		for _, item := range items {
			list = append(list, CompatibilityResponse(item).(M))
		}
		out["items"] = list
	}
	if messages, ok := v["messages"].([]source.Message); ok {
		replies := []M{}
		for _, message := range messages {
			var record M
			_ = json.Unmarshal(message.Evidence, &record)
			if record == nil {
				record = M{}
			}
			if v["_compatRedacted"] == true {
				delete(record, "cc")
				author := domain.Obj(record["author"])
				delete(author, "email")
			}
			replies = append(replies, record)
		}
		out["replies"] = replies
		out["meta"] = M{"current_page": v["currentPage"], "total_pages": v["totalPages"], "total_count": v["totalCount"]}
		delete(out, "messages")
		delete(out, "currentPage")
		delete(out, "totalPages")
		delete(out, "totalCount")
	}
	if filters, ok := v["filters"].([]source.Filter); ok {
		list := []M{}
		for _, f := range filters {
			list = append(list, M{"id": f.ID, "name": f.Name, "active": f.Active})
		}
		out["filters"] = list
	}
	if evidence, ok := v["_compatMetadata"].(map[string]json.RawMessage); ok {
		for _, kind := range []string{"fields", "templates", "statuses"} {
			var m M
			_ = json.Unmarshal(evidence[kind], &m)
			if m == nil {
				m = M{}
			}
			out[kind] = m
		}
	}
	return out
}
