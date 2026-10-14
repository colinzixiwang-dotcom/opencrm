package ruoyi

// EnsureSupportMenus is an additive, idempotent migration; existing grants are preserved.
func (s Service) EnsureSupportMenus() error {
	pages := []struct {
		key, name string
		all       bool
	}{{"rma", "RMAs", true}, {"rmatasks", "Task center", false}, {"rmalogistics", "Awaiting dispatch", true}, {"supportorders", "Support orders", true}, {"serials", "Serial numbers", true}, {"benefits", "Cards & promo codes", true}, {"rmaconfig", "Support configuration", false}}
	for i, p := range pages {
		var n int64
		s.DB.Model(&SysMenu{}).Where("perms=?", ViewPermission(p.key)).Count(&n)
		if n > 0 {
			continue
		}
		m := SysMenu{MenuName: p.name, MenuType: "C", URL: p.key, Perms: ViewPermission(p.key), Status: "0", Visible: "0", Icon: p.key, OrderNum: 14 + i}
		if e := s.DB.Create(&m).Error; e != nil {
			return e
		}
		roles := []SysRole{}
		s.DB.Find(&roles)
		for _, r := range roles {
			if r.RoleKey == "admin" || (p.all && (r.RoleKey == "operator" || r.RoleKey == "analyst")) {
				if e := s.DB.Create(&RoleMenu{r.RoleID, m.MenuID}).Error; e != nil {
					return e
				}
			}
		}
	}
	for _, a := range []string{"rma.create", "rma.note", "rmatask.update", "rmatask.review", "rmatask.execute", "rmaconfig.save", "supportorder.save", "serial.save"} {
		var n int64
		s.DB.Model(&SysMenu{}).Where("action=?", a).Count(&n)
		if n > 0 {
			continue
		}
		var parent SysMenu
		s.DB.Where("perms=?", ViewPermission(ActionModule[a])).First(&parent)
		m := SysMenu{MenuName: a, MenuType: "F", ParentID: parent.MenuID, Perms: Permission(a), Status: "0", Visible: "1", Action: a, OrderNum: 500}
		if e := s.DB.Create(&m).Error; e != nil {
			return e
		}
		roles := []SysRole{}
		s.DB.Find(&roles)
		for _, r := range roles {
			if r.RoleKey == "admin" || (r.RoleKey == "operator" && (a == "rma.create" || a == "rma.note" || a == "rmatask.update")) {
				if e := s.DB.Create(&RoleMenu{r.RoleID, m.MenuID}).Error; e != nil {
					return e
				}
			}
		}
	}
	return nil
}
