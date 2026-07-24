//! Picker mode state machine. Ports `src/tui/picker-modes.ts`,
//! `src/tui/picker-run.ts`, and the key-dispatch rules of
//! `src/tui/picker-actions.ts` as plain data + transition functions; the
//! ratatui shell (task 3.2) renders [`Screen`] and calls these methods.
//!
//! Flow: `list → (confirm when gated) → one input screen per declared input →
//! optional prompt screen → run screen`. Escape backs out to the list from
//! confirm/input/prompt, exits 0 from the list, and exits 1 from a finished
//! (failed) run; it is ignored while a run is in flight.

use std::collections::BTreeMap;

use crate::workflow::errors::{InputSpec, WorkflowListEntry};
use crate::workflow::load::LoadedWorkflow;

use super::gate::requires_confirm;
use super::rows::{self, RunTerminal};
use super::run::{RunEvent, RunRequest};
use super::text::{sanitize_display, truncate};

/// Footer hint per screen, byte-identical to the TS picker.
pub const LIST_HINT: &str = "type filter · ↑↓ move · enter run · esc cancel";
/// Footer for the prompt and free-text input screens.
pub const PROMPT_HINT: &str = "enter submit · esc back";
/// Footer for a choice (options-backed) input screen.
pub const CHOICE_HINT: &str = "type filter · ↑↓ move · enter select · esc back";
/// Footer for the confirm screen.
pub const CONFIRM_HINT: &str = "enter run · esc cancel";
/// Footer while a run is in flight.
pub const RUNNING_HINT: &str = "running…";
/// Footer once a run failed; the next enter/escape exits 1.
pub const FAIL_HINT: &str = "enter/esc close";

/// Max width of a step label on a run progress line.
const PROGRESS_LABEL_MAX: usize = 48;

/// The five picker modes (TS `PickerState["mode"]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Mode {
    List,
    Confirm,
    Input,
    Prompt,
    Run,
}

/// The full screen data the shell renders. Each variant carries exactly the
/// state that screen needs.
#[derive(Debug, Clone, PartialEq)]
pub enum Screen {
    List(ListScreen),
    Confirm(ConfirmScreen),
    Input(InputScreen),
    Prompt(PromptScreen),
    Run(RunScreen),
}

impl Screen {
    /// Which mode this screen belongs to.
    #[must_use]
    pub fn mode(&self) -> Mode {
        match self {
            Self::List(_) => Mode::List,
            Self::Confirm(_) => Mode::Confirm,
            Self::Input(_) => Mode::Input,
            Self::Prompt(_) => Mode::Prompt,
            Self::Run(_) => Mode::Run,
        }
    }

    /// Footer hint for this screen.
    #[must_use]
    pub fn hint(&self) -> &'static str {
        match self {
            Self::List(_) => LIST_HINT,
            Self::Confirm(_) => CONFIRM_HINT,
            Self::Input(input) => match input.kind {
                InputKind::Text { .. } => PROMPT_HINT,
                InputKind::Choice { .. } => CHOICE_HINT,
            },
            Self::Prompt(_) => PROMPT_HINT,
            Self::Run(run) => {
                if run.is_running() {
                    RUNNING_HINT
                } else {
                    FAIL_HINT
                }
            }
        }
    }
}

/// List mode: the filterable workflow browser.
#[derive(Debug, Clone, PartialEq)]
pub struct ListScreen {
    pub filter: String,
    /// Index into `valid`; wraps on move, clamped on filter change.
    pub selected: usize,
    /// Filtered runnable entries (row order).
    pub valid: Vec<WorkflowListEntry>,
    /// Filtered entries whose load failed; rendered dimmed, not selectable.
    pub invalid: Vec<WorkflowListEntry>,
}

impl ListScreen {
    /// Selectable rows for the current filter.
    #[must_use]
    pub fn rows(&self) -> Vec<rows::PickerRow<'_>> {
        rows::build_picker_rows(self.valid.iter())
    }

    /// Dimmed invalid-workflow lines (`""` when none — block hidden).
    #[must_use]
    pub fn invalid_lines(&self) -> String {
        rows::format_invalid_lines(self.invalid.iter())
    }
}

