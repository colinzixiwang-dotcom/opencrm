package tickets

import (
	"context"
	"gorm.io/gorm"
	"harbor/internal/domain"
	"harbor/internal/persistence"
	"harbor/internal/ruoyi"
	"net/url"
	"strconv"
	"strings"
)

func (s *Service) all(ctx context.Context, path, key string, q url.Values) ([]M, error) {
	out := []M{}
	if q == nil {
		q = url.Values{}
	}
	for page := 1; page <= 1000; page++ {
		q.Set("page", strconv.Itoa(page))
		q.Set("per_page", "100")
		v, e := s.API.Get(ctx, path, q)
		if e != nil {
			return nil, e
		}
		out = append(out, rows(v[key])...)
		if page >= int(domain.N(obj(v["meta"])["total_pages"])) {
			return out, nil
		}
	}
	return nil, fail("Udesk account pagination exceeded its limit.", 502)
}
func (s *Service) SyncAccounts(ctx context.Context, actor M, reset bool) (M, error) {
	if !admin(actor) {
		return nil, fail("Only administrators can synchronize Udesk accounts.", 403)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	agents, e := s.all(ctx, "agents", "agents", url.Values{"with_disabled": {"true"}})
	if e != nil {
		return nil, e
	}
	groups, e := s.all(ctx, "user_groups", "user_groups", nil)
	if e != nil {
		return nil, e
	}
	roles, e := s.API.Get(ctx, "agent_roles", nil)
	if e != nil {
		return nil, e
	}
	// Whitelist account data: the agent API can contain unrelated SIP passwords.
	clean := []M{}
	for _, a := range agents {
		v := M{}
		for _, k := range []string{"id", "email", "nick_name", "role_name", "disable_status", "user_group_ids", "profile"} {
			v[k] = a[k]
		}
		clean = append(clean, v)
	}
	hash := domain.HashPassword("HarborDemo!2026")
	e = s.DB.Transaction(func(tx *gorm.DB) error {
		if e := persistence.Lock(tx); e != nil {
			return e
		}
		if e := EnsureRoles(tx); e != nil {
			return e
		}
		seen := []string{}
		for _, a := range clean {
			aid := id(a["id"])
			email := strings.ToLower(strings.TrimSpace(id(a["email"])))
			if aid == "" || !strings.Contains(email, "@") {
				return fail("Udesk returned an account without a valid ID or email.", 502)
			}
			sourceRole := strings.ToLower(strings.TrimSpace(id(a["role_name"])))
			enabled := id(a["disable_status"]) == "enable"
			scope := "own"
			roleKey := "support_agent"
			switch sourceRole {
			case "admin", "administrator", "超级管理员", "管理员":
				roleKey = "admin"
			case "supervisor", "manager", "主管", "组长":
				roleKey = "support_supervisor"
				scope = "group"
			}
			var m Mapping
			lookup := tx.Where("tenant=? AND agent_id=?", s.Tenant, aid).First(&m).Error
			if lookup != nil && lookup != gorm.ErrRecordNotFound {
				return lookup
			}
			var user ruoyi.SysUser
			isNew := false
			if lookup == nil {
				if e := tx.First(&user, "user_id=?", m.UserID).Error; e != nil {
					return e
				}
			} else {
				err := tx.Where("email=?", email).First(&user).Error
				if err == gorm.ErrRecordNotFound {
					user = ruoyi.SysUser{UserID: domain.ID("USR"), Password: hash}
					isNew = true
				} else if err != nil {
					return err
				}
				var conflict int64
				tx.Model(&Mapping{}).Where("user_id=?", user.UserID).Count(&conflict)
				if conflict > 0 {
					return fail("An account is already mapped to another Udesk agent.", 409)
				}
				m = Mapping{Tenant: s.Tenant, AgentID: aid, UserID: user.UserID, Scope: scope, Groups: enc(a["user_group_ids"])}
			}
			// Preserve existing non-source accounts' role grants on an email match.
			if isNew || lookup == nil {
				if m.Managed {
					roleKey = "support_agent"
					if m.Scope == "group" {
						roleKey = "support_supervisor"
					}
				}
				var role ruoyi.SysRole
				if e := tx.Where("role_key=?", roleKey).First(&role).Error; e != nil {
					return e
				}
				if e := tx.Where("user_id=?", user.UserID).Delete(&ruoyi.UserRole{}).Error; e != nil {
					return e
				}
				if e := tx.Create(&ruoyi.UserRole{UserID: user.UserID, RoleID: role.RoleID}).Error; e != nil {
					return e
				}
			}
			user.UserName = id(a["nick_name"])
			if user.UserName == "" {
				user.UserName = email
			}
			user.Email = email
			user.LoginName = email
			user.Status = "1"
			if enabled {
				user.Status = "0"
			}
			if reset {
				user.Password = hash
			}
			if e := tx.Save(&user).Error; e != nil {
				return e
			}
			sourceGroups := []string{}
			if raw, ok := a["user_group_ids"].([]any); ok {
				for _, g := range raw {
					sourceGroups = append(sourceGroups, id(g))
				}
			}
			if !m.Managed {
				m.Scope = scope
				m.Groups = enc(sourceGroups)
			}
			m.Email = email
			m.Name = user.UserName
			m.SourceRole = sourceRole
			m.SourceGroups = enc(sourceGroups)
			m.Enabled = enabled
			if e := tx.Save(&m).Error; e != nil {
				return e
			}
			seen = append(seen, aid)
			if !enabled {
				if e := tx.Exec(persistence.SQL(tx, "DELETE FROM sessions WHERE user_id=?"), user.UserID).Error; e != nil {
					return e
				}
			}
		}
		// Only after a complete source scan: disappeared mapped identities lose access.
		missing := []Mapping{}
		q := tx.Where("tenant=?", s.Tenant)
		if len(seen) > 0 {
			q = q.Where("agent_id NOT IN ?", seen)
		}
		if e := q.Find(&missing).Error; e != nil {
			return e
		}
		for _, m := range missing {
			if e := tx.Model(&m).Update("enabled", false).Error; e != nil {
				return e
			}
			if e := tx.Model(&ruoyi.SysUser{}).Where("user_id=?", m.UserID).Update("status", "1").Error; e != nil {
				return e
			}
			tx.Exec(persistence.SQL(tx, "DELETE FROM sessions WHERE user_id=?"), m.UserID)

		}
		if reset {
			if e := tx.Model(&ruoyi.SysUser{}).Where("1=1").Update("password", hash).Error; e != nil {
				return e
			}
			if e := tx.Exec(persistence.SQL(tx, "DELETE FROM sessions")).Error; e != nil {
				return e
			}
		}
		if e := persistence.AppendAudit(tx, M{"id": domain.ID("AUD"), "action": "udesk.accounts.sync", "actor": actor["name"], "at": domain.Now(), "accounts": len(clean), "resetPasswords": reset}); e != nil {
			return e
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	for kind, data := range map[string]M{"agents": {"agents": clean}, "groups": {"user_groups": groups}, "roles": roles} {
		if e = s.saveMetadata(kind, data); e != nil {
			return nil, e
		}
	}
	return M{"accounts": len(clean), "groups": len(groups), "resetPasswords": reset, "fetchedAt": domain.Now()}, nil
}
func (s *Service) Accounts(actor M) (M, error) {
	if !admin(actor) {
		return nil, fail("Only administrators can manage Udesk mappings.", 403)
	}
	m := []Mapping{}
	if e := s.DB.Where("tenant=?", s.Tenant).Order("name").Find(&m).Error; e != nil {
		return nil, e
	}
	g, _ := s.metadata("groups")
	r, _ := s.metadata("roles")
	return M{"mappings": m, "groups": g["user_groups"], "roles": r["agent_roles"]}, nil
}
