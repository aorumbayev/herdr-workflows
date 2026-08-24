package workflow

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

// BundleEntry is the only data carried by a shared workflow payload.
type BundleEntry struct {
	Name string `json:"name"`
	YAML string `json:"yaml"`
}

type Bundle []BundleEntry

var (
	importCommandRE = regexp.MustCompile(`^hwf\s+workflow\s+import\s+"([^"]+)"\s*$`)
	commandPrefixRE = regexp.MustCompile(`(?i)^(hwf|herdr-workflows)\b`)
	workflowYAMLRE  = regexp.MustCompile(`(?m)^version:\s*v1alpha1\b`)
	workflowStepsRE = regexp.MustCompile(`(?m)^steps:\s*(?:$|\[)`)
)

const gzipOSUnix = 3

func validateBundle(bundle Bundle) error {
	if len(bundle) == 0 {
		return fmt.Errorf("bundle must contain at least one workflow")
	}
	seen := map[string]bool{}
	for _, entry := range bundle {
		if !NameRE.MatchString(entry.Name) {
			return errors.New(NameRule)
		}
		if entry.YAML == "" {
			return fmt.Errorf("yaml must be non-empty")
		}
		if seen[entry.Name] {
			return fmt.Errorf("duplicate workflow name '%s'", entry.Name)
		}
		seen[entry.Name] = true
	}
	return nil
}

// EncodePayload returns a platform-stable gzip/base64 workflow bundle.
func EncodePayload(bundle Bundle) (string, error) {
	if err := validateBundle(bundle); err != nil {
		return "", &LoadError{"cannot encode bundle: " + err.Error()}
	}
	data, err := json.Marshal(bundle)
	if err != nil {
		return "", err
	}
	if err := caps.AssertUnderCaptureCap("workflow bundle", string(data)); err != nil {
		return "", err
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	writer.OS = gzipOSUnix
	if _, err := writer.Write(data); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(compressed.Bytes()), nil
}

func FormatImportCommand(payload string) string {
	return `hwf workflow import "` + payload + `"`
}

// ExtractPayload accepts only the generated command or a raw encoded payload.
func ExtractPayload(text string) (string, error) {
	trimmed := strings.TrimSpace(text)
	if match := importCommandRE.FindStringSubmatch(trimmed); match != nil {
		return match[1], nil
	}
	if commandPrefixRE.MatchString(trimmed) {
		return "", &LoadError{`expected canonical command: hwf workflow import "<payload>"`}
	}
	return trimmed, nil
}

func gunzipBounded(encoded string) ([]byte, error) {
	compact := strings.Join(strings.Fields(encoded), "")
	if len(compact) > caps.CaptureByteLimit {
		return nil, &caps.CaptureLimitError{Source: "workflow bundle", Bytes: len(compact), Limit: caps.CaptureByteLimit}
	}
	compressed, err := base64.StdEncoding.DecodeString(compact)
	if err != nil {
		return nil, &LoadError{"not an hwf workflow payload (expected base64 from the docs)"}
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, &LoadError{"not an hwf workflow payload (expected base64 from the docs)"}
	}
	defer func() { _ = reader.Close() }()
	data, err := io.ReadAll(io.LimitReader(reader, caps.CaptureByteLimit+1))
	if err != nil {
		return nil, &LoadError{"not an hwf workflow payload (expected base64 from the docs)"}
	}
	if len(data) > caps.CaptureByteLimit {
		return nil, &caps.CaptureLimitError{Source: "workflow bundle", Bytes: len(data), Limit: caps.CaptureByteLimit}
	}
	return data, nil
}

// DecodePayload validates the canonical bundle without executing workflows.
func DecodePayload(payload string) (Bundle, error) {
	encoded, err := ExtractPayload(payload)
	if err != nil {
		return nil, err
	}
	data, err := gunzipBounded(encoded)
	if err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, &LoadError{"payload decoded but is not JSON"}
	}
	if err := rejectLegacyPayload(value); err != nil {
		return nil, err
	}
	items, ok := value.([]any)
	if !ok {
		return nil, &LoadError{"payload is not a shared workflow bundle: expected an array"}
	}
	bundle := make(Bundle, 0, len(items))
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, &LoadError{"payload is not a shared workflow bundle: expected workflow entries"}
		}
		name, nameOK := object["name"].(string)
		yaml, yamlOK := object["yaml"].(string)
		if !nameOK || !yamlOK {
			return nil, &LoadError{"payload is not a shared workflow bundle: entries require name and yaml"}
		}
		if len(object) != 2 {
			return nil, &LoadError{"payload is not a shared workflow bundle: unrecognized entry fields"}
		}
		bundle = append(bundle, BundleEntry{Name: name, YAML: yaml})
	}
	if err := validateBundle(bundle); err != nil {
		return nil, &LoadError{"payload is not a shared workflow bundle: " + err.Error()}
	}
	return bundle, nil
}

