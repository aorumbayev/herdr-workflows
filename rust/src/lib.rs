//! Library surface: all ported modules. `main.rs` is a thin clap shell over
//! this crate. Modules land here as their ports complete (tasks 1.x-4.x).

pub mod config;
pub mod herdr;
pub mod init;
pub mod picker;
pub mod repo;
pub mod runner;
pub mod web;
pub mod workflow;
