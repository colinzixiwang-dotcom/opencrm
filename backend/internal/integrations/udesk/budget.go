package udesk

import (
	"context"
	source "harbor/internal/supportsource"
	"time"
)

// Do not reserve a long FIFO of future slots: pending interactive reads may
// overtake a background scan. Active HTTP calls are never interrupted.
func (c *Client) acquire(ctx context.Context) error {
	foreground := !source.IsBackground(ctx)
	if foreground {
		c.mu.Lock()
		c.foreground++
		c.mu.Unlock()
		defer func() { c.mu.Lock(); c.foreground--; c.mu.Unlock() }()
	}
	for {
		if e := ctx.Err(); e != nil {
			return e
		}
		c.mu.Lock()
		wait := time.Until(c.next)
		if wait <= 0 && (foreground || c.foreground == 0) {
			c.next = time.Now().Add(1100 * time.Millisecond)
			c.mu.Unlock()
			return nil
		}
		c.mu.Unlock()
		if wait <= 0 || wait > 50*time.Millisecond {
			wait = 50 * time.Millisecond
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
