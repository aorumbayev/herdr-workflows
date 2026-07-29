/**
 * Objective oracle assertion: every v1alpha1 YAML fence in the reply must load through hwf's
 * real loader (src/workflow/load.ts). No LLM judge — the loader is the authority.
 *
 * vars:
 *   require_yaml: false  -> a reply with no workflow fence passes (clarify / routing tasks)
 *   must_contain: [str]  -> substrings the loading YAML must contain (e.g. an explicit selector)
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const ORACLE = path.join(__dirname, "oracle.ts");
const FENCE = /```ya?ml\n([\s\S]*?)```/g;

function fences(text) {
  const out = [];
  FENCE.lastIndex = 0;
  let m;
  while ((m = FENCE.exec(text || ""))) {
    // keep the fence verbatim: the loader accepts a leading schema-pointer comment, and the
    // banned-text check must still see it
    const body = m[1] || "";
    if (/^\s*version:\s*v1alpha1\b/m.test(body)) out.push(body);
  }
  return out;
}

function loads(yaml, i, seed) {
  try {
    const args = [ORACLE, "-", `evalcase${i}`, ...(seed ? ["--seed", seed] : [])];
    const raw = execFileSync("bun", args, {
      input: yaml,
      encoding: "utf8",
      timeout: 60000,
    });
    const line = raw.trim().split("\n").pop();
    return JSON.parse(line);
  } catch (e) {
    return { ok: false, error: `oracle failed: ${String(e.message).slice(0, 300)}` };
  }
}

module.exports = (output, context) => {
  const vars = (context && context.vars) || {};
  // the fixture's own workflows must be visible, or a `workflow: <child>` ref looks missing
  const wd = ((context && context.providerResponse && context.providerResponse.metadata) || {})
    .workingDir;
  const seed = wd ? path.resolve(__dirname, wd, ".hwf", "workflows") : undefined;
  const found = fences(output);
  if (found.length === 0) {
    return vars.require_yaml === false
      ? { pass: true, score: 1, reason: "no workflow emitted (allowed for this task)" }
      : { pass: false, score: 0, reason: "no v1alpha1 YAML fence in reply" };
  }
  const failures = [];
  found.forEach((y, i) => {
    const r = loads(y, i, seed);
    if (!r.ok) failures.push(`fence ${i + 1}: ${r.error}`);
  });
  const missing = (vars.must_contain || []).filter((s) => !found.some((y) => y.includes(s)));
  if (missing.length) failures.push(`missing required text: ${missing.join(", ")}`);
  // fences only: prose that *names* a rejected key ("dropped `out:`") is correct, not a defect
  const banned = (vars.must_not_contain || []).filter((s) => found.some((y) => y.includes(s)));
  if (banned.length) failures.push(`contains banned text: ${banned.join(", ")}`);

  return failures.length
    ? { pass: false, score: 0, reason: failures.join(" | ") }
    : { pass: true, score: 1, reason: `${found.length} workflow(s) load` };
};
