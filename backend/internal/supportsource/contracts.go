// Package supportsource is the consumer-owned contract between Support Access
// and external support systems. Provider DTOs must not cross this boundary.
package supportsource

import (
	"context"
	"encoding/json"
	"time"
)

const MappingVersion = 1

type Reference struct {
	Provider string `json:"provider"`
	Tenant   string `json:"tenant"`
	ID       string `json:"id"`
}
type Attachment struct {
	Reference string `json:"reference"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Size      int64  `json:"size"`
	Origin    string `json:"origin"`
	MessageID string `json:"messageId,omitempty"`
	URL       string `json:"-"`
}
type Option struct {
	Value    any      `json:"value"`
	Label    string   `json:"label"`
	Children []Option `json:"children,omitempty"`
}
type Field struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Kind    string   `json:"kind"`
	Options []Option `json:"options,omitempty"`
}
type FieldValue struct {
	Field
	Value   any    `json:"value"`
	Section string `json:"section"`
}
type Template struct {
	ID     string  `json:"id"`
	Fields []Field `json:"fields"`
}
type Ticket struct {
	Ref               Reference      `json:"reference"`
	ID                string         `json:"id"`
	Number            string         `json:"number"`
	Subject           string         `json:"subject"`
	Content           string         `json:"content"`
	ContentFormat     string         `json:"contentFormat"`
	Status            string         `json:"status"`
	StatusCode        string         `json:"statusCode"`
	Channel           string         `json:"channel"`
	ChannelCode       string         `json:"channelCode"`
	Priority          string         `json:"priority"`
	AssigneeID        string         `json:"assigneeId"`
	AssigneeName      string         `json:"assigneeName"`
	GroupID           string         `json:"groupId"`
	GroupName         string         `json:"groupName"`
	CustomerID        string         `json:"customerId"`
	CustomerName      string         `json:"customerName"`
	CustomerEmail     string         `json:"customerEmail"`
	CustomerPhone     string         `json:"customerPhone"`
	CustomerTelephone string         `json:"customerTelephone"`
	TemplateID        string         `json:"templateId"`
	CreatedAt         string         `json:"createdAt"`
	UpdatedAt         string         `json:"updatedAt"`
	RepliedAt         string         `json:"repliedAt"`
	CustomValues      map[string]any `json:"customValues"`
	Fields            []FieldValue   `json:"fields"`
	Attachments       []Attachment   `json:"attachments"`
	// Evidence is opaque to business code, used only for persistence and the
	// temporary v1 HTTP presenter. It is never serialized into the CRM v2 API.
	Evidence json.RawMessage `json:"-"`
}
type Author struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Email string `json:"email,omitempty"`
}
type Message struct {
	ID            string          `json:"id"`
	Kind          string          `json:"kind"`
	Content       string          `json:"content"`
	ContentFormat string          `json:"contentFormat"`
	CreatedAt     string          `json:"createdAt"`
	Author        Author          `json:"author"`
	Attachments   []Attachment    `json:"attachments"`
	Evidence      json.RawMessage `json:"-"`
}
type ConversationPage struct {
	Messages    []Message       `json:"messages"`
	CurrentPage int             `json:"currentPage"`
	TotalPages  int             `json:"totalPages"`
	TotalCount  int             `json:"totalCount"`
	SourcePage  int             `json:"-"`
	Evidence    json.RawMessage `json:"-"`
}
type Filter struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
}
type Metadata struct {
	Fields    []Field                    `json:"fields"`
	Templates []Template                 `json:"templates"`
	Filters   []Filter                   `json:"filters"`
	Evidence  map[string]json.RawMessage `json:"-"`
}
type Group struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Agent struct {
	ID       string   `json:"id"`
	Email    string   `json:"email"`
	Name     string   `json:"name"`
	Role     string   `json:"role"`
	Enabled  bool     `json:"enabled"`
	GroupIDs []string `json:"groupIds"`
}
type Directory struct {
	Agents []Agent
	Groups []Group
	Roles  []Group
}

// The provider owns traversal and validates completeness. Sync only publishes a
// batch when ScanTickets has succeeded, preserving its transaction boundary.
type TicketReader interface {
	ReadTicket(context.Context, string, bool) (Ticket, error)
	ReadConversation(context.Context, string, int) (ConversationPage, error)
}
type SyncSource interface {
	ScanTickets(context.Context, string) ([]Ticket, error)
}
type DirectoryReader interface {
	ReadMetadata(context.Context) (Metadata, error)
	ReadDirectory(context.Context) (Directory, error)
	ReadGroups(context.Context) ([]Group, error)
}
type Source interface {
	TicketReader
	SyncSource
	DirectoryReader
	Tenant() string
	TicketURL(string) string
	// Legacy records are upgraded by the provider's codec, not by domain code.
	DecodeTicket(json.RawMessage) (Ticket, error)
	DecodeMetadata(map[string]json.RawMessage) (Metadata, error)
}

type ErrorKind string

const (
	Unavailable     ErrorKind = "unavailable"
	RateLimited     ErrorKind = "rate_limited"
	InvalidResponse ErrorKind = "invalid_response"
	NotFound        ErrorKind = "not_found"
	Rejected        ErrorKind = "rejected"
	InvalidQuery    ErrorKind = "invalid_query"
)

type Error struct {
	Kind    ErrorKind
	Message string
}

func (e *Error) Error() string { return e.Message }
func ParseTime(value string) *time.Time {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05 -0700", "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, e := time.Parse(layout, value); e == nil {
			t = t.UTC()
			return &t
		}
	}
	return nil
}
