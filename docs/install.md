# Install

Install the plugin, then tell it which agents you have.

## Requirements

| You need                   | Version        |
| -------------------------- | -------------- |
| [herdr](https://herdr.dev) | 0.8.2 or later |
| Linux or macOS             | Any            |

On Windows, install herdr and this plugin inside WSL2. The plugin refuses a native Windows install.

## Install the plugin

```bash
herdr plugin install aorumbayev/herdr-workflows
```

herdr downloads a checksum-verified release binary. You do not need Go. If the download or the check fails, a prior install stays in place.

Setup links `hwf` and `herdr-workflows` into `~/.local/bin` (or `$XDG_BIN_HOME`), and adds the `prefix+k` keybinding to your herdr config. If setup skips one of these, it prints why. If your bin directory is not on `PATH`, add it.

Check the result:

```bash
hwf --version
herdr config check
```

## Update

```bash
hwf update
```

`hwf update` installs the latest release. If you are current, it changes nothing. If the download or the check fails, the prior binary stays. When a newer release exists, the picker shows a `run hwf update` hint in the filter row.

`hwf update` does not run when:

- Your install predates the command. Run `herdr plugin install aorumbayev/herdr-workflows` once more.
- You linked a development checkout. Use `go run ./scripts/install-dev`.

## Configure agents

```bash
cd your-repo
hwf init            # for this repo, shared with your team
hwf init --global   # for you, on this machine
```

Both commands search your `PATH` for `claude`, `codex`, `cursor`, `opencode`, `grok`, and `agy`. Each one found becomes a profile with the same name. The first name in alphabetical order becomes `default_profile`.

Without `--global`, `hwf init` also creates `.hwf/workflows/` and a `.hwf/.gitignore` for `config.local.yaml` and `tmp/`. A second run prompts before it overwrites. `--force` skips the prompt. `transcripts:` entries survive an overwrite.

## Profiles

A profile is a name for one way to start an agent. Your workflow says `using: deep-review`, and the profile says what that launches.

```yaml
# .hwf/config.yaml
profiles:
  claude:
    kind: claude
  deep-review:
    kind: claude
    args: ["--model", "opus"]
default_profile: claude
```

`kind` is the agent that herdr starts. `args` are its startup flags, so one kind can give you several roles. A step gets a profile from `using:`, or from `default_profile`. With neither, the run stops before step 1. [Config](/reference#config) gives the rules.

herdr owns the list of kinds, so check the docs of your herdr version. Add any kind that it accepts by hand, for example `kind: gemini`. An agent that herdr does not support cannot be an `agent:` step. Run it as a plain command instead: `run: [my-agent, --prompt, "{{inputs.task}}"]`. You get the output and the exit code, but no turn and no `response`.

## Config layers

Three files merge, in this order:

1. Global plugin config, at `$HERDR_PLUGIN_CONFIG_DIR/config.yaml`. Find the directory with `herdr plugin config-dir herdr-workflows`.
2. `.hwf/config.yaml`, committed and shared.
3. `.hwf/config.local.yaml`, gitignored and yours alone.

A later layer replaces a whole named entry, never a part of one. So `config.local.yaml` can point `deep-review` at Codex on your laptop, and the team keeps Claude. Config accepts `profiles`, `default_profile`, and `transcripts` only.

## Next

- [Write a workflow](/guide)
- [Import a ready-made one](/examples)
