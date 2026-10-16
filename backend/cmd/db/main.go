// db is the explicit migration/import and isolated-test administration tool.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"gorm.io/gorm"
	"harbor/internal/integrations/udesk"
	"harbor/internal/persistence"
	"harbor/internal/store"
	"log"
	"os"
)

func main() {
	action := flag.String("action", "migrate", "migrate, import, dump, destroy-test, verify")
	file := flag.String("file", "", "legacy export JSON path")
	namespace := flag.String("namespace", "", "isolated test namespace only")
	flag.Parse()
	if e := udesk.LoadEnv(".env"); e != nil {
		log.Fatal("Cannot load configuration")
	}
	if e := udesk.LoadEnv("../.env"); e != nil {
		log.Fatal("Cannot load configuration")
	}
	if e := run(*action, *file, *namespace); e != nil {
		log.Fatal(e)
	}
}
func run(action, file, namespace string) error {
	db, e := persistence.Open(namespace)
	if e != nil {
		return e
	}
	pool, _ := db.DB()
	defer pool.Close()
	switch action {
	case "destroy-test":
		return persistence.Destroy(db)
	case "migrate":
		return store.Migrate(db)
	case "import":
		b, e := os.ReadFile(file)
		if e != nil {
			return e
		}
		var export struct {
			State  persistence.M               `json:"state"`
			Tables map[string][]map[string]any `json:"tables"`
		}
		if e = json.Unmarshal(b, &export); e != nil {
			return e
		}
		if export.State["version"] == nil || len(export.Tables["sys_user"]) == 0 {
			return fmt.Errorf("legacy export is incomplete")
		}
		if e = store.Migrate(db); e != nil {
			return e
		}
		return db.Transaction(func(tx *gorm.DB) error {
			if e := persistence.Lock(tx); e != nil {
				return e
			}
			if e := persistence.AssertEmpty(tx); e != nil {
				return e
			}
			// Imports only known current tables; no SQL identifiers from the input.
			for _, name := range []string{"sys_user", "sys_role", "sys_menu", "sys_user_role", "sys_role_menu", "sessions", "request_receipts", "tickets", "metadata", "mappings", "snapshots", "drafts", "links", "reply_pages", "runs"} {
				for _, row := range export.Tables[name] {
					for k, v := range row {
						if n, ok := v.(float64); ok {
							if (name == "mappings") && (k == "enabled" || k == "managed") {
								row[k] = n != 0
							} else {
								row[k] = int64(n)
							}
						}
					}
					if e := tx.Table(persistence.Table(tx, name)).Create(row).Error; e != nil {
						return fmt.Errorf("import %s: %w", name, e)
					}
				}
			}
			if e := persistence.Write(tx, export.State); e != nil {
				return e
			}
			if e := store.ResetSequences(tx); e != nil {
				return e
			}
			fmt.Println("Imported existing workspace, accounts, grants, sessions, Udesk records and drafts into PostgreSQL.")
			return nil
		})
	case "dump":
		state, e := persistence.Read(db)
		if e != nil {
			return e
		}
		b, e := json.Marshal(state)
		if e != nil {
			return e
		}
		fmt.Println(string(b))
		return nil
	case "verify":
		state, e := persistence.Read(db)
		if e != nil {
			return e
		}
		fmt.Println("Storage: PostgreSQL; namespaces:", persistence.Owners())
		for _, c := range persistence.Collections {
			fmt.Printf("%s: %d\n", c.Key, len(state[c.Key].([]persistence.M)))
		}
		for _, name := range []string{"sys_user", "sys_role", "sys_menu", "sys_user_role", "sys_role_menu", "sessions", "tickets", "mappings", "drafts"} {
			var n int64
			if e := db.Table(persistence.Table(db, name)).Count(&n).Error; e != nil {
				return e
			}
			fmt.Printf("%s: %d\n", name, n)
		}
		return nil
	}
	return fmt.Errorf("unknown action")
}
