// Adapted from lostvip-com/ruoyi-go (MIT), commit fb2af8b8e8375267f723d29f8607b3f5ae6db800.
// Copyright (c) 2020 lostvip.com. See backend/third_party/ruoyi-go/LICENSE.
// Preserves RuoYi's role keys, menu types, permission strings, status flags and join tables.
// Changes: string user IDs for Harbor compatibility, password omission, explicit GORM injection.
package ruoyi

type SysRole struct {
	RoleID   int64  `gorm:"primaryKey;column:role_id" json:"roleId"`
	RoleName string `gorm:"size:60" json:"roleName"`
	RoleKey  string `gorm:"uniqueIndex;size:100" json:"roleKey"`
	RoleSort int    `json:"roleSort"`
	Status   string `json:"status"`
	Remark   string `json:"remark"`
}

type SysMenu struct {
	MenuID   int64  `gorm:"primaryKey;column:menu_id" json:"menuId"`
	MenuName string `json:"menuName"`
	ParentID int64  `json:"parentId"`
	OrderNum int    `json:"orderNum"`
	URL      string `gorm:"column:url" json:"url"`
	MenuType string `json:"menuType"`
	Visible  string `json:"visible"`
	Status   string `json:"status"`
	Perms    string `json:"perms"`
	Icon     string `json:"icon"`
	Action   string `json:"action,omitempty"`
}

type SysUser struct {
	UserID    string `gorm:"primaryKey;column:user_id" json:"userId"`
	UserName  string `json:"userName"`
	LoginName string `gorm:"uniqueIndex" json:"loginName"`
	Email     string `gorm:"uniqueIndex" json:"email"`
	Password  string `json:"-"`
	Status    string `json:"status"`
}

type UserRole struct {
	UserID string `gorm:"primaryKey;column:user_id"`
	RoleID int64  `gorm:"primaryKey;column:role_id"`
}

type RoleMenu struct {
	RoleID int64 `gorm:"primaryKey;column:role_id"`
	MenuID int64 `gorm:"primaryKey;column:menu_id"`
}
