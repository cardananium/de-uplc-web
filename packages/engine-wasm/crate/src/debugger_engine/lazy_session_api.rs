use crate::{
    lazy_loading::{NavigationResult, PathSegment},
    views::{self, Detail, Root, Writer},
    debugger_engine::DebuggerError,
    wasm_tools::JsError,
};
use std::collections::HashSet;
use uplc::machine::MachineState;
use uplc::manual_machine::ManualMachine;

/// Implementation of lazy loading API for SessionController
pub struct LazySessionApi;

impl LazySessionApi {
    /// Convert path segments back to their string form (the absolute path the UI passes). Every
    /// placeholder of the view carries a `_path` handle that starts with it, so the UI expands a
    /// node by handle instead of reconstructing the path itself.
    fn path_to_strings(path: &[PathSegment]) -> Vec<String> {
        path.iter()
            .map(|seg| match seg {
                PathSegment::Index(i) => i.to_string(),
                PathSegment::Field(f) => f.clone(),
            })
            .collect()
    }

    /// Get machine state with lazy loading support.
    pub fn get_machine_state_lazy(
        machine: &ManualMachine,
        term_ids: &HashSet<i32>,
        path: Vec<PathSegment>,
        return_full_object: bool,
    ) -> Result<String, JsError> {
        let base = Self::path_to_strings(&path);
        let detail = Detail::lazy(return_full_object);
        let state = machine.current_state();

        // If no path specified, return the top-level state
        if path.is_empty() {
            return Ok(Writer::new(term_ids, &base).write(Root::State(state), detail));
        }

        // Navigate to the specific element
        let rest = &path[1..];
        let result = match (state, path.first().unwrap()) {
            (MachineState::Return(_context, value), PathSegment::Field(field)) if field == "value" => {
                views::value_at(value, rest, term_ids, &base, detail)
            }
            (MachineState::Return(context, _), PathSegment::Field(field)) if field == "context" => {
                views::frame_at(context, rest, term_ids, &base, detail)
            }
            (MachineState::Compute(_context, env, _term), PathSegment::Field(field)) if field == "env" => {
                // If path continues after 'env', navigate to values inside env
                if rest.is_empty() {
                    NavigationResult::Found(Writer::new(term_ids, &base).write(Root::Env(env), detail))
                } else {
                    views::env_value_at(env, rest, term_ids, &base, detail)
                }
            }
            (MachineState::Compute(context, _, _), PathSegment::Field(field)) if field == "context" => {
                views::frame_at(context, rest, term_ids, &base, detail)
            }
            (MachineState::Compute(_, _, term), PathSegment::Field(field)) if field == "term" => {
                views::term_at(term, rest, term_ids, &base, detail)
            }
            (MachineState::Done(term), PathSegment::Field(field)) if field == "term" => {
                views::term_at(term, rest, term_ids, &base, detail)
            }
            _ => NavigationResult::InvalidPath(format!("Invalid path for machine state: {:?}", path)),
        };

        Self::finish(result)
    }

    fn finish(result: NavigationResult<String>) -> Result<String, JsError> {
        match result {
            NavigationResult::Found(json) => Ok(json),
            NavigationResult::InvalidPath(msg) => Err(DebuggerError::MachineError(msg))?,
            NavigationResult::Incomplete => Err(DebuggerError::MachineError("Path incomplete".to_string()))?,
        }
    }

    /// Get current environment with lazy loading support.
    pub fn get_current_env_lazy(
        machine: &ManualMachine,
        term_ids: &HashSet<i32>,
        path: Vec<PathSegment>,
        return_full_object: bool,
    ) -> Result<String, JsError> {
        let base = Self::path_to_strings(&path);
        let detail = Detail::lazy(return_full_object);
        match machine.current_state() {
            MachineState::Compute(_, env, _) => {
                // If path is empty, return the whole env
                if path.is_empty() {
                    return Ok(Writer::new(term_ids, &base).write(Root::Env(env), detail));
                }
                // Navigate to specific element
                let result = if path.first() == Some(&PathSegment::Field("values".to_string()))
                    || matches!(path.first(), Some(PathSegment::Index(_)))
                {
                    // Navigating to a value
                    views::env_value_at(env, &path, term_ids, &base, detail)
                } else {
                    NavigationResult::InvalidPath(format!("Invalid path for env: {:?}", path))
                };
                Self::finish(result)
            }
            _ => Ok(r#"{"values":[]}"#.to_string()),
        }
    }

    /// Get machine context with lazy loading support.
    pub fn get_machine_context_lazy(
        machine: &ManualMachine,
        term_ids: &HashSet<i32>,
        path: Vec<PathSegment>,
        return_full_object: bool,
    ) -> Result<String, JsError> {
        let base = Self::path_to_strings(&path);
        let detail = Detail::lazy(return_full_object);
        let contexts = views::frames(machine.current_state());

        // If path is empty, return all contexts
        if path.is_empty() {
            return Ok(Writer::new(term_ids, &base).write(Root::Frames(contexts), detail));
        }

        // Navigate to specific element
        // First segment should be an index
        if let Some(PathSegment::Index(idx)) = path.first() {
            if let Some(context) = contexts.get(*idx) {
                Self::finish(views::frame_at(context, &path[1..], term_ids, &base, detail))
            } else {
                Err(DebuggerError::MachineError(format!("Context index {} out of bounds", idx)))?
            }
        } else {
            Err(DebuggerError::MachineError("First path segment must be an index for contexts".to_string()))?
        }
    }

    /// Parse path string from JSON array format
    pub fn parse_path(path_json: &str) -> Result<Vec<PathSegment>, JsError> {
        if path_json.trim().is_empty() || path_json == "[]" {
            return Ok(vec![]);
        }

        let path_array: Vec<String> = serde_json::from_str(path_json)
            .map_err(|e| DebuggerError::MachineError(format!("Invalid path format: {}", e)))?;

        let segments: Vec<PathSegment> = path_array
            .into_iter()
            .map(|s| {
                if let Ok(index) = s.parse::<usize>() {
                    PathSegment::Index(index)
                } else {
                    PathSegment::Field(s)
                }
            })
            .collect();

        Ok(segments)
    }
}
