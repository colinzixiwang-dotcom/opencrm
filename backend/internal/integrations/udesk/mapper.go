package udesk

import (
	"encoding/json"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"

	"harbor/internal/domain"
	source "harbor/internal/supportsource"
)

var htmlTag = regexp.MustCompile(`<\/?[a-zA-Z][^>]*>`)

func object(v any) M {
	if s, ok := v.(string); ok {
		var m M
		if json.Unmarshal([]byte(s), &m) == nil {
			return m
		}
	}
	return domain.Obj(v)
}
func mapOptions(v any) []source.Option {
	out := []source.Option{}
	for _, o := range records(v) {
		label := key(o["title"])
		if label == "" {
			label = key(o["label"])
		}
		out = append(out, source.Option{Value: o["value"], Label: label, Children: mapOptions(o["subs"])})
	}
	return out
}
func mapField(v M) source.Field {
	return source.Field{Key: key(v["field_name"]), Label: key(v["field_label"]), Kind: key(v["content_type"]), Options: mapOptions(v["options"])}
}
func format(content, declared string) string {
	if declared == "html" || htmlTag.MatchString(content) {
		return "html"
	}
	return "text"
}
func attachment(v any, origin, message string) (source.Attachment, bool) {
	m := domain.Obj(v)
	s := key(m["url"])
	if s == "" {
		s = key(m["file_url"])
	}
	if s == "" {
		s = key(m["download_url"])
	}
	if text, ok := v.(string); ok {
		s = text
	}
	u, e := url.Parse(s)
	if e != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return source.Attachment{}, false
	}
	name := key(m["name"])
	if name == "" {
		name = key(m["file_name"])
	}
	if name == "" {
		name = path.Base(u.Path)
	}
	name = path.Base(name)
	ext := strings.ToLower(path.Ext(name))
	mime := key(m["content_type"])
	if mime == "" {
		mime = key(m["mime_type"])
	}
	kind := "file"
	switch {
	case ext == ".eml" || mime == "message/rfc822":
		kind = "email"
	case strings.Contains("|.png|.jpg|.jpeg|.gif|.webp|.avif|.bmp|", "|"+ext+"|") || strings.HasPrefix(mime, "image/"):
		kind = "image"
	case ext == ".pdf" || mime == "application/pdf":
		kind = "pdf"
	case ext == ".mp4" || ext == ".webm" || ext == ".mov":
		kind = "video"
	case ext == ".mp3" || ext == ".wav" || ext == ".ogg" || ext == ".m4a":
		kind = "audio"
	}
	size := domain.N(m["file_size"])
	if size == 0 {
		size = domain.N(m["size"])
	}
	return source.Attachment{Reference: u.Scheme + "://" + u.Host + u.EscapedPath(), Name: name, Kind: kind, Size: size, Origin: origin, MessageID: message, URL: s}, true
}
func mapAttachments(v any, origin, message string) []source.Attachment {
	out := []source.Attachment{}
	list, ok := v.([]any)
	if !ok {
		if typed, yes := v.([]M); yes {
			for _, f := range typed {
				list = append(list, f)
			}
		} else if v != nil {
			list = []any{v}
		}
	}
	for _, f := range list {
		if a, ok := attachment(f, origin, message); ok {
			out = append(out, a)
		}
	}
	return out
}
func fieldValue(v any) any {
	if a, ok := attachment(v, "ticket", ""); ok {
		if _, isString := v.(string); !isString {
			return a
		}
	}
	if m, ok := v.(map[string]any); ok {
		out := M{}
		for k, val := range m {
			out[k] = fieldValue(val)
		}
		return out
	}
	if list, ok := v.([]any); ok {
		out := []any{}
		for _, val := range list {
			out = append(out, fieldValue(val))
		}
		return out
	}
	return v
}
func human(k string) string {
	parts := strings.Split(k, "_")
	for i, p := range parts {
		if len(p) > 0 {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " ")
}

// Labels for opaque source extras are translated here, never in React.
var extraLabels = map[string]string{"agent_emails_count": "Agent email count", "agent_replied_at": "Agent last replied", "agent_summary": "Agent summary", "assignee_avatar": "Agent avatar", "call_result": "Call result", "call_type": "Call type", "content_type": "Content format", "conversation_id": "Conversation ID", "creator_id": "Created by", "customer_emails_count": "Customer email count", "customer_owner_group_id": "Customer owner group ID", "customer_owner_group_name": "Customer owner group", "customer_owner_id": "Customer owner ID", "customer_owner_name": "Customer owner", "customer_replied_at": "Customer last replied", "customer_telephone": "Customer telephone", "email_reply_status": "Email reply status", "emails_count": "Email count", "first_replied_at": "First replied", "followers": "Followers", "im_sub_session_id": "Chat session ID", "is_associated": "Associated ticket", "knowledge_catalog": "Knowledge category", "knowledge_question": "Knowledge question", "last_closed_operator_name": "Last closed by", "organization_id": "Organization ID", "participate_handling_robots": "Participating bots", "reminder_count": "Reminder count", "replied_by": "Last replied by", "resolved_at": "Resolved at", "robot_summary": "Bot summary", "satisfaction": "Satisfaction", "solving_at": "Processing started", "source": "Source", "survey_vote_desc": "Survey feedback", "survey_vote_tags": "Survey tags", "ticket_category": "Ticket category", "ticket_category_name": "Ticket category name", "timers": "Timers", "unexecuted_alarm_count": "Pending reminders", "updator_id": "Updated by", "has_reminder": "Has reminder", "id": "Udesk ticket ID", "assignee_id": "Agent ID", "user_id": "Customer ID", "user_group_id": "Agent group ID", "url": "Ticket link", "solved_at": "Solved at", "closed_at": "Closed at", "replied_at": "Last reply", "field_num": "Ticket number", "subject": "Subject", "content": "Content", "user_name": "Customer", "user_email": "Email address", "user_cellphone": "Phone", "assignee_name": "Assignee", "user_group_name": "Agent group", "template_id": "Template", "status": "Status", "status_en": "English status", "priority": "Priority", "platform": "Channel", "tags": "Tags", "created_at": "Created", "updated_at": "Updated", "solved_deadline": "Due date", "attachments": "Attachments"}

func (a *Adapter) mapTicket(v M) (source.Ticket, error) {
	id := key(v["id"])
	if id == "" {
		return source.Ticket{}, invalid("Udesk returned a ticket without an ID.")
	}
	t := source.Ticket{ID: id, Ref: source.Reference{Provider: "udesk", Tenant: a.Tenant(), ID: id}, Number: key(v["field_num"]), Subject: key(v["subject"]), Content: key(v["content"]), ContentFormat: format(key(v["content"]), key(v["content_type"])), Status: key(v["status"]), StatusCode: key(v["status_en"]), Channel: key(v["platform"]), ChannelCode: key(v["platform_name"]), Priority: key(v["priority"]), AssigneeID: key(v["assignee_id"]), AssigneeName: key(v["assignee_name"]), GroupID: key(v["user_group_id"]), GroupName: key(v["user_group_name"]), CustomerID: key(v["user_id"]), CustomerName: key(v["user_name"]), CustomerEmail: key(v["user_email"]), CustomerPhone: key(v["user_cellphone"]), CustomerTelephone: key(v["customer_telephone"]), TemplateID: key(v["template_id"]), CreatedAt: key(v["created_at"]), UpdatedAt: key(v["updated_at"]), RepliedAt: key(v["replied_at"]), CustomValues: map[string]any{}, Attachments: mapAttachments(v["attachments"], "ticket", ""), Evidence: raw(v), Fields: []source.FieldValue{}}
	if t.ChannelCode == "" {
		t.ChannelCode = t.Channel
	}
	if t.StatusCode == "" {
		t.StatusCode = t.Status
	}
	for k, val := range object(v["custom_fields_v2"]) {
		t.CustomValues[k] = fieldValue(val)
	}
	for k, val := range object(v["custom_fields"]) {
		t.CustomValues[k] = fieldValue(val)
	}
	used := map[string]bool{}
	for _, k := range strings.Fields("id field_num subject content content_type status status_en platform platform_name custom_fields custom_fields_v2 attachments") {
		used[k] = true
	}
	add := func(sourceKey, name, label, section, kind string) {
		used[sourceKey] = true
		t.Fields = append(t.Fields, source.FieldValue{Field: source.Field{Key: name, Label: label, Kind: kind}, Value: fieldValue(v[sourceKey]), Section: section})
	}
	for _, f := range []struct{ sourceKey, name, label, section, kind string }{
		{"user_name", "customerName", "Customer", "Customer information", "text"}, {"user_email", "customerEmail", "Email address", "Customer information", "text"}, {"user_cellphone", "customerPhone", "Phone", "Customer information", "text"}, {"customer_telephone", "customerTelephone", "Customer telephone", "Customer information", "text"},
		{"assignee_name", "assigneeName", "Assignee", "Handling information", "text"}, {"user_group_name", "groupName", "Agent group", "Handling information", "text"}, {"priority", "priority", "Priority", "Handling information", "text"}, {"created_at", "createdAt", "Created", "Handling information", "datetime"}, {"updated_at", "updatedAt", "Updated", "Handling information", "datetime"}, {"tags", "tags", "Tags", "Handling information", "text"}, {"ticket_category_name", "categoryName", "Ticket category name", "Issue classification", "text"},
		{"assignee_id", "assigneeId", "Agent ID", "System information", "text"}, {"user_id", "customerId", "Customer ID", "System information", "text"}, {"user_group_id", "groupId", "Agent group ID", "System information", "text"}, {"template_id", "templateId", "Template", "System information", "text"},
	} {
		add(f.sourceKey, f.name, f.label, f.section, f.kind)
	}
	keys := []string{}
	for k := range v {
		if !used[k] {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		section := "Other fields"
		if strings.HasSuffix(k, "_id") || strings.HasSuffix(k, "count") || k == "has_reminder" || k == "assignee_avatar" || k == "url" {
			section = "System information"
		}
		kind := "text"
		if strings.HasSuffix(k, "_at") || strings.HasSuffix(k, "_deadline") {
			kind = "datetime"
		}
		label := extraLabels[k]
		if label == "" {
			label = human(k)
		}
		add(k, k, label, section, kind)
	}
	t.Fields = append(t.Fields, source.FieldValue{Field: source.Field{Key: "id", Label: "Udesk ticket ID", Kind: "text"}, Value: id, Section: "System information"})
	return t, nil
}
func mapMessage(v M) source.Message {
	author := domain.Obj(v["author"])
	kind := strings.ToLower(key(author["user_type"]))
	if kind == "user" || kind == "end_user" {
		kind = "customer"
	}
	if kind != "customer" && kind != "agent" {
		kind = "unknown"
	}
	messageKind := "external"
	if key(v["function_type"]) == "internal" || key(v["function_type"]) == "internat" {
		messageKind = "internal"
	}
	id := key(v["id"])
	return source.Message{ID: id, Kind: messageKind, Content: key(v["content"]), ContentFormat: format(key(v["content"]), key(v["content_format"])), CreatedAt: key(v["created_at"]), Author: source.Author{ID: key(author["id"]), Name: key(author["nick_name"]), Kind: kind, Email: key(author["email"])}, Attachments: mapAttachments(v["attachments"], "message", id), Evidence: raw(v)}
}

// ResolveAttachment inspects only an authorized source record. It preserves the
// verified recursive search for custom-field files and renews signed URLs.
func ResolveAttachment(evidence json.RawMessage, ref string) string {
	var v any
	if json.Unmarshal(evidence, &v) != nil {
		return ""
	}
	var find func(any, int) string
	find = func(v any, depth int) string {
		if depth > 16 {
			return ""
		}
		if a, ok := attachment(v, "", ""); ok && a.Reference == ref {
			return a.URL
		}
		switch x := v.(type) {
		case map[string]any:
			for _, val := range x {
				if r := find(val, depth+1); r != "" {
					return r
				}
			}
		case []any:
			for _, val := range x {
				if r := find(val, depth+1); r != "" {
					return r
				}
			}
		case string:
			if strings.HasPrefix(strings.TrimSpace(x), "{") || strings.HasPrefix(strings.TrimSpace(x), "[") {
				var parsed any
				if json.Unmarshal([]byte(x), &parsed) == nil {
					return find(parsed, depth+1)
				}
			}
		}
		return ""
	}
	return find(v, 0)
}
