import { WorkflowLoadError, positioned, type FlatStep } from "./errors";
import { AGENT_INPUT_RE } from "./inputs";
import type { RawStep } from "./parse";
import {
  commandHasPlaceholder,
  paramsHavePrompt,
  paramsHaveSession,
  textHasPrompt,
  textHasSession,
} from "./substitute";

const SESSION_STDIN_ONLY = "{session}/{session_file} only allowed in stdin";

function banSessionOutsideStdin(
  file: string,
  stepIndex: number,
  key: string | undefined,
  text: string | undefined,
): void {
  if (!text || !textHasSession(text)) return;
  throw new WorkflowLoadError(positioned(file, stepIndex, key, SESSION_STDIN_ONLY));
}

function banPlaceholder(file: string, stepIndex: number, command: string): void {
  const ph = commandHasPlaceholder(command);
  if (!ph) return;
  if (ph === "session" || ph === "session_file") {
    throw new WorkflowLoadError(positioned(file, stepIndex, undefined, SESSION_STDIN_ONLY));
  }
  throw new WorkflowLoadError(
    positioned(
      file,
      stepIndex,
      undefined,
      `placeholder {${ph}} not allowed in command strings (use stdin/prompt/params)`,
    ),
  );
}

export function rawToFlat(file: string, stepIndex: number, step: RawStep): FlatStep {
  if (step.shell !== undefined) {
    banPlaceholder(file, stepIndex, step.shell);
    return { verb: "shell", command: step.shell, stdin: step.stdin };
  }
  if (step.open !== undefined) {
    banPlaceholder(file, stepIndex, step.open);
    if (step.wait_for !== undefined) {
      return {
        verb: "open",
        command: step.open,
        waitFor: step.wait_for,
        timeoutMs: (step.timeout ?? 60) * 1000,
      };
    }
    return { verb: "open", command: step.open };
  }
  if (step.agent !== undefined) {
    banSessionOutsideStdin(file, stepIndex, "prompt", step.prompt);
    if (step.wait !== undefined) {
      return {
        verb: "agent",
        name: step.agent,
        prompt: step.prompt,
        wait: true,
        timeoutMs: (step.timeout ?? 1800) * 1000,
      };
    }
    return { verb: "agent", name: step.agent, prompt: step.prompt };
  }
  if (step.herdr !== undefined) {
    if (paramsHaveSession(step.params)) {
      throw new WorkflowLoadError(positioned(file, stepIndex, "params", SESSION_STDIN_ONLY));
    }
    return { verb: "herdr", method: step.herdr, params: step.params };
  }
  throw new WorkflowLoadError(positioned(file, stepIndex, "run", "internal: run not flattened"));
}

export function flatNeedsPrompt(steps: FlatStep[]): boolean {
  return steps.some(
    (s) =>
      (s.verb === "shell" && !!s.stdin && textHasPrompt(s.stdin)) ||
      (s.verb === "agent" && !!s.prompt && textHasPrompt(s.prompt)) ||
      (s.verb === "herdr" && paramsHavePrompt(s.params)),
  );
}

export function flatNeedsSession(steps: FlatStep[]): boolean {
  return steps.some((s) => s.verb === "shell" && !!s.stdin && textHasSession(s.stdin));
}

/** True when any agent step binds to the invoking pane's agent. */
export function flatNeedsInvokingAgent(steps: FlatStep[]): boolean {
  return steps.some((s) => s.verb === "agent" && s.name === "{agent}");
}

export function checkAgents(file: string, steps: FlatStep[], agents: Set<string>): void {
  steps.forEach((step, idx) => {
    if (step.verb !== "agent") return;
    if (step.name === "{agent}") return;
    if (AGENT_INPUT_RE.test(step.name)) return; // validated against declared inputs in checkInputRefs
    if (!agents.has(step.name)) {
      throw new WorkflowLoadError(
        positioned(file, idx + 1, "agent", `unknown agent '${step.name}'`),
      );
    }
  });
}
