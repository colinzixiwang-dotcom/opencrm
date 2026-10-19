package udesk

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"harbor/internal/domain"
	source "harbor/internal/supportsource"
)

// Adapter is the anti-corruption boundary. It owns all Udesk endpoints,
// pagination peculiarities and DTO translation, but no CRM access policies.
type Adapter struct {
	API  API
	Base string
}

func NewAdapter(api API, base string) *Adapter { return &Adapter{API: api, Base: base} }
func (a *Adapter) Tenant() string              { return a.Base }
func (a *Adapter) TicketURL(id string) string {
	return strings.TrimRight(strings.TrimSuffix(a.Base, "/open_api_v1"), "/") + "/entry/ticket/show/" + url.PathEscape(id)
}
func (a *Adapter) ReadTicket(ctx context.Context, key string, number bool) (source.Ticket, error) {
	q := url.Values{}
	if number {
		q.Set("num", key)
	} else {
		q.Set("id", key)
	}
	v, e := a.API.Get(ctx, "tickets/detail", q)
	if e != nil {
		return source.Ticket{}, e
	}
	return a.mapTicket(domain.Obj(v["ticket"]))
}
func (a *Adapter) DecodeTicket(raw json.RawMessage) (source.Ticket, error) {
	var v M
	if json.Unmarshal(raw, &v) != nil {
		return source.Ticket{}, invalid("Invalid stored source ticket.")
	}
	return a.mapTicket(v)
}
func invalid(message string) error {
	return &source.Error{Kind: source.InvalidResponse, Message: message}
}
func key(v any) string {
	if v == nil {
		return ""
	}
	if n, ok := v.(float64); ok {
		return strconv.FormatFloat(n, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}
func raw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func records(v any) []M         { return domain.Items(v) }
func (a *Adapter) ReadConversation(ctx context.Context, id string, page int) (source.ConversationPage, error) {
	if page < 1 || page > 100000 {
		return source.ConversationPage{}, &source.Error{Kind: source.InvalidQuery, Message: "Invalid replies page."}
	}
	path := "tickets/" + url.PathEscape(id) + "/replies"
	get := func(p int) (M, error) {
		return a.API.Get(ctx, path, url.Values{"page": {strconv.Itoa(p)}, "per_page": {"20"}})
	}
	v, e := get(1)
	if e != nil {
		return source.ConversationPage{}, e
	}
	pages := max(1, int(domain.N(domain.Obj(v["meta"])["total_pages"])))
	if page > pages {
		return source.ConversationPage{}, &source.Error{Kind: source.InvalidQuery, Message: "Invalid replies page."}
	}
	sourcePage := pages - page + 1
	if sourcePage != 1 {
		v, e = get(sourcePage)
		if e != nil {
			return source.ConversationPage{}, e
		}
	}
	out := source.ConversationPage{CurrentPage: page, TotalPages: pages, SourcePage: sourcePage, TotalCount: int(domain.N(domain.Obj(v["meta"])["total_count"])), Evidence: raw(v), Messages: []source.Message{}}
	list := records(v["replies"])
	for i := len(list) - 1; i >= 0; i-- {
		out.Messages = append(out.Messages, mapMessage(list[i]))
	}
	if _, ok := domain.Obj(v["meta"])["total_count"]; !ok {
		out.TotalCount = len(list)
	}
	return out, nil
}
func (a *Adapter) ScanTickets(ctx context.Context, filter string) ([]source.Ticket, error) {
	all := []source.Ticket{}
	seen := map[string]bool{}
	firstIDs := ""
	for page, pages := 1, 1; page <= pages; page++ {
		path := "tickets"
		q := url.Values{"page": {strconv.Itoa(page)}, "per_page": {"100"}}
		if filter != "" {
			path = "tickets/tickets_in_filter"
			q.Set("filter_id", filter)
		}
		v, e := a.API.Get(ctx, path, q)
		if e != nil {
			return nil, e
		}
		if page == 1 {
			pages = max(1, int(domain.N(domain.Obj(v["meta"])["total_pages"])))
			if pages > 10000 {
				return nil, invalid("Udesk synchronization range exceeds its page limit.")
			}
		}
		ids := []string{}
		added := 0
		for _, row := range records(v["contents"]) {
			t := row
			if nested, ok := row["ticket"].(map[string]any); ok {
				t = nested
			}
			mapped, e := a.mapTicket(t)
			if e != nil {
				return nil, e
			}
			ids = append(ids, mapped.ID)
			if !seen[mapped.ID] {
				seen[mapped.ID] = true
				all = append(all, mapped)
				added++
			}
		}
		fingerprint := string(raw(ids))
		if page == 1 {
			firstIDs = fingerprint
		}
		// Verified tenant behavior: an over-advertised final page repeats page one.
		if page > 1 && added == 0 {
			if page == pages && (len(ids) == 0 || fingerprint == firstIDs) {
				break
			}
			return nil, invalid("Udesk repeated or omitted an intermediate source page.")
		}
	}
	return all, nil
}
func (a *Adapter) all(ctx context.Context, path, name string, q url.Values) ([]M, error) {
	if q == nil {
		q = url.Values{}
	}
	out := []M{}
	for page := 1; page <= 1000; page++ {
		q.Set("page", strconv.Itoa(page))
		q.Set("per_page", "100")
		v, e := a.API.Get(ctx, path, q)
		if e != nil {
			return nil, e
		}
		out = append(out, records(v[name])...)
		if page >= int(domain.N(domain.Obj(v["meta"])["total_pages"])) {
			return out, nil
		}
	}
	return nil, invalid("Udesk directory pagination exceeded its limit.")
}
func (a *Adapter) ReadGroups(ctx context.Context) ([]source.Group, error) {
	v, e := a.all(ctx, "user_groups", "user_groups", nil)
	if e != nil {
		return nil, e
	}
	out := []source.Group{}
	for _, g := range v {
		if key(g["id"]) == "" {
			return nil, invalid("Udesk returned a group without an ID.")
		}
		out = append(out, source.Group{ID: key(g["id"]), Name: key(g["name"])})
	}
	return out, nil
}
func (a *Adapter) ReadDirectory(ctx context.Context) (source.Directory, error) {
	out := source.Directory{}
	agents, e := a.all(ctx, "agents", "agents", url.Values{"with_disabled": {"true"}})
	if e != nil {
		return out, e
	}
	for _, v := range agents {
		agent := source.Agent{ID: key(v["id"]), Email: strings.ToLower(strings.TrimSpace(key(v["email"]))), Name: key(v["nick_name"]), Role: strings.ToLower(strings.TrimSpace(key(v["role_name"]))), Enabled: key(v["disable_status"]) == "enable", GroupIDs: []string{}}
		if agent.ID == "" || !strings.Contains(agent.Email, "@") {
			return out, invalid("Udesk returned an account without a valid ID or email.")
		}
		for _, id := range domain.Strings(v["user_group_ids"]) {
			agent.GroupIDs = append(agent.GroupIDs, id)
		}
		// domain.Strings handles only strings; numeric IDs must also be preserved.
		if ids, ok := v["user_group_ids"].([]any); ok {
			agent.GroupIDs = []string{}
			for _, id := range ids {
				agent.GroupIDs = append(agent.GroupIDs, key(id))
			}
		}
		out.Agents = append(out.Agents, agent)
	}
	out.Groups, e = a.ReadGroups(ctx)
	if e != nil {
		return out, e
	}
	roles, e := a.API.Get(ctx, "agent_roles", nil)
	if e != nil {
		return out, e
	}
	for _, v := range records(roles["agent_roles"]) {
		out.Roles = append(out.Roles, source.Group{ID: key(v["id"]), Name: key(v["name"])})
	}
	return out, nil
}
func (a *Adapter) ReadMetadata(ctx context.Context) (source.Metadata, error) {
	data := map[string]json.RawMessage{}
	for _, item := range []struct {
		kind, path string
		q          url.Values
	}{{"statuses", "tickets/status", nil}, {"templates", "tickets/ticket_templates", nil}, {"fields", "custom_fields", url.Values{"category": {"ticket"}}}} {
		v, e := a.API.Get(ctx, item.path, item.q)
		if e != nil {
			return source.Metadata{}, e
		}
		data[item.kind] = raw(v)
	}
	filters, e := a.all(ctx, "tickets/filters", "filters", nil)
	if e != nil {
		return source.Metadata{}, e
	}
	data["filters"] = raw(M{"filters": filters})
	return a.DecodeMetadata(data)
}
func (a *Adapter) DecodeMetadata(data map[string]json.RawMessage) (source.Metadata, error) {
	out := source.Metadata{Fields: []source.Field{}, Templates: []source.Template{}, Filters: []source.Filter{}, Evidence: data}
	decode := func(kind string) M { var v M; _ = json.Unmarshal(data[kind], &v); return v }
	for _, v := range records(decode("fields")["fields"]) {
		out.Fields = append(out.Fields, mapField(v))
	}
	for _, v := range records(decode("templates")["templates"]) {
		t := source.Template{ID: key(v["id"]), Fields: []source.Field{}}
		for _, f := range records(v["custom_fields"]) {
			field := mapField(f)
			if field.Label == "" {
				field.Label = key(f["field_title"])
			}
			t.Fields = append(t.Fields, field)
		}
		out.Templates = append(out.Templates, t)
	}
	seen := map[string]bool{}
	for _, v := range records(decode("filters")["filters"]) {
		id := key(v["id"])
		if seen[id] {
			continue
		}
		seen[id] = true
		active, ok := v["active"].(bool)
		out.Filters = append(out.Filters, source.Filter{ID: id, Name: key(v["name"]), Active: !ok || active})
	}
	return out, nil
}

// Client satisfies the consumer's port, keeping construction in the composition
// root compatible while callers can inject Adapter with any API in contract tests.
func (c *Client) adapter() *Adapter          { return NewAdapter(c, c.Base) }
func (c *Client) TicketURL(id string) string { return c.adapter().TicketURL(id) }
func (c *Client) ReadTicket(ctx context.Context, id string, n bool) (source.Ticket, error) {
	return c.adapter().ReadTicket(ctx, id, n)
}
func (c *Client) ReadConversation(ctx context.Context, id string, p int) (source.ConversationPage, error) {
	return c.adapter().ReadConversation(ctx, id, p)
}
func (c *Client) ScanTickets(ctx context.Context, f string) ([]source.Ticket, error) {
	return c.adapter().ScanTickets(ctx, f)
}
func (c *Client) ReadGroups(ctx context.Context) ([]source.Group, error) {
	return c.adapter().ReadGroups(ctx)
}
func (c *Client) ReadDirectory(ctx context.Context) (source.Directory, error) {
	return c.adapter().ReadDirectory(ctx)
}
func (c *Client) ReadMetadata(ctx context.Context) (source.Metadata, error) {
	return c.adapter().ReadMetadata(ctx)
}
func (c *Client) DecodeTicket(raw json.RawMessage) (source.Ticket, error) {
	return c.adapter().DecodeTicket(raw)
}
func (c *Client) DecodeMetadata(v map[string]json.RawMessage) (source.Metadata, error) {
	return c.adapter().DecodeMetadata(v)
}

var _ source.Source = (*Adapter)(nil)
var _ source.Source = (*Client)(nil)
