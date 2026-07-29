#!/usr/bin/env bun
/**
 * One-time baseline: create annotated tag v0.1.0 on HEAD when absent.
 * Run on main (or the commit that should be the first published baseline) before
 * enabling automated semantic-release analysis of later conventional commits.
 * Does not push — review then `git push origin v0.1.0`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function git(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const manifest = readFileSync(join(import.meta.dir, "..", "herdr-plugin.toml"), "utf8");
const version = /^version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
if (version !== "0.1.0") {
  console.error(`expected herdr-plugin.toml version 0.1.0, found ${version}`);
  process.exit(1);
}

const existing = git(["tag", "-l", "v0.1.0"]);
if (existing.stdout.trim() === "v0.1.0") {
  console.log("v0.1.0 already exists — baseline established");
  process.exit(0);
}

const created = git([
  "tag",
  "-a",
  "v0.1.0",
  "-m",
  "chore(release): 0.1.0 baseline for semantic-release",
]);
if (created.status !== 0) {
  console.error(created.stderr || created.stdout);
  process.exit(created.status);
}
console.log("created annotated tag v0.1.0 on HEAD (not pushed)");
console.log("review, then: git push origin v0.1.0");
