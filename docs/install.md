# Install

Get the plugin onto your machine, then tell it which agents you have.

## Requirements

| You need                   | Version        |
| -------------------------- | -------------- |
| [herdr](https://herdr.dev) | 0.7.5 or later |
| [Bun](https://bun.sh)      | 1.3 or later   |
| Linux or macOS             | Any            |

On Windows, install herdr **and** this plugin inside WSL2. A native Windows herdr can't talk to `hwf` running in WSL, because they're separate servers with separate sockets.

## Install the plugin

```bash
herdr plugin install aorumbayev/herdr-workflows
```

herdr builds the plugin from source on your machine: it checks your Bun version, runs `bun install --production --frozen-lockfile`, compiles a binary with `bun build --compile`, then runs setup. If Bun is missing or too old, the build stops and tells you the minimum version.

There are no prebuilt binaries and no npm package. Releases are GitHub Releases: a tag and notes, nothing to download.

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

`hwf update` compares your installed version against the latest published GitHub Release, ignoring drafts. If a newer one exists, it reinstalls through herdr. If you're already current, it says so and changes nothing.

The picker also tells you: when a newer release exists, list mode shows a `run hwf update` hint in the filter row. The hint never blocks you, and a failed check shows nothing at all.

Cases where `hwf update` won't run:

- **Your install predates the command.** Run `herdr plugin install aorumbayev/herdr-workflows` once more to get it. After that, `hwf update` works.
- **You linked a development checkout.** Use `bun run install:dev`, which compiles your working tree and relinks it.
- **Your binary is unregistered or directly copied.** Install it through herdr with `herdr plugin install aorumbayev/herdr-workflows`.

## Tell it about your agents

```bash
cd your-repo
hwf init            # for this repo, shared with your team
hwf init --global   # for you, on this machine
```

Both commands look for `claude`, `codex`, `cursor`, and `opencode` on your `PATH`. Each one found becomes a profile with the same name. The first name alphabetically becomes `default_profile`.

`hwf init` also creates `.hwf/workflows/` and writes a `.hwf/.gitignore` covering `config.local.yaml` and `tmp/`. Running it again asks before it overwrites, or use `--force` to skip the question. Existing `transcripts:` entries survive an overwrite.

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

`hwf init` only probes four binaries, because those four are named after their kind. herdr starts more than that. Add the rest by hand:

```yaml
profiles:
  gem:
    kind: gemini
  review:
    kind: codex
    args: ["--full-auto"]
```

As of herdr 0.7.5 the kinds are `pi`, `claude`, `codex`, `gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`, `copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`, and `maki`. herdr owns that list and a newer herdr may accept more, so check your version's docs rather than this page. A kind herdr doesn't accept fails when the step tries to start it, and nothing else launches in its place.

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
