// Command gen-herdr-methods writes internal/host/herdr_methods.gen.go again
// from schemas/herdr-api.schema.json. Start this command from the repository root:
//
//	go run ./scripts/gen-herdr-methods
//
// This command never calls `herdr api schema`. The committed JSON is the correct source.
package main

import (
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"sort"
	"strconv"
	"strings"
)

type schema = map[string]any

func obj(v any) schema {
	m, _ := v.(schema)
	return m
}

func arr(v any) []any {
	s, _ := v.([]any)
	return s
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func resolveRef(root schema, ref string) schema {
	cur := any(root)
	for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
		next, ok := obj(cur)[part]
		if !ok {
			fatalf("unresolved $ref %s", ref)
		}
		cur = next
	}
	m, ok := cur.(schema)
	if !ok {
		fatalf("bad $ref %s", ref)
	}
	return m
}

func deref(root schema, s schema, seen map[string]bool) schema {
	ref := str(s["$ref"])
	if ref == "" {
		return s
	}
	if seen[ref] {
		return schema{}
	}
	seen[ref] = true
	return deref(root, resolveRef(root, ref), seen)
}

func jsonKind(v any) string {
	switch v.(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case nil:
		return "null"
	default:
		return "object"
	}
}

type propSpec struct {
	kinds      []string
	nullable   bool
	enumValues []any
}

func extractPropSpec(root schema, s schema) propSpec {
	resolved := deref(root, s, map[string]bool{})
	var kinds []string
	var nullable bool
	var enumValues []any
	seen := map[string]bool{}
	addKind := func(k string) {
		if !seen[k] {
			seen[k] = true
			kinds = append(kinds, k)
		}
	}
	var absorb func(s schema)
	absorb = func(s schema) {
		r := deref(root, s, map[string]bool{})
		if c, ok := r["const"]; ok {
			enumValues = append(enumValues, c)
			addKind(jsonKind(c))
			return
		}
		if e, ok := r["enum"]; ok {
			for _, v := range arr(e) {
				enumValues = append(enumValues, v)
				addKind(jsonKind(v))
			}
			return
		}
		switch t := r["type"].(type) {
		case string:
			if t == "null" {
				nullable = true
			} else {
				addKind(t)
			}
		case []any:
			for _, x := range t {
				if x == "null" {
					nullable = true
				} else {
					addKind(str(x))
				}
			}
		}
		for _, key := range []string{"anyOf", "oneOf"} {
			for _, alt := range arr(r[key]) {
				absorb(obj(alt))
			}
		}
	}
	absorb(resolved)
	if len(kinds) == 0 {
		kinds = []string{"object"}
	}
	return propSpec{kinds: kinds, nullable: nullable, enumValues: enumValues}
}

type methodParams struct {
	required             []string
	properties           map[string]propSpec
	additionalProperties bool
}

func extractParams(root schema, params schema) methodParams {
	resolved := deref(root, params, map[string]bool{})
	out := methodParams{properties: map[string]propSpec{}}
	for _, r := range arr(resolved["required"]) {
		out.required = append(out.required, str(r))
	}
	for name, prop := range obj(resolved["properties"]) {
		out.properties[name] = extractPropSpec(root, obj(prop))
	}
	out.additionalProperties = resolved["additionalProperties"] == true
	return out
}

type denyRule struct {
	match  func(string) bool
	reason string
}

var denyRules = []denyRule{
	{
		func(m string) bool { return m == "server.stop" },
		"would stop the server running the workflow",
	},
	{
		func(m string) bool { return strings.HasPrefix(m, "server.") },
		"server control methods are not available to workflows",
	},
	{
		func(m string) bool { return strings.HasPrefix(m, "plugin.") },
		"plugin lifecycle methods are not available to workflows",
	},
	{
		func(m string) bool { return m == "events.subscribe" },
		"event subscriptions have no terminating step semantics",
	},
	{
		func(m string) bool { return m == "session.snapshot" },
		"whole-session snapshots are not available; use targeted *.list / *.get methods",
	},
	{
		func(m string) bool { return m == "popup.close" },
		"popup.close belongs to the picker's own lifecycle",
	},
	{
		func(m string) bool { return strings.HasPrefix(m, "pane.graphics.") },
		"pane.graphics.* methods are experimental and feature-gated",
	},
	{func(m string) bool {
		switch m {
		case "pane.report_agent", "pane.report_agent_session",
			"pane.clear_agent_authority", "pane.release_agent":
			return true
		}
		return false
	}, "agent-identity authority methods would corrupt herdr's own detection"},
	{
		func(m string) bool { return m == "agent.view.set" || m == "agent.view.clear" },
		"agent view filters are client UI state, not workflow automation",
	},
}