/// Confirm mode: gate for repo-owned / dynamic-options workflows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmScreen {
    pub name: String,
}

impl ConfirmScreen {
    /// Status line: `<name> · workflow may run shell commands`.
    #[must_use]
    pub fn message(&self) -> String {
        format!("{} · workflow may run shell commands", self.name)
    }
}

/// Input mode: one screen per declared input, choice or free text.
#[derive(Debug, Clone, PartialEq)]
pub struct InputScreen {
    pub name: String,
    pub spec: InputSpec,
    pub kind: InputKind,
}

impl InputScreen {
    /// Status line: `<name> · <label>`.
    #[must_use]
    pub fn title(&self) -> String {
        format!("{} · {}", self.name, self.spec.label)
    }

    /// Placeholder for a free-text input (`<label>…`).
    #[must_use]
    pub fn placeholder(&self) -> String {
        format!("{}…", self.spec.label)
    }

    /// Options matching the current choice filter (empty for text inputs).
    #[must_use]
    pub fn visible_options(&self) -> Vec<&str> {
        match &self.kind {
            InputKind::Choice { options, filter, .. } => {
                rows::filter_choice_options(options, filter)
            }
            InputKind::Text { .. } => Vec::new(),
        }
    }
}

/// Choice inputs show a filterable list; text inputs a single line seeded
/// with the declared default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputKind {
    Text { value: String },
    Choice {
        options: Vec<String>,
        filter: String,
        /// Index into the *filtered* options; preselected to the default.
        selected: usize,
    },
}

/// Prompt mode: free-text `{prompt}` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptScreen {
    pub name: String,
    pub value: String,
}

/// Run mode: streamed step progress; doubles as the failure display for both
/// load and execution errors. Success never lingers here — it exits 0.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunScreen {
    pub name: String,
    /// `[i/n] label` lines, labels truncated to 48 chars.
    pub lines: Vec<String>,
    /// `Some(detail)` once the run (or its load) failed.
    pub failed: Option<String>,
}

impl RunScreen {
    /// Still executing (or loading); keypresses are ignored.
    #[must_use]
    pub fn is_running(&self) -> bool {
        self.failed.is_none()
    }

    /// Body text: progress lines plus the `Failed · <detail>` trailer.
    #[must_use]
    pub fn text(&self) -> String {
        let terminal = self.failed.as_ref().map(|detail| RunTerminal {
            ok: false,
            detail: detail.clone(),
        });
        rows::format_run_progress(&self.name, &self.lines, terminal)
    }
}

/// What the shell must do after a transition.
#[derive(Debug, Clone, PartialEq)]
#[must_use]
pub enum Action {
    /// Screen state already updated; nothing else to do.
    None,
    /// Load the pending entry with dynamic options resolved, then report via
    /// [`Picker::loaded`] / [`Picker::load_failed`]. The picker is already
    /// showing the run screen as an input lock (one confirmation starts one
    /// options command).
    Load { confirmed: bool },
    /// Inputs and prompt collected; hand the request to a
    /// [`super::run::RunExecutor`] (task 3.4) and feed its
    /// [`RunEvent`]s back via [`Picker::apply_run_event`]. Boxed: far larger
    /// than the other variants.
    Run(Box<RunRequest>),
    /// Exit the process with this code.
    Exit(i32),
}

/// The picker state machine. Construct with [`Picker::new`], drive with the
/// transition methods, render [`Picker::screen`].
#[derive(Debug, Clone)]
pub struct Picker {
    entries: Vec<WorkflowListEntry>,
    screen: Screen,
    pending: Option<WorkflowListEntry>,
    workflow: Option<LoadedWorkflow>,
    input_queue: Vec<InputSpec>,
    input_index: usize,
    input_values: BTreeMap<String, String>,
    /// List selection preserved across escape-backs (the TS Select widget
    /// keeps its index when modes change).
    list_selected: usize,
    exit: Option<i32>,
}

