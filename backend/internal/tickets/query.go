package tickets

import (
	"context"
	"database/sql"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"
	"harbor/internal/persistence"
)

const MaxListAge = 15 * time.Minute

func (s *Service) Search(ctx context.Context, actor M, filter, cursor string, size int, order, search string) (result M, err error) {

	if err = s.readPermission(actor); err != nil {
		return nil, err
	}
	if _, err = s.scope(ctx); err != nil {
		return nil, err
	}
	if err = s.validateFilter(actor, filter); err != nil {
		return nil, err
	}
	if size < 1 || size > 100 {
		return nil, fail("Page size must be between 1 and 100.", 400)
	}
	if order == "" {
		order = "replied_at:desc"
	}
	columns := map[string]string{"replied_at": "replied_time", "created_at": "created_time", "updated_at": "updated_time", "field_num": "number_value", "subject": "lower(subject)", "assignee_name": "lower(assignee_name)", "status": "lower(status)"}
	parts := strings.Split(order, ":")
	aliases := map[string]string{"repliedAt": "replied_at", "createdAt": "created_at", "updatedAt": "updated_at", "number": "field_num", "assigneeName": "assignee_name"}
	if len(parts) == 2 {
		if column, ok := aliases[parts[0]]; ok {
			parts[0] = column
		}
	}
	if len(parts) != 2 || columns[parts[0]] == "" || (parts[1] != "asc" && parts[1] != "desc") || ((parts[0] == "subject" || parts[0] == "assignee_name" || parts[0] == "status") && parts[1] != "asc") {
		return nil, fail("Invalid ticket sort order.", 400)
	}
	offset := 0
	if cursor != "" {
		if !strings.HasPrefix(cursor, "global:") {
			return nil, fail("Invalid ticket cursor.", 400)
		}
		n, e := strconv.Atoi(strings.TrimPrefix(cursor, "global:"))
		if e != nil || n < 0 || n > 1000000000 {
			return nil, fail("Invalid ticket cursor.", 400)
		}
		offset = n
	}
	search = strings.TrimSpace(search)
	if len(search) > 500 {
		return nil, fail("Search is too long.", 400)
	}
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var state SyncState
		e := tx.Where("tenant=? AND scope=?", s.Tenant, filter).First(&state).Error
		if e != nil && e != gorm.ErrRecordNotFound {
			return e
		}
		initialized := state.LastSuccess != nil
		stale := initialized && time.Since(*state.LastSuccess) > MaxListAge
		at := ""
		if initialized {
			at = state.LastSuccess.UTC().Format(time.RFC3339Nano)
		}
		result = M{"items": []M{}, "nextCursor": "", "fetchedAt": at, "filterId": filter, "sort": order, "query": search, "scanLimited": false, "totalPages": 1, "totalCount": 0, "initializing": !initialized, "stale": stale, "syncError": state.Error, "syncIntervalSeconds": 60, "searchIncludesReplies": false}
		if !initialized || (stale) {
			return nil
		}

		policy, e := scopeFrom(tx, s.Tenant)
		if e != nil {
			return e
		}
		result["scopeRevision"] = policy.Revision
		result["product"] = MorphoScope
		members := persistence.Table(tx, "filter_members")
		base := func() *gorm.DB {
			q := tx.Model(&Ticket{}).Where("tenant=?", s.Tenant).Where("external_id IN (SELECT ticket_id FROM "+members+" WHERE tenant=? AND scope=? AND generation=?)", s.Tenant, filter, state.Generation)
			q = policy.apply(q)

			if search != "" {
				escaped := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(search)
				q = q.Where("search_text ILIKE ?", "%"+escaped+"%")
			}
			return q
		}
		var count int64
		if e := base().Count(&count).Error; e != nil {
			return e
		}
		// If refresh/search shrinks the result, return its last valid page.
		if count > 0 && int64(offset) >= count {
			offset = int((count-1)/int64(size)) * size
		}
		records := []Ticket{}
		ordering := columns[parts[0]] + " " + parts[1] + " NULLS LAST, length(external_id) DESC, external_id DESC"
		if e := base().Order(ordering).Offset(offset).Limit(size).Find(&records).Error; e != nil {
			return e
		}
		items := []M{}
		for _, record := range records {
			v, e := s.decodeRecord(record)
			if e != nil {
				return e
			}
			items = append(items, (&Service{DB: tx, API: s.API, Tenant: s.Tenant}).public(actor, v, record.FetchedAt))
		}
		next := ""
		if int64(offset+size) < count {
			next = "global:" + strconv.Itoa(offset+size)
		}
		result["items"] = items
		result["nextCursor"] = next
		result["totalCount"] = int(count)
		result["totalPages"] = max(1, (int(count)+size-1)/size)
		result["currentPage"] = offset/size + 1
		return nil
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	return
}
