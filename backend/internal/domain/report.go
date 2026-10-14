package domain

import (
	"sort"
	"time"
)

func Report(s M, from, to, channel string) M {
	if from == "" {
		from = "0000-01-01"
	}
	if to == "" {
		to = "9999-12-31"
	}
	if channel == "" {
		channel = "all"
	}
	loc, e := time.LoadLocation(Str(Obj(s["settings"])["timezone"]))
	if e != nil {
		loc = time.UTC
	}
	calendar := func(v string) string {
		if len(v) == 10 {
			return v
		}
		d, e := time.Parse(time.RFC3339Nano, v)
		if e != nil {
			return ""
		}
		return d.In(loc).Format("2006-01-02")
	}
	included := func(v string) bool { d := calendar(v); return d != "" && d >= from && d <= to }
	r := M{}
	for _, k := range []string{"revenueCents", "cogsCents", "grossProfitCents", "expenseCents", "netProfitCents", "units", "orders", "stockValueCents", "transitValueCents", "outstandingSalesCents", "outstandingPurchaseCents"} {
		r[k] = int64(0)
	}
	products := map[string]M{}
	days := map[string]int64{}
	channels := map[string]int64{}
	for _, o := range Rows(s, "sales") {
		if !In(Str(o["status"]), "shipped", "completed") || !included(Str(o["shippedAt"])) || (channel != "all" && Str(o["channel"]) != channel) {
			continue
		}
		r["orders"] = N(r["orders"]) + 1
		var value int64
		for _, l := range Rows(o, "lines") {
			q := N(l["qty"]) - N(l["returned"])
			revenue := q * N(l["unitCents"])
			cost := N(l["costTotalCents"]) - N(l["returnedCostCents"])
			r["revenueCents"] = N(r["revenueCents"]) + revenue
			r["cogsCents"] = N(r["cogsCents"]) + cost
			r["units"] = N(r["units"]) + q
			value += revenue
			key := Str(l["productId"])
			p := products[key]
			if p == nil {
				p = M{"productId": key, "units": int64(0), "revenueCents": int64(0), "cogsCents": int64(0)}
			}
			p["units"] = N(p["units"]) + q
			p["revenueCents"] = N(p["revenueCents"]) + revenue
			p["cogsCents"] = N(p["cogsCents"]) + cost
			products[key] = p
		}
		days[calendar(Str(o["shippedAt"]))] += value
		channels[Str(o["channel"])] += value
	}
	expenses := []M{}
	for _, x := range Rows(s, "expenses") {
		if included(Str(x["date"])) {
			expenses = append(expenses, x)
			r["expenseCents"] = N(r["expenseCents"]) + N(x["amountCents"])
		}
	}
	for _, x := range Rows(s, "stocks") {
		r["stockValueCents"] = N(r["stockValueCents"]) + N(x["valueCents"])
	}
	for _, x := range Rows(s, "shipments") {
		if x["status"] == "in_transit" {
			for _, l := range Rows(x, "lines") {
				r["transitValueCents"] = N(r["transitValueCents"]) + N(l["costTotalCents"])
			}
		}
	}
	for _, x := range Rows(s, "sales") {
		if !In(Str(x["status"]), "draft", "cancelled") {
			r["outstandingSalesCents"] = N(r["outstandingSalesCents"]) + Total(x) - N(x["refundCents"]) - N(x["paidCents"])
		}
	}
	for _, x := range Rows(s, "purchases") {
		if !In(Str(x["status"]), "draft", "pending", "cancelled") {
			r["outstandingPurchaseCents"] = N(r["outstandingPurchaseCents"]) + Total(x) - N(x["paidCents"])
		}
	}
	r["grossProfitCents"] = N(r["revenueCents"]) - N(r["cogsCents"])
	r["netProfitCents"] = N(r["grossProfitCents"]) - N(r["expenseCents"])
	ps := []M{}
	for _, p := range products {
		ps = append(ps, p)
	}
	sort.Slice(ps, func(i, j int) bool { return N(ps[i]["revenueCents"]) > N(ps[j]["revenueCents"]) })
	ds := []M{}
	for d, v := range days {
		ds = append(ds, M{"date": d, "revenueCents": v})
	}
	sort.Slice(ds, func(i, j int) bool { return Str(ds[i]["date"]) < Str(ds[j]["date"]) })
	cs := []M{}
	for c, v := range channels {
		cs = append(cs, M{"channel": c, "revenueCents": v})
	}
	sort.Slice(cs, func(i, j int) bool { return Str(cs[i]["channel"]) < Str(cs[j]["channel"]) })
	r["products"] = ps
	r["daily"] = ds
	r["channels"] = cs
	r["expenses"] = expenses
	return r
}