impl Picker {
    /// A picker in list mode over the discovered (already validated) entries.
    pub fn new(entries: Vec<WorkflowListEntry>) -> Self {
        let screen = Self::list_screen(&entries, "", 0);
        Self {
            entries,
            screen,
            pending: None,
            workflow: None,
            input_queue: Vec::new(),
            input_index: 0,
            input_values: BTreeMap::new(),
            list_selected: 0,
            exit: None,
        }
    }

    fn list_screen(entries: &[WorkflowListEntry], filter: &str, selected: usize) -> Screen {
        let filtered = rows::filter_workflow_entries(entries, filter);
        let selected = if filtered.valid.is_empty() {
            selected
        } else {
            selected.min(filtered.valid.len() - 1)
        };
        Screen::List(ListScreen {
            filter: filter.to_string(),
            selected,
            valid: filtered.valid.into_iter().cloned().collect(),
            invalid: filtered.invalid.into_iter().cloned().collect(),
        })
    }

    /// Current screen (render this).
    #[must_use]
    pub fn screen(&self) -> &Screen {
        &self.screen
    }

    /// Current mode.
    #[must_use]
    pub fn mode(&self) -> Mode {
        self.screen.mode()
    }

    /// Exit code once the picker is done.
    #[must_use]
    pub fn exit_code(&self) -> Option<i32> {
        self.exit
    }

    /// Entry being confirmed / collected / run.
    #[must_use]
    pub fn pending(&self) -> Option<&WorkflowListEntry> {
        self.pending.as_ref()
    }

    /// Replace the list filter text and re-filter (selection clamped).
    pub fn set_list_filter(&mut self, filter: String) {
        if matches!(self.screen, Screen::List(_)) {
            let selected = match &self.screen {
                Screen::List(list) => list.selected,
                _ => 0,
            };
            self.screen = Self::list_screen(&self.entries, &filter, selected);
        }
    }

    /// Replace a choice input's filter text (selection clamped).
    pub fn set_choice_filter(&mut self, filter: String) {
        if let Screen::Input(InputScreen {
            kind:
                InputKind::Choice {
                    options,
                    filter: current,
                    selected,
                },
            ..
        }) = &mut self.screen
        {
            *current = filter;
            let matched = rows::filter_choice_options(options, current).len();
            if matched > 0 {
                *selected = (*selected).min(matched - 1);
            }
        }
    }

    /// Replace a free-text input's value.
    pub fn set_input_text(&mut self, value: String) {
        if let Screen::Input(InputScreen {
            kind: InputKind::Text { value: current },
            ..
        }) = &mut self.screen
        {
            *current = value;
        }
    }

    /// Replace the prompt screen's value.
    pub fn set_prompt_text(&mut self, value: String) {
        if let Screen::Prompt(prompt) = &mut self.screen {
            prompt.value = value;
        }
    }

    /// Selection up one row, wrapping (list and choice-input screens).
    pub fn move_up(&mut self) {
        self.move_selection(false);
    }

    /// Selection down one row, wrapping (list and choice-input screens).
    pub fn move_down(&mut self) {
        self.move_selection(true);
    }

    fn move_selection(&mut self, forward: bool) {
        let (selected, len) = match &mut self.screen {
            Screen::List(list) => (&mut list.selected, list.valid.len()),
            Screen::Input(input) => match &mut input.kind {
                InputKind::Choice {
                    options,
                    filter,
                    selected,
                } => (
                    selected,
                    rows::filter_choice_options(options, filter).len(),
                ),
                InputKind::Text { .. } => return,
            },
            _ => return,
        };
        if len > 0 {
            *selected = if forward {
                (*selected + 1) % len
            } else {
                (*selected + len - 1) % len
            };
        }
    }

