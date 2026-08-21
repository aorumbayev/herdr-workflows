# Install

Get the plugin onto your machine, then tell it which agents you have.

## Requirements

| You need                   | Version        |
| -------------------------- | -------------- |
| [herdr](https://herdr.dev) | 0.8.2 or later |
| Linux or macOS             | Any            |

On Windows, install herdr **and** this plugin inside WSL2. WSL2 uses the Linux release archive. A native Windows herdr can't talk to `hwf` running in WSL, because they're separate servers with separate sockets. Native Windows installs are refused.

### WSL2 smoke

Repeatable check that a Windows host uses the Linux archive inside WSL2, not a native Windows build.

1. Open a WSL2 shell (Ubuntu or another Linux distro).
2. Install herdr for Linux inside that shell, then install the plugin:

```bash
herdr plugin install aorumbayev/herdr-workflows
```

3. Confirm the shell reports Linux (`uname -s` prints `Linux`). The release archive is then `linux_amd64` or `linux_arm64` from `uname -m`.
4. Confirm the plugin binary:

```bash
hwf --version
```

5. Confirm native Windows platforms are refused. A native Windows install path errors and does not use a Windows archive. Do not install a second herdr in your live control workspace for this check.

## Install the plugin

```bash
herdr plugin install aorumbayev/herdr-workflows
```

herdr clones the release tag and runs the manifest build: it downloads the verified archive for that tag's version, checks the SHA-256 entry in `checksums.txt`, extracts `bin/herdr-workflows`, then runs setup. The target host does not need Go. A checksum mismatch or download failure stops the build and leaves any prior install in place.

There is no npm package. Releases publish GitHub Release notes plus platform archives for Linux and macOS (`amd64` and `arm64`).

Setup then links two commands, `hwf` and `herdr-workflows`, into `~/.local/bin` (or `$XDG_BIN_HOME`), and adds the `prefix+k` keybinding to your herdr config. Both steps are optional. If one is skipped, setup prints why and carries on. If setup says your bin directory isn't on `PATH`, add it.

Check the result:

```bash
hwf --version
herdr config check
```

## Update

```bash
hwf update
```

`hwf update` compares your installed version against the latest published GitHub Release, ignoring drafts. If a newer one exists, a Herdr-managed install reinstalls through herdr, and a standalone or copied binary downloads the matching archive, verifies it, and replaces itself. If you're already current, it says so and changes nothing.

The picker also tells you: when a newer release exists, list mode shows a `run hwf update` hint in the filter row. The hint never blocks you, and a failed check shows nothing at all.

Cases where `hwf update` won't run:

- **Your install predates the command.** Run `herdr plugin install aorumbayev/herdr-workflows` once more to get it. After that, `hwf update` works.
- **You linked a development checkout.** Use `go run ./scripts/install-dev`, which compiles your working tree and relinks it.
- **Download or checksum verification fails.** The prior binary stays in place and the command exits nonzero.

## Tell it about your agents

```bash
cd your-repo
hwf init            # for this repo, shared with your team
hwf init --global   # for you, on this machine
```

Both commands look for `claude`, `codex`, `cursor`, `opencode`, `grok`, and `agy` on your `PATH`. Each one found becomes a profile with the same name. The first name alphabetically becomes `default_profile`.

Without `--global`, `hwf init` also creates `.hwf/workflows/` and writes a `.hwf/.gitignore` covering `config.local.yaml` and `tmp/`. Running either form again asks before it overwrites, or use `--force` to skip the question. Existing `transcripts:` entries survive an overwrite.

Use the repo form when your team shares profiles in git. Use `--global` when you keep your workflows in `~/.hwf/workflows` and don't want to touch the repo.

## Profiles

A profile is a nickname for one way of starting an agent. Your workflow says `using: deep-review`, and the profile says what that launches.

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

A profile has two fields, and never anything else:

- **`kind`** is which agent herdr starts. A kind name, not a path and not a command line.
- **`args`** are its startup flags. This is how one kind gives you several roles, like `deep-review` above.

How a step ends up with one:

1. `using:` names a profile. Templates work here, so `using: "{{inputs.target}}"` lets whoever runs it pick.
2. No `using:`, and the step falls back to `default_profile`.
3. Neither exists, and the run stops before step 1.

A `using:` name that isn't in your config fails when the file loads. A name that arrives through a template can only be checked when the step runs.

`target:` is the alternative, and it ignores profiles completely: it prompts an agent that's already running, by name or pane ID.

`hwf init` writes one profile per kind it found on your `PATH`. Role names and `args` are yours to add.

### Kinds herdr supports

`hwf init` probes six binaries — `claude`, `codex`, `cursor`, `opencode`, `grok`, and `agy` — the kinds whose executable name is known to the plugin. herdr starts more than that. Add the rest by hand:

```yaml
profiles:
  gem:
    kind: gemini
  review:
    kind: codex
    args: ["--full-auto"]
```

As of herdr 0.8.2 the kinds are `pi`, `claude`, `codex`, `gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`, `copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`, `qwen`, and `maki`. herdr owns that list and a newer herdr may accept more, so check your version's docs rather than this page. A kind herdr doesn't accept fails when the step tries to start it, and nothing else launches in its place.

### Agents herdr doesn't support

An `agent:` step can't reach them. herdr identifies agents by their process and their screen, and both live inside the herdr binary, so a brand-new harness needs a herdr release. No config file adds one.

What still works is treating it as a plain command:

```yaml
- run: [my-agent, --prompt, "{{inputs.task}}"]
```

You get its output and exit code. You don't get a turn: no waiting for it to go idle, no `response` to pass along, no notification when it asks you something. Good enough for a tool that answers and exits. Not enough for a live conversation.

## Where config comes from

Three files merge, in this order:

1. Global plugin config, at `$HERDR_PLUGIN_CONFIG_DIR/config.yaml`. Find the directory with `herdr plugin config-dir herdr-workflows`.
2. `.hwf/config.yaml`, committed and shared.
3. `.hwf/config.local.yaml`, gitignored and yours alone.

A later layer replaces a whole named entry, never part of one. So `config.local.yaml` can repoint `deep-review` at Codex on your laptop while the team keeps Claude, but it can't change only that profile's `args`.

Config accepts three keys: `profiles`, `default_profile`, and `transcripts`. Nothing else. See [Reference](/reference#config).

You can also edit both files in the browser. Run `hwf web` and open the **Config** tab, which validates the YAML before it saves.

## Next

- [Write a workflow](/guide)
- [Import a ready-made one](/examples)
