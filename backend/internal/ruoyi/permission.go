// Adapted from RuoYi-Go PermissionService.HasPermi and PermitCheck (MIT).
// Copyright (c) 2020 lostvip.com. See third_party/ruoyi-go/LICENSE.
// Changes: JSON API failures instead of template redirects; deny unknown actions;
// database-derived role/menu grants; disabled-role handling; no administrator-ID magic.
package ruoyi

import (
	"fmt"
	"gorm.io/gorm"
	"harbor/internal/domain"
	"harbor/internal/persistence"
	"strings"
)

type M = domain.M
type Service struct{ DB *gorm.DB }

var Modules = []string{"home", "product", "sales", "fba", "purchase", "warehouse", "logistics", "advertising", "service", "finance", "statistics", "tools", "settings"}
var ActionModule = map[string]string{
	"warranty.save": "settings", "rma.create": "rma", "rma.note": "rma", "rmatask.update": "rma", "rmatask.review": "rmatasks", "rmatask.execute": "rmatasks", "rmaconfig.save": "rmaconfig", "supportorder.save": "supportorders", "serial.save": "serials",
	"product.create": "product", "product.update": "product", "supplier.create": "purchase", "warehouse.create": "warehouse",
	"purchase.create": "purchase", "purchase.transition": "purchase", "purchase.receive": "purchase", "purchase.pay": "finance", "inventory.adjust": "warehouse",
	"shipment.create": "logistics", "shipment.transition": "logistics", "sale.create": "sales", "sale.transition": "sales", "sale.return": "sales", "sale.pay": "finance",
	"expense.create": "finance", "campaign.create": "advertising", "campaign.update": "advertising", "ticket.create": "service", "ticket.transition": "service", "task.create": "tools", "task.transition": "tools",
	"settings.update": "settings", "user.create": "settings", "user.update": "settings", "role.save": "settings", "menu.save": "settings", "user.assignRoles": "settings",
}

func Permission(action string) string {
	switch action {
	case "user.create":
		return "system:user:add"
	case "user.update", "user.assignRoles":
		return "system:user:edit"
	case "role.save":
		return "system:role:edit"
	case "menu.save":
		return "system:menu:edit"
	}
	parts := strings.Split(action, ".")
	if len(parts) != 2 {
		return ""
	}
	verb := parts[1]
	if verb == "create" {
		verb = "add"
	}
	if verb == "update" {
		verb = "edit"
	}
	return "erp:" + parts[0] + ":" + verb
}
func ViewPermission(module string) string { return "erp:" + module + ":view" }
func (s Service) Roles(userID string) []SysRole {
	roles := []SysRole{}
	s.DB.Table(persistence.SQL(s.DB, "sys_role r")).Select("r.*").Joins(persistence.SQL(s.DB, "JOIN sys_user_role ur ON ur.role_id=r.role_id")).Where("ur.user_id=? AND r.status=?", userID, "0").Order("r.role_sort, r.role_id").Scan(&roles)
	return roles
}

// These capabilities belong to every active CRM account, including accounts
// with no role assignment. Review, execution and settings remain role controlled.
var sharedTicketPermissions = []string{"erp:service:view", "erp:rma:view", "erp:rma:add"}

