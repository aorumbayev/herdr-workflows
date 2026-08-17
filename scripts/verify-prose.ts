import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FILES = ["README.md", "CONTRIBUTING.md", "AGENTS.md"];
const DIRS = ["docs", "openspec", "skills", ".agents/skills"];
const SKIP_DIRS = new Set([".vitepress", "node_modules"]);

type Rule = { re: RegExp; use: string; why: string };

/**
 * Microsoft Writing Style Guide, the part a regex can judge. Tone, heading
 * parallelism, and bold-for-emphasis stay human review — see AGENTS.md.
 */
const RULES: Rule[] = [
  // UI actions
  { re: /\bclicks?(\s+on)?\b/gi, use: "select", why: "one verb covers mouse, keyboard, and touch" },
  {
    re: /\bdouble-click\b/gi,
    use: "select",
    why: "unless the double action is literally required",
  },
  { re: /\btaps?\b/gi, use: "select", why: "`tap` belongs only in touch-specific content" },
  {
    re: /\bhit\s+(the\s+)?(enter|escape|key|button)\b/gi,
    use: "press, or select",
    why: "`hit` is not a UI verb",
  },
  { re: /\bkey\s+in\b/gi, use: "enter", why: "`key in` is dated" },
  {
    re: /\blog\s?(in|into|on|out|off)\b/gi,
    use: "sign in, sign out",
    why: "Microsoft uses sign in / sign out",
  },
  {
    re: /\blog(in|out)\s+(screen|page|button|form)\b/gi,
    use: "sign-in screen",
    why: "hyphenate the modifier",
  },

  // Plain language
  { re: /\bin order to\b/gi, use: "to", why: "the extra words carry nothing" },
  { re: /\bdue to the fact that\b/gi, use: "because", why: "" },
  { re: /\bat this point in time\b/gi, use: "now", why: "" },
  { re: /\bin the event that\b/gi, use: "if", why: "" },
  { re: /\bwith regard to\b/gi, use: "about", why: "" },
  { re: /\butilize[sd]?\b/gi, use: "use", why: "" },
  { re: /\bleverages?\b/gi, use: "use", why: "`leverage` is a noun outside finance" },
  { re: /\bfacilitates?\b/gi, use: "help, make it easier", why: "" },
  { re: /\bcommences?\b/gi, use: "start", why: "" },
  { re: /\bprior to\b/gi, use: "before", why: "" },
  { re: /\bsubsequent to\b/gi, use: "after", why: "" },
  {
    re: /\bsimply\b/gi,
    use: "nothing — delete it",
    why: "it tells the reader their trouble is their own fault",
  },
  {
    re: /\bjust\s+(click|select|run|add|use|open|type)\b/gi,
    use: "the verb alone",
    why: "`just` minimizes the reader's work",
  },
  {
    re: /\b(easily|quickly|smoothly|effortlessly)\b/gi,
    use: "nothing — delete it",
    why: "claims the reader's experience for them",
  },
  { re: /\bplease\b/gi, use: "nothing — delete it", why: "instructions are not requests" },
  {
    re: /\b(basically|actually|obviously|of course)\b/gi,
    use: "nothing — delete it",
    why: "filler, or condescending",
  },

  // Words with a second meaning. `since` and `while` are skipped: their time
  // sense is correct and a regex can't tell it from the causal one.
  { re: /\bwhilst\b/gi, use: "while, or although", why: "" },
  {
    re: /\bsee (the )?(table|section|list|note)? ?(above|below)\b/gi,
    use: "preceding / following, or a link",
    why: "position changes with rendering",
  },
  {
    re: /\b(over|under)\s+\d/gi,
    use: "more than, less than",
    why: "`over` and `under` are spatial",
  },

  // Anthropomorphism
  {
    re: /\b(herdr|hwf|the (app|system|plugin|picker|workbench|runner|loader))\s+(thinks|wants|sees|understands|knows|feels|believes)\b/gi,
    use: "reports, requires, reads, accepts",
    why: "software has no inner life",
  },

  // Bias-free and dated terms
  { re: /\b(white|black)\s?list(ed|ing)?\b/gi, use: "allowlist, blocklist", why: "" },
  { re: /\b(master|slave)\b/gi, use: "primary, replica", why: "" },
  { re: /\bsanity check\b/gi, use: "quick check, verify", why: "" },
  { re: /\bdummy data\b/gi, use: "sample data", why: "" },

  // Names and spelling
  { re: /\bGithub\b/g, use: "GitHub", why: "capital H" },
  { re: /\b(Powershell|power shell)\b/g, use: "PowerShell", why: "" },
  { re: /\bJavascript\b/g, use: "JavaScript", why: "" },
  { re: /\bTypescript\b/g, use: "TypeScript", why: "" },
  { re: /\b(Mac OS|OS X)\b/g, use: "macOS", why: "" },
  {
    re: /\b(recogni|organi|customi|initiali|seriali|normali|summari|prioriti|optimi|synchroni|authori|standardi|categori|minimi|maximi)s(e|ed|es|ing|ation)\b/gi,
    use: "-ize spelling",
    why: "US spelling",
  },
  {
    re: /\b(analys(e|ed|es|ing)|behaviour|colour|centre|licence|defence|artefact|catalogue|dialogue|programme|grey|labell(ed|ing)|cancell(ed|ing)|modelling|travelled)\b/gi,
    use: "US spelling",
    why: "",
  },
  { re: /\bemail address\b/gi, use: "email", why: "`address` is redundant" },

  // Punctuation CONTRIBUTING.md bans outright. Masking blanks code spans, so a
  // semicolon that follows one still ends prose and must match after spaces.
  { re: /; +[^\s;]/g, use: "two sentences", why: "no semicolons in prose" },
];

