//! herdr socket JSON-RPC client and `herdr` CLI subprocess wrappers.
//! Port of `src/adapter/` (tasks 2.1-2.2): `rpc` is the raw transport,
//! `cli` the verb-level wrappers the runner composes. Runner tests fake
//! this boundary through the `runner::Herdr` trait, not by mocking here.

pub mod cli;
pub mod rpc;
