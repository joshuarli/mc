//! Read-only commands for offline trace evidence.

mod cli;
mod evidence;
mod error;
mod trace;

pub use cli::run;
pub use error::CliError;
