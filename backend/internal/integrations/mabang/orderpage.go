package mabang

import (
	"context"
	source "harbor/internal/ordersource"
)

func (c *Client) ReadPage(ctx context.Context, q source.BatchQuery) (source.Page, error) {
	if q.Branch < 0 || q.Branch > 1 {
		return source.Page{}, failure("invalid_range", "Invalid order partition.", 400)
	}
	api := "order-get-order-list-new"
	p := map[string]string{"paidtimeStart": q.Date + " 00:00:00", "paidtimeEnd": q.Date + " 23:59:59", "maxRows": "700", "status": []string{"7", "6"}[q.Branch], "canSend": "3"}
	key := "data"
	if q.History {
		api = "get-history-order-list"
		key = "list"
		p = map[string]string{"paidTime": q.Date, "pageSize": "700", "canSend": []string{"1", "2"}[q.Branch]}
	}
	if q.Cursor != "" {
		p["cursor"] = q.Cursor
	}
	d, e := c.call(ctx, api, p)
	if e != nil {
		return source.Page{}, e
	}
	rows, ok := d[key].([]any)
	if !ok {
		return source.Page{}, failure("malformed", "Mabang returned an invalid order page.", 502)
	}
	out := source.Page{Orders: []source.Order{}, NextCursor: str(d["nextCursor"])}
	if has, explicit := d["hasNext"].(bool); explicit && !has {
		out.NextCursor = ""
	}
	if d["hasNext"] == true && out.NextCursor == "" {
		return out, failure("malformed", "Mabang returned an invalid order cursor.", 502)
	}
	for _, v := range rows {
		r, ok := v.(map[string]any)
		if !ok {
			return out, failure("malformed", "Mabang returned an invalid order page.", 502)
		}
		o, e := mapOrder(r, c.Key, q.History)
		if e != nil {
			return out, e
		}
		out.Orders = append(out.Orders, o)
	}
	return out, nil
}
