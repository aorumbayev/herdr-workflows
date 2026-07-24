//! JSONL run log. Port of `src/runlog.ts`. The state directory is carried
//! by a [`RunLog`] handle instead of read from `HERDR_PLUGIN_STATE_DIR` at
//! every append, so tests inject a temp dir (Rust 2024 `env::set_var` is
//! `unsafe`, and this crate forbids unsafe code).

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// One run-log line. Field order matches the TS object literals so the
/// JSONL stays byte-comparable; `None` fields are omitted entirely.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunLogEntry {
    pub ts: String,
    pub run: String,
    pub workflow: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// State directory holding `runs.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunLog(PathBuf);

impl RunLog {
    /// Explicit state dir (tests).
    #[must_use]
    pub fn new(state_dir: PathBuf) -> Self {
        Self(state_dir)
    }

    /// `HERDR_PLUGIN_STATE_DIR`, else `~/.hwf/state` — the TS `stateDir()`.
    #[must_use]
    pub fn from_env() -> Self {
        let dir = std::env::var_os("HERDR_PLUGIN_STATE_DIR").map_or_else(
            || {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .or_else(std::env::home_dir)
                    .unwrap_or_default()
                    .join(".hwf")
                    .join("state")
            },
            PathBuf::from,
        );
        Self(dir)
    }

    /// `runLogPath()`.
    #[must_use]
    pub fn path(&self) -> PathBuf {
        self.0.join("runs.jsonl")
    }

    /// `appendRunLog` — observability must not break a workflow run, so all
    /// I/O errors are swallowed.
    pub fn append(&self, entry: &RunLogEntry) {
        let Ok(mut line) = serde_json::to_string(entry) else {
            return;
        };
        line.push('\n');
        if std::fs::create_dir_all(&self.0).is_err() {
            return;
        }
        let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path())
        else {
            return;
        };
        use std::io::Write as _;
        let _ = file.write_all(line.as_bytes());
    }

    /// `readRunLog` — missing file and corrupt lines degrade to skipped.
    #[must_use]
    pub fn read(&self) -> Vec<RunLogEntry> {
        let Ok(text) = std::fs::read_to_string(self.path()) else {
            return Vec::new();
        };
        text.split('\n')
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
}

/// `recentRuns` — final per-run entries (no `step`), newest first.
#[must_use]
pub fn recent_runs(entries: &[RunLogEntry], limit: usize) -> Vec<RunLogEntry> {
    entries
        .iter()
        .filter(|e| e.step.is_none())
        .rev()
        .take(limit)
        .cloned()
        .collect()
}

/// `new Date().toISOString()` — UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`.
#[must_use]
pub fn iso_now() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    iso_from_millis(millis)
}

/// Civil date from Unix days (Howard Hinnant's algorithm), milliseconds
/// precision to match `Date#toISOString`.
fn iso_from_millis(millis: u128) -> String {
    let days = (millis / 86_400_000) as i64;
    let ms_of_day = millis % 86_400_000;
    let (hour, min, sec, ms) = (
        ms_of_day / 3_600_000,
        (ms_of_day / 60_000) % 60,
        (ms_of_day / 1_000) % 60,
        ms_of_day % 1_000,
    );
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{ms:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(workflow: &str, step: Option<u32>, ok: bool) -> RunLogEntry {
        RunLogEntry {
            ts: "2026-01-01T00:00:00.000Z".to_string(),
            run: "abcd1234".to_string(),
            workflow: workflow.to_string(),
            step,
            total: step.map(|_| 2),
            label: step.map(|i| format!("shell: step {i}")),
            ok,
            error: if ok { None } else { Some("boom".to_string()) },
        }
    }

    #[test]
    fn iso_from_millis_matches_known_epochs() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_millis(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
        assert_eq!(iso_from_millis(86_400_000), "1970-01-02T00:00:00.000Z");
    }

    #[test]
    fn final_entry_omits_step_fields_entirely() {
        let json = serde_json::to_string(&entry("m", None, true)).expect("serialize");
        assert_eq!(
            json,
            r#"{"ts":"2026-01-01T00:00:00.000Z","run":"abcd1234","workflow":"m","ok":true}"#
        );
    }

    #[test]
    fn step_entry_serializes_in_ts_key_order() {
        let json = serde_json::to_string(&entry("m", Some(2), false)).expect("serialize");
        assert_eq!(
            json,
            r#"{"ts":"2026-01-01T00:00:00.000Z","run":"abcd1234","workflow":"m","step":2,"total":2,"label":"shell: step 2","ok":false,"error":"boom"}"#
        );
    }

    #[test]
    fn recent_runs_filters_finals_newest_first_with_limit() {
        let entries: Vec<RunLogEntry> = (0..50)
            .flat_map(|i| {
                [
                    entry("m", Some(1), true),
                    entry(&format!("w{i}"), None, true),
                ]
            })
            .collect();
        let recent = recent_runs(&entries, 40);
        assert_eq!(recent.len(), 40);
        assert_eq!(recent[0].workflow, "w49");
        assert!(recent.iter().all(|e| e.step.is_none()));
    }

    #[test]
    fn append_then_read_roundtrip_skips_corrupt_lines() {
        let dir = std::env::temp_dir().join(format!("hwf-runlog-{}", uuid::Uuid::new_v4()));
        let log = RunLog::new(dir.clone());
        log.append(&entry("m", None, true));
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(log.path())
            .expect("open");
        file.write_all(b"not-json\n").expect("write");
        drop(file);
        let entries = log.read();
        assert_eq!(entries, vec![entry("m", None, true)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_swallows_fs_errors() {
        let blocker =
            std::env::temp_dir().join(format!("hwf-runlog-blocker-{}", uuid::Uuid::new_v4()));
        std::fs::write(&blocker, "file").expect("blocker file");
        let log = RunLog::new(blocker.clone());
        log.append(&entry("m", None, true));
        assert!(log.read().is_empty());
        let _ = std::fs::remove_file(&blocker);
    }
}
