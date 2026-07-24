//! `wait: done` polling. Port of `src/runner/agent-wait.ts`: 2s poll, 30s
//! idle grace, 3-strike error tolerance after first successful read, grace-
//! window tolerance before it. Clock and sleep are injectable so tests run
//! on a fake clock; the production default sleeps the thread.

use std::time::Duration;

use crate::herdr::rpc::HerdrError;

/// `AGENT_WAIT_POLL_MS`.
pub const AGENT_WAIT_POLL: Duration = Duration::from_millis(2_000);
/// `AGENT_WAIT_IDLE_GRACE_MS`.
pub const AGENT_WAIT_IDLE_GRACE: Duration = Duration::from_millis(30_000);

/// Clock/sleep injection — `sleep`/`now`/`pollMs`/`idleGraceMs` in the TS
/// deps. `now` returns milliseconds on an arbitrary monotonic scale.
pub struct AgentWaitClock {
    pub poll: Duration,
    pub idle_grace: Duration,
    pub sleep: Box<dyn Fn(Duration)>,
    pub now: Box<dyn Fn() -> u64>,
}

impl Default for AgentWaitClock {
    fn default() -> Self {
        let start = std::time::Instant::now();
        Self {
            poll: AGENT_WAIT_POLL,
            idle_grace: AGENT_WAIT_IDLE_GRACE,
            sleep: Box::new(std::thread::sleep),
            now: Box::new(move || start.elapsed().as_millis() as u64),
        }
    }
}

/// `waitAgentDone`.
///
/// # Errors
/// `HerdrError` — `agent_wait_timeout` past `timeout`, or the status error
/// once tolerance runs out (3 consecutive after the first success; the idle
/// grace window before it). `on_blocked` errors propagate, matching TS.
pub fn wait_agent_done(
    pane_id: &str,
    timeout: Duration,
    agent_status: &mut dyn FnMut(&str) -> Result<String, HerdrError>,
    clock: &AgentWaitClock,
    on_blocked: Option<&dyn Fn() -> Result<(), HerdrError>>,
) -> Result<(), HerdrError> {
    let start = &clock.now;
    let t0 = start();
    let mut saw_working = false;
    let mut ever_resolved = false;
    let mut consecutive_errors = 0u32;
    let mut blocked_notified = false;

    loop {
        let elapsed = Duration::from_millis(start().saturating_sub(t0));
        if elapsed >= timeout {
            return Err(HerdrError::new(
                "agent_wait_timeout",
                format!(
                    "agent wait timed out after {}s",
                    (timeout.as_millis() as f64 / 1000.0).round() as u64
                ),
            ));
        }

        match agent_status(pane_id) {
            Ok(status) => {
                ever_resolved = true;
                consecutive_errors = 0;
                match status.as_str() {
                    "done" => return Ok(()),
                    "working" => {
                        saw_working = true;
                        blocked_notified = false;
                    }
                    "idle" => {
                        if saw_working || elapsed >= clock.idle_grace {
                            return Ok(());
                        }
                    }
                    "blocked" => {
                        if !blocked_notified {
                            blocked_notified = true;
                            if let Some(on_blocked) = on_blocked {
                                on_blocked()?;
                            }
                        }
                    }
                    _ => {}
                }
            }
            Err(error) => {
                consecutive_errors += 1;
                // Before the first successful read, errors usually mean herdr
                // hasn't detected the freshly spawned agent yet — tolerate
                // them for the grace window instead of 3 strikes.
                if ever_resolved && consecutive_errors >= 3
                    || !ever_resolved && elapsed >= clock.idle_grace
                {
                    return Err(error);
                }
            }
        }

        (clock.sleep)(clock.poll);
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use super::*;

    /// Fake clock advanced by `sleep`, like the TS `clock` variable.
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

    #[test]
    fn constants_match_ts() {
        assert_eq!(AGENT_WAIT_POLL.as_millis(), 2_000);
        assert_eq!(AGENT_WAIT_IDLE_GRACE.as_millis(), 30_000);
    }

    #[test]
    fn done_returns_immediately() {
        let (clock, _) = fake_clock(1, 5);
        let mut calls = 0;
        wait_agent_done(
            "p1",
            Duration::from_secs(5),
            &mut |_| {
                calls += 1;
                Ok("done".to_string())
            },
            &clock,
            None,
        )
        .expect("done");
        assert_eq!(calls, 1);
    }

    #[test]
    fn working_then_idle_completes_without_grace() {
        let (clock, _) = fake_clock(1, 30_000);
        let mut statuses = ["working", "idle"].into_iter();
        wait_agent_done(
            "p1",
            Duration::from_secs(5),
            &mut |_| Ok(statuses.next().expect("status").to_string()),
            &clock,
            None,
        )
        .expect("completes");
    }

    #[test]
    fn never_working_idle_waits_out_grace() {
        let (clock, time) = fake_clock(5, 10);
        wait_agent_done(
            "p1",
            Duration::from_secs(5),
            &mut |_| Ok("idle".to_string()),
            &clock,
            None,
        )
        .expect("grace elapses");
        assert!(time.get() >= 10);
    }

    #[test]
    fn blocked_notifies_once_per_streak() {
        let (clock, _) = fake_clock(1, 5);
        let mut statuses = ["working", "blocked", "blocked", "working", "done"].into_iter();
        let notified = Cell::new(0);
        wait_agent_done(
            "p1",
            Duration::from_secs(5),
            &mut |_| Ok(statuses.next().expect("status").to_string()),
            &clock,
            Some(&|| {
                notified.set(notified.get() + 1);
                Ok(())
            }),
        )
        .expect("completes");
        assert_eq!(notified.get(), 1);
    }

    #[test]
    fn timeout_error_message_rounds_seconds() {
        let (clock, _) = fake_clock(600, 5);
        let err = wait_agent_done(
            "p1",
            Duration::from_secs(1),
            &mut |_| Ok("working".to_string()),
            &clock,
            None,
        )
        .expect_err("times out");
        assert_eq!(err.message, "agent wait timed out after 1s");
    }

    #[test]
    fn pre_detection_errors_tolerated_until_grace() {
        let (clock, time) = fake_clock(1, 5);
        let mut n = 0;
        let err = wait_agent_done(
            "p1",
            Duration::from_secs(5),
            &mut |_| {
                n += 1;
                time.set(time.get() + 3); // grace 5ms: elapsed 0, 3 tolerated; 6 exceeds
                Err(HerdrError::new("agent_status_failed", format!("err{n}")))
            },
            &clock,
            None,
        )
        .expect_err("fails");
        assert_eq!(n, 3);
        assert_eq!(err.message, "err3");
    }

    #[test]
    fn post_detection_three_strikes_fail_two_then_success_continues() {
        let (clock, _) = fake_clock(1, 5);
        let mut n = 0;
        wait_agent_done(
            "p1",
            Duration::from_secs(5),
            &mut |_| {
                n += 1;
                if n == 1 {
                    return Ok("working".to_string());
                }
                Err(HerdrError::new("agent_status_failed", format!("err{n}")))
            },
            &clock,
            None,
        )
        .expect_err("3 strikes");
        assert_eq!(n, 4);

        let mut m = 0;
        wait_agent_done(
            "p1",
            Duration::from_secs(5),
            &mut |_| {
                m += 1;
                if m <= 2 {
                    return Err(HerdrError::new("agent_status_failed", format!("err{m}")));
                }
                Ok("done".to_string())
            },
            &clock,
            None,
        )
        .expect("recovers");
        assert_eq!(m, 3);
    }
}