func (s Service) activeUser(userID string) bool {
	var n int64
	return s.DB.Model(&SysUser{}).Where("user_id=? AND status=?", userID, "0").Count(&n).Error == nil && n == 1
}
func (s Service) Menus(userID string) []SysMenu {
	out := []SysMenu{}
	if !s.activeUser(userID) {
		return out
	}
	admin := false
	for _, r := range s.Roles(userID) {
		if r.RoleKey == "admin" {
			admin = true
		}
	}
	q := s.DB.Table(persistence.SQL(s.DB, "sys_menu m")).Select("DISTINCT m.*").Where("m.status=?", "0")
	if !admin {
		q = q.Where(persistence.SQL(s.DB, "m.perms IN ? OR m.menu_id IN (SELECT rm.menu_id FROM sys_role_menu rm JOIN sys_user_role ur ON ur.role_id=rm.role_id JOIN sys_role r ON r.role_id=ur.role_id WHERE ur.user_id=? AND r.status=?)"), sharedTicketPermissions, userID, "0")
	}
	q.Order("m.order_num,m.menu_id").Scan(&out)
	return out
}
func (s Service) HasPermi(userID, permission string) bool {
	if permission == "" || !s.activeUser(userID) {
		return false
	}
	for _, role := range s.Roles(userID) {
		if role.RoleKey == "admin" {
			return true
		}
	}
	// RuoYi HasPermi compares each user's assigned menu permission string.
	for _, menu := range s.Menus(userID) {
		if strings.EqualFold(menu.Perms, permission) {
			return true
		}
	}
	return false
}
func (s Service) Allowed(userID, action string) bool {
	_, known := ActionModule[action]
	return known && s.HasPermi(userID, Permission(action))
}
func (s Service) Actor(u SysUser) M {
	roles := s.Roles(u.UserID)
	key := "unassigned"
	keys := []string{}
	admin := false
	for _, r := range roles {
		keys = append(keys, r.RoleKey)
		if r.RoleKey == "admin" {
			admin = true
		}
	}
	if len(keys) > 0 {
		key = keys[0]
	}
	actions := []string{}
	codes := []string{}
	grants := map[string]bool{}
	for _, m := range s.Menus(u.UserID) {
		grants[m.Perms] = true
		codes = append(codes, m.Perms)
	}
	for a := range ActionModule {
		if admin || grants[Permission(a)] {
			actions = append(actions, a)
		}
	}
	if admin {
		codes = append(codes, "*:*:*")
	}
	return M{"id": u.UserID, "name": u.UserName, "email": u.Email, "role": key, "roles": keys, "active": u.Status == "0", "permissions": actions, "permissionCodes": codes}
}
func (s Service) Init(state M) error {
	var count int64
	s.DB.Model(&SysRole{}).Count(&count)
	if count > 0 {
		return nil
	}
	roles := []SysRole{{RoleID: 1, RoleName: "Administrator", RoleKey: "admin", Status: "0", RoleSort: 0}, {RoleID: 2, RoleName: "Operator", RoleKey: "operator", Status: "0", RoleSort: 1}, {RoleID: 3, RoleName: "Analyst", RoleKey: "analyst", Status: "0", RoleSort: 2}}
	for _, r := range roles {
		if e := s.DB.Create(&r).Error; e != nil {
			return e
		}
	}
	menus := []SysMenu{}
	parents := map[string]int64{}
	for i, module := range Modules {
		mid := int64(i + 1)
		parents[module] = mid
		menus = append(menus, SysMenu{MenuID: mid, MenuName: map[string]string{"home": "Overview", "product": "Product", "sales": "Sales", "fba": "FBA", "purchase": "Purchase", "warehouse": "Warehouse", "logistics": "Logistics", "advertising": "Advertising", "service": "Service", "finance": "Finance", "statistics": "Statistics", "tools": "Tools", "settings": "Settings"}[module], MenuType: "C", URL: module, Perms: ViewPermission(module), Status: "0", Visible: "0", Icon: module, OrderNum: i})
	}
	mid := int64(100)
	for a, module := range ActionModule {
		if parents[module] == 0 {
			continue
		}
		menus = append(menus, SysMenu{MenuID: mid, MenuName: a, ParentID: parents[module], MenuType: "F", Perms: Permission(a), Status: "0", Visible: "1", Action: a, OrderNum: int(mid)})
		mid++
	}
	for _, m := range menus {
		if e := s.DB.Create(&m).Error; e != nil {
			return e
		}
		for _, r := range roles {
			if r.RoleKey == "admin" || (m.MenuType != "F") || (r.RoleKey == "operator" && !domain.In(m.Action, "warehouse.create", "purchase.pay", "sale.pay", "expense.create", "settings.update", "user.create", "user.update", "role.save", "menu.save", "user.assignRoles")) {
				if e := s.DB.Create(&RoleMenu{r.RoleID, m.MenuID}).Error; e != nil {
					return e
				}
			}
		}
	}
	for _, u := range domain.Rows(state, "users") {
		if e := s.SyncUser(u); e != nil {
			return e
		}
	}
	return nil
}
func (s Service) SyncUser(u M) error {
	key := domain.Str(u["role"])
	var role SysRole
	if e := s.DB.Where("role_key=?", key).First(&role).Error; e != nil {
		return fmt.Errorf("unknown role: %s", key)
	}
	status := "1"
	if domain.Bool(u["active"]) {
		status = "0"
	}
	user := SysUser{UserID: domain.Str(u["id"]), UserName: domain.Str(u["name"]), LoginName: domain.Str(u["email"]), Email: domain.Str(u["email"]), Password: domain.Str(u["passwordHash"]), Status: status}
	if e := s.DB.Save(&user).Error; e != nil {
		return e
	}
	if e := s.DB.Where("user_id=?", user.UserID).Delete(&UserRole{}).Error; e != nil {
		return e
	}
	return s.DB.Create(&UserRole{user.UserID, role.RoleID}).Error
}
func (s Service) RoleData() []M {
	rows := []SysRole{}
	s.DB.Order("role_sort,role_id").Find(&rows)
	out := []M{}
	for _, r := range rows {
		ids := []int64{}
		s.DB.Model(&RoleMenu{}).Where("role_id=?", r.RoleID).Pluck("menu_id", &ids)
		out = append(out, M{"id": r.RoleID, "roleId": r.RoleID, "roleName": r.RoleName, "roleKey": r.RoleKey, "status": r.Status, "remark": r.Remark, "menuIds": ids})
	}
	return out
}
func (s Service) AllMenus() []SysMenu {
	m := []SysMenu{}
	s.DB.Order("order_num,menu_id").Find(&m)
	return m
}
func (s Service) SystemAction(action string, b, actor M) (M, error) {
	if !s.Allowed(domain.Str(actor["id"]), action) {
		return nil, &domain.Error{Message: "Your role does not permit this action.", Status: 403}
	}
	switch action {
	case "role.save":
		rid := domain.N(b["roleId"])
		name := domain.Required(b["roleName"], "Role name", 60)
		key := domain.Required(b["roleKey"], "Role key", 64)
		if !validKey(key) {
			domain.Fail("Use a role key with letters, digits, underscores, or hyphens.")
		}
		status := domain.Choice(b["status"], "0", "1")
		var role SysRole
		if rid > 0 {
			if s.DB.First(&role, rid).Error != nil {
				domain.Fail("Role not found.", 404)
			}
			if role.RoleKey == "admin" {
				domain.Fail("The built-in administrator role is protected.", 409)
			}
		} else if key == "admin" {
			domain.Fail("Administrator role key is reserved.", 409)
		}
		var duplicate int64
		s.DB.Model(&SysRole{}).Where("role_key=? AND role_id<>?", key, rid).Count(&duplicate)
		if duplicate > 0 {
			domain.Fail("Role key already exists.", 409)
		}
		ids := []int64{}
		seen := map[int64]bool{}
		raw, ok := b["menuIds"].([]any)
		if !ok {
			domain.Fail("menuIds must be an array.")
		}
		for _, v := range raw {
			id := domain.Int(v, "Menu ID", 1, 1000000)
			if seen[id] {
				continue
			}
			seen[id] = true
			var n int64
			s.DB.Model(&SysMenu{}).Where("menu_id=?", id).Count(&n)
			if n != 1 {
				domain.Fail("Unknown menu permission.")
			}
			ids = append(ids, id)
		}
		role.RoleName = name
		role.RoleKey = key
		role.Status = status
		role.Remark = domain.Text(b["remark"], 500)
		if e := s.DB.Save(&role).Error; e != nil {
			return nil, e
		}
		s.DB.Where("role_id=?", role.RoleID).Delete(&RoleMenu{})
		for _, id := range ids {
			if e := s.DB.Create(&RoleMenu{role.RoleID, id}).Error; e != nil {
				return nil, e
			}
		}
		return M{"id": role.RoleID, "roleKey": key}, nil
	case "menu.save":
		var menu SysMenu
		if s.DB.First(&menu, domain.N(b["menuId"])).Error != nil {
			domain.Fail("Menu not found.", 404)
		}
		menu.MenuName = domain.Required(b["menuName"], "Menu name", 60)
		menu.Visible = domain.Choice(b["visible"], "0", "1")
		menu.Status = domain.Choice(b["status"], "0", "1")
		menu.OrderNum = int(domain.Int(b["orderNum"], "Order", 0, 10000))
		if menu.URL == "settings" && menu.Status != "0" {
			domain.Fail("The system settings menu cannot be disabled.", 409)
		}
		return M{"id": menu.MenuID}, s.DB.Save(&menu).Error
	case "user.assignRoles":
		uid := domain.Required(b["id"], "User ID", 100)
		var u SysUser
		if s.DB.First(&u, "user_id=?", uid).Error != nil {
			domain.Fail("User not found.", 404)
		}
		raw, ok := b["roleIds"].([]any)
		if !ok || len(raw) == 0 {
			domain.Fail("Assign at least one role.")
		}
		ids := []int64{}
		admin := false
		seen := map[int64]bool{}
		for _, v := range raw {
			rid := domain.Int(v, "Role ID", 1, 1000000)
			if seen[rid] {
				continue
			}
			seen[rid] = true
			var r SysRole
			if s.DB.First(&r, rid).Error != nil {
				domain.Fail("Unknown role.")
			}
			if r.RoleKey == "admin" {
				admin = true
			}
			ids = append(ids, rid)
		}
		hasAdmin := false
		for _, r := range s.Roles(uid) {
			if r.RoleKey == "admin" {
				hasAdmin = true
			}
		}
		if uid == domain.Str(actor["id"]) && hasAdmin && !admin {
			domain.Fail("You cannot remove your own administrator access.", 409)
		}
		if hasAdmin && !admin {
			var admins int64
			s.DB.Table(persistence.SQL(s.DB, "sys_user_role ur")).Joins(persistence.SQL(s.DB, "JOIN sys_role r ON r.role_id=ur.role_id JOIN sys_user u ON u.user_id=ur.user_id")).Where("r.role_key='admin' AND u.status='0'").Count(&admins)
			if admins <= 1 {
				domain.Fail("At least one active administrator is required.", 409)
			}
		}
		s.DB.Where("user_id=?", uid).Delete(&UserRole{})
		for _, rid := range ids {
			if e := s.DB.Create(&UserRole{uid, rid}).Error; e != nil {
				return nil, e
			}
		}
		return M{"id": uid}, nil
	}
	return nil, &domain.Error{Message: "Unknown system action.", Status: 404}
}
func validKey(s string) bool {
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return s != ""
}
