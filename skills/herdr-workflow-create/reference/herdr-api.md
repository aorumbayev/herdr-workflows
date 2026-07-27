# herdr methods available to workflows

## Contents

- How primitives are spelled
- Allowed methods and their params
- Denied methods
- Capturing results with `out:`

Pinned protocol 17, herdr ≥ 0.7.5. A protocol mismatch aborts at startup naming both
numbers.

## How primitives are spelled

The dotted method name **is** the step key; its value is the params object. There is no
`herdr:` + `params:` wrapper.

```yaml
- pane.split: { direction: right, ratio: 0.4, focus: true }
- notification.show: { title: "done", body: "{error}", sound: done }
- tab.close: { tab_id: "{source_tab}" }
- ping: # no params
```

Params are validated at load: unknown key, wrong type, missing required, or bad enum
value all fail before anything runs. Placeholders may appear inside string values.
`pane_id`, `tab_id`, and `workspace_id` are filled in from the invoking context when the
method accepts them and the step omits them — so `pane.split: { direction: right }`
splits the pane the workflow was launched from.

### Methods that take two context ids

Three methods accept more than one of those three ids and treat them as _mutually
exclusive_. Auto-fill supplies every one you leave out, so these fail at run time however
few you set — the loader passes them, and the error only appears on a live run.

| Method                   | Accepts              | Error when both arrive                        |
| ------------------------ | -------------------- | --------------------------------------------- |
| `layout.apply`           | tab_id, workspace_id | `use either tab_id or workspace_id, not both` |
| `layout.export`          | pane_id, tab_id      | `layout target not found`                     |
| `layout.set_split_ratio` | pane_id, tab_id      | `layout target not found`                     |

Pin the one you do not want to `null`. Both ids are nullable in the schema, auto-fill only
fires on a _missing_ key, and herdr reads null as absent:

```yaml
- layout.apply: { tab_id: "{sometab}", workspace_id: null, root: … } # replace that tab
- layout.apply: { tab_id: null, workspace_id: "{ws}", root: … } # new tab in that workspace
- layout.export: { pane_id: null } # the invoking tab's layout
```

Omitting both is not a way out: `layout.export: {}` gets both filled in and fails.

`in:`, `cwd:`, `env:`, `ratio:`, `prompt:`, `shell:` are **not** allowed on a primitive
step; put the equivalent in the params.

## Allowed methods

`req` = required params. Enum values are listed inline.

### agent

| Method             | req                 | optional                                                                                |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------- |
| `agent.list`       | —                   | —                                                                                       |
| `agent.get`        | target              | —                                                                                       |
| `agent.explain`    | target              | —                                                                                       |
| `agent.focus`      | target              | —                                                                                       |
| `agent.prompt`     | target, text        | wait (object)                                                                           |
| `agent.read`       | target, source      | source: visible/recent/recent_unwrapped/detection; format: text/ansi; lines; strip_ansi |
| `agent.rename`     | target              | name                                                                                    |
| `agent.send_keys`  | target, keys[]      | —                                                                                       |
| `agent.start`      | name, kind, pane_id | args[], timeout_ms                                                                      |
| `agent.wait`       | target              | until[], timeout_ms                                                                     |
| `agent.view.set`   | source              | filter, label, sort[]                                                                   |
| `agent.view.clear` | —                   | source                                                                                  |

### pane

| Method                 | req                           | optional                                                           |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `pane.split`           | direction: right/down         | ratio, cwd, env, focus, target_pane_id, workspace_id               |
| `pane.close`           | pane_id                       | —                                                                  |
| `pane.focus`           | pane_id                       | —                                                                  |
| `pane.focus_direction` | direction: left/right/up/down | pane_id                                                            |
| `pane.get`             | pane_id                       | —                                                                  |
| `pane.current`         | —                             | caller_pane_id                                                     |
| `pane.list`            | —                             | workspace_id                                                       |
| `pane.layout`          | —                             | pane_id                                                            |
| `pane.edges`           | —                             | pane_id                                                            |
| `pane.neighbor`        | direction                     | pane_id                                                            |
| `pane.move`            | pane_id, destination          | focus                                                              |
| `pane.swap`            | —                             | direction, pane_id, source_pane_id, target_pane_id                 |
| `pane.resize`          | direction                     | amount, pane_id                                                    |
| `pane.zoom`            | —                             | mode: toggle/on/off, pane_id                                       |
| `pane.rename`          | pane_id                       | label                                                              |
| `pane.read`            | pane_id, source               | format, lines, strip_ansi                                          |
| `pane.send_text`       | pane_id, text                 | —                                                                  |
| `pane.send_keys`       | pane_id, keys[]               | —                                                                  |
| `pane.send_input`      | pane_id                       | text, keys[]                                                       |
| `pane.wait_for_output` | pane_id, source, match        | lines, strip_ansi, timeout_ms                                      |
| `pane.process_info`    | —                             | pane_id                                                            |
| `pane.report_metadata` | pane_id, source               | title, agent, display_agent, state_labels, tokens, ttl_ms, clear_* |

