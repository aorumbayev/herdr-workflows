/** Bundled agent skills. Text imports embed the files, so the compiled binary serves them. */
import createSkill from "../skills/herdr-workflow-create/SKILL.md" with { type: "text" };
import createHerdrApi from "../skills/herdr-workflow-create/reference/herdr-api.md" with { type: "text" };
import createRecipes from "../skills/herdr-workflow-create/reference/recipes.md" with { type: "text" };
import createSyntax from "../skills/herdr-workflow-create/reference/syntax.md" with { type: "text" };
import createValidate from "../skills/herdr-workflow-create/scripts/validate.sh" with { type: "text" };
import upgradeSkill from "../skills/herdr-workflow-upgrade/SKILL.md" with { type: "text" };
import upgradeBreakages from "../skills/herdr-workflow-upgrade/reference/herdr-0.8.0.md" with { type: "text" };

type SkillFile = { path: string; text: string };

export type Skill = { name: string; description: string; files: SkillFile[] };

function defineSkill(name: string, files: SkillFile[]): Skill {
  const description = /^description:\s*(.+)$/m.exec(files[0]?.text ?? "")?.[1]?.trim() ?? "";
  return { name, description, files };
}

const SKILLS: Skill[] = [
  defineSkill("herdr-workflow-create", [
    { path: "skills/herdr-workflow-create/SKILL.md", text: createSkill },
    { path: "skills/herdr-workflow-create/reference/herdr-api.md", text: createHerdrApi },
    { path: "skills/herdr-workflow-create/reference/recipes.md", text: createRecipes },
    { path: "skills/herdr-workflow-create/reference/syntax.md", text: createSyntax },
    { path: "skills/herdr-workflow-create/scripts/validate.sh", text: createValidate },
  ]),
  defineSkill("herdr-workflow-upgrade", [
    { path: "skills/herdr-workflow-upgrade/SKILL.md", text: upgradeSkill },
    {
      path: "skills/herdr-workflow-upgrade/reference/herdr-0.8.0.md",
      text: upgradeBreakages,
    },
  ]),
];

export function listSkills(): Skill[] {
  return SKILLS;
}

export function findSkill(name: string): Skill | undefined {
  return SKILLS.find((skill) => skill.name === name);
}

export function formatSkill(skill: Skill): string {
  const parts = skill.files.map((file) => `==> ${file.path} <==\n\n${file.text.trimEnd()}\n`);
  return `${parts.join("\n")}\n`;
}