func isAllowedArea(method string) bool {
	if method == "ping" || method == "notification.show" {
		return true
	}
	if strings.HasPrefix(method, "client.window_title.") {
		return true
	}
	for _, prefix := range []string{"workspace.", "tab.", "pane.", "worktree.", "agent.", "layout."} {
		if strings.HasPrefix(method, prefix) {
			return true
		}
	}
	return false
}

func denyReason(method string) string {
	for _, rule := range denyRules {
		if rule.match(method) {
			return rule.reason
		}
	}
	if !isAllowedArea(method) {
		return fmt.Sprintf("method '%s' is outside the workflow allowlist", method)
	}
	return ""
}

type focusPolicy struct {
	kind   string
	field  string
	fields [2]string
}

var (
	focusFilterOptOut   = map[string]bool{"pane.list": true, "tab.list": true}
	focusOptionalAnchor = map[string]bool{"workspace.move_block": true}
	focusExactlyOne     = map[string][2]string{
		"layout.apply":           {"workspace_id", "tab_id"},
		"layout.set_split_ratio": {"tab_id", "pane_id"},
		"worktree.list":          {"workspace_id", "cwd"},
		"worktree.create":        {"workspace_id", "cwd"},
		"worktree.open":          {"workspace_id", "cwd"},
	}
)

var (
	focusAtLeastOne = map[string][2]string{"layout.export": {"pane_id", "tab_id"}}
	focusRequire    = map[string]string{"pane.split": "target_pane_id"}
)

