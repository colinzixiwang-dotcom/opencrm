package supportsource

import "context"

type backgroundKey struct{}

// Background marks synchronization work so interactive source reads get the next
// available slot. Both classes still consume the same provider request budget.
func Background(ctx context.Context) context.Context {
	return context.WithValue(ctx, backgroundKey{}, true)
}
func IsBackground(ctx context.Context) bool {
	value, _ := ctx.Value(backgroundKey{}).(bool)
	return value
}
