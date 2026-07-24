//! Ported assertions from `test/runner.test.ts` — every test drives
//! `runner::run_workflow` end to end against a `FakeHerdr` implementing the
//! `runner::Herdr` trait seam (assertions ported, mock shapes not). Shell
//! steps run the real `sh`, as the TS suite does.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use herdr_workflows::config::{AgentsConfig, SessionsConfig};
use herdr_workflows::herdr::cli::{LayoutApplyParams, LayoutApplyResult, PaneReadOpts};
use herdr_workflows::herdr::rpc::HerdrError;
use herdr_workflows::runner::agent_wait::AgentWaitClock;
use herdr_workflows::runner::context::InvocationContext;
use herdr_workflows::runner::deps::StepResult;
use herdr_workflows::runner::runlog::RunLog;
use herdr_workflows::runner::{Herdr, RunOptions, run_workflow};
use serde_json::{Map, Value, json};

// ---------------------------------------------------------------- fixtures

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("hwf-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `repoWith` — `.hwf/workflows/<name>.yaml` per entry.
fn repo_with(files: &[(&str, &str)]) -> TempDir {
    let root = TempDir::new("run");
    let dir = root.path().join(".hwf").join("workflows");
    std::fs::create_dir_all(&dir).expect("workflows dir");
    for (name, body) in files {
        std::fs::write(dir.join(format!("{name}.yaml")), body).expect("write workflow");
    }
    root
}

fn agents(names: &[&str]) -> AgentsConfig {
    names
        .iter()
        .map(|name| {
            (
                (*name).to_string(),
                vec![(*name).to_string(), "{prompt}".to_string()],
            )
        })
        .collect()
}

fn ctx(root: &Path) -> InvocationContext {
    InvocationContext {
        cwd: root.display().to_string(),
        ..InvocationContext::default()
    }
}

type FakeSlot<T> = RefCell<Box<dyn FnMut() -> Result<T, HerdrError>>>;
type WaitSlot = RefCell<Box<dyn FnMut(&str, &str, u64) -> Result<(), HerdrError>>>;
type SessionSlot = RefCell<Box<dyn FnMut(&str) -> Result<String, HerdrError>>>;
type CloseSlot = RefCell<Box<dyn FnMut(&str) -> Result<(), HerdrError>>>;

/// `mockDeps` — recording fake with the same defaults as the TS mock.
struct FakeHerdr {
    notes: RefCell<Vec<String>>,
    calls: RefCell<Vec<(String, Map<String, Value>)>>,
    layouts: RefCell<Vec<LayoutApplyParams>>,
    tokens: RefCell<Vec<Option<String>>>,
    reads: RefCell<Vec<PaneReadOpts>>,
    sessions_seen: RefCell<Vec<(String, SessionsConfig)>>,
    layout_fn: FakeSlot<LayoutApplyResult>,
    status_fn: FakeSlot<String>,
    label_fn: FakeSlot<String>,
    wait_fn: WaitSlot,
    read_fn: FakeSlot<String>,
    token_fn: FakeSlot<()>,
    session_fn: SessionSlot,
    close_fn: CloseSlot,
}

impl Default for FakeHerdr {
    fn default() -> Self {
        Self {
            notes: RefCell::new(Vec::new()),
            calls: RefCell::new(Vec::new()),
            layouts: RefCell::new(Vec::new()),
            tokens: RefCell::new(Vec::new()),
            reads: RefCell::new(Vec::new()),
            sessions_seen: RefCell::new(Vec::new()),
            layout_fn: RefCell::new(Box::new(|| {
                Ok(LayoutApplyResult {
                    tab_id: "t1".to_string(),
                    pane_id: "p1".to_string(),
                    workspace_id: "w1".to_string(),
                })
            })),
            status_fn: RefCell::new(Box::new(|| Ok("idle".to_string()))),
            label_fn: RefCell::new(Box::new(|| Ok("claude".to_string()))),
            wait_fn: RefCell::new(Box::new(|_, _, _| Ok(()))),
            read_fn: RefCell::new(Box::new(|| Ok(String::new()))),
            token_fn: RefCell::new(Box::new(|| Ok(()))),
            session_fn: RefCell::new(Box::new(|_| Ok(String::new()))),
            close_fn: RefCell::new(Box::new(|_| Ok(()))),
        }
    }
}

impl Herdr for FakeHerdr {
    fn layout_apply(&self, params: &LayoutApplyParams) -> Result<LayoutApplyResult, HerdrError> {
        self.layouts.borrow_mut().push(params.clone());
        (self.layout_fn.borrow_mut())()
    }

    fn herdr_call(&self, method: &str, params: Map<String, Value>) -> Result<Value, HerdrError> {
        self.calls.borrow_mut().push((method.to_string(), params));
        Ok(json!({}))
    }

    fn notification_show(&self, title: &str, body: Option<&str>) -> Result<(), HerdrError> {
        self.notes
            .borrow_mut()
            .push(format!("{title}|{}", body.unwrap_or("")));
        Ok(())
    }

    fn agent_status(&self, _pane_id: &str) -> Result<String, HerdrError> {
        (self.status_fn.borrow_mut())()
    }

    fn agent_label(&self, _pane_id: &str) -> Result<String, HerdrError> {
        (self.label_fn.borrow_mut())()
    }

    fn wait_output(&self, pane_id: &str, regex: &str, timeout_ms: u64) -> Result<(), HerdrError> {
        (self.wait_fn.borrow_mut())(pane_id, regex, timeout_ms)
    }

    fn pane_read(&self, _pane_id: &str, opts: PaneReadOpts) -> Result<String, HerdrError> {
        self.reads.borrow_mut().push(opts);
        (self.read_fn.borrow_mut())()
    }

    fn report_token(&self, _pane_id: &str, value: Option<&str>) -> Result<(), HerdrError> {
        self.tokens.borrow_mut().push(value.map(str::to_string));
        (self.token_fn.borrow_mut())()
    }

    fn session_text(&self, pane_id: &str, sessions: &SessionsConfig) -> Result<String, HerdrError> {
        self.sessions_seen
            .borrow_mut()
            .push((pane_id.to_string(), sessions.clone()));
        (self.session_fn.borrow_mut())(pane_id)
    }

    fn tab_close(&self, tab_id: &str) -> Result<(), HerdrError> {
        (self.close_fn.borrow_mut())(tab_id)
    }
}

/// The TS mock's `agentWaitPollMs: 1, agentWaitIdleGraceMs: 5` on a real clock.
fn test_clock() -> AgentWaitClock {
    let start = std::time::Instant::now();
    AgentWaitClock {
        poll: Duration::from_millis(1),
        idle_grace: Duration::from_millis(5),
        sleep: Box::new(|_| {}),
        now: Box::new(move || start.elapsed().as_millis() as u64),
    }
}

/// Fake clock advanced by `sleep`, for the tests TS drove with `now`/`sleep`.
fn fake_clock(poll_ms: u64, grace_ms: u64) -> (AgentWaitClock, Rc<Cell<u64>>) {
    let time = Rc::new(Cell::new(0u64));
    let (t_sleep, t_now) = (Rc::clone(&time), Rc::clone(&time));
    (
        AgentWaitClock {
            poll: Duration::from_millis(poll_ms),
            idle_grace: Duration::from_millis(grace_ms),
            sleep: Box::new(move |d| t_sleep.set(t_sleep.get() + d.as_millis() as u64)),
            now: Box::new(move || t_now.get()),
        },
        time,
    )
}

struct Run<'a> {
    fake: &'a FakeHerdr,
    log: &'a RunLog,
    root: &'a Path,
    name: &'a str,
    agents: AgentsConfig,
    sessions: SessionsConfig,
    ctx: InvocationContext,
    inputs: BTreeMap<String, String>,
    prompt: Option<&'a str>,
    clock: Option<&'a AgentWaitClock>,
    on_progress: Option<herdr_workflows::runner::deps::ProgressCallback<'a>>,
}

