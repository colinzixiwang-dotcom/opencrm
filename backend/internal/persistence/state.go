package persistence

import (
	"bytes"
	"encoding/json"
	"fmt"
	"gorm.io/gorm"
	"harbor/internal/domain"
	"sort"
	"strconv"
	"strings"
)

type M = domain.M
type Collection struct{ Key, Owner, Table string }

// Only existing capabilities are represented. Each row is one current aggregate,
// not an entire workspace. JSONB preserves flexible fields and policy snapshots.
var Collections = []Collection{
	{"products", "catalog", "products"}, {"serials", "catalog", "serials"},
	{"rmas", "rma", "cases"}, {"rmaTasks", "rma", "tasks"}, {"supportOrders", "rma", "orders"}, {"benefitHistory", "rma", "benefit_history"},
	{"audit", "audit", "entries"},
	{"suppliers", "operations", "suppliers"}, {"warehouses", "operations", "warehouses"}, {"stocks", "operations", "stocks"}, {"movements", "operations", "movements"}, {"purchases", "operations", "purchases"}, {"sales", "operations", "sales"}, {"shipments", "operations", "shipments"}, {"payments", "operations", "payments"}, {"expenses", "operations", "expenses"}, {"campaigns", "operations", "campaigns"}, {"tasks", "operations", "tasks"}, {"tickets", "operations", "legacy_tickets"},
}

func Owners() []string {
	set := map[string]bool{"configuration": true}
	for _, owner := range Tables {
		set[owner] = true
	}
	for _, c := range Collections {
		set[c.Owner] = true
	}
	out := []string{}
	for owner := range set {
		out = append(out, owner)
	}
	sort.Strings(out)
	return out
}
func Read(db *gorm.DB) (M, error) {
	state := M{}
	var values []struct{ Key, Data string }
	if e := db.Table(Table(db, "workspace_values")).Find(&values).Error; e != nil {
		return nil, e
	}
	for _, v := range values {
		var value any
		if e := json.Unmarshal([]byte(v.Data), &value); e != nil {
			return nil, e
		}
		state[v.Key] = value
	}
	config := M{}
	values = nil
	if e := db.Table(OwnerTable(db, "configuration", "documents")).Find(&values).Error; e != nil {
		return nil, e
	}
	for _, v := range values {
		var value any
		if e := json.Unmarshal([]byte(v.Data), &value); e != nil {
			return nil, e
		}
		if v.Key == "settings" {
			state["settings"] = value
		} else {
			config[v.Key] = value
		}
	}
	state["supportConfig"] = config
	for _, c := range Collections {
		var rows []struct{ Data string }
		q := db.Table(OwnerTable(db, c.Owner, c.Table)).Order("position,id")
		if c.Key == "audit" {
			q = q.Limit(5000)
		}
		if e := q.Find(&rows).Error; e != nil {
			return nil, e
		}
		items := []M{}
		for _, row := range rows {
			var item M
			if e := json.Unmarshal([]byte(row.Data), &item); e != nil {
				return nil, e
			}
			items = append(items, item)
		}
		state[c.Key] = items
	}
	// Access tables are authoritative. Domain compatibility receives a projection,
	// never another persisted copy of credentials or role assignments.
	var users []struct{ ID, Name, Email, PasswordHash, Role, Status string }
	query := SQL(db, `SELECT u.user_id AS id,u.user_name AS name,u.email,u.password AS password_hash,u.status,
 COALESCE((SELECT r.role_key FROM sys_user_role ur JOIN sys_role r ON r.role_id=ur.role_id WHERE ur.user_id=u.user_id ORDER BY r.role_sort,r.role_id LIMIT 1),'unassigned') AS role FROM sys_user u ORDER BY u.user_id`)
	if e := db.Raw(query).Scan(&users).Error; e != nil {
		return nil, e
	}
	result := []M{}
	for _, u := range users {
		result = append(result, M{"id": u.ID, "name": u.Name, "email": u.Email, "passwordHash": u.PasswordHash, "role": u.Role, "active": u.Status == "0"})
	}
	state["users"] = result
	return state, nil
}
func put(db *gorm.DB, table, key string, value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	return db.Exec("INSERT INTO "+table+" (key,data) VALUES (?,?::jsonb) ON CONFLICT(key) DO UPDATE SET data=excluded.data WHERE "+table+".data IS DISTINCT FROM excluded.data", key, string(b)).Error
}
func Write(db *gorm.DB, state M) error {
	known := map[string]bool{"users": true, "settings": true, "supportConfig": true}
	for _, c := range Collections {
		known[c.Key] = true
		table := OwnerTable(db, c.Owner, c.Table)

		items := domain.Rows(state, c.Key)
		var stored []struct {
			ID       string
			Position int
			Data     string
		}
		if e := db.Table(table).Find(&stored).Error; e != nil {
			return e
		}
		old := map[string]struct {
			Position int
			Data     []byte
		}{}
		for _, row := range stored {
			var value any
			if e := json.Unmarshal([]byte(row.Data), &value); e != nil {
				return e
			}
			data, e := json.Marshal(value)
			if e != nil {
				return e
			}
			old[row.ID] = struct {
				Position int
				Data     []byte
			}{row.Position, data}
		}
		if c.Key == "audit" {
			for i := len(items) - 1; i >= 0; i-- {
				if _, exists := old[domain.Str(items[i]["id"])]; !exists {
					if e := AppendAudit(db, items[i]); e != nil {
						return e
					}
				}
			}
			continue
		}
		ids := []string{}
		seen := map[string]bool{}
		values := []string{}
		args := []any{}
		for i, item := range items {
			key := domain.Str(item["id"])
			if key == "" {
				key = "row:" + strconv.Itoa(i)
			}
			if seen[key] {
				return fmt.Errorf("duplicate aggregate ID in %s", c.Key)
			}
			seen[key] = true
			ids = append(ids, key)
			data, e := json.Marshal(item)
			if e != nil {
				return e
			}
			before, exists := old[key]
			if exists && before.Position == i && bytes.Equal(before.Data, data) {
				continue
			}
			values = append(values, "(?,?,?::jsonb)")
			args = append(args, key, i, string(data))
		}
		if len(values) > 0 {
			q := "INSERT INTO " + table + " (id,position,data) VALUES " + strings.Join(values, ",") + " ON CONFLICT(id) DO UPDATE SET position=excluded.position,data=excluded.data"
			if e := db.Exec(q, args...).Error; e != nil {
				return e
			}
		}
		removed := []string{}
		for id := range old {
			if !seen[id] {
				removed = append(removed, id)
			}
		}
		if len(removed) > 0 {
			if e := db.Table(table).Where("id IN ?", removed).Delete(&aggregateRow{}).Error; e != nil {
				return e
			}
		}

	}
	if e := put(db, OwnerTable(db, "configuration", "documents"), "settings", state["settings"]); e != nil {
		return e
	}
	config := domain.Obj(state["supportConfig"])
	for k, v := range config {
		if e := put(db, OwnerTable(db, "configuration", "documents"), k, v); e != nil {
			return e
		}
	}
	for k, v := range state {
		if !known[k] {
			if e := put(db, Table(db, "workspace_values"), k, v); e != nil {
				return e
			}
		}
	}
	return nil
}

