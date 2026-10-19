package tickets

import (
	"context"
)

// AttachmentURL resolves only inside an authorized live record, never an arbitrary URL.
func (s *Service) AttachmentURL(ctx context.Context, actor M, key, ref string, replyPage int) (string, error) {
	t, _, e := s.detail(ctx, actor, key, false)
	if e != nil {
		return "", e
	}
	if found := s.API.ResolveAttachment(t.Evidence, ref); found != "" {
		return found, nil
	}
	if replyPage > 0 && replyPage <= 100000 {
		// detail already checked once in this request; reuse that authorization result.
		page, e := s.API.ReadConversation(ctx, key, replyPage)
		if e != nil {
			return "", e
		}
		if found := s.API.ResolveAttachment(page.Evidence, ref); found != "" {
			return found, nil
		}
	}
	return "", fail("Attachment not found on this ticket.", 404)
}
