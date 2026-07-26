import type { FlatStep } from "./types";
import {
  paramsHavePrompt,
  paramsHaveSession,
  paramsPlaceholders,
  textHasPrompt,
  textHasSession,
  textPlaceholders,
} from "./substitute";

export function stepReferencedNames(step: FlatStep): string[] {
  const names: string[] = [];
  const addText = (text: string | undefined) => {
    if (text) names.push(...textPlaceholders(text));
  };
  const a = step.action;
  if (a.kind === "run") {
    if (a.payload.form === "argv") for (const el of a.payload.argv) addText(el);
    if (a.cwd) addText(a.cwd);
    if (a.env) for (const v of Object.values(a.env)) addText(v);
  } else if (a.kind === "agent") {
    addText(a.agent);
    addText(a.prompt);
    if (a.cwd) addText(a.cwd);
    if (a.env) for (const v of Object.values(a.env)) addText(v);
  } else if (a.kind === "primitive") {
    names.push(...paramsPlaceholders(a.params));
  } else if (a.kind === "include") {
    for (const v of Object.values(a.with)) addText(v);
  }
  if (step.when?.kind === "nonempty") names.push(step.when.name);
  if (step.when?.kind === "argv") for (const el of step.when.argv) addText(el);
  if (step.for?.kind === "binding") names.push(step.for.name);
  if (step.retry?.until?.kind === "nonempty") names.push(step.retry.until.name);
  if (step.retry?.until?.kind === "argv") for (const el of step.retry.until.argv) addText(el);
  return names;
}

export function flatNeedsPrompt(steps: FlatStep[]): boolean {
  return steps.some((s) => {
    if (s.action.kind === "agent" && s.action.prompt && textHasPrompt(s.action.prompt)) return true;
    if (s.action.kind === "primitive" && paramsHavePrompt(s.action.params)) return true;
    if (s.action.kind === "run" && s.action.payload.form === "argv") {
      return s.action.payload.argv.some(textHasPrompt);
    }
    if (s.action.kind === "include") return flatNeedsPrompt(s.action.steps);
    return stepReferencedNames(s).includes("prompt");
  });
}

export function flatNeedsSession(steps: FlatStep[]): boolean {
  return steps.some((s) => {
    if (s.action.kind === "agent" && s.action.prompt && textHasSession(s.action.prompt))
      return true;
    if (s.action.kind === "primitive" && paramsHaveSession(s.action.params)) return true;
    if (s.action.kind === "run" && s.action.payload.form === "argv") {
      return s.action.payload.argv.some(textHasSession);
    }
    if (s.action.kind === "include") return flatNeedsSession(s.action.steps);
    return false;
  });
}

export function flatNeedsInvokingAgent(steps: FlatStep[]): boolean {
  return steps.some((s) => {
    if (s.action.kind === "agent" && s.action.agent === "{agent}") return true;
    if (s.action.kind === "include") return flatNeedsInvokingAgent(s.action.steps);
    return stepReferencedNames(s).includes("agent");
  });
}