func optionalSelectors(params methodParams) []string {
	required := map[string]bool{}
	for _, r := range params.required {
		required[r] = true
	}
	var out []string
	for key := range params.properties {
		if (key == "target" || strings.HasSuffix(key, "_id")) && !required[key] {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

func focusPolicyForMethod(method string, params methodParams) focusPolicy {
	if focusFilterOptOut[method] {
		return focusPolicy{kind: "filter"}
	}
	if focusOptionalAnchor[method] {
		return focusPolicy{kind: "none"}
	}
	switch method {
	case "pane.swap":
		return focusPolicy{kind: "swap"}
	case "pane.move":
		return focusPolicy{kind: "move"}
	}
	if fields, ok := focusExactlyOne[method]; ok {
		return focusPolicy{kind: "exactlyOne", fields: fields}
	}
	if fields, ok := focusAtLeastOne[method]; ok {
		return focusPolicy{kind: "atLeastOne", fields: fields}
	}
	if field, ok := focusRequire[method]; ok {
		return focusPolicy{kind: "require", field: field}
	}
	optional := optionalSelectors(params)
	switch len(optional) {
	case 0:
		return focusPolicy{kind: "none"}
	case 1:
		return focusPolicy{kind: "require", field: optional[0]}
	}
	fatalf("focus policy: %s has optional selectors [%s] — classify in the generator tables",
		method, strings.Join(optional, ", "))
	return focusPolicy{}
}

type methodEntry struct {
	name   string
	reason string
	params methodParams
}

func extractMethods(root schema) []methodEntry {
	variants := arr(obj(obj(root["schemas"])["request"])["oneOf"])
	if len(variants) == 0 {
		fatalf("request.oneOf empty")
	}
	var methods []methodEntry
	for _, variant := range variants {
		v := obj(variant)
		method := str(obj(obj(v["properties"])["method"])["const"])
		if method == "" {
			fatalf("request variant missing method const")
		}
		params, ok := obj(v["properties"])["params"]
		if !ok {
			fatalf("no params for %s", method)
		}
		methods = append(methods, methodEntry{
			name:   method,
			reason: denyReason(method),
			params: extractParams(root, obj(params)),
		})
	}
	sort.Slice(methods, func(i, j int) bool { return methods[i].name < methods[j].name })
	return methods
}

type resultVariant struct {
	Type  string
	Paths []string
}

func cloneSeen(seen map[string]bool) map[string]bool {
	out := make(map[string]bool, len(seen))
	for k := range seen {
		out[k] = true
	}
	return out
}

func collectDotPaths(root schema, s schema, prefix string, out map[string]bool, seen map[string]bool) {
	if ref := str(s["$ref"]); ref != "" {
		if seen[ref] {
			return
		}
		seen[ref] = true
		s = resolveRef(root, ref)
	}
	for key, child := range obj(s["properties"]) {
		if key == "type" && prefix == "" {
			continue
		}
		path := key
		if prefix != "" {
			path = prefix + "." + key
		}
		out[path] = true
		collectDotPaths(root, obj(child), path, out, cloneSeen(seen))
	}
	alts := arr(s["oneOf"])
	if alts == nil {
		alts = arr(s["anyOf"])
	}
	for _, alt := range alts {
		collectDotPaths(root, obj(alt), prefix, out, cloneSeen(seen))
	}
	if items, ok := s["items"]; ok {
		collectDotPaths(root, obj(items), prefix, out, cloneSeen(seen))
	}
}

// extractResultVariantPaths gives the dot paths for each result type.
func extractResultVariantPaths(root schema) map[string][]string {
	schemas := obj(root["schemas"])
	successResp := obj(schemas["success_response"])
	resultNode := obj(obj(successResp["properties"])["result"])
	resultRef := str(resultNode["$ref"])
	if resultRef == "" {
		fatalf("success_response.properties.result.$ref missing")
	}
	resultSchema := resolveRef(root, resultRef)
	variants := arr(resultSchema["oneOf"])
	if len(variants) == 0 {
		fatalf("success result oneOf empty")
	}
	paths := map[string][]string{}
	for _, variant := range variants {
		v := obj(variant)
		typ := str(obj(obj(v["properties"])["type"])["const"])
		if typ == "" {
			fatalf("result variant missing type const")
		}
		set := map[string]bool{}
		collectDotPaths(root, v, "", set, map[string]bool{})
		keys := make([]string, 0, len(set))
		for k := range set {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		paths[typ] = keys
	}
	return paths
}

// Result schema oneOf uses the key `type`, not `method`. The overrides specify the
// methods whose success type does not use the naming convention.
var methodResultTypeOverrides = map[string][]string{
	"ping":                          {"pong"},
	"pane.wait_for_output":          {"output_matched"},
	"events.wait":                   {"wait_matched"},
	"events.subscribe":              {"subscription_started"},
	"agent.wait":                    {"agent_info"},
	"agent.start":                   {"agent_started"},
	"agent.prompt":                  {"agent_prompted"},
	"agent.read":                    {"pane_read"},
	"agent.view.set":                {"agent_view"},
	"agent.view.clear":              {"agent_view"},
	"server.reload_config":          {"config_reload"},
	"server.reload_agent_manifests": {"agent_manifest_reload"},
	"server.agent_manifests":        {"agent_manifest_status"},
	"client.window_title.set":       {"client_window_title"},
	"client.window_title.clear":     {"client_window_title"},
	"layout.set_split_ratio":        {"layout_split_ratio_set"},
	"plugin.link":                   {"plugin_linked"},
	"plugin.unlink":                 {"plugin_unlinked"},
	"plugin.pane.open":              {"plugin_pane_opened"},
	"plugin.pane.focus":             {"plugin_pane_focused"},
	"plugin.pane.close":             {"plugin_pane_closed"},
	"plugin.enable":                 {"plugin_enabled"},
	"plugin.disable":                {"plugin_disabled"},
	"plugin.action.invoke":          {"plugin_action_invoked"},
	"pane.split":                    {"pane_info"},
	"pane.get":                      {"pane_info"},
	"workspace.get":                 {"workspace_info"},
	"tab.get":                       {"tab_info"},
	"agent.get":                     {"agent_info"},
	"workspace.create":              {"workspace_created"},
	"workspace.move_block":          {"workspace_list"},
	"tab.create":                    {"tab_created"},
	"worktree.create":               {"worktree_created"},
	"worktree.open":                 {"worktree_opened"},
	"worktree.remove":               {"worktree_removed"},
}

var okResultMethods = map[string]bool{
	"server.stop":                true,
	"server.live_handoff":        true,
	"workspace.focus":            true,
	"workspace.rename":           true,
	"workspace.close":            true,
	"workspace.move":             true,
	"workspace.report_metadata":  true,
	"tab.focus":                  true,
	"tab.rename":                 true,
	"tab.close":                  true,
	"tab.move":                   true,
	"agent.send_keys":            true,
	"agent.rename":               true,
	"agent.focus":                true,
	"pane.focus":                 true,
	"pane.rename":                true,
	"pane.send_text":             true,
	"pane.send_keys":             true,
	"pane.send_input":            true,
	"pane.input.set":             true,
	"pane.close":                 true,
	"pane.graphics.set":          true,
	"pane.graphics.clear":        true,
	"pane.report_agent":          true,
	"pane.report_agent_session":  true,
	"pane.report_metadata":       true,
	"pane.clear_agent_authority": true,
	"pane.release_agent":         true,
	"popup.close":                true,
}

func resultTypesForMethod(method string, known map[string]bool) []string {
	if overrides, ok := methodResultTypeOverrides[method]; ok {
		return overrides
	}
	if okResultMethods[method] {
		return []string{"ok"}
	}
	parts := strings.Split(method, ".")
	snake := strings.ReplaceAll(method, ".", "_")
	last := parts[len(parts)-1]
	area := parts[0]
	var candidates []string
	candidates = append(candidates, snake)
	if last == "list" {
		candidates = append(candidates, area+"_list")
	}
	if last == "create" {
		candidates = append(candidates, area+"_created")
	}
	if last == "get" {
		candidates = append(candidates, area+"_info")
	}
	if last == "open" {
		candidates = append(candidates, area+"_opened")
	}
	if last == "remove" {
		candidates = append(candidates, area+"_removed")
	}
	for _, c := range candidates {
		if known[c] {
			return []string{c}
		}
	}
	fatalf("no success result type mapped for method '%s' (tried %s)", method, strings.Join(candidates, ", "))
	return nil
}

// buildMethodResultVariants gives the success variants for each request method.
func buildMethodResultVariants(methods []methodEntry, variantPaths map[string][]string) map[string][]resultVariant {
	known := map[string]bool{}
	for typ := range variantPaths {
		known[typ] = true
	}
	out := map[string][]resultVariant{}
	for _, m := range methods {
		var variants []resultVariant
		for _, typ := range resultTypesForMethod(m.name, known) {
			paths, ok := variantPaths[typ]
			if !ok {
				fatalf("method '%s' maps to unknown result type '%s'", m.name, typ)
			}
			variants = append(variants, resultVariant{Type: typ, Paths: paths})
		}
		out[m.name] = variants
	}
	return out
}

// flattenResultPaths gives the set of all result variant paths, in sort order.
func flattenResultPaths(variantPaths map[string][]string) []string {
	set := map[string]bool{}
	for _, paths := range variantPaths {
		for _, p := range paths {
			set[p] = true
		}
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

// readMinHerdrVersion reads min_herdr_version from the manifest at the repository
// root.
func readMinHerdrVersion(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		fatalf("read manifest: %v", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, `min_herdr_version = "`); ok {
			return strings.TrimSuffix(v, `"`)
		}
	}
	fatalf("manifest missing min_herdr_version")
	return ""
}

func emitValue(v any) string {
	switch t := v.(type) {
	case string:
		return strconv.Quote(t)
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return strconv.FormatFloat(t, 'g', -1, 64)
	case nil:
		return "nil"
	}
	fatalf("cannot emit Go literal for %v", v)
	return ""
}

func emitStringList(values []string) string {
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = strconv.Quote(v)
	}
	return "[]string{" + strings.Join(parts, ", ") + "}"
}

func emitPropSpec(p propSpec) string {
	var b strings.Builder
	b.WriteString("{kinds: " + emitStringList(p.kinds))
	if p.nullable {
		b.WriteString(", nullable: true")
	}
	if len(p.enumValues) > 0 {
		parts := make([]string, len(p.enumValues))
		for i, v := range p.enumValues {
			parts[i] = emitValue(v)
		}
		b.WriteString(", enumValues: []any{" + strings.Join(parts, ", ") + "}")
	}
	b.WriteString("}")
	return b.String()
}

func emitParams(p methodParams) string {
	var b strings.Builder
	b.WriteString("methodParams{required: " + emitStringList(p.required) + ", properties: map[string]propSpec{")
	keys := make([]string, 0, len(p.properties))
	for k := range p.properties {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		b.WriteString(strconv.Quote(k) + ": " + emitPropSpec(p.properties[k]) + ", ")
	}
	b.WriteString("}")
	if p.additionalProperties {
		b.WriteString(", additionalProperties: true")
	}
	b.WriteString("}")
	return b.String()
}

func emitGenerated(protocol float64, minVersion string, methods []methodEntry, resultPaths []string, methodVariants map[string][]resultVariant) string {
	var b strings.Builder
	fmt.Fprintf(&b, "// Code generated by scripts/gen-herdr-methods from schemas/herdr-api.schema.json (protocol %v). DO NOT EDIT.\n\n", protocol)
	b.WriteString("package host\n\n")
	fmt.Fprintf(&b, "const Protocol = %d\n\n", int(protocol))
	fmt.Fprintf(&b, "const MinHerdrVersion = %s\n\n", strconv.Quote(minVersion))
	b.WriteString("var herdrMethods = map[string]methodEntry{\n")
	for _, m := range methods {
		fmt.Fprintf(&b, "%s: {params: %s", strconv.Quote(m.name), emitParams(m.params))
		if m.reason != "" {
			fmt.Fprintf(&b, ", denied: %s", strconv.Quote(m.reason))
		}
		b.WriteString("},\n")
	}
	b.WriteString("}\n\n")
	b.WriteString("var herdrFocusPolicy = map[string]focusPolicy{\n")
	for _, m := range methods {
		if m.reason != "" {
			continue
		}
		policy := focusPolicyForMethod(m.name, m.params)
		fmt.Fprintf(&b, "%s: {kind: %s", strconv.Quote(m.name), strconv.Quote(policy.kind))
		if policy.field != "" {
			fmt.Fprintf(&b, ", field: %s", strconv.Quote(policy.field))
		}
		if policy.fields[0] != "" {
			fmt.Fprintf(&b, ", fields: [2]string{%s, %s}",
				strconv.Quote(policy.fields[0]), strconv.Quote(policy.fields[1]))
		}
		b.WriteString("},\n")
	}
	b.WriteString("}\n\n")
	b.WriteString("var resultDotPaths = map[string]bool{\n")
	for _, p := range resultPaths {
		fmt.Fprintf(&b, "%s: true,\n", strconv.Quote(p))
	}
	b.WriteString("}\n\n")
	b.WriteString("var methodResultVariants = map[string][]resultVariant{\n")
	for _, m := range methods {
		parts := make([]string, len(methodVariants[m.name]))
		for i, v := range methodVariants[m.name] {
			parts[i] = fmt.Sprintf("{Type: %s, Paths: %s}", strconv.Quote(v.Type), emitStringList(v.Paths))
		}
		fmt.Fprintf(&b, "%s: {%s},\n", strconv.Quote(m.name), strings.Join(parts, ", "))
	}
	b.WriteString("}\n")
	formatted, err := format.Source([]byte(b.String()))
	if err != nil {
		fatalf("gofmt: %v", err)
	}
	return string(formatted)
}

// buildSource makes the host method table from the committed schema and
// manifest. It does not write a file.
func buildSource(schemaPath, manifestPath string) string {
	data, err := os.ReadFile(schemaPath)
	if err != nil {
		fatalf("read schema: %v", err)
	}
	var root schema
	if err := json.Unmarshal(data, &root); err != nil {
		fatalf("parse schema: %v", err)
	}
	methods := extractMethods(root)
	protocol, ok := root["protocol"].(float64)
	if !ok {
		fatalf("protocol must be a number")
	}
	variantPaths := extractResultVariantPaths(root)
	methodVariants := buildMethodResultVariants(methods, variantPaths)
	resultPaths := flattenResultPaths(variantPaths)
	return emitGenerated(protocol, readMinHerdrVersion(manifestPath), methods, resultPaths, methodVariants)
}

func main() {
	const outPath = "internal/host/herdr_methods.gen.go"
	out := buildSource("schemas/herdr-api.schema.json", "herdr-plugin.toml")
	if err := os.WriteFile(outPath, []byte(out), 0o644); err != nil {
		fatalf("write: %v", err)
	}
	fmt.Printf("wrote %s\n", outPath)
}
