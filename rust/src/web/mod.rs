//! Web workbench on `tiny_http` (design D3). Port of `src/web/` (tasks 4.1-4.3).

pub mod routes;
pub mod routes_files;
pub mod server;
pub mod yaml_build;

pub use server::{PAGE_HTML, WebOptions, WebServer, serve, start_web_server};