func rejectLegacyPayload(value any) error {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	if _, hasVersion := object["v"]; hasVersion {
		return &LoadError{"payload uses the removed single-workflow format; re-export as a workflow bundle"}
	}
	if _, hasName := object["name"]; hasName {
		if _, hasBody := object["body"]; hasBody {
			return &LoadError{"payload uses the removed single-workflow format; re-export as a workflow bundle"}
		}
	}
	return nil
}

func LooksLikeWorkflowYAML(text string) bool {
	t := strings.TrimSpace(text)
	if t == "" || len(t) > caps.CaptureByteLimit {
		return false
	}
	if !strings.Contains(t, "\n") && len(t) > 80 && regexp.MustCompile(`^[A-Za-z0-9+/=\s]+$`).MatchString(t) {
		return false
	}
	return workflowYAMLRE.MatchString(t) && workflowStepsRE.MatchString(t)
}

// CheckPayload performs schema-only validation, including raw YAML documents.
func CheckPayload(payload string, name ...string) (Bundle, error) {
	text := strings.TrimSpace(payload)
	bundle, err := DecodePayload(text)
	if err == nil {
		for _, entry := range bundle {
			if _, parseErr := ParseRaw(entry.Name+".yaml", entry.YAML); parseErr != nil {
				return nil, parseErr
			}
		}
		return bundle, nil
	}
	if !LooksLikeWorkflowYAML(text) {
		return nil, err
	}
	if len(name) == 0 || strings.TrimSpace(name[0]) == "" {
		return nil, &LoadError{"raw YAML import requires a workflow name"}
	}
	validated, nameErr := AssertWorkflowName(name[0])
	if nameErr != nil {
		return nil, nameErr
	}
	if err := caps.AssertUnderCaptureCap("workflow yaml", text); err != nil {
		return nil, err
	}
	if _, parseErr := ParseRaw(validated+".yaml", text); parseErr != nil {
		return nil, parseErr
	}
	return Bundle{{Name: validated, YAML: text}}, nil
}

type ExportedBundle struct {
	Entries    Bundle
	Provenance []Provenance
	Payload    string
	Command    string
}

type Provenance struct {
	Name   string
	Source string
}