### tab / workspace / worktree / layout / misc

| Method                      | req                          | optional                                                                              |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `tab.create`                | —                            | label, cwd, env, focus, workspace_id                                                  |
| `tab.close`                 | tab_id                       | —                                                                                     |
| `tab.focus` / `tab.get`     | tab_id                       | —                                                                                     |
| `tab.list`                  | —                            | workspace_id                                                                          |
| `tab.move`                  | tab_id, insert_index         | —                                                                                     |
| `tab.rename`                | tab_id, label                | —                                                                                     |
| `workspace.create`          | —                            | label, cwd, env, focus                                                                |
| `workspace.close`           | workspace_id                 | —                                                                                     |
| `workspace.focus` / `.get`  | workspace_id                 | —                                                                                     |
| `workspace.list`            | —                            | —                                                                                     |
| `workspace.move`            | workspace_id, insert_index   | —                                                                                     |
| `workspace.rename`          | workspace_id, label          | —                                                                                     |
| `workspace.report_metadata` | workspace_id, source, tokens | seq, ttl_ms                                                                           |
| `worktree.create`           | —                            | branch, base, path, label, cwd, focus, workspace_id                                   |
| `worktree.open`             | —                            | branch, path, label, cwd, focus, workspace_id                                         |
| `worktree.list`             | —                            | cwd, workspace_id                                                                     |
| `worktree.remove`           | workspace_id                 | force                                                                                 |
| `layout.apply`              | root                         | focus, tab_id, tab_label, workspace_id                                                |
| `layout.export`             | —                            | pane_id, tab_id                                                                       |
| `layout.set_split_ratio`    | path[], ratio                | pane_id, tab_id                                                                       |
| `notification.show`         | title                        | body, sound: none/done/request, position: top-left/top-right/bottom-left/bottom-right |
| `client.window_title.set`   | title                        | —                                                                                     |
| `client.window_title.clear` | —                            | —                                                                                     |
| `ping`                      | —                            | —                                                                                     |

## Denied methods

Using one is a load error quoting the reason.

| Method(s)                                                                                                | Reason                                         |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `server.stop`                                                                                            | would stop the server running the workflow     |
| `server.reload_config`, `server.reload_agent_manifests`, `server.agent_manifests`, `server.live_handoff` | server control is not available to workflows   |
| `plugin.*` (link, unlink, enable, disable, list, log.list, action._, pane._)                             | plugin lifecycle is not available to workflows |
| `events.subscribe`                                                                                       | no terminating step semantics                  |
| `events.wait`                                                                                            | outside the workflow allowlist                 |
| `integration.install`, `integration.uninstall`                                                           | outside the workflow allowlist                 |
| `session.snapshot`                                                                                       | use targeted `*.list` / `*.get` instead        |
| `popup.close`                                                                                            | belongs to the picker's own lifecycle          |
| `pane.graphics.set/clear/info`                                                                           | experimental and feature-gated                 |
| `pane.report_agent`, `pane.report_agent_session`, `pane.clear_agent_authority`, `pane.release_agent`     | would corrupt herdr's own agent detection      |

## Capturing results with `out:`

Primitives require map form: `out: { <name>: <dot.path> }`. The path is checked at load
against herdr's whole result union, and again against the actual result at run time — a
path that exists in some other method's result still fails at run time with
`out.<name>: path '<p>' missing on result.type '<t>'`. Stick to paths the method really
returns.

Reliable pairings:

| Step                                 | Path                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| `worktree.create` / `worktree.open`  | `worktree.path`, `worktree.branch`, `worktree.open_workspace_id`     |
| `workspace.create`                   | `workspace.workspace_id`, `workspace.label`                          |
| `tab.create`                         | `tab.tab_id`, `tab.workspace_id`                                     |
| `pane.split`                         | `pane.pane_id`, `pane.tab_id`, `pane.workspace_id`                   |
| `pane.read` / `agent.read`           | `read.text`                                                          |
| placed `run:` (`in: tab/right/down`) | `pane_id`, `workspace_id`, `layout.tab_id`, `layout.focused_pane_id` |

Non-string values are JSON-encoded into the binding.
