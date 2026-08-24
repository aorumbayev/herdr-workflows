package cli

import (
	"fmt"
	"os"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/spf13/cobra"
)

func runScratchGet(cmd *cobra.Command, args []string) error {
	value, err := history.ScratchGet(args[0], os.Getenv)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(cmd.OutOrStdout(), value)
	return err
}

func runScratchSet(cmd *cobra.Command, args []string) error {
	return history.ScratchSet(args[0], args[1], os.Getenv)
}

func runScratchList(cmd *cobra.Command, _ []string) error {
	keys, err := history.ScratchList(os.Getenv)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if _, err := fmt.Fprintln(cmd.OutOrStdout(), key); err != nil {
			return err
		}
	}
	return nil
}

func runScratchDelete(_ *cobra.Command, args []string) error {
	return history.ScratchDelete(args[0], os.Getenv)
}
