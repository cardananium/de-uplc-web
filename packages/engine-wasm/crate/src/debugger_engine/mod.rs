pub mod debugger_engine;
pub mod session_controller;
pub mod lazy_session_api;

pub use debugger_engine::{DebuggerEngine, new_session_from_program, new_session_from_parts};
pub use session_controller::SessionController;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status_type")]
pub enum SerializableExecutionStatus {
    #[serde(rename = "Ready")]
    Ready,
    #[serde(rename = "Done")]
    Done {
        result: crate::serializer::SerializableTerm,
    },
    #[serde(rename = "Error")]
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StepResult {
    pub term_id: i32,
    pub status: SerializableExecutionStatus,
}

/// Why a Plutus V3 run that ends on anything but unit fails (CIP-117), in the words cquisitor's
/// validator uses, so that the stepper and the validator agree.
pub const NOT_UNIT: &str = "The script evaluated to a term other than unit, which PlutusV3 requires";

/// Where a run stands, its failure in the debugger's words.
pub(crate) enum RunStatus<'a> {
    Ready,
    Done(&'a uplc::ast::Term<uplc::ast::NamedDeBruijn>),
    /// The machine failed, or a Plutus V3 run ended on something other than unit.
    Error(String),
}

impl<'a> RunStatus<'a> {
    pub(crate) fn of(status: &'a uplc::manual_machine::ExecutionStatus, language: &pallas_primitives::conway::Language) -> Self {
        use pallas_primitives::conway::Language;
        use uplc::{
            ast::{Constant, Term},
            manual_machine::ExecutionStatus,
        };

        match status {
            ExecutionStatus::Ready => RunStatus::Ready,
            // As the ledger has it: a V3 script succeeds only by returning unit. The machine is done
            // all the same, so the value it ended on stays there to look at.
            ExecutionStatus::Done(term)
                if *language == Language::PlutusV3
                    && !matches!(term, Term::Constant { value, .. } if matches!(value.as_ref(), Constant::Unit)) =>
            {
                RunStatus::Error(NOT_UNIT.to_string())
            }
            ExecutionStatus::Done(term) => RunStatus::Done(term),
            ExecutionStatus::Error(error) => RunStatus::Error(error.to_string()),
        }
    }
}

/// A step, as `StepResult` declares it: the term just computed, and where the run stands — its
/// result written in full.
pub(crate) fn step_json(term_id: i32, status: RunStatus<'_>) -> String {
    let status = match status {
        RunStatus::Ready => r#"{"status_type":"Ready"}"#.to_string(),
        RunStatus::Done(term) => format!(
            r#"{{"status_type":"Done","result":{}}}"#,
            crate::views::plain(crate::views::Root::Term(term), &std::collections::HashSet::new())
        ),
        RunStatus::Error(message) => format!(
            r#"{{"status_type":"Error","message":{}}}"#,
            serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".to_string())
        ),
    };
    format!(r#"{{"term_id":{term_id},"status":{status}}}"#)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Budget {
    pub mem: i64,
    pub cpu: i64,
}

impl From<uplc::machine::cost_model::ExBudget> for Budget {
    fn from(ex_budget: uplc::machine::cost_model::ExBudget) -> Self {
        Budget {
            mem: ex_budget.mem,
            cpu: ex_budget.cpu,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DebuggerError {
    #[error("Failed to parse transaction: {0}")]
    TransactionParseError(String),

    #[error("Failed to find redeemer: {0}")]
    RedeemerNotFound(String),

    #[error("Failed to find script: {0}")]
    ScriptNotFound(String),

    #[error("Failed to build script context: {0}")]
    ScriptContextBuildError(String),

    #[error("Failed to build program: {0}")]
    ProgramBuildError(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Machine error: {0}")]
    MachineError(String),

    #[error("Invalid script context")]
    InvalidScriptContext,

    #[error("UTXO conversion error: {0}")]
    UtxoConversionError(#[from] crate::utxo::UtxoConversionError),

    #[error("IO Error: {0}")]
    IoError(#[from] std::io::Error),
}