// ExportWorkflowBundle includes the exact selected source and repo-first children.
func ExportWorkflowBundle(name, scope, repoRoot string) (ExportedBundle, error) {
	entries := Bundle{}
	provenance := []Provenance{}
	seen := map[string]bool{}
	var visit func(string, string, []string) error
	visit = func(current, exactScope string, stack []string) error {
		if slices.Contains(stack, current) {
			return &LoadError{fmt.Sprintf("workflow cycle: %s", strings.Join(append(slices.Clone(stack), current), " → "))}
		}
		if seen[current] {
			return nil
		}
		var file, source string
		//nolint:nestif // exact-source export needs path, existence, and stat-error checks.
		if exactScope != "" {
			var err error
			file, err = Path(exactScope, repoRoot, current)
			if err != nil {
				return err
			}
			source = exactScope
			if _, err := os.Stat(file); errors.Is(err, os.ErrNotExist) {
				return &LoadError{fmt.Sprintf("workflow '%s' not found in %s", current, exactScope)}
			} else if err != nil {
				return err
			}
		} else {
			resolved, err := ResolveWorkflowFile(current, repoRoot)
			if errors.Is(err, ErrWorkflowNotFound) {
				via := strings.Join(stack, " → ")
				if via == "" {
					via = "entry"
				}
				return &LoadError{fmt.Sprintf("workflow '%s' not found (via %s)", current, via)}
			}
			if err != nil {
				return err
			}
			file, source = resolved.File, resolved.Source
		}
		body, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		raw, err := ParseRaw(file, string(body))
		if err != nil {
			return err
		}
		seen[current] = true
		entries = append(entries, BundleEntry{Name: current, YAML: string(body)})
		provenance = append(provenance, Provenance{Name: current, Source: source})
		for _, child := range ReferencedWorkflowChildren(raw) {
			if err := visit(child, "", append(slices.Clone(stack), current)); err != nil {
				return err
			}
		}
		return nil
	}
	if err := visit(name, scope, nil); err != nil {
		return ExportedBundle{}, err
	}
	payload, err := EncodePayload(entries)
	if err != nil {
		return ExportedBundle{}, err
	}
	return ExportedBundle{Entries: entries, Provenance: provenance, Payload: payload, Command: FormatImportCommand(payload)}, nil
}

type BundlePreviewEntry struct {
	Name     string
	YAML     string
	Title    string
	Warnings []string
}

type BundlePreview struct {
	Entries            []BundlePreviewEntry
	Warnings           []string
	UnresolvedChildren []string
	Banner             string
	Text               string
}

func PreviewBundle(bundle Bundle) (BundlePreview, error) {
	if err := validateBundle(bundle); err != nil {
		return BundlePreview{}, err
	}
	names := map[string]bool{}
	for _, entry := range bundle {
		names[entry.Name] = true
	}
	aggregated := Sensitivity{}
	entries := make([]BundlePreviewEntry, 0, len(bundle))
	for _, entry := range bundle {
		raw, err := ParseRaw(entry.Name+".yaml", entry.YAML)
		if err != nil {
			return BundlePreview{}, err
		}
		local := analyzeWorkflowSensitivity(raw)
		MergeSensitivity(&aggregated, local)
		for _, child := range ReferencedWorkflowChildren(raw) {
			if !names[child] && !slices.Contains(aggregated.UnresolvedChildren, child) {
				aggregated.UnresolvedChildren = append(aggregated.UnresolvedChildren, child)
			}
		}
		entries = append(entries, BundlePreviewEntry{
			Name: entry.Name, YAML: entry.YAML, Title: DisplayTitle(entry.Name, raw.Title), Warnings: SensitivityLabels(local),
		})
	}
	slices.Sort(aggregated.SensitiveMethods)
	slices.Sort(aggregated.UnresolvedChildren)
	labels := SensitivityLabels(aggregated)
	banner := FormatSensitivityBanner(aggregated)
	childNote := ""
	if len(aggregated.UnresolvedChildren) > 0 {
		childNote = "Note: referenced workflows not in this bundle (" + strings.Join(aggregated.UnresolvedChildren, ", ") + ") will resolve from the importing repo (or be missing).\n"
	}
	sections := make([]string, len(entries))
	for i, entry := range entries {
		section := "--- " + entry.Name + ".yaml (" + entry.Title + ") ---\n"
		if len(entry.Warnings) > 0 {
			section += "⚠ " + strings.Join(entry.Warnings, " · ") + "\n"
		}
		section += entry.YAML + "\n"
		sections[i] = section
	}
	text := banner + childNote + strings.Join(sections, "\n")
	return BundlePreview{Entries: entries, Warnings: labels, UnresolvedChildren: aggregated.UnresolvedChildren, Banner: banner, Text: text}, nil
}

type ImportScope string

