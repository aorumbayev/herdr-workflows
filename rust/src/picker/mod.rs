//! ratatui picker popup (design D2). Tasks 3.1-3.5.
//!
//! Data layer (3.1, landed): `rows` (row building, filters, run/invalid
//! formatting), `text` (truncation + sanitize helpers), `gate` (confirm
//! predicate), `modes` (the list → confirm → input → prompt → run state
//! machine as plain data + transition functions), `run` (progress model +
//! runner seam). The ratatui shell (3.2) renders `modes::Screen` and drives
//! `modes::Picker`.

pub mod gate;
pub mod modes;
pub mod rows;
pub mod run;
pub mod text;
