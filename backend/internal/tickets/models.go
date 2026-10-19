package tickets

import (
	"gorm.io/gorm"
	"harbor/internal/domain"
	"harbor/internal/ruoyi"
	"time"
)

type M = domain.M

// Support Access owns external records; the naming strategy places drafts/links
// in the RMA context and synchronization runs in Integration.
type Ticket struct {
	ID            uint   `gorm:"primaryKey"`
	Tenant        string `gorm:"uniqueIndex:ticket_source"`
	ExternalID    string `gorm:"uniqueIndex:ticket_source"`
	Number        string `gorm:"index"`
	Assignee      string `gorm:"index"`
	GroupID       string `gorm:"index"`
	SourceUpdated string
	FetchedAt     string
	Raw           string
	Subject       string
	Status        string
	Channel       string
	AssigneeName  string
	NumberValue   int64
	CreatedTime   *time.Time
	UpdatedTime   *time.Time
	RepliedTime   *time.Time
	SearchText    string
}
type Metadata struct {
	ID        uint   `gorm:"primaryKey"`
	Tenant    string `gorm:"uniqueIndex:metadata_source"`
	Kind      string `gorm:"uniqueIndex:metadata_source"`
	FetchedAt string
	Raw       string
}
type Mapping struct {
	ID           uint   `gorm:"primaryKey" json:"id"`
	Tenant       string `gorm:"uniqueIndex:agent_source" json:"-"`
	AgentID      string `gorm:"uniqueIndex:agent_source" json:"agentId"`
	UserID       string `gorm:"uniqueIndex:user_source" json:"userId"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	SourceRole   string `json:"sourceRole"`
	SourceGroups string `json:"sourceGroups"`
	Scope        string `json:"scope"`
	Groups       string `json:"groups"`
	Enabled      bool   `json:"enabled"`
	Managed      bool   `json:"managed"`
}
type Snapshot struct {
	ID        string `gorm:"primaryKey"`
	Tenant    string
	TicketID  string `gorm:"index"`
	Number    string
	FetchedAt string
	Raw       string
}
type Draft struct {
	ID         string `gorm:"primaryKey" json:"id"`
	UserID     string `gorm:"index" json:"ownerId"`
	Tenant     string `json:"-"`
	TicketID   string `json:"ticketId"`
	SnapshotID string `json:"snapshotId"`
	Payload    string `json:"-"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
	RMAID      string `json:"rmaId"`
}
type Link struct {
	ID         uint   `gorm:"primaryKey"`
	Tenant     string `gorm:"index"`
	TicketID   string `gorm:"index"`
	RMAID      string `gorm:"uniqueIndex"`
	OwnerID    string
	SnapshotID string
}
type ReplyPage struct {
	ID        uint   `gorm:"primaryKey"`
	Tenant    string `gorm:"uniqueIndex:reply_page"`
	TicketID  string `gorm:"uniqueIndex:reply_page"`
	Page      int    `gorm:"uniqueIndex:reply_page"`
	FetchedAt string
	Raw       string
}
type Run struct {
	ID          string `gorm:"primaryKey" json:"id"`
	UserID      string `json:"-"`
	Kind        string `json:"kind"`
	Status      string `json:"status"`
	Count       int    `json:"count"`
	Error       string `json:"error,omitempty"`
	CreatedAt   string `json:"createdAt"`
	CompletedAt string `json:"completedAt"`
}

func Init(db *gorm.DB) error {
	return db.AutoMigrate(&Ticket{}, &Metadata{}, &Mapping{}, &Snapshot{}, &Draft{}, &Link{}, &ReplyPage{}, &Run{})
}
func EnsureRoles(db *gorm.DB) error {
	for _, key := range []string{"support_agent", "support_supervisor"} {
		var role ruoyi.SysRole
		created := false
		if e := db.Where("role_key=?", key).First(&role).Error; e == gorm.ErrRecordNotFound {
			role = ruoyi.SysRole{RoleKey: key, RoleName: map[string]string{"support_agent": "Support agent", "support_supervisor": "Support supervisor"}[key], Status: "0", RoleSort: 5}
			if e = db.Create(&role).Error; e != nil {
				return e
			}
			created = true
		} else if e != nil {
			return e
		}
		// Role permission edits must survive restarts and subsequent directory syncs.
		if !created {
			continue
		}
		menus := []ruoyi.SysMenu{}
		if e := db.Where("perms IN ?", []string{"erp:home:view", "erp:service:view", "erp:rma:view", "erp:product:view", "erp:supportorders:view", "erp:serials:view", "erp:benefits:view", "erp:rmalogistics:view", "erp:rma:add", "erp:rma:note", "erp:rmatask:edit"}).Find(&menus).Error; e != nil {
			return e
		}
		for _, m := range menus {
			if e := db.Where(ruoyi.RoleMenu{RoleID: role.RoleID, MenuID: m.MenuID}).FirstOrCreate(&ruoyi.RoleMenu{RoleID: role.RoleID, MenuID: m.MenuID}).Error; e != nil {
				return e
			}
		}
	}
	return nil
}

// SyncState publishes only complete source scopes. Lists never infer completeness
// from the opportunistic cache left by earlier interactive requests.
type SyncState struct {
	ID          uint   `gorm:"primaryKey"`
	Tenant      string `gorm:"uniqueIndex:sync_scope"`
	Scope       string `gorm:"uniqueIndex:sync_scope"`
	Generation  string
	LastSuccess *time.Time
	LastAttempt *time.Time
	Error       string
}
type FilterMember struct {
	Tenant     string `gorm:"primaryKey"`
	Scope      string `gorm:"primaryKey"`
	Generation string `gorm:"primaryKey"`
	TicketID   string `gorm:"primaryKey"`
}
