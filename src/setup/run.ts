import { installCliCommands } from "./cli-install";
import { installKeybindings } from "./keybindings";
import {
  binDirOnPath,
  isEphemeralPluginRoot,
  resolveBinDir,
  resolveManagedBinary,
  resolvePluginRoot,
} from "./paths";

/** Nonfatal host setup: PATH commands + picker keybinding. Never throws to callers. */
export function runSetup(): void {
  const log = (line: string) => process.stdout.write(`${line}\n`);

  try {
    const env = process.env;
    const binDir = resolveBinDir(env);

    const pluginRoot = resolvePluginRoot(env);
    const binary = resolveManagedBinary(pluginRoot);
    if (!binary) {
      log(`skipped cli install: managed binary not found under ${pluginRoot} (run build first)`);
    } else {
      const cli = installCliCommands({
        binDir,
        binary,
        ephemeral: isEphemeralPluginRoot(pluginRoot),
      });
      for (const line of cli.messages) log(line);
    }

    if (!binDirOnPath(binDir, env)) {
      log(`warning: ${binDir} is not on PATH — add it to your shell profile`);
    }

    const keys = installKeybindings({ env });
    for (const line of keys.messages) log(line);
  } catch (error) {
    log(`skipped setup: ${error instanceof Error ? error.message : error}`);
  }
}