type aggregateRow struct{ ID string }

func CreateStateTables(db *gorm.DB) error {
	for _, c := range Collections {
		table := OwnerTable(db, c.Owner, c.Table)
		if e := db.Exec("CREATE TABLE " + table + " (id text PRIMARY KEY, position bigint NOT NULL, data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'))").Error; e != nil {
			return e
		}
	}
	for _, table := range []string{Table(db, "workspace_values"), OwnerTable(db, "configuration", "documents")} {
		if e := db.Exec("CREATE TABLE " + table + " (key text PRIMARY KEY, data jsonb NOT NULL)").Error; e != nil {
			return e
		}
	}
	return nil
}
func AssertEmpty(db *gorm.DB) error {
	var n int64
	if e := db.Table(Table(db, "workspace_values")).Count(&n).Error; e != nil {
		return e
	}
	if n > 0 {
		return fmt.Errorf("target contains initialized business data; refusing legacy import")
	}
	return nil
}

// AppendAudit is the append-only persistence port used by account synchronization
// and existing business commands. The caller holds the transaction command lock.
func AppendAudit(db *gorm.DB, entry M) error {
	b, e := json.Marshal(entry)
	if e != nil {
		return e
	}
	table := OwnerTable(db, "audit", "entries")
	return db.Exec("INSERT INTO "+table+" (id,position,data) SELECT ?,COALESCE(MIN(position),0)-1,?::jsonb FROM "+table+" ON CONFLICT(id) DO NOTHING", domain.Str(entry["id"]), string(b)).Error
}