/** Replace code spans, fences, and link targets with spaces so offsets survive. */
function maskCode(text: string): string {
  const masked = text.split("\n");
  let inFence = false;
  return masked
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return " ".repeat(line.length);
      }
      if (inFence) return " ".repeat(line.length);
      return line
        .replace(/`[^`]*`/g, (m) => " ".repeat(m.length))
        .replace(/\]\([^)]*\)/g, (m) => " ".repeat(m.length))
        .replace(/<https?:[^>]*>|https?:\/\/\S+/g, (m) => " ".repeat(m.length));
    })
    .join("\n");
}

async function markdownFiles(): Promise<string[]> {
  const found = FILES.map((f) => join(ROOT, f));
  for (const dir of DIRS) {
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(join(current, entry.name));
        } else if (entry.name.endsWith(".md")) found.push(join(current, entry.name));
      }
    };
    await walk(join(ROOT, dir));
  }
  return found.sort();
}

type Finding = { file: string; line: number; column: number; text: string; rule: Rule };

async function scan(path: string): Promise<Finding[]> {
  const lines = maskCode(await readFile(path, "utf8")).split("\n");
  const findings: Finding[] = [];
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const match of line.matchAll(rule.re)) {
        findings.push({
          file: relative(ROOT, path),
          line: index + 1,
          column: (match.index ?? 0) + 1,
          text: match[0],
          rule,
        });
      }
    }
  }
  return findings;
}

const EXPECTATIONS = `
This check is the machine-checked subset of the docs style (AGENTS.md, "Docs style"):

  UI verbs     select, not click / tap / double-click. press, not hit. enter, not key in.
               sign in and sign out, not log in and log out.
  Wordiness    to, because, if, about, before, after, use, help, start — not their
               long forms (in order to, due to the fact that, prior to, utilize...).
  Filler       simply, just, easily, quickly, please, basically, actually, obviously.
  Direction    no "see above" or "see below". more than / less than, not over / under.
  Naming       GitHub, PowerShell, JavaScript, TypeScript, macOS. US spelling.
  Machines     herdr reports, requires, reads — never thinks, wants, sees, knows.

Fix the lines listed, or, when a match is a genuine technical term, wrap it in
backticks. Code spans, fenced blocks, and link targets are not scanned.

Voice, sentence length, and terminology consistency are not checked here. They
follow CONTRIBUTING.md, "Documentation style" (Simplified Technical English).
`;

const files = await markdownFiles();
const findings = (await Promise.all(files.map(scan)))
  .flat()
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

if (findings.length === 0) {
  console.log(`prose: ${files.length} files clean`);
  process.exit(0);
}

let current = "";
for (const f of findings) {
  if (f.file !== current) {
    current = f.file;
    console.log(`\n${current}`);
  }
  const why = f.rule.why ? ` (${f.rule.why})` : "";
  console.log(`  ${f.line}:${f.column}  "${f.text}" → ${f.rule.use}${why}`);
}
console.log(EXPECTATIONS);
const hits = findings.length;
const bad = new Set(findings.map((f) => f.file)).size;
console.log(`prose: ${hits} issue${hits === 1 ? "" : "s"} in ${bad} file${bad === 1 ? "" : "s"}`);
process.exit(1);