    /// Enter key: dispatch per mode (TS `handlePickerKey` + the select/input
    /// widget enter handlers).
    pub fn accept(&mut self) -> Action {
        match self.screen.mode() {
            Mode::List => {
                let Screen::List(list) = &self.screen else {
                    return Action::None;
                };
                let Some(entry) = list.valid.get(list.selected).cloned() else {
                    return Action::None;
                };
                self.list_selected = list.selected;
                self.accept_entry(entry)
            }
            Mode::Confirm => {
                let Some(entry) = self.pending.clone() else {
                    return Action::None;
                };
                self.begin_prepare(&entry);
                Action::Load { confirmed: true }
            }
            Mode::Input => self.submit_input(),
            Mode::Prompt => self.submit_prompt(),
            Mode::Run => {
                // Enter closes a failed run; ignored while running.
                if matches!(&self.screen, Screen::Run(run) if !run.is_running()) {
                    self.finish(1)
                } else {
                    Action::None
                }
            }
        }
    }

    /// Escape key: exit from the list, back out to the list from
    /// confirm/input/prompt, close a failed run; ignored while running.
    pub fn escape(&mut self) -> Action {
        match self.screen.mode() {
            Mode::List => self.finish(0),
            Mode::Confirm | Mode::Input | Mode::Prompt => {
                self.reset_to_list();
                Action::None
            }
            Mode::Run => {
                if matches!(&self.screen, Screen::Run(run) if !run.is_running()) {
                    self.finish(1)
                } else {
                    Action::None
                }
            }
        }
    }

    /// `acceptWorkflow`: gate check, then confirm screen or load.
    fn accept_entry(&mut self, entry: WorkflowListEntry) -> Action {
        self.pending = Some(entry.clone());
        if requires_confirm(&entry) {
            self.screen = Screen::Confirm(ConfirmScreen {
                name: entry.name.clone(),
            });
            return Action::None;
        }
        self.begin_prepare(&entry);
        Action::Load { confirmed: false }
    }

    /// `setRunMode` during prepare: lock input while the load (and any
    /// dynamic-options command) resolves.
    fn begin_prepare(&mut self, entry: &WorkflowListEntry) {
        self.screen = Screen::Run(RunScreen {
            name: entry.name.clone(),
            lines: Vec::new(),
            failed: None,
        });
    }

    /// Report a successful load of the pending entry (`confirmed` comes from
    /// the [`Action::Load`] the shell acted on). Advances to confirm (when
    /// the load revealed repo-owned composition and the user has not
    /// confirmed), the first input screen, the prompt screen, or the run.
    pub fn loaded(&mut self, workflow: LoadedWorkflow, confirmed: bool) -> Action {
        let Some(mut entry) = self.pending.clone() else {
            return Action::None;
        };
        // Reflect the loaded shape back onto the entry (TS mutates it in
        // place), including the stored copy so re-selection reuses the facts.
        entry.needs_prompt = Some(workflow.needs_prompt);
        entry.inputs = Some(workflow.inputs.clone());
        entry.repo_owned = Some(workflow.repo_owned);
        if let Some(stored) = self
            .entries
            .iter_mut()
            .find(|candidate| candidate.name == entry.name && candidate.file == entry.file)
        {
            stored.needs_prompt = entry.needs_prompt;
            stored.inputs.clone_from(&entry.inputs);
            stored.repo_owned = entry.repo_owned;
        }
        let repo_owned = workflow.repo_owned;
        self.pending = Some(entry.clone());
        self.workflow = Some(workflow);
        if repo_owned && !confirmed {
            self.screen = Screen::Confirm(ConfirmScreen {
                name: entry.name.clone(),
            });
            return Action::None;
        }
        self.input_queue = entry.inputs.clone().unwrap_or_default();
        self.input_index = 0;
        self.input_values.clear();
        self.advance(&entry)
    }

    /// Report a failed load: the run screen shows `Failed · <error>` and the
    /// next enter/escape exits 1 (TS `showFailure` during prepare).
    pub fn load_failed(&mut self, error: &str) -> Action {
        let name = self
            .pending
            .as_ref()
            .map_or_else(String::new, |entry| entry.name.clone());
        self.screen = Screen::Run(RunScreen {
            name,
            lines: Vec::new(),
            failed: Some(error.to_string()),
        });
        Action::None
    }