impl<'a> Run<'a> {
    fn new(fake: &'a FakeHerdr, log: &'a RunLog, root: &'a Path, name: &'a str) -> Self {
        Self {
            fake,
            log,
            root,
            name,
            agents: AgentsConfig::new(),
            sessions: SessionsConfig::new(),
            ctx: ctx(root),
            inputs: BTreeMap::new(),
            prompt: None,
            clock: None,
            on_progress: None,
        }
    }

    fn go(self) -> StepResult {
        let clock;
        let clock = match self.clock {
            Some(c) => Some(c),
            None => {
                clock = test_clock();
                Some(&clock)
            }
        };
        run_workflow(&RunOptions {
            name: self.name,
            repo_root: self.root,
            agents: &self.agents,
            sessions: &self.sessions,
            ctx: &self.ctx,
            prompt: self.prompt,
            inputs: self.inputs,
            workflow: None,
            herdr: self.fake,
            run_log: self.log,
            wait_clock: clock,
            on_progress: self.on_progress,
            on_stderr: None,
        })
        .expect("workflow loads")
    }
}

fn state_log() -> (TempDir, RunLog) {
    let dir = TempDir::new("state");
    let log = RunLog::new(dir.path().to_path_buf());
    (dir, log)
}

fn inputs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

// ------------------------------------------------------------------- tests

