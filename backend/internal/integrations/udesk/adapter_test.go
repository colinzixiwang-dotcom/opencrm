package udesk

import (
	"context"
	"encoding/json"
	source "harbor/internal/supportsource"
	"net/url"
	"reflect"
	"testing"
)

type adapterFixture struct{ pages map[string]M }

func (f adapterFixture) Get(_ context.Context, path string, q url.Values) (M, error) {
	v := f.pages[path+":"+q.Get("page")]
	if v == nil {
		v = f.pages[path]
	}
	b, _ := json.Marshal(v)
	var copy M
	_ = json.Unmarshal(b, &copy)
	return copy, nil
}
func TestAdapterPreservesDynamicFieldsAndSourceIdentity(t *testing.T) {
	a := NewAdapter(nil, "https://tickets.example/open_api_v1")
	ticket, e := a.DecodeTicket(json.RawMessage(`{"id":20713607,"field_num":"#717","platform":"new_channel","status":"custom_status","user_group_id":5060,"user_email":"customer@example.com","custom_fields_v2":"{\"NewField\":\"kept\"}","custom_fields":{"Upload":[{"file_url":"https://files.example/photo.jpg?signature=secret","file_name":"photo.jpg"}]},"attachments":[{"url":"javascript:alert(1)"},{"url":"https://files.example/original.eml?token=secret","file_size":1234}],"future_field":{"a":true}}`))
	if e != nil {
		t.Fatal(e)
	}
	if ticket.ID != "20713607" || ticket.Number != "#717" || ticket.GroupID != "5060" || ticket.StatusCode != "custom_status" || ticket.ChannelCode != "new_channel" {
		t.Fatal(ticket)
	}
	if ticket.CustomValues["NewField"] != "kept" || len(ticket.Attachments) != 1 || ticket.Attachments[0].Kind != "email" {
		t.Fatal(ticket)
	}
	b, _ := json.Marshal(ticket)
	var m M
	_ = json.Unmarshal(b, &m)
	if string(b) == "" || m["Evidence"] != nil || m["field_num"] != nil {
		t.Fatal("source DTO leaked", string(b))
	}
	if a.TicketURL(ticket.ID) != "https://tickets.example/entry/ticket/show/20713607" {
		t.Fatal(a.TicketURL(ticket.ID))
	}
	if ResolveAttachment(ticket.Evidence, "https://files.example/photo.jpg") != "https://files.example/photo.jpg?signature=secret" {
		t.Fatal("custom attachment lost")
	}
	if ResolveAttachment(ticket.Evidence, "https://files.example/not-member.jpg") != "" {
		t.Fatal("unrelated attachment accepted")
	}
	if _, e = a.DecodeTicket(json.RawMessage(`{"field_num":"#717"}`)); e == nil {
		t.Fatal("missing ID accepted")
	}
}
func TestAdapterOwnsChronologicalSourcePagination(t *testing.T) {
	a := NewAdapter(adapterFixture{pages: map[string]M{
		"tickets/1/replies:1": {"replies": []M{{"id": 4}, {"id": 3}}, "meta": M{"total_pages": 2, "total_count": 4}},
		"tickets/1/replies:2": {"replies": []M{{"id": 2, "function_type": "internat"}, {"id": 1, "author": M{"user_type": "end_user"}}}, "meta": M{"total_pages": 2, "total_count": 4}},
	}}, "tenant")
	p, e := a.ReadConversation(context.Background(), "1", 1)
	if e != nil {
		t.Fatal(e)
	}
	if p.CurrentPage != 1 || p.SourcePage != 2 || p.Messages[0].ID != "1" || p.Messages[0].Author.Kind != "customer" || p.Messages[1].Kind != "internal" {
		t.Fatal(p)
	}
	if _, e = a.ReadConversation(context.Background(), "1", 3); e == nil {
		t.Fatal("invalid page accepted")
	}
}
func TestAdapterRejectsPartialSyncAndDeduplicatesFinalRepeat(t *testing.T) {
	first := M{"contents": []M{{"ticket": M{"id": 1}}}, "meta": M{"total_pages": 3}}
	pages := map[string]M{"tickets:1": first, "tickets:2": {"contents": []M{{"id": 2}}}, "tickets:3": first}
	a := NewAdapter(adapterFixture{pages: pages}, "tenant")
	tickets, e := a.ScanTickets(context.Background(), "")
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual([]string{tickets[0].ID, tickets[1].ID}, []string{"1", "2"}) {
		t.Fatal(tickets)
	}
	pages["tickets:2"] = first
	if _, e = a.ScanTickets(context.Background(), ""); e == nil {
		t.Fatal("partial scan accepted")
	}
}
func TestMetadataTranslationKeepsUnknownFieldsAndOptions(t *testing.T) {
	a := NewAdapter(nil, "tenant")
	m, e := a.DecodeMetadata(map[string]json.RawMessage{"fields": json.RawMessage(`{"fields":[{"field_name":"NewField","field_label":"新字段","content_type":"new_type","options":[{"value":"x","title":"X","subs":[{"value":"y","title":"Y"}]}]}]}`)})
	if e != nil || m.Fields[0].Kind != "new_type" || m.Fields[0].Options[0].Children[0].Label != "Y" {
		t.Fatal(m, e)
	}
	var _ source.TicketReader = a
}
