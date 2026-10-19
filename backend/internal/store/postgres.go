package store

import (
	"database/sql"
	"fmt"
	"gorm.io/gorm"
	"harbor/internal/domain"
	"harbor/internal/persistence"
	"harbor/internal/ruoyi"
	"harbor/internal/support"
	"harbor/internal/tickets"
)

// Migrate applies the current model once. Only existing capabilities are created.
func Migrate(db *gorm.DB) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if e := persistence.Lock(tx); e != nil {
			return e
		}
		for _, owner := range persistence.Owners() {
			if e := tx.Exec(`CREATE SCHEMA IF NOT EXISTS "` + persistence.Prefix(tx) + owner + `"`).Error; e != nil {
				return e
			}
		}
		ledger := persistence.Table(tx, "schema_migrations")
		if e := tx.Exec("CREATE TABLE IF NOT EXISTS " + ledger + " (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())").Error; e != nil {
			return e
		}
		var n int64
		if e := tx.Table(ledger).Where("version=1").Count(&n).Error; e != nil {
			return e
		}
		if n > 0 {
			return migrateTicketIndex(tx, ledger)
		}
		if e := tx.AutoMigrate(&ruoyi.SysUser{}, &ruoyi.SysRole{}, &ruoyi.SysMenu{}, &ruoyi.UserRole{}, &ruoyi.RoleMenu{}); e != nil {
			return e
		}
		if e := tickets.Init(tx); e != nil {
			return e
		}
		for _, q := range []string{
			"CREATE TABLE " + persistence.Table(tx, "sessions") + " (hash text PRIMARY KEY,user_id text NOT NULL,expires bigint NOT NULL)",
			"CREATE TABLE " + persistence.Table(tx, "request_receipts") + " (key text PRIMARY KEY,user_id text NOT NULL,payload_hash text NOT NULL,result jsonb NOT NULL,created bigint NOT NULL)",
		} {
			if e := tx.Exec(q).Error; e != nil {
				return e
			}
		}
		if e := persistence.CreateStateTables(tx); e != nil {
			return e
		}
		if e := tx.Exec("INSERT INTO " + ledger + " (version) VALUES(1)").Error; e != nil {
			return e
		}
		return migrateTicketIndex(tx, ledger)
	})
}

// Open's nonempty argument is an isolated test namespace, never a filesystem path.
// Production always uses the configured PostgreSQL instance and imported data.
func Open(namespace string) (*Store, error) {
	db, e := persistence.Open(namespace)
	if e != nil {
		return nil, e
	}
	s := &Store{DB: db}
	if e = Migrate(db); e != nil {
		s.Close()
		return nil, e
	}
	e = db.Transaction(func(tx *gorm.DB) error {
		if e := persistence.Lock(tx); e != nil {
			return e
		}
		var n int64
		if e := tx.Table(persistence.Table(tx, "workspace_values")).Count(&n).Error; e != nil {
			return e
		}
		if n > 0 {
			return nil
		}
		if namespace == "" {
			return fmt.Errorf("PostgreSQL is empty: import the existing workspace before starting the server")
		}
		state := domain.Seed()
		domain.Migrate(state)
		support.Ensure(state)
		if e := (ruoyi.Service{DB: tx}).Init(state); e != nil {
			return e
		}
		// Explicit seed IDs must not collide with PostgreSQL-generated role/menu IDs.
		if e := ResetSequences(tx); e != nil {
			return e
		}
		if e := (ruoyi.Service{DB: tx}).EnsureSupportMenus(); e != nil {
			return e
		}
		if e := tickets.EnsureRoles(tx); e != nil {
			return e
		}
		return persistence.Write(tx, state)
	})
	if e != nil {
		s.Close()
		return nil, e
	}
	return s, nil
}
func ResetSequences(db *gorm.DB) error {
	for _, v := range []struct{ Table, Column string }{{"sys_role", "role_id"}, {"sys_menu", "menu_id"}, {"tickets", "id"}, {"metadata", "id"}, {"mappings", "id"}, {"links", "id"}, {"reply_pages", "id"}} {
		table := persistence.Table(db, v.Table)
		q := "SELECT setval(pg_get_serial_sequence(?,?),COALESCE(MAX(" + v.Column + "),1),MAX(" + v.Column + ") IS NOT NULL) FROM " + table
		if e := db.Exec(q, table, v.Column).Error; e != nil {
			return e
		}
	}
	return nil
}
func (s *Store) Destroy() error {
	e := persistence.Destroy(s.DB)
	closeErr := s.Close()
	if e != nil {
		return e
	}
	return closeErr
}
func (s *Store) State() (state M, err error) {
	err = s.DB.Transaction(func(tx *gorm.DB) error { state, err = Read(tx); return err }, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	return
}

// v2 is additive. Historical ticket cache rows remain unlisted until a complete
// background scan publishes scope membership; RMA snapshots are untouched.
func migrateTicketIndex(tx *gorm.DB, ledger string) error {
	var n int64
	if e := tx.Table(ledger).Where("version=2").Count(&n).Error; e != nil {
		return e
	}
	if n > 0 {
		return nil
	}
	if e := tx.AutoMigrate(&tickets.Ticket{}, &tickets.SyncState{}, &tickets.FilterMember{}); e != nil {
		return e
	}
	table := persistence.Table(tx, "tickets")
	for _, definition := range []string{
		"ticket_reply_query ON " + table + " (tenant, replied_time DESC NULLS LAST, external_id DESC)",
		"ticket_assignee_query ON " + table + " (tenant, assignee, replied_time DESC NULLS LAST)",
		"ticket_group_query ON " + table + " (tenant, group_id, replied_time DESC NULLS LAST)",
	} {
		if e := tx.Exec("CREATE INDEX IF NOT EXISTS " + definition).Error; e != nil {
			return e
		}
	}
	return tx.Exec("INSERT INTO " + ledger + " (version) VALUES(2)").Error
}
