package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/spf13/cobra"
)

const machineSchemaVersion = 1

// machineError is a JSON-mode failure. Main writes it to stdout as the one response.
type machineError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *machineError) Error() string { return e.Message }

func machineErr(code, message string) error {
	return &machineError{Code: code, Message: message}
}

type machineWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Count   int    `json:"count"`
}

type runsListResponse struct {
	SchemaVersion int               `json:"schema_version"`
	OK            bool              `json:"ok"`
	Runs          []history.Summary `json:"runs"`
	NextCursor    *string           `json:"next_cursor"`
	Warnings      []machineWarning  `json:"warnings"`
}

type runResponse struct {
	SchemaVersion int  `json:"schema_version"`
	OK            bool `json:"ok"`
	Run           any  `json:"run"`
}

type machineFailure struct {
	SchemaVersion int           `json:"schema_version"`
	OK            bool          `json:"ok"`
	Error         *machineError `json:"error"`
}

func writeMachine(w io.Writer, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = w.Write(append(raw, '\n'))
	return err
}

func writeMachineFailure(w io.Writer, e *machineError) {
	_ = writeMachine(w, machineFailure{SchemaVersion: machineSchemaVersion, Error: e})
}

func newRunsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "runs",
		Short: "Machine-readable run history (--json)",
		RunE: func(c *cobra.Command, args []string) error {
			c.SetOut(c.ErrOrStderr())
			_ = c.Help()
			return errUsage
		},
	}
	cmd.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return machineErr("invalid_request", err.Error())
	})
	list := &cobra.Command{
		Use:   "list --json",
		Short: "List runs newest first, one page per call",
		Args:  machineArgs(0),
		RunE:  runRunsList,
	}
	list.Flags().Bool("json", false, "print one JSON object (required)")
	list.Flags().String("checkout-root", "", "absolute checkout root to filter by")
	list.Flags().StringArray("status", nil, "status filter, repeatable: "+strings.Join(history.Statuses, ", "))
	list.Flags().Int("limit", history.DefaultListLimit, fmt.Sprintf("page size, 1 to %d", history.MaxListLimit))
	list.Flags().String("cursor", "", "next_cursor from the previous page")
	get := &cobra.Command{
		Use:   "get <run-id> --json",
		Short: "Print one run with ordered step records",
		Args:  machineArgs(1),
		RunE:  runRunsGet,
	}
	get.Flags().Bool("json", false, "print one JSON object (required)")
	cmd.AddCommand(list, get)
	return cmd
}

func machineArgs(n int) cobra.PositionalArgs {
	return func(_ *cobra.Command, args []string) error {
		if len(args) != n {
			return machineErr("invalid_request", fmt.Sprintf("accepts %d arg(s), received %d", n, len(args)))
		}
		return nil
	}
}

func requireJSONFlag(cmd *cobra.Command) error {
	jsonOut, _ := cmd.Flags().GetBool("json")
	if !jsonOut {
		return fmt.Errorf("%s requires --json", cmd.CommandPath())
	}
	return nil
}

func runRunsList(cmd *cobra.Command, _ []string) error {
	if err := requireJSONFlag(cmd); err != nil {
		return err
	}
	filter, err := listFilterFromFlags(cmd)
	if err != nil {
		return err
	}
	listed := history.ListRuns(filter)
	switch {
	case listed.Unavailable:
		return machineErr("history_unavailable", "run history storage is unavailable")
	case listed.SchemaVersion != 0:
		return machineErr("incompatible_history", fmt.Sprintf("run history schema version %d is incompatible", listed.SchemaVersion))
	}
	resp := runsListResponse{SchemaVersion: machineSchemaVersion, OK: true, Runs: listed.Runs, Warnings: []machineWarning{}}
	if resp.Runs == nil {
		resp.Runs = []history.Summary{}
	}
	if listed.NextCursor != nil {
		token := listed.NextCursor.Encode()
		resp.NextCursor = &token
	}
	if listed.Malformed > 0 {
		resp.Warnings = append(resp.Warnings, machineWarning{Code: "malformed_run_skipped", Message: "skipped malformed run records", Count: listed.Malformed})
	}
	if n := len(listed.Incompatible); n > 0 {
		resp.Warnings = append(resp.Warnings, machineWarning{Code: "incompatible_run_skipped", Message: "skipped run records with an incompatible snapshot version", Count: n})
	}
	return writeMachine(cmd.OutOrStdout(), resp)
}

func listFilterFromFlags(cmd *cobra.Command) (history.ListFilter, error) {
	flags := cmd.Flags()
	filter := history.ListFilter{}
	if root, _ := flags.GetString("checkout-root"); root != "" {
		if !filepath.IsAbs(root) {
			return filter, machineErr("invalid_request", "--checkout-root must be an absolute path")
		}
		canon := history.CanonicalRepoRoot(root)
		filter.CheckoutRoot = &canon
	}
	statuses, _ := flags.GetStringArray("status")
	for _, status := range statuses {
		if !slices.Contains(history.Statuses, status) {
			return filter, machineErr("invalid_request", "--status must be one of: "+strings.Join(history.Statuses, ", "))
		}
	}
	filter.Status = statuses
	limit, _ := flags.GetInt("limit")
	if limit < 1 || limit > history.MaxListLimit {
		return filter, machineErr("invalid_request", fmt.Sprintf("--limit must be an integer from 1 to %d", history.MaxListLimit))
	}
	filter.Limit = limit
	if token, _ := flags.GetString("cursor"); token != "" {
		cursor, ok := history.DecodeCursor(token)
		if !ok {
			return filter, machineErr("invalid_request", "--cursor is not a cursor from a previous page")
		}
		filter.After = &cursor
	}
	return filter, nil
}

func runRunsGet(cmd *cobra.Command, args []string) error {
	if err := requireJSONFlag(cmd); err != nil {
		return err
	}
	id, ok := history.NormalizeRunUUID(args[0])
	if !ok {
		return machineErr("invalid_request", "run id must be a complete UUID")
	}
	detail := history.RunDetail(id, time.Time{}).Detail
	if err := detailError(detail); err != nil {
		return err
	}
	return writeMachine(cmd.OutOrStdout(), runResponse{SchemaVersion: machineSchemaVersion, OK: true, Run: detail})
}

func detailError(detail history.Detail) error {
	switch detail.Kind {
	case "snapshot":
		return nil
	case "invalid":
		return machineErr("invalid_request", detail.Message)
	case "missing", "expired":
		return machineErr("run_not_found", detail.Message)
	case "incompatible":
		return machineErr("incompatible_history", detail.Message)
	default:
		return machineErr("history_unavailable", detail.Message)
	}
}
