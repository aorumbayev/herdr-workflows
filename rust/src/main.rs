//! CLI entry (`hwf` / `herdr-workflows`). Mirrors `src/cli.ts` + `src/cli-args.ts`.
//! Thin shell over the `herdr_workflows` library crate.

use std::collections::BTreeMap;
use std::io::IsTerminal;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use herdr_workflows::config::load_config;
use herdr_workflows::herdr::cli::{notification_show, plugin_pane_open};
use herdr_workflows::init::cmd_init;
use herdr_workflows::repo::{resolve_repo_root, resolve_repo_root_from_cwd};
use herdr_workflows::runner::context::read_invocation_context;
use herdr_workflows::runner::runlog::RunLog;
use herdr_workflows::runner::{LiveHerdr, RunOptions, run_workflow};
use herdr_workflows::web;

#[derive(Parser)]
#[command(
    name = "herdr-workflows",
    version,
    about = "herdr plugin that sequences short linear YAML workflows"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run a workflow by name
    Run {
        /// Workflow name
        name: Option<String>,
        /// Value for the {prompt} placeholder
        #[arg(long)]
        prompt: Option<String>,
        /// Input value, name=value (repeatable)
        #[arg(long = "input", value_name = "name=value")]
        inputs: Vec<String>,
    },
    /// Open the picker popup
    Picker,
    /// Start the web workbench
    Web {
        /// Port to bind (1-65535); auto-increments from 7317 when omitted
        #[arg(long)]
        port: Option<String>,
        /// Do not open a browser
        #[arg(long = "no-open")]
        no_open: bool,
    },
    /// Seed .hwf config and workflows
    Init {
        /// Overwrite an existing .hwf/config.yaml
        #[arg(long)]
        force: bool,
        /// Alias for --force
        #[arg(long)]
        yes: bool,
        /// Seed handoff + worktree playbooks: global, repo, or none
        #[arg(long, value_name = "global|repo|none", alias = "seed-playbooks")]
        seed: Option<String>,
    },
    /// Launch the picker from a herdr pane
    Launch,
    /// Unknown command — the TS parser fell through to usage.
    #[command(external_subcommand)]
    Other(Vec<String>),
}

/// `die`: message to stderr, exit 1.
fn die(message: &str) -> ExitCode {
    eprintln!("{message}");
    ExitCode::FAILURE
}

fn not_implemented(mode: &str) -> ExitCode {
    eprintln!("{mode}: not implemented");
    ExitCode::from(2)
}

fn usage() -> ExitCode {
    die("usage: hwf|herdr-workflows [<run|init|launch|picker|web>]  (no args: web UI)")
}

/// `parseInputFlags`: split `--input name=value` pairs.
///
/// # Errors
/// The TS `die` message for a malformed pair.
fn parse_input_flags(values: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut inputs = BTreeMap::new();
    for kv in values {
        match kv.find('=') {
            Some(eq) if eq > 0 => {
                inputs.insert(kv[..eq].to_string(), kv[eq + 1..].to_string());
            }
            _ => return Err(format!("--input expects name=value, got '{kv}'")),
        }
    }
    Ok(inputs)
}

/// `cmdLaunch`: forward the invoking pane's repo + raw context to a fresh
/// picker popup; `ui_busy` downgrades to a notification instead of failure.
fn cmd_launch() -> ExitCode {
    // The picker runs in a fresh popup pane rooted at the plugin dir, so forward the invoking
    // pane's repo (and raw context) — otherwise workflow discovery and {pane} target the wrong place.
    let ctx = read_invocation_context();
    let repo_root = resolve_repo_root(std::path::Path::new(&ctx.cwd));
    let mut env = BTreeMap::new();
    env.insert(
        "HERDR_WORKFLOWS_REPO_ROOT".to_string(),
        repo_root.display().to_string(),
    );
    if let Ok(raw) = std::env::var("HERDR_PLUGIN_CONTEXT_JSON")
        && !raw.is_empty()
    {
        env.insert("HERDR_PLUGIN_CONTEXT_JSON".to_string(), raw);
    }
    match plugin_pane_open("picker", &env, Some("popup")) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) if error.code == "ui_busy" => {
            match notification_show(
                "herdr-workflows",
                Some("Another popup is open — close it first."),
            ) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => die(&error.message),
            }
        }
        Err(error) => die(&error.message),
    }
}

fn cmd_run(name: Option<String>, prompt: Option<String>, inputs: Vec<String>) -> ExitCode {
    let Some(name) = name else {
        return die("usage: hwf|herdr-workflows run <name> [--prompt …] [--input name=value …]");
    };
    let inputs = match parse_input_flags(&inputs) {
        Ok(inputs) => inputs,
        Err(message) => return die(&message),
    };
    let repo_root = resolve_repo_root_from_cwd();
    let cfg = match load_config(&repo_root) {
        Ok(cfg) => cfg,
        Err(error) => return die(&error.to_string()),
    };
    let mut ctx = read_invocation_context();
    ctx.cwd = repo_root.display().to_string();
    let run_log = RunLog::from_env();
    let result = run_workflow(&RunOptions {
        name: &name,
        repo_root: &repo_root,
        agents: &cfg.agents,
        sessions: &cfg.sessions,
        ctx: &ctx,
        prompt: prompt.as_deref(),
        inputs,
        workflow: None,
        herdr: &LiveHerdr,
        run_log: &run_log,
        wait_clock: None,
        on_progress: Some(&|i, n, label| println!("[{i}/{n}] {label}")),
        on_stderr: Some(&|text| {
            if text.ends_with('\n') {
                eprint!("{text}");
            } else {
                eprintln!("{text}");
            }
        }),
    });
    match result {
        Ok(result) if result.ok => ExitCode::SUCCESS,
        Ok(result) => die(&result.error.unwrap_or_default()),
        Err(error) => die(&error.to_string()),
    }
}

fn cmd_web(port: Option<String>, no_open: bool) -> ExitCode {
    let port = match port {
        None => None,
        Some(raw) => match raw.parse::<u16>() {
            Ok(port) if port >= 1 => Some(port),
            _ => {
                return die(&format!(
                    "--port expects an integer between 1 and 65535, got '{raw}'"
                ));
            }
        },
    };
    let repo_root = resolve_repo_root_from_cwd();
    match web::serve(&repo_root, port, no_open) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => die(&error.to_string()),
    }
}

fn main() -> ExitCode {
    // Older cached manifests invoked `hook.mjs herdr <cmd>`; strip that prefix so a stale
    // plugins.json still reaches launch/picker until the next install re-links.
    let mut args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.get(1).is_some_and(|a| a == "herdr") {
        args.remove(1);
    }
    let cli = Cli::parse_from(args);
    match cli.command {
        None => {
            if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
                cmd_web(None, false)
            } else {
                usage()
            }
        }
        Some(Command::Run {
            name,
            prompt,
            inputs,
        }) => cmd_run(name, prompt, inputs),
        Some(Command::Picker) => not_implemented("picker"),
        Some(Command::Web { port, no_open }) => cmd_web(port, no_open),
        Some(Command::Init { force, yes, seed }) => {
            let repo_root = resolve_repo_root_from_cwd();
            match cmd_init(&repo_root, force || yes, seed.as_deref()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(message) => die(&message),
            }
        }
        Some(Command::Launch) => cmd_launch(),
        Some(Command::Other(_args)) => usage(),
    }
}
