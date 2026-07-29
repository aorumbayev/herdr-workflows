/**
 * promptfoo custom provider: the local `claude` CLI in print mode.
 *
 * The documented `anthropic:claude-agent-sdk` provider needs ANTHROPIC_API_KEY, which this host
 * does not have. The CLI uses the machine's existing Claude Code credentials, so it is the only
 * way to get real agent runs here. Everything else in the harness follows the promptfoo
 * agent-skills guide: one fixture dir per skill version, providers differing only in working_dir.
 */
const { spawn } = require("node:child_process");

function runClaude(args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ out, err: `${err}\nspawn: ${e.message}`, code: -1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, err, code });
    });
  });
}

class ClaudeCliProvider {
  constructor(options = {}) {
    this.config = options.config || {};
    this.label =
      options.label || this.config.label || `claude-cli:${this.config.working_dir || "."}`;
  }

  id() {
    return this.label;
  }

  async callApi(prompt) {
    const cwd = this.config.working_dir;
    // prompt first: --allowedTools is variadic and swallows a trailing prompt argument
    const args = [
      prompt,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      this.config.model || "sonnet",
      "--permission-mode",
      "acceptEdits",
      // one comma-separated value: --allowedTools is variadic and would swallow the prompt
      "--allowedTools",
      (
        this.config.allowed_tools || ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "Skill"]
      ).join(","),
    ];
    const { out, err, code } = await runClaude(args, cwd, this.config.timeout_ms || 300000);

    const skills = [];
    let text = "";
    let cost;
    let numTurns;
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "assistant") {
        for (const b of ev.message?.content || []) {
          if (b.type === "tool_use" && b.name === "Skill" && b.input?.skill)
            skills.push(b.input.skill);
        }
      }
      if (ev.type === "result") {
        text = ev.result || "";
        cost = ev.total_cost_usd;
        numTurns = ev.num_turns;
        if (ev.is_error) text = `${text}\n[cli error: ${ev.subtype || "unknown"}]`;
      }
    }
    if (!text && code !== 0) return { error: `claude exited ${code}: ${err.slice(0, 500)}` };

    return {
      output: text,
      ...(cost !== undefined ? { cost } : {}),
      metadata: { skills, numTurns, workingDir: cwd },
    };
  }
}

module.exports = ClaudeCliProvider;
