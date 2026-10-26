// Package sourceinfo describes provenance without exposing connector credentials.
package sourceinfo

type Metadata struct {
	ConnectionID    string   `json:"connectionId"`
	API             string   `json:"api"`
	MappingVersion  int      `json:"mappingVersion"`
	FetchedAt       string   `json:"fetchedAt"`
	RawPlatform     string   `json:"rawPlatform,omitempty"`
	RawPlatformCode string   `json:"rawPlatformCode,omitempty"`
	RawStatus       string   `json:"rawStatus,omitempty"`
	Warnings        []string `json:"warnings,omitempty"`
}

// Timestamp preserves naive source dates without inventing their UTC offset.
type Timestamp struct {
	Raw      string `json:"raw"`
	UTC      string `json:"utc,omitempty"`
	TimeZone string `json:"timeZone"`
}
