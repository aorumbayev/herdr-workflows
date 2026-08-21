package cli

import (
	"fmt"
	"strings"

	assets "github.com/aorumbayev/herdr-workflows/embed"
	"github.com/spf13/cobra"
)

func runSkillsList(cmd *cobra.Command, _ []string) error {
	for _, skill := range assets.ListSkills() {
		if _, err := fmt.Fprintf(cmd.OutOrStdout(), "%s — %s\n", skill.Name, skill.Description); err != nil {
			return err
		}
	}
	return nil
}

func runSkillsShow(cmd *cobra.Command, args []string) error {
	skill, ok := assets.FindSkill(args[0])
	if !ok {
		names := make([]string, 0, len(assets.ListSkills()))
		for _, s := range assets.ListSkills() {
			names = append(names, s.Name)
		}
		return fmt.Errorf("unknown skill '%s' — available: %s", args[0], strings.Join(names, ", "))
	}
	_, err := fmt.Fprint(cmd.OutOrStdout(), assets.FormatSkill(skill))
	return err
}
