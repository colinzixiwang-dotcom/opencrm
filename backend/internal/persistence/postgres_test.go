package persistence

import (
	"net/url"
	"testing"
)

func TestPostgresConfigurationHasNoLocalFallback(t *testing.T) {
	for _, key := range []string{"DATABASE_URL", "PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPORT", "PGSSLMODE"} {
		t.Setenv(key, "")
	}
	if _, e := DSN(); e == nil {
		t.Fatal("missing PostgreSQL configuration accepted")
	}
	t.Setenv("DATABASE_URL", "file:local.sqlite")
	if _, e := DSN(); e == nil {
		t.Fatal("non-PostgreSQL URL accepted")
	}
	t.Setenv("DATABASE_URL", "")
	t.Setenv("PGHOST", "192.168.1.84")
	t.Setenv("PGDATABASE", "morpho")
	t.Setenv("PGUSER", "app")
	t.Setenv("PGPASSWORD", "special:@ /?&")
	t.Setenv("PGSSLMODE", "require")
	raw, e := DSN()
	if e != nil {
		t.Fatal(e)
	}
	u, e := url.Parse(raw)
	if e != nil {
		t.Fatal(e)
	}
	password, _ := u.User.Password()
	if password != "special:@ /?&" || u.Query().Get("sslmode") != "require" {
		t.Fatal("connection parameters were corrupted")
	}
}
