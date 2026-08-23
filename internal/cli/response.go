package cli

import (
	"fmt"
	"os"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"github.com/spf13/cobra"
)

func runResponseCheck(cmd *cobra.Command, args []string) error {
	oneOfRaw, err := cmd.Flags().GetString("one-of")
	if err != nil {
		return err
	}
	tokens, err := workflow.ParseVerdictTokens(oneOfRaw)
	if err != nil {
		return err
	}

	path := args[0]
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("response file not found: %s", path)
		}
		return err
	}
	text := string(data)
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("response file is empty: %s", path)
	}

	verdict, ok, line := workflow.ParseVerdict(text, tokens)
	if !ok {
		return fmt.Errorf("%s", workflow.VerdictMismatchMessage(line, tokens))
	}
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "%s\n", verdict)
	return err
}
