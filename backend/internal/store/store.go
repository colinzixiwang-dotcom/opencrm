package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"harbor/internal/domain"
	"harbor/internal/ruoyi"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type M = domain.M
type Store struct {
	DB *gorm.DB
	mu sync.Mutex
}

func Open(path string) (*Store, error) {
	if path != ":memory:" {
		if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
			return nil, e
		}
	}
	db, e := gorm.Open(sqlite.Open(path), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if e != nil {
		return nil, e
	}
	sql, _ := db.DB()
	sql.SetMaxOpenConns(1)
	sql.Exec("PRAGMA journal_mode=WAL")
	sql.Exec("PRAGMA busy_timeout=5000")
	for _, q := range []string{"CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)", "CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)", "CREATE TABLE IF NOT EXISTS request_receipts (key TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL)"} {
		if e := db.Exec(q).Error; e != nil {
			return nil, e
		}
	}
	var count int64
	db.Table("app_state").Count(&count)
	if count == 0 {
		b, _ := json.Marshal(domain.Seed())
		if e := db.Exec("INSERT INTO app_state(id,data) VALUES(1,?)", string(b)).Error; e != nil {
			return nil, e
		}
	}
	s := &Store{DB: db}
	state, e := Read(db)
	if e != nil {
		return nil, e
	}
	domain.Migrate(state)
	if e := Write(db, state); e != nil {
		return nil, e
	}
	if e := db.Transaction(func(tx *gorm.DB) error { return (ruoyi.Service{DB: tx}).Init(state) }); e != nil {
		return nil, e
	}
	return s, nil
}
func (s *Store) Close() error { db, _ := s.DB.DB(); return db.Close() }
func Read(db *gorm.DB) (M, error) {
	var row struct{ Data string }
	if e := db.Raw("SELECT data FROM app_state WHERE id=1").Scan(&row).Error; e != nil {
		return nil, e
	}
	var state M
	e := json.Unmarshal([]byte(row.Data), &state)
	return state, e
}
func Write(db *gorm.DB, s M) error {
	b, e := json.Marshal(s)
	if e != nil {
		return e
	}
	return db.Exec("UPDATE app_state SET data=? WHERE id=1", string(b)).Error
}
func (s *Store) State() (M, error) { return Read(s.DB) }
func Digest(v string) string       { b := sha256.Sum256([]byte(v)); return hex.EncodeToString(b[:]) }
func (s *Store) Apply(uid, action string, b M, key string) (response M, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	payload, _ := json.Marshal(M{"action": action, "payload": b})
	hash := Digest(string(payload))
	err = s.DB.Transaction(func(tx *gorm.DB) error {
		var user ruoyi.SysUser
		if tx.First(&user, "user_id=? AND status='0'", uid).Error != nil {
			return &domain.Error{Message: "Your account no longer has access.", Status: 401}
		}
		svc := ruoyi.Service{DB: tx}
		actor := svc.Actor(user)
		if !svc.Allowed(uid, action) {
			return &domain.Error{Message: "Your role does not permit this action.", Status: 403}
		}
		if key != "" {
			var row struct{ UserID, PayloadHash, Result string }
			r := tx.Raw("SELECT user_id,payload_hash,result FROM request_receipts WHERE key=?", key).Scan(&row)
			if r.Error != nil {
				return r.Error
			}
			if r.RowsAffected > 0 {
				if row.UserID != uid || row.PayloadHash != hash {
					return &domain.Error{Message: "Idempotency key was already used for another request.", Status: 409}
				}
				if e := json.Unmarshal([]byte(row.Result), &response); e != nil {
					return e
				}
				response["replayed"] = true
				return nil
			}
		}
		state, e := Read(tx)
		if e != nil {
			return e
		}
		var result M
		if domain.In(action, "role.save", "menu.save", "user.assignRoles") {
			result, e = svc.SystemAction(action, b, actor)
			if e != nil {
				return e
			}
			state["version"] = domain.N(state["version"]) + 1
			domain.Prepend(state, "audit", M{"id": domain.ID("AUD"), "action": action, "reference": fmt.Sprint(result["id"]), "actor": actor["name"], "at": domain.Now()})
			if len(domain.Rows(state, "audit")) > 5000 {
				state["audit"] = domain.Rows(state, "audit")[:5000]
			}
		} else {
			if domain.In(action, "user.create", "user.update") {
				var count int64
				tx.Model(&ruoyi.SysRole{}).Where("role_key=?", domain.Str(b["role"])).Count(&count)
				if count != 1 {
					return &domain.Error{Message: "Unknown role.", Status: 400}
				}
				if action == "user.update" && (domain.Str(b["role"]) != "admin" || !domain.Bool(b["active"])) {
					target := domain.Str(b["id"])
					hasAdmin := false
					for _, r := range svc.Roles(target) {
						if r.RoleKey == "admin" {
							hasAdmin = true
						}
					}
					if hasAdmin {
						var admins int64
						tx.Table("sys_user_role ur").Joins("JOIN sys_role r ON r.role_id=ur.role_id JOIN sys_user u ON u.user_id=ur.user_id").Where("r.role_key='admin' AND u.status='0'").Count(&admins)
						if admins <= 1 {
							return &domain.Error{Message: "At least one active administrator is required.", Status: 409}
						}
					}
				}
			}
			state, result, e = domain.Mutate(state, action, b, actor)
			if e != nil {
				return e
			}
			if domain.In(action, "user.create", "user.update") {
				if e := svc.SyncUser(result); e != nil {
					return e
				}
			}
		}
		if e := Write(tx, state); e != nil {
			return e
		}
		safe := domain.Clone(result)
		delete(safe, "passwordHash")
		response = M{"result": safe, "version": state["version"]}
		if key != "" {
			encoded, _ := json.Marshal(response)
			if e := tx.Exec("INSERT INTO request_receipts(key,user_id,payload_hash,result,created) VALUES(?,?,?,?,?)", key, uid, hash, string(encoded), time.Now().UnixMilli()).Error; e != nil {
				return e
			}
		}
		return nil
	})
	return response, err
}