const (
	ImportRepo   ImportScope = "repo"
	ImportGlobal ImportScope = "global"
)

func ParseImportScope(raw string) (ImportScope, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "r", "repo", "local", "cwd":
		return ImportRepo, true
	case "g", "global", "home":
		return ImportGlobal, true
	default:
		return "", false
	}
}

func importScopeDir(scope ImportScope, repoRoot, home string) string {
	if scope == ImportRepo {
		return filepath.Join(repoRoot, ".hwf", "workflows")
	}
	return filepath.Join(home, ".hwf", "workflows")
}

type ImportConflict struct {
	Name string
	Path string
}

type ImportWriteResult struct {
	Status    string
	Results   []ImportResult
	Conflicts []ImportConflict
}

type ImportResult struct {
	Name string
	Path string
}

func PreflightConflicts(bundle Bundle, dir string) ([]ImportConflict, error) {
	conflicts := []ImportConflict{}
	for _, entry := range bundle {
		path := filepath.Join(dir, entry.Name+".yaml")
		if _, err := os.Stat(path); err == nil {
			conflicts = append(conflicts, ImportConflict{Name: entry.Name, Path: path})
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return conflicts, nil
}

type importJournal struct {
	Dest     string `json:"dest"`
	Staging  string `json:"staging"`
	Previous string `json:"previous"`
}

func ImportJournalPath(dir string) string {
	return dir + ".import-journal"
}

func readJournal(dir string) (importJournal, bool) {
	data, err := os.ReadFile(ImportJournalPath(dir))
	if err != nil {
		return importJournal{}, false
	}
	var journal importJournal
	if json.Unmarshal(data, &journal) != nil || journal.Dest == "" || journal.Staging == "" || journal.Previous == "" {
		return importJournal{}, false
	}
	return journal, true
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func journalStale(path string) bool {
	info, err := os.Stat(path)
	return err != nil || time.Since(info.ModTime()) >= 10*time.Second
}

// RecoverInterruptedImport repairs or rolls back an interrupted directory swap.
func RecoverInterruptedImport(dir string, force ...bool) error {
	path := ImportJournalPath(dir)
	if !pathExists(path) {
		return nil
	}
	journal, ok := readJournal(dir)
	if !ok {
		return os.Remove(path)
	}
	if len(force) == 0 || !force[0] {
		if !journalStale(path) {
			return nil
		}
	}
	dest, staging, previous := pathExists(journal.Dest), pathExists(journal.Staging), pathExists(journal.Previous)
	switch {
	case dest && staging && !previous:
		if err := os.RemoveAll(journal.Staging); err != nil {
			return err
		}
	case !dest && previous && staging:
		if err := os.Rename(journal.Staging, journal.Dest); err != nil {
			return err
		}
		if err := os.RemoveAll(journal.Previous); err != nil {
			return err
		}
	case dest && previous:
		if err := os.RemoveAll(journal.Previous); err != nil {
			return err
		}
		if staging {
			if err := os.RemoveAll(journal.Staging); err != nil {
				return err
			}
		}
	case !dest && previous && !staging:
		if err := os.Rename(journal.Previous, journal.Dest); err != nil {
			return err
		}
	default:
		if staging {
			if err := os.RemoveAll(journal.Staging); err != nil {
				return err
			}
		}
		if dest && previous {
			if err := os.RemoveAll(journal.Previous); err != nil {
				return err
			}
		}
	}
	return os.Remove(path)
}

func randomID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err == nil {
		return fmt.Sprintf("%x", value)
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func claimJournal(journal importJournal) (bool, error) {
	data, err := json.Marshal(journal)
	if err != nil {
		return false, err
	}
	file, err := os.OpenFile(ImportJournalPath(journal.Dest), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer func() { _ = file.Close() }()
	_, err = file.Write(data)
	return true, err
}

func linkOrCopy(source, destination string) error {
	if err := os.Link(source, destination); err == nil {
		return nil
	} else if !errors.Is(err, syscall.EOPNOTSUPP) && !errors.Is(err, syscall.ENOTSUP) && !errors.Is(err, syscall.ENOSYS) && !errors.Is(err, syscall.EPERM) && !errors.Is(err, syscall.EXDEV) && !errors.Is(err, syscall.EMLINK) {
		return err
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	return os.WriteFile(destination, data, info.Mode().Perm())
}

type ImportHooks struct {
	AfterPublish func(ImportResult) error
	BeforeSwap   func() error
}

func claimImportJournal(dir string, journal importJournal) (bool, error) {
	claimed, err := claimJournal(journal)
	if err != nil || claimed {
		return claimed, err
	}
	for i := 0; i < 100; i++ {
		time.Sleep(10 * time.Millisecond)
		if err := RecoverInterruptedImport(dir); err != nil {
			return false, err
		}
		if !pathExists(ImportJournalPath(dir)) {
			break
		}
	}
	return claimJournal(journal)
}

func writeBundleAtomic(bundle Bundle, dir string, replaceAll bool, hooks ImportHooks) (ImportWriteResult, error) {
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return ImportWriteResult{}, err
	}
	if err := RecoverInterruptedImport(dir); err != nil {
		return ImportWriteResult{}, err
	}
	id := randomID()
	journal := importJournal{Dest: dir, Staging: dir + "." + id + ".staging", Previous: dir + "." + id + ".prev"}
	claimed, err := claimImportJournal(dir, journal)
	if err != nil {
		return ImportWriteResult{}, err
	}
	if !claimed {
		return ImportWriteResult{}, &LoadError{fmt.Sprintf("import already in progress for %s", dir)}
	}
	if !replaceAll {
		conflicts, conflictErr := PreflightConflicts(bundle, dir)
		if conflictErr != nil {
			_ = os.Remove(ImportJournalPath(dir))
			return ImportWriteResult{}, conflictErr
		}
		if len(conflicts) > 0 {
			_ = os.Remove(ImportJournalPath(dir))
			return ImportWriteResult{Status: "conflicts", Conflicts: conflicts}, nil
		}
	}
	cleanup := func() {
		_ = RecoverInterruptedImport(dir, true)
		_ = os.RemoveAll(journal.Staging)
		_ = os.Remove(ImportJournalPath(dir))
	}
	if err := os.MkdirAll(journal.Staging, 0o755); err != nil {
		cleanup()
		return ImportWriteResult{}, err
	}
	bundleFiles := map[string]bool{}
	for _, entry := range bundle {
		bundleFiles[entry.Name+".yaml"] = true
	}
	entries, readErr := os.ReadDir(dir)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		cleanup()
		return ImportWriteResult{}, readErr
	}
	if readErr == nil {
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") || bundleFiles[entry.Name()] {
				continue
			}
			if entry.IsDir() {
				continue
			}
			if err := linkOrCopy(filepath.Join(dir, entry.Name()), filepath.Join(journal.Staging, entry.Name())); err != nil {
				cleanup()
				return ImportWriteResult{}, err
			}
		}
	}
	results := make([]ImportResult, 0, len(bundle))
	for _, entry := range bundle {
		result := ImportResult{Name: entry.Name, Path: filepath.Join(dir, entry.Name+".yaml")}
		if err := os.WriteFile(filepath.Join(journal.Staging, entry.Name+".yaml"), []byte(WithPinnedSchemaPointer(entry.YAML)), 0o644); err != nil {
			cleanup()
			return ImportWriteResult{}, err
		}
		results = append(results, result)
		if hooks.AfterPublish != nil {
			staged := result
			staged.Path = filepath.Join(journal.Staging, entry.Name+".yaml")
			if err := hooks.AfterPublish(staged); err != nil {
				cleanup()
				return ImportWriteResult{}, err
			}
		}
	}
	if hooks.BeforeSwap != nil {
		if err := hooks.BeforeSwap(); err != nil {
			cleanup()
			return ImportWriteResult{}, err
		}
	}
	if pathExists(dir) {
		if err := os.Rename(dir, journal.Previous); err != nil {
			cleanup()
			return ImportWriteResult{}, err
		}
	}
	if err := os.Rename(journal.Staging, dir); err != nil {
		cleanup()
		return ImportWriteResult{}, err
	}
	if err := os.RemoveAll(journal.Previous); err != nil {
		cleanup()
		return ImportWriteResult{}, err
	}
	if err := os.Remove(ImportJournalPath(dir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return ImportWriteResult{}, err
	}
	return ImportWriteResult{Status: "written", Results: results}, nil
}

const ImportDisclaimer = "This payload came from outside your machine. Imported workflows are\nreviewed executable code: they run shell commands and agent prompts with your\npermissions. Read every line below before you accept it. There is no sandbox."

type ImportPrompts struct {
	Confirm           func(string) (bool, error)
	ChooseScope       func() (ImportScope, error)
	ConfirmReplaceAll func([]ImportConflict) (bool, error)
}

type RunImportOptions struct {
	RepoRoot string
	Home     string
	Scope    ImportScope
	Force    bool
	Name     string
	Prompts  *ImportPrompts
	Hooks    ImportHooks
}

type ImportOutcome struct {
	Aborted bool
	Bundle  Bundle
	Result  ImportWriteResult
	Dir     string
}

// RunImport validates, reviews, and atomically writes one workflow bundle.
func RunImport(payload string, opts RunImportOptions) (ImportOutcome, error) {
	var bundle Bundle
	var err error
	if opts.Name != "" {
		bundle, err = CheckPayload(payload, opts.Name)
	} else {
		bundle, err = CheckPayload(payload)
	}
	if err != nil {
		return ImportOutcome{}, err
	}
	preview, err := PreviewBundle(bundle)
	if err != nil {
		return ImportOutcome{}, err
	}
	if opts.Prompts != nil {
		if opts.Prompts.Confirm == nil {
			return ImportOutcome{}, &LoadError{"import prompts are incomplete: Confirm is required"}
		}
		confirmed, confirmErr := opts.Prompts.Confirm(preview.Text)
		if confirmErr != nil {
			return ImportOutcome{}, confirmErr
		}
		if !confirmed {
			return ImportOutcome{Aborted: true}, nil
		}
	}
	scope := opts.Scope
	if scope == "" && opts.Prompts != nil && opts.Prompts.ChooseScope != nil {
		scope, err = opts.Prompts.ChooseScope()
		if err != nil {
			return ImportOutcome{}, err
		}
	}
	if scope == "" {
		return ImportOutcome{}, &LoadError{"no destination chosen (pass --to=repo|global)"}
	}
	home := opts.Home
	if home == "" {
		home, err = os.UserHomeDir()
		if err != nil {
			return ImportOutcome{}, err
		}
	}
	dir := importScopeDir(scope, opts.RepoRoot, home)
	conflicts, err := PreflightConflicts(bundle, dir)
	if err != nil {
		return ImportOutcome{}, err
	}
	replaceAll := opts.Force
	//nolint:nestif // replacement confirmation has distinct prompt and no-prompt outcomes.
	if len(conflicts) > 0 && !replaceAll {
		if opts.Prompts != nil && opts.Prompts.ConfirmReplaceAll != nil {
			replaceAll, err = opts.Prompts.ConfirmReplaceAll(conflicts)
			if err != nil {
				return ImportOutcome{}, err
			}
			if !replaceAll {
				return ImportOutcome{Aborted: true}, nil
			}
		} else {
			return ImportOutcome{Bundle: bundle, Result: ImportWriteResult{Status: "conflicts", Conflicts: conflicts}, Dir: dir}, nil
		}
	}
	result, err := writeBundleAtomic(bundle, dir, replaceAll, opts.Hooks)
	if err != nil {
		return ImportOutcome{}, err
	}
	return ImportOutcome{Bundle: bundle, Result: result, Dir: dir}, nil
}
