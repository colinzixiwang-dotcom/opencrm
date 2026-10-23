package ruoyi

func (s Service) EnsureOrderMenus() error {
	var parent SysMenu
	if e := s.DB.Where("perms=?", "erp:orders:view").FirstOrCreate(&parent, SysMenu{MenuName: "Order center", MenuType: "C", URL: "orders", Perms: "erp:orders:view", Status: "0", Visible: "0", Icon: "sales", OrderNum: 9}).Error; e != nil {
		return e
	}
	for _, cap := range []string{"list", "search", "detail"} {
		m := SysMenu{MenuName: "Order center: " + cap, ParentID: parent.MenuID, MenuType: "F", Perms: "erp:orders:" + cap, Status: "0", Visible: "1", OrderNum: 600}
		if e := s.DB.Where("perms=?", m.Perms).FirstOrCreate(&SysMenu{}, m).Error; e != nil {
			return e
		}
	}
	return nil
}
