import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { writeHostExecutableSync } from "./host-executable";

const root = mkdtempSync(join(tmpdir(), "hwf-test-env-"));
const bin = join(root, "bin");
mkdirSync(bin);

const deniedSh = "echo 'real herdr executables are disabled during tests' >&2\nexit 97\n";

let herdrBin = "";
for (const name of ["herdr", "hwf", "herdr-workflows"]) {
  const path = writeHostExecutableSync(join(bin, name), deniedSh);
  if (name === "herdr") herdrBin = path;
}

for (const name of [
  "HERDR_CLIENT_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_PLUGIN_CONTEXT_JSON",
  "HERDR_PLUGIN_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "HERDR_WORKFLOWS_REPO_ROOT",
  "HERDR_WORKSPACE_ID",
]) {
  delete process.env[name];
}

process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.HERDR_BIN_PATH = herdrBin;
process.env.HERDR_CONFIG_PATH = join(root, "config", "herdr", "config.toml");
process.env.HERDR_PLUGIN_CONFIG_DIR = join(root, "plugin-config");
process.env.HERDR_PLUGIN_STATE_DIR = join(root, "plugin-state");
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
