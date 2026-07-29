// Re-grade a saved promptfoo export offline (no new agent runs): replay assert-loads.js + assert-skill.js.
const fs = require("node:fs");
const loadsA = require("./assert-loads.js");
const skillA = require("./assert-skill.js");
const W = { loads: 4, skill: 2, cost: 0.5, latency: 0.5 };
const d = JSON.parse(
  fs.readFileSync(
    process.argv[2] && process.argv[2] !== "x" ? process.argv[2] : process.argv[3],
    "utf8",
  ),
);
const rows = d.results.results || d.results;
const per = {};
for (const r of rows) {
  const label = r.provider.label;
  const desc = (r.testCase || {}).description || "";
  const vars = r.vars || {};
  const output = (r.response || {}).output || "";
  const ctx = { vars, providerResponse: r.response || {} };
  const got = {
    loads: loadsA(output, ctx),
    skill: skillA(output, ctx),
    cost: { pass: (r.cost ?? 0) <= 0.4 },
    latency: { pass: (r.latencyMs ?? 0) <= 90000 },
  };
  const num = Object.entries(got).reduce((a, [k, v]) => a + W[k] * (v.pass ? 1 : 0), 0);
  const den = Object.values(W).reduce((a, b) => a + b, 0);
  (per[label] ||= []).push({
    desc,
    score: num / den,
    got,
    cost: r.cost,
    turns: (r.response?.metadata || {}).numTurns,
  });
}
for (const [label, tests] of Object.entries(per).sort()) {
  const tot = tests.reduce((a, t) => a + t.score, 0) / tests.length;
  const cost = tests.reduce((a, t) => a + (t.cost || 0), 0);
  console.log(
    `\n== ${label}  weighted ${tot.toFixed(3)}  (${tests.length} tests, $${cost.toFixed(2)})`,
  );
  for (const t of tests.sort((a, b) => a.desc.localeCompare(b.desc))) {
    const f = Object.entries(t.got)
      .filter(([, v]) => !v.pass)
      .map(([k]) => k);
    console.log(
      `  ${t.score.toFixed(2)} turns=${t.turns} ${t.desc}${f.length ? "   MISS: " + f.join(",") : ""}`,
    );
    if (!t.got.loads.pass) console.log(`       -> ${t.got.loads.reason}`);
  }
}
