package host

import (
	"maps"
	"slices"
)

// MethodPropSpec describes one herdr method parameter for method docs and skills.
type MethodPropSpec struct {
	Kinds      []string `json:"kinds"`
	Nullable   bool     `json:"nullable"`
	EnumValues []any    `json:"enumValues,omitempty"`
}

// MethodParamsSpec is the parameter contract for one herdr method.
type MethodParamsSpec struct {
	Required             []string                  `json:"required"`
	Properties           map[string]MethodPropSpec `json:"properties"`
	AdditionalProperties bool                      `json:"additionalProperties"`
}

// MethodCatalogEntry is one row of the generated herdr method table.
type MethodCatalogEntry struct {
	Method  string           `json:"method"`
	Allowed bool             `json:"allowed"`
	Reason  string           `json:"reason,omitempty"`
	Params  MethodParamsSpec `json:"params"`
}

// MethodCatalog returns the sorted herdr method table for method docs and skills.
func MethodCatalog() []MethodCatalogEntry {
	names := slices.Sorted(maps.Keys(herdrMethods))
	out := make([]MethodCatalogEntry, len(names))
	for i, name := range names {
		entry := herdrMethods[name]
		props := make(map[string]MethodPropSpec, len(entry.params.properties))
		for key, spec := range entry.params.properties {
			props[key] = MethodPropSpec{
				Kinds:      append([]string(nil), spec.kinds...),
				Nullable:   spec.nullable,
				EnumValues: append([]any(nil), spec.enumValues...),
			}
		}
		row := MethodCatalogEntry{
			Method:  name,
			Allowed: entry.denied == "",
			Params: MethodParamsSpec{
				Required:             append([]string(nil), entry.params.required...),
				Properties:           props,
				AdditionalProperties: entry.params.additionalProperties,
			},
		}
		if entry.denied != "" {
			row.Reason = entry.denied
		}
		out[i] = row
	}
	return out
}
