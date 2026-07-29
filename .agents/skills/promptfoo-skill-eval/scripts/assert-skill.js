/**
 * skill-used / not-skill-used. promptfoo's built-in versions of these assertions only work with
 * the anthropic:claude-agent-sdk provider, so this reads the Skill tool calls the CLI provider
 * recorded in metadata.
 *
 * vars: expect_skill (name that must be used) | forbid_skill (name that must not be used)
 */
module.exports = (output, context) => {
  const vars = (context && context.vars) || {};
  const meta = (context && context.providerResponse && context.providerResponse.metadata) || {};
  const skills = meta.skills || [];
  const want = vars.expect_skill;
  const forbid = vars.forbid_skill;

  if (forbid) {
    const hit = skills.includes(forbid);
    return {
      pass: !hit,
      score: hit ? 0 : 1,
      reason: hit
        ? `routed into ${forbid} (should not)`
        : `did not route into ${forbid} [${skills.join(",") || "none"}]`,
    };
  }
  if (want) {
    const hit = skills.includes(want);
    return {
      pass: hit,
      score: hit ? 1 : 0,
      reason: hit ? `used ${want}` : `did not use ${want} [${skills.join(",") || "none"}]`,
    };
  }
  return { pass: true, score: 1, reason: "no skill expectation" };
};