#[test]
fn inputs_substitute_into_stdin_and_choice_input_resolves_agent() {
    let root = repo_with(&[(
        "m",
        "inputs:\n  target:\n    options: [claude, codex]\n  focus: {}\nsteps:\n  - shell: cat\n    stdin: \"focus={input.focus}\"\n  - agent: \"{input.target}\"\n    prompt: \"{last}\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude", "codex"])
        .inputs(inputs(&[("target", "codex"), ("focus", "tests")]))
        .go();
    assert!(result.ok);
    let layouts = fake.layouts.borrow();
    assert_eq!(layouts.len(), 1);
    assert_eq!(layouts[0].label, "codex");
    assert_eq!(layouts[0].command, vec!["codex", "focus=tests"]);
}

#[test]
fn missing_required_input_fails_before_steps() {
    let root = repo_with(&[(
        "m",
        "inputs:\n  focus: {}\nsteps:\n  - shell: cat\n    stdin: \"{input.focus}\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let result = Run::new(&fake, &log, root.path(), "m").go();
    assert!(!result.ok);
    assert!(fake.notes.borrow()[0].contains("missing input 'focus'"));
}

#[test]
fn default_fills_missing_input_and_bad_choice_fails() {
    let root = repo_with(&[(
        "m",
        "inputs:\n  mode:\n    options: [fast, slow]\n    default: fast\nsteps:\n  - shell: cat\n    stdin: \"{input.mode}\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let ok = Run::new(&fake, &log, root.path(), "m").go();
    assert!(ok.ok);

    let bad = Run::new(&fake, &log, root.path(), "m")
        .inputs(inputs(&[("mode", "warp")]))
        .go();
    assert!(!bad.ok);
    assert!(bad.error.expect("error").contains("must be one of"));
}

#[test]
fn unknown_provided_input_fails() {
    let root = repo_with(&[(
        "m",
        "inputs:\n  focus: {}\nsteps:\n  - shell: cat\n    stdin: \"{input.focus}\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let result = Run::new(&fake, &log, root.path(), "m")
        .inputs(inputs(&[("focus", "x"), ("extra", "y")]))
        .go();
    assert!(!result.ok);
    assert!(
        result
            .error
            .expect("error")
            .contains("unknown input 'extra'")
    );
}

#[test]
fn failure_at_step_n_stops_sequence_and_notifies_once() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - shell: \"echo one\"\n  - shell: \"echo two >&2; exit 1\"\n  - shell: \"echo three\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let saw = RefCell::new(Vec::new());
    let result = Run::new(&fake, &log, root.path(), "m")
        .on_progress(&|_i, _n, label| saw.borrow_mut().push(label.to_string()))
        .go();
    assert!(!result.ok);
    assert!(!saw.borrow().iter().any(|s| s.contains("three")));
    let notes = fake.notes.borrow();
    assert_eq!(notes.len(), 1);
    assert!(notes[0].contains("step 2"));
}

#[test]
fn last_threads_between_shell_steps() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - shell: \"printf hi\"\n  - shell: \"cat\"\n    stdin: \"{last}\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let result = Run::new(&fake, &log, root.path(), "m").go();
    assert!(result.ok);
    assert_eq!(result.last, "hi");
}

#[test]
fn recovery_runs_once_and_recovery_failure_notifies_again() {
    let root = repo_with(&[
        (
            "recover",
            "steps:\n  - shell: \"cat\"\n    stdin: \"{error}\"\n  - shell: \"exit 1\"\n",
        ),
        (
            "m",
            "steps:\n  - shell: \"printf kept\"\n  - shell: \"exit 1\"\non_fail: recover\n",
        ),
    ]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let result = Run::new(&fake, &log, root.path(), "m").go();
    assert!(!result.ok);
    let notes = fake.notes.borrow();
    assert_eq!(notes.len(), 2);
    assert!(notes[0].contains("step 2"));
    assert!(notes[1].contains("step 2"));
}

#[test]
fn error_filled_only_in_recovery_and_last_survives() {
    let root = repo_with(&[
        (
            "recover",
            "steps:\n  - shell: \"cat\"\n    stdin: \"L={last} E={error}\"\n",
        ),
        (
            "m",
            "steps:\n  - shell: \"printf kept\"\n  - shell: \"exit 1\"\non_fail: recover\n",
        ),
    ]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let result = Run::new(&fake, &log, root.path(), "m").go();
    assert!(result.ok);
    assert!(result.last.contains("L=kept"));
    assert!(result.last.contains("E=step 2"));
}

#[test]
fn herdr_params_auto_filled_from_context() {
    let root = repo_with(&[("m", "steps:\n  - herdr: tab.close\n")]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    Run::new(&fake, &log, root.path(), "m")
        .ctx(InvocationContext {
            workspace_id: Some("w1".to_string()),
            tab_id: Some("t9".to_string()),
            pane_id: Some("p9".to_string()),
            ..ctx(root.path())
        })
        .go();
    let calls = fake.calls.borrow();
    assert_eq!(calls[0].0, "tab.close");
    let expected = json!({ "tab_id": "t9", "pane_id": "p9", "workspace_id": "w1" });
    assert_eq!(calls[0].1, *expected.as_object().expect("object"));
}

#[test]
fn agent_prompt_passed_as_single_argv_element() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    prompt: \"line1\\n$(rm -rf /)\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .go();
    let layouts = fake.layouts.borrow();
    assert_eq!(layouts[0].command, vec!["claude", "line1\n$(rm -rf /)"]);
}

#[test]
fn agent_wait_completes_on_explicit_done() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    prompt: hi\n    wait: done\n    timeout: 5\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let n = Cell::new(0);
    *fake.status_fn.borrow_mut() = Box::new(move || {
        n.set(n.get() + 1);
        Ok(if n.get() < 2 { "working" } else { "done" }.to_string())
    });
    *fake.read_fn.borrow_mut() = Box::new(|| Ok(" done output \n".to_string()));
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .go();
    assert!(result.ok);
    assert_eq!(result.last, "done output");
}

#[test]
fn agent_wait_completes_on_working_then_idle() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let n = Cell::new(0);
    *fake.status_fn.borrow_mut() = Box::new(move || {
        n.set(n.get() + 1);
        Ok(if n.get() < 2 { "working" } else { "idle" }.to_string())
    });
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .go();
    assert!(result.ok);
}

#[test]
fn agent_wait_completes_on_never_working_idle_grace() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.status_fn.borrow_mut() = Box::new(|| Ok("idle".to_string()));
    let (clock, _) = fake_clock(5, 10);
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .clock(&clock)
        .go();
    assert!(result.ok);
}

#[test]
fn agent_blocked_notifies_once_then_completes() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let i = Cell::new(0);
    *fake.status_fn.borrow_mut() = Box::new(move || {
        let statuses = ["working", "blocked", "blocked", "working", "done"];
        let idx = (i.get() as usize).min(statuses.len() - 1);
        i.set(i.get() + 1);
        Ok(statuses[idx].to_string())
    });
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .go();
    assert!(result.ok);
    let notes = fake.notes.borrow();
    assert_eq!(notes.iter().filter(|n| n.contains("waiting")).count(), 1);
    assert!(notes[0].contains("agent blocked on step 1"));
}

#[test]
fn agent_wait_timeout_fails_and_runs_on_fail() {
    let root = repo_with(&[
        ("recover", "steps:\n  - shell: \"printf recovered\"\n"),
        (
            "m",
            "steps:\n  - agent: claude\n    wait: done\n    timeout: 1\non_fail: recover\n",
        ),
    ]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.status_fn.borrow_mut() = Box::new(|| Ok("working".to_string()));
    let (clock, _) = fake_clock(600, 5);
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .clock(&clock)
        .go();
    assert!(result.ok);
    assert_eq!(result.last, "recovered");
    assert!(fake.notes.borrow().iter().any(|n| n.contains("timed out")));
}

#[test]
fn agent_wait_success_sets_last_for_next_step() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n  - shell: \"cat\"\n    stdin: \"{last}\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.status_fn.borrow_mut() = Box::new(|| Ok("done".to_string()));
    *fake.read_fn.borrow_mut() = Box::new(|| Ok("from-pane".to_string()));
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .go();
    assert!(result.ok);
    assert_eq!(result.last, "from-pane");
}

#[test]
fn wait_for_ok_continues_and_throw_fails_step() {
    let root_ok = repo_with(&[(
        "m",
        "steps:\n  - open: bun run dev\n    wait_for: ready\n    timeout: 5\n  - shell: \"printf next\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let waits = Rc::new(RefCell::new(Vec::new()));
    let w = Rc::clone(&waits);
    *fake.wait_fn.borrow_mut() = Box::new(move |pane, regex, timeout| {
        w.borrow_mut()
            .push((pane.to_string(), regex.to_string(), timeout));
        Ok(())
    });
    let ok = Run::new(&fake, &log, root_ok.path(), "m").go();
    assert!(ok.ok);
    assert_eq!(ok.last, "next");
    assert_eq!(
        *waits.borrow(),
        vec![("p1".to_string(), "ready".to_string(), 5000)]
    );

    let root_bad = repo_with(&[(
        "m",
        "steps:\n  - open: bun run dev\n    wait_for: ready\n    timeout: 5\n",
    )]);
    let fake_bad = FakeHerdr::default();
    *fake_bad.wait_fn.borrow_mut() =
        Box::new(|_, _, _| Err(HerdrError::new("wait_output_failed", "match timeout")));
    let bad = Run::new(&fake_bad, &log, root_bad.path(), "m").go();
    assert!(!bad.ok);
    assert!(fake_bad.notes.borrow()[0].contains("match timeout"));
}

#[test]
fn agent_status_errors_before_detection_tolerated_until_grace() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let (clock, time) = fake_clock(1, 5);
    let n = Rc::new(Cell::new(0));
    let t = Rc::clone(&time);
    let n2 = Rc::clone(&n);
    *fake.status_fn.borrow_mut() = Box::new(move || {
        n2.set(n2.get() + 1);
        t.set(t.get() + 3); // grace 5ms: elapsed 0, 3 tolerated; 6 exceeds
        Err(HerdrError::new(
            "agent_status_failed",
            format!("err{}", n2.get()),
        ))
    });
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .clock(&clock)
        .go();
    assert!(!result.ok);
    assert_eq!(n.get(), 3);
}

#[test]
fn post_detection_three_strikes_fail_and_two_then_success_continues() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n",
    )]);
    let (_state, log) = state_log();

    let fail_fake = FakeHerdr::default();
    let n = Rc::new(Cell::new(0));
    let n2 = Rc::clone(&n);
    *fail_fake.status_fn.borrow_mut() = Box::new(move || {
        n2.set(n2.get() + 1);
        if n2.get() == 1 {
            return Ok("working".to_string());
        }
        Err(HerdrError::new(
            "agent_status_failed",
            format!("err{}", n2.get()),
        ))
    });
    let failed = Run::new(&fail_fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .go();
    assert!(!failed.ok);
    assert_eq!(n.get(), 4);

    let ok_fake = FakeHerdr::default();
    let m = Rc::new(Cell::new(0));
    let m2 = Rc::clone(&m);
    *ok_fake.status_fn.borrow_mut() = Box::new(move || {
        m2.set(m2.get() + 1);
        if m2.get() <= 2 {
            return Err(HerdrError::new(
                "agent_status_failed",
                format!("err{}", m2.get()),
            ));
        }
        Ok("done".to_string())
    });
    let ok = Run::new(&ok_fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .go();
    assert!(ok.ok);
    assert_eq!(m.get(), 3);
}

#[test]
fn runlog_records_step_entries_and_final_with_error() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - shell: \"printf one\"\n  - shell: \"echo boom >&2; exit 1\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let result = Run::new(&fake, &log, root.path(), "m").go();
    assert!(!result.ok);
    let entries = log.read();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].workflow, "m");
    assert_eq!(entries[0].step, Some(1));
    assert_eq!(entries[0].total, Some(2));
    assert_eq!(entries[0].label.as_deref(), Some("shell: printf one"));
    assert!(entries[0].ok);
    assert_eq!(entries[1].step, Some(2));
    assert!(!entries[1].ok);
    assert!(
        entries[1]
            .error
            .as_deref()
            .expect("error")
            .contains("step 2")
    );
    assert_eq!(entries[2].workflow, "m");
    assert!(!entries[2].ok);
    assert_eq!(entries[2].step, None);
    assert!(
        entries[2]
            .error
            .as_deref()
            .expect("error")
            .contains("step 2")
    );
    let run_ids: std::collections::HashSet<&str> = entries.iter().map(|e| e.run.as_str()).collect();
    assert_eq!(run_ids.len(), 1);
    assert_eq!(run_ids.into_iter().next().expect("run id").len(), 8);
}

#[test]
fn token_progress_then_clear_when_pane_set_and_skipped_without() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - shell: \"printf a\"\n  - shell: \"printf b\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    Run::new(&fake, &log, root.path(), "m")
        .ctx(InvocationContext {
            pane_id: Some("p9".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert_eq!(
        *fake.tokens.borrow(),
        vec![Some("m 1/2".to_string()), Some("m 2/2".to_string()), None]
    );

    let no_pane = FakeHerdr::default();
    Run::new(&no_pane, &log, root.path(), "m").go();
    assert!(no_pane.tokens.borrow().is_empty());
}

#[test]
fn token_rejection_does_not_fail_run() {
    let root = repo_with(&[("m", "steps:\n  - shell: \"printf ok\"\n")]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.token_fn.borrow_mut() = Box::new(|| Err(HerdrError::new("report_token_failed", "boom")));
    let result = Run::new(&fake, &log, root.path(), "m")
        .ctx(InvocationContext {
            pane_id: Some("p9".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert!(result.ok);
}

#[test]
fn on_fail_recovery_logged_under_same_run_and_token_cleared_once() {
    let root = repo_with(&[
        ("recover", "steps:\n  - shell: \"printf recovered\"\n"),
        ("m", "steps:\n  - shell: \"exit 1\"\non_fail: recover\n"),
    ]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let result = Run::new(&fake, &log, root.path(), "m")
        .ctx(InvocationContext {
            pane_id: Some("p9".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert!(result.ok);
    let entries = log.read();
    let workflows: Vec<&str> = entries.iter().map(|e| e.workflow.as_str()).collect();
    assert_eq!(workflows, vec!["m", "recover", "m"]);
    assert!(entries.iter().all(|e| e.run == entries[0].run));
    assert_eq!(entries[0].step, Some(1));
    assert!(!entries[0].ok);
    assert_eq!(entries[1].workflow, "recover");
    assert_eq!(entries[1].step, Some(1));
    assert!(entries[1].ok);
    assert_eq!(entries[2].step, None);
    assert!(entries[2].ok);
    let tokens = fake.tokens.borrow();
    assert_eq!(tokens.iter().filter(|t| t.is_none()).count(), 1);
    assert_eq!(tokens.last().expect("last token"), &None);
}

#[test]
fn needs_session_without_pane_fails_and_on_fail_not_run() {
    let root = repo_with(&[
        ("recover", "steps:\n  - shell: \"printf recovered\"\n"),
        (
            "m",
            "steps:\n  - shell: cat\n    stdin: \"{session}\"\non_fail: recover\n",
        ),
    ]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let result = Run::new(&fake, &log, root.path(), "m").go();
    assert!(!result.ok);
    assert!(
        result
            .error
            .expect("error")
            .contains("session handoff must be launched from an agent pane")
    );
    assert_eq!(fake.notes.borrow().len(), 1);
    let entries = log.read();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].workflow, "m");
}

#[test]
fn needs_session_calls_session_text_and_substitutes_into_stdin() {
    let root = repo_with(&[("m", "steps:\n  - shell: cat\n    stdin: \"{session}\"\n")]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.session_fn.borrow_mut() = Box::new(|_| Ok("user:\nhello session".to_string()));
    let result = Run::new(&fake, &log, root.path(), "m")
        .ctx(InvocationContext {
            pane_id: Some("pane-42".to_string()),
            ..ctx(root.path())
        })
        .go();
    let seen = fake.sessions_seen.borrow();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "pane-42");
    assert!(result.ok);
    assert_eq!(result.last, "user:\nhello session");
}

#[test]
fn session_file_yields_temp_path_readable_during_run_and_removed_after() {
    let transcript = "user:\nHERDR_EOF\n'quote\" $(reject) `tick`\nlast line";
    let root = repo_with(&[(
        "m",
        "steps:\n  - shell: sh -s\n    stdin: |\n      P='{session_file}'\n      printf %s \"$P\" > path.txt\n      cat \"$P\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.session_fn.borrow_mut() = Box::new(move |_| Ok(transcript.to_string()));
    let result = Run::new(&fake, &log, root.path(), "m")
        .ctx(InvocationContext {
            pane_id: Some("pane-42".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert!(result.ok);
    assert_eq!(result.last, transcript);
    let path = std::fs::read_to_string(root.path().join("path.txt")).expect("path.txt");
    assert!(path.contains("hwf-session-"));
    assert!(!Path::new(&path).exists(), "session file removed after run");
}

#[test]
fn run_workflow_passes_sessions_to_session_text() {
    let root = repo_with(&[("m", "steps:\n  - shell: cat\n    stdin: \"{session}\"\n")]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.session_fn.borrow_mut() = Box::new(|_| Ok("from sessions".to_string()));
    let sessions: SessionsConfig = [(
        "codex".to_string(),
        vec!["echo".to_string(), "hi".to_string()],
    )]
    .into_iter()
    .collect();
    let result = Run::new(&fake, &log, root.path(), "m")
        .sessions(sessions.clone())
        .ctx(InvocationContext {
            pane_id: Some("p1".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert_eq!(fake.sessions_seen.borrow()[0].1, sessions);
    assert!(result.ok);
    assert_eq!(result.last, "from sessions");
}

#[test]
fn session_text_throw_runs_on_fail_with_error_filled() {
    let root = repo_with(&[
        (
            "recover",
            "steps:\n  - shell: cat\n    stdin: \"E={error}\"\n",
        ),
        (
            "m",
            "steps:\n  - shell: cat\n    stdin: \"{session}\"\non_fail: recover\n",
        ),
    ]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.session_fn.borrow_mut() = Box::new(|_| {
        Err(HerdrError::new(
            "session_file_missing",
            "session file not found: /tmp/x.jsonl",
        ))
    });
    let result = Run::new(&fake, &log, root.path(), "m")
        .ctx(InvocationContext {
            pane_id: Some("p1".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert!(result.ok);
    assert!(
        result
            .last
            .contains("E=step 0: session file not found: /tmp/x.jsonl")
    );
    let entries = log.read();
    assert!(entries.iter().any(|e| e.workflow == "recover"));
}

#[test]
fn session_text_throw_without_on_fail_fails_with_its_message() {
    let root = repo_with(&[("m", "steps:\n  - shell: cat\n    stdin: \"{session}\"\n")]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.session_fn.borrow_mut() = Box::new(|_| {
        Err(HerdrError::new(
            "session_file_missing",
            "session file not found: /tmp/x.jsonl",
        ))
    });
    let result = Run::new(&fake, &log, root.path(), "m")
        .ctx(InvocationContext {
            pane_id: Some("p1".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert!(!result.ok);
    assert!(
        result
            .error
            .expect("error")
            .contains("session file not found: /tmp/x.jsonl")
    );
}

#[test]
fn two_agent_opens_track_prev_tab_for_tab_close() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n  - agent: claude\n    prompt: \"{last}\"\n  - herdr: tab.close\n  - herdr: tab.close\n    params:\n      tab_id: \"{prev_tab}\"\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let n = Cell::new(0);
    *fake.layout_fn.borrow_mut() = Box::new(move || {
        n.set(n.get() + 1);
        Ok(LayoutApplyResult {
            tab_id: format!("tab-{}", n.get()),
            pane_id: format!("pane-{}", n.get()),
            workspace_id: "w1".to_string(),
        })
    });
    *fake.status_fn.borrow_mut() = Box::new(|| Ok("done".to_string()));
    *fake.read_fn.borrow_mut() = Box::new(|| Ok("handoff-body".to_string()));
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .ctx(InvocationContext {
            workspace_id: Some("w1".to_string()),
            tab_id: Some("source-tab".to_string()),
            pane_id: Some("src".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert!(result.ok);
    let calls = fake.calls.borrow();
    let closes: Vec<&(String, Map<String, Value>)> =
        calls.iter().filter(|c| c.0 == "tab.close").collect();
    assert_eq!(closes.len(), 2);
    let first = json!({ "tab_id": "source-tab", "pane_id": "src", "workspace_id": "w1" });
    let second = json!({ "tab_id": "tab-1", "pane_id": "src", "workspace_id": "w1" });
    assert_eq!(closes[0].1, *first.as_object().expect("object"));
    assert_eq!(closes[1].1, *second.as_object().expect("object"));
    let reads = fake.reads.borrow();
    assert_eq!(reads[0].lines, Some(100_000));
    assert_eq!(reads[0].source, Some("recent-unwrapped"));
}

#[test]
fn invoking_agent_resolves_from_invoking_pane() {
    let root = repo_with(&[("m", "steps:\n  - agent: \"{agent}\"\n    prompt: go\n")]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.label_fn.borrow_mut() = Box::new(|| Ok("codex".to_string()));
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude", "codex"])
        .ctx(InvocationContext {
            pane_id: Some("p1".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert!(result.ok);
    assert_eq!(fake.layouts.borrow()[0].command, vec!["codex", "go"]);
}

#[test]
fn invoking_agent_fails_when_label_not_in_config() {
    let root = repo_with(&[("m", "steps:\n  - agent: \"{agent}\"\n    prompt: go\n")]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.label_fn.borrow_mut() = Box::new(|| Ok("gemini".to_string()));
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .ctx(InvocationContext {
            pane_id: Some("p1".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert!(!result.ok);
    assert!(result.error.expect("error").contains("gemini"));
}

#[test]
fn shell_steps_export_hwf_input_env_from_resolved_inputs() {
    let root = repo_with(&[(
        "m",
        "inputs:\n  branch: {}\n  base:\n    default: main\nsteps:\n  - shell: 'printf \"%s/%s\" \"$HWF_INPUT_branch\" \"$HWF_INPUT_base\"'\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let result = Run::new(&fake, &log, root.path(), "m")
        .inputs(inputs(&[("branch", "feat/x")]))
        .go();
    assert_eq!(
        result,
        StepResult {
            ok: true,
            error: None,
            last: "feat/x/main".to_string(),
        }
    );
}

#[test]
fn close_source_closes_invoking_tab_after_successful_agent_open() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    prompt: hi\n    close_source: true\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    let closed = Rc::new(RefCell::new(Vec::new()));
    let c = Rc::clone(&closed);
    *fake.close_fn.borrow_mut() = Box::new(move |tab| {
        c.borrow_mut().push(tab.to_string());
        Ok(())
    });
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .ctx(InvocationContext {
            tab_id: Some("src-tab".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert!(result.ok);
    assert_eq!(fake.layouts.borrow().len(), 1);
    assert_eq!(*closed.borrow(), vec!["src-tab".to_string()]);
}

#[test]
fn close_source_skipped_when_agent_open_fails() {
    let root = repo_with(&[(
        "m",
        "steps:\n  - agent: claude\n    prompt: hi\n    close_source: true\n",
    )]);
    let (_state, log) = state_log();
    let fake = FakeHerdr::default();
    *fake.layout_fn.borrow_mut() =
        Box::new(|| Err(HerdrError::new("layout_apply_failed", "layout boom")));
    let closed = Rc::new(RefCell::new(Vec::new()));
    let c = Rc::clone(&closed);
    *fake.close_fn.borrow_mut() = Box::new(move |tab| {
        c.borrow_mut().push(tab.to_string());
        Ok(())
    });
    let result = Run::new(&fake, &log, root.path(), "m")
        .agents_with(&["claude"])
        .ctx(InvocationContext {
            tab_id: Some("src-tab".to_string()),
            ..ctx(root.path())
        })
        .go();
    assert!(!result.ok);
    assert!(closed.borrow().is_empty());
}

// Builder-style helpers on Run, kept out of the literal to keep init terse.
impl<'a> Run<'a> {
    fn agents_with(mut self, names: &[&str]) -> Self {
        self.agents = agents(names);
        self
    }

    fn sessions(mut self, sessions: SessionsConfig) -> Self {
        self.sessions = sessions;
        self
    }

    fn ctx(mut self, ctx: InvocationContext) -> Self {
        self.ctx = ctx;
        self
    }

    fn inputs(mut self, inputs: BTreeMap<String, String>) -> Self {
        self.inputs = inputs;
        self
    }

    fn clock(mut self, clock: &'a AgentWaitClock) -> Self {
        self.clock = Some(clock);
        self
    }

    fn on_progress(mut self, on_progress: &'a dyn Fn(usize, usize, &str)) -> Self {
        self.on_progress = Some(on_progress);
        self
    }
}
