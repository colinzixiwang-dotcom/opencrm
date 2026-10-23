// Package persistence provides PostgreSQL infrastructure and the compatibility
// repository for today's aggregate documents. It contains no eligibility rules.
package persistence

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
)

var Tables = map[string]string{
	"order_index_records": "order_reference", "order_index_jobs": "integration",
	"import_batches":  "integration",
	"order_evidences": "order_reference",
	"sys_user":        "access_control", "sys_role": "access_control", "sys_menu": "access_control", "sys_user_role": "access_control", "sys_role_menu": "access_control", "sessions": "access_control",
	"tickets": "support_access", "metadata": "support_access", "mappings": "support_access", "snapshots": "support_access", "reply_pages": "support_access",
	"ticket_scopes": "support_access", "ticket_scope_groups": "support_access", "ticket_scope_changes": "support_access",
	"sync_states": "integration", "filter_members": "support_access",
	"drafts": "rma", "links": "rma", "runs": "integration", "request_receipts": "integration", "workspace_values": "integration", "schema_migrations": "integration",
}

type Names struct {
	schema.NamingStrategy
	Prefix string
}

func (n Names) TableName(model string) string {
	name := n.NamingStrategy.TableName(model)
	switch model {
	case "SysUser":
		name = "sys_user"
	case "SysRole":
		name = "sys_role"
	case "SysMenu":
		name = "sys_menu"
	case "UserRole":
		name = "sys_user_role"
	case "RoleMenu":
		name = "sys_role_menu"
	}
	owner := Tables[name]
	if owner == "" {
		return name
	}
	return n.Prefix + owner + "." + name
}
func Prefix(db *gorm.DB) string             { return db.NamingStrategy.(Names).Prefix }
func Table(db *gorm.DB, name string) string { return Prefix(db) + Tables[name] + "." + name }

var identifiers = regexp.MustCompile(`\b(sys_user_role|sys_role_menu|sys_user|sys_role|sys_menu|sessions|request_receipts|tickets|metadata|mappings|snapshots|reply_pages|drafts|links|runs|workspace_values)\b`)

// SQL qualifies known infrastructure table names in static SQL, including joins.
func SQL(db *gorm.DB, query string) string {
	return identifiers.ReplaceAllStringFunc(query, func(name string) string { return Table(db, name) })
}
func OwnerTable(db *gorm.DB, owner, name string) string { return Prefix(db) + owner + "." + name }

// DSN accepts DATABASE_URL or libpq-compatible PG* configuration; no SQLite fallback.
func DSN() (string, error) {
	if raw := strings.TrimSpace(os.Getenv("DATABASE_URL")); raw != "" {
		u, e := url.Parse(raw)
		if e != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
			return "", fmt.Errorf("DATABASE_URL must be a PostgreSQL URL")
		}
		if os.Getenv("PGSSLMODE") != "" && !u.Query().Has("sslmode") {
			q := u.Query()
			q.Set("sslmode", os.Getenv("PGSSLMODE"))
			u.RawQuery = q.Encode()
		}
		return u.String(), nil
	}
	host, db, user := os.Getenv("PGHOST"), os.Getenv("PGDATABASE"), os.Getenv("PGUSER")
	if host == "" || db == "" || user == "" {
		return "", fmt.Errorf("PostgreSQL configuration is required: set DATABASE_URL or PGHOST/PGDATABASE/PGUSER")
	}
	port := os.Getenv("PGPORT")
	if port == "" {
		port = "5432"
	}
	mode := os.Getenv("PGSSLMODE")
	if mode == "" {
		mode = "prefer"
	}
	u := url.URL{Scheme: "postgresql", Host: host + ":" + port, Path: "/" + db, User: url.UserPassword(user, os.Getenv("PGPASSWORD"))}
	q := url.Values{"sslmode": {mode}, "connect_timeout": {"5"}, "application_name": {"morpho_rma_crm"}}
	u.RawQuery = q.Encode()
	return u.String(), nil
}
func Open(namespace string) (*gorm.DB, error) {
	dsn, e := DSN()
	if e != nil {
		return nil, e
	}
	prefix := ""
	if namespace != "" {
		// Tests use isolated schema sets in the same PostgreSQL instance.
		if namespace == ":memory:" {
			b := make([]byte, 16)
			if _, e = rand.Read(b); e != nil {
				return nil, e
			}
			namespace = hex.EncodeToString(b)
		}
		hash := sha256.Sum256([]byte(namespace))
		prefix = "test_" + hex.EncodeToString(hash[:8]) + "_"
	}
	db, e := gorm.Open(postgres.New(postgres.Config{DSN: dsn}), &gorm.Config{NamingStrategy: Names{NamingStrategy: schema.NamingStrategy{}, Prefix: prefix}, Logger: logger.Default.LogMode(logger.Silent), DisableAutomaticPing: true})
	if e != nil {
		return nil, fmt.Errorf("cannot configure PostgreSQL connection")
	}
	pool, e := db.DB()
	if e != nil {
		return nil, e
	}
	pool.SetMaxOpenConns(12)
	pool.SetMaxIdleConns(4)
	pool.SetConnMaxLifetime(30 * time.Minute)
	if e = pool.Ping(); e != nil {
		pool.Close()
		return nil, fmt.Errorf("cannot connect to configured PostgreSQL server (check PG* configuration and server availability)")
	}
	return db, nil
}

// Lock serializes existing map-based commands across processes until each command
// is moved to a dedicated aggregate repository; it never covers network calls.
func Lock(db *gorm.DB) error {
	return db.Exec("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", Prefix(db)+"workspace.commands").Error
}
func Destroy(db *gorm.DB) error {
	prefix := Prefix(db)
	if !strings.HasPrefix(prefix, "test_") {
		return fmt.Errorf("refusing to drop production schemas")
	}
	for _, owner := range Owners() {
		if e := db.Exec(`DROP SCHEMA IF EXISTS "` + prefix + owner + `" CASCADE`).Error; e != nil {
			return e
		}
	}
	return nil
}
