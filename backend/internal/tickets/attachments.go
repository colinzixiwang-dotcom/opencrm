package tickets

import (
	"context"
	"encoding/json"
	"harbor/internal/domain"
	"net/url"
	"strings"
)

// AttachmentURL resolves a credential-free reference only against an authorized
// live source payload. The browser cannot provide an arbitrary fetch target.
func (s *Service) AttachmentURL(ctx context.Context, actor M, key, ref string, replyPage int) (string, error) {
	ticket, _, err := s.detail(ctx, actor, key, false)
	if err != nil {
		return "", err
	}
	var find func(any, int) string
	find = func(value any, depth int) string {
		if depth > 16 {
			return ""
		}
		switch v := value.(type) {
		case map[string]any:
			for k, val := range v {
				if k == "url" || k == "file_url" || k == "download_url" {
					raw := domain.Str(val)
					u, e := url.Parse(raw)
					if e == nil && u.User == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Scheme+"://"+u.Host+u.EscapedPath() == ref {
						return raw
					}
				}
				if found := find(val, depth+1); found != "" {
					return found
				}
			}
		case []any:
			for _, val := range v {
				if found := find(val, depth+1); found != "" {
					return found
				}
			}
		case string:
			if strings.HasPrefix(strings.TrimSpace(v), "{") || strings.HasPrefix(strings.TrimSpace(v), "[") {
				var parsed any
				if json.Unmarshal([]byte(v), &parsed) == nil {
					return find(parsed, depth+1)
				}
			}
		}
		return ""
	}
	if found := find(ticket, 0); found != "" {
		return found, nil
	}
	if replyPage > 0 && replyPage <= 100000 {
		replies, e := s.Replies(ctx, actor, key, replyPage)
		if e != nil {
			return "", e
		}
		if found := find(replies, 0); found != "" {
			return found, nil
		}
	}
	return "", fail("Attachment not found on this ticket.", 404)
}
