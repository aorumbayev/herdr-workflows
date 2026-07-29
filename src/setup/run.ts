import { installCliCommands } from "./cli-install";
import { installKeybindings } from "./keybindings";
import {
  binDirOnPath,
  isEphemeralPluginRoot,
  resolveBinDir,
  resolveManagedBinary,
  resolvePluginRoot,
} from "./paths";

export type SetupResult = {
  messages: string[];
  ok: boolean;
};

/** Nonfatal host setup: PATH commands + picker keybinding. Never throws to callers. */
export function runSetup(opts: {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): SetupResult {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const messages: string[] = [];
  const emit = (line: string) => {
    messages.push(line);
    log(line);
  };

  try {
    const binDir = resolveBinDir(env);

    const pluginRoot = resolvePluginRoot(env);
    const binary = resolveManagedBinary(pluginRoot);
    if (!binary) {
      emit(`skipped cli install: managed binary not found under ${pluginRoot} (run build first)`);
    } else {
      const cli = installCliCommands({
        binDir,
        binary,
        ephemeral: isEphemeralPluginRoot(pluginRoot),
      });
      for (const line of cli.messages) emit(line);
    }

    if (!binDirOnPath(binDir, env)) {
      emit(`warning: ${binDir} is not on PATH — add it to your shell profile`);
    }

    const keys = installKeybindings({ env });
    for (const line of keys.messages) emit(line);
  } catch (error) {
    emit(`skipped setup: ${error instanceof Error ? error.message : error}`);
  }

  return { messages, ok: true };
}
