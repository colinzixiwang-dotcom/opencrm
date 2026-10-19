package supportsource

// PublicResponse removes compatibility-only carrier values. Evidence fields on
// typed records are also excluded by JSON tags, so v2 never exposes raw payloads.
func PublicResponse(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range v {
			if len(k) > 0 && k[0] != '_' {
				out[k] = PublicResponse(val)
			}
		}
		return out
	case []map[string]any:
		out := []map[string]any{}
		for _, item := range v {
			out = append(out, PublicResponse(item).(map[string]any))
		}
		return out
	default:
		return value
	}
}