    /// Feed one runner progress event into the run screen.
    pub fn apply_run_event(&mut self, event: &RunEvent) -> Action {
        if let RunEvent::Finished(Ok(())) = event {
            return if matches!(self.screen, Screen::Run(_)) {
                self.finish(0)
            } else {
                Action::None
            };
        }
        let Screen::Run(run) = &mut self.screen else {
            return Action::None;
        };
        match event {
            RunEvent::Progress { step, total, label } => {
                run.lines
                    .push(format!("[{step}/{total}] {}", truncate(label, PROGRESS_LABEL_MAX)));
                Action::None
            }
            RunEvent::Finished(Err(detail)) => {
                run.failed = Some(detail.clone());
                Action::None
            }
            RunEvent::Finished(Ok(())) => unreachable!("handled above"),
        }
    }

    /// `storeInput`: record the current input screen's value (text inputs are
    /// trimmed, choices are not) and advance.
    fn submit_input(&mut self) -> Action {
        let Screen::Input(input) = &self.screen else {
            return Action::None;
        };
        let Some(entry) = self.pending.clone() else {
            return Action::None;
        };
        let name = input.spec.name.clone();
        let value = match &input.kind {
            InputKind::Text { value } => value.trim().to_string(),
            InputKind::Choice { selected, .. } => {
                let visible = input.visible_options();
                let Some(choice) = visible.get(*selected) else {
                    return Action::None;
                };
                (*choice).to_string()
            }
        };
        self.input_values.insert(name, value);
        self.input_index += 1;
        self.advance(&entry)
    }

    /// `submitPrompt`: record the trimmed prompt and start the run.
    fn submit_prompt(&mut self) -> Action {
        let Screen::Prompt(prompt) = &self.screen else {
            return Action::None;
        };
        let Some(entry) = self.pending.clone() else {
            return Action::None;
        };
        let value = prompt.value.trim().to_string();
        self.start_run(&entry, value)
    }

    /// Declared inputs first, then `{prompt}` if used, then run
    /// (TS `advanceInput`).
    fn advance(&mut self, entry: &WorkflowListEntry) -> Action {
        if let Some(spec) = self.input_queue.get(self.input_index).cloned() {
            let kind = match &spec.options {
                Some(options) => {
                    let selected = spec
                        .default
                        .as_ref()
                        .and_then(|default| options.iter().position(|o| o == default))
                        .unwrap_or(0);
                    InputKind::Choice {
                        options: options.clone(),
                        filter: String::new(),
                        selected,
                    }
                }
                None => InputKind::Text {
                    value: spec.default.clone().unwrap_or_default(),
                },
            };
            self.screen = Screen::Input(InputScreen {
                name: entry.name.clone(),
                spec,
                kind,
            });
            return Action::None;
        }
        if entry.needs_prompt == Some(true) {
            self.screen = Screen::Prompt(PromptScreen {
                name: entry.name.clone(),
                value: String::new(),
            });
            return Action::None;
        }
        self.start_run(entry, String::new())
    }

    /// `startRun` minus execution: sanitize values, swap to the run screen,
    /// hand the shell a [`RunRequest`].
    fn start_run(&mut self, entry: &WorkflowListEntry, prompt: String) -> Action {
        let inputs = self
            .input_values
            .iter()
            .map(|(key, value)| (key.clone(), sanitize_display(value)))
            .collect();
        let workflow = self
            .workflow
            .clone()
            .expect("start_run requires a loaded workflow");
        self.screen = Screen::Run(RunScreen {
            name: entry.name.clone(),
            lines: Vec::new(),
            failed: None,
        });
        Action::Run(Box::new(RunRequest {
            name: entry.name.clone(),
            prompt: sanitize_display(&prompt),
            inputs,
            workflow,
        }))
    }

    /// `setListMode`: back to a fresh browser, selection preserved.
    fn reset_to_list(&mut self) {
        self.pending = None;
        self.workflow = None;
        self.input_queue.clear();
        self.input_index = 0;
        self.input_values.clear();
        self.screen = Self::list_screen(&self.entries, "", self.list_selected);
    }

    fn finish(&mut self, code: i32) -> Action {
        self.exit = Some(code);
        Action::Exit(code)
    }
}
