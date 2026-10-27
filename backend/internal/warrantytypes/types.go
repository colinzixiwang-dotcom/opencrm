// Package warrantytypes defines the shared identity contract between catalog
// assignments and support-owned warranty policies. It owns no persistence.
package warrantytypes

import "harbor/internal/domain"

type M = domain.M

func Definitions(policy M) []M {
	if policy["classes"] != nil {
		return domain.Rows(policy, "classes")
	}
	return []M{
		{"id": "halo_device", "name": "Halo device"},
		{"id": "halo_accessory", "name": "Halo accessory"},
		{"id": "colorbox_device", "name": "ColorBox device"},
		{"id": "colorbox_consumable", "name": "ColorBox consumable"},
		{"id": "device", "name": "Legacy device"},
		{"id": "printhead_1080", "name": "Printhead 1080"},
		{"id": "printhead_3200", "name": "Printhead 3200"},
	}
}

func Exists(policy M, id string) bool {
	for _, c := range Definitions(policy) {
		if domain.Str(c["id"]) == id {
			return true
		}
	}
	return false
}
