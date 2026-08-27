use std::collections::HashSet;

use crate::budget::SerializableBudget;
use crate::debugger_engine::{DebuggerError, lazy_session_api::LazySessionApi};
use crate::profile::{ProfileAttribution, ProfileRunner};
use crate::wasm_tools::JsError;
use crate::{SerializableEnv, SerializableExecutionStatus, SerializableMachineContext, SerializableMachineState, SerializableScriptContext, SerializableTerm};
use pallas_primitives::conway::Language;
use uplc::{
    ast::{NamedDeBruijn, Program, Term},
    machine::{
        cost_model::{CostModel, ExBudget},
        MachineState,
    },
    manual_machine::ManualMachine,
    tx::script_context::ScriptContext,
    PlutusData,
};

use crate::wasm_tools::wasm_bindgen;

const DEFAULT_SLIPPAGE: u32 = 1;

#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct SessionController {
    redeemer: String,
    machine: Box<ManualMachine>,
    language: Language,
    /// The ExUnits DECLARED for this session — a tx redeemer's `ex_units`, or the ones a parts
    /// deep-link carried. `None` when nothing declared any (a bare program, or a parts link without
    /// them): there is then no denominator at all, and the budget panel / profile say so instead of
    /// quoting a share of `ExBudget::default()`, which is a generic reference budget with no
    /// relationship to this script.
    declared_budget: Option<ExBudget>,
    image_budget: ExBudget,
    script_hash: String,
    /// What the script is being run FOR ("Spending", "Minting", … or a link-supplied label), or
    /// `None` when nothing in this session names one. Resolved ONCE, at construction: the panel
    /// asks for it exactly once per session, and re-deriving it per call would make a one-line UI
    /// read walk the context Data again.
    purpose: Option<String>,
    last_error: Option<String>,
    program_version: (usize, usize, usize),
    entry_term: Box<Term<NamedDeBruijn>>,
    // None for a context-free session (created from a plain UPLC program, no transaction).
    context: Option<ScriptContext>,
    // The raw PlutusData of the context for the "parts" path (which has no typed ScriptContext):
    // get_tx_script_context falls back to serializing this as a Data tree when `context` is None.
    raw_context_data: Option<PlutusData>,
    cost_model: CostModel,
    term_ids: HashSet<i32>,
    version: u64,
    // The profile run lives on its OWN machine (see profile.rs), so it survives stepping the debug
    // session but NOT reset(): reset rebuilds `machine`, and a runner left over from the machine
    // that no longer exists would report a profile of a session the user has since restarted.
    profile_runner: Option<Box<ProfileRunner>>,
}

#[wasm_bindgen]
impl SessionController {
    pub(crate) fn new(
        script_hash: String,
        language: Language,
        program: Box<Program<NamedDeBruijn>>,
        script_context: Option<ScriptContext>,
        raw_context_data: Option<PlutusData>,
        cost_model: CostModel,
        upper_bound_budget: ExBudget,
        declared_budget: Option<ExBudget>,
        redeemer: String,
        purpose_override: Option<String>,
    ) -> Result<Self, JsError> {
        // The purpose the caller HANDED US wins: a parts deep-link's `purpose` field exists exactly
        // for the contexts we cannot read (absent, or valid Data that isn't a ScriptContext), and its
        // generator knew which redeemer this was while we are inferring. Blank counts as absent, so
        // `purpose=` in a URL doesn't suppress a perfectly good derived value.
        let purpose = purpose_override
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .or_else(|| script_context.as_ref().map(|c| purpose_name(c).to_string()))
            .or_else(|| {
                raw_context_data
                    .as_ref()
                    .and_then(crate::script_context::from_plutus_data::script_purpose_name_from_data)
                    .map(str::to_string)
            });
        let program_version = program.version;
        let entry_term = Box::new(program.term);
        let machine = Box::new(ManualMachine::new(
            language.clone(),
            cost_model.clone(),
            upper_bound_budget.clone(),
            DEFAULT_SLIPPAGE,
            (*entry_term).clone(),
        )
        .map_err(|e| {
            DebuggerError::MachineError(format!("Failed to create manual machine: {:?}", e))
        })?);

        let mut term_ids = HashSet::new();
        collect_term_ids(&entry_term, &mut term_ids);

        Ok(SessionController {
            script_hash,
            purpose,
            machine,
            language,
            declared_budget,
            image_budget: upper_bound_budget,
            last_error: None,
            program_version,
            redeemer,
            entry_term,
            context: script_context,
            raw_context_data,
            cost_model,
            term_ids,
            version: 0,
            profile_runner: None,
        })
    }

    pub fn get_tx_script_context(&self) -> Result<String, JsError> {
        // Transaction mode: a typed ScriptContext (named tx_info / redeemer / script_info fields).
        if let Some(context) = self.context.as_ref() {
            let serializable_context: SerializableScriptContext = context
                .try_into()
                .map_err(|e| DebuggerError::MachineError(format!("Failed to convert script context to serializable: {:?}", e)))?;
            return Ok(serde_json::to_string(&serializable_context)
                .map_err(|e| DebuggerError::MachineError(e.to_string()))?);
        }
        // "Parts" mode: no typed ScriptContext, but the caller supplied the context as raw PlutusData.
        // Decode it into the SAME named SerializableScriptContext the session returns in tx mode
        // (inverse of to_plutus_data); fall back to the raw Data tree if it isn't a valid ScriptContext.
        if let Some(data) = self.raw_context_data.as_ref() {
            // catch_unwind so a malformed (valid-PlutusData-but-not-a-ScriptContext) input falls back
            // to the raw Data tree instead of failing the whole call.
            let parsed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::script_context::from_plutus_data::script_context_from_data(data)
            }));
            if let Ok(Ok(ctx)) = parsed {
                return Ok(serde_json::to_string(&ctx)
                    .map_err(|e| DebuggerError::MachineError(e.to_string()))?);
            }
            let serializable = crate::plutus_data::SerializablePlutusData::from_pallas(data);
            return Ok(serde_json::to_string(&serializable)
                .map_err(|e| DebuggerError::MachineError(e.to_string()))?);
        }
        Err(DebuggerError::MachineError(
            "No script context: this session was created from a plain UPLC program (no transaction).".to_string(),
        ).into())
    }

    /// The applied script context as CBOR hex (PlutusData), or "" for a context-free session.
    /// Lets you EXPORT a transaction-derived context to re-use it via the parts deep-link, and is
    /// the round-trip oracle for the parts-mode named-context decoder.
    pub fn get_context_cbor(&self) -> Result<String, JsError> {
        use uplc::tx::to_plutus_data::ToPlutusData;
        // tx mode: the typed context's canonical Plutus encoding. parts mode: the actual Data that was
        // applied (decoded from CBOR or built by the named-JSON forward encoder) — so a JSON-context
        // session can export exactly the bytes the validator saw.
        let data = match (&self.context, &self.raw_context_data) {
            (Some(ctx), _) => ctx.to_plutus_data(),
            (None, Some(raw)) => raw.clone(),
            (None, None) => return Ok(String::new()),
        };
        let bytes = pallas_codec::minicbor::to_vec(&data)
            .map_err(|e| DebuggerError::MachineError(format!("cbor encode context: {e}")))?;
        Ok(hex::encode(bytes))
    }

    /// Gets the Plutus Core version
    pub fn get_plutus_core_version(&self) -> Result<String, JsError> {
        Ok(format!(
            "{}.{}.{}",
            self.program_version.0, self.program_version.1, self.program_version.2
        ))
    }

    /// Gets the Plutus language version
    pub fn get_plutus_language_version(&self) -> Result<Option<String>, JsError> {
        let version = match self.language {
            Language::PlutusV1 => "V1",
            Language::PlutusV2 => "V2",
            Language::PlutusV3 => "V3",
        };
        Ok(Some(version.to_string()))
    }

    pub fn get_script_hash(&self) -> Result<String, JsError> {
        Ok(self.script_hash.clone())
    }

    /// What the script is being run for — `"Spending"`, `"Minting"`, … in tx mode and whenever a
    /// parts-mode context decodes; a parts link's own `purpose` label when it carried one; `""`
    /// (= unknown, the panel prints `—`) when neither source has anything. `""` rather than an
    /// Option to match `get_script_hash`, whose "nothing to report" answer the host already maps.
    pub fn get_script_purpose(&self) -> Result<String, JsError> {
        Ok(self.purpose.clone().unwrap_or_default())
    }

    pub fn get_machine_context(&self) -> Result<String, JsError> {
        let contexts = self.get_machine_context_inner()?;
        Ok(serde_json::to_string(&contexts)
            .map_err(|e| DebuggerError::MachineError(e.to_string()))?)
    }

    pub(crate) fn get_machine_context_inner(&self) -> Result<Vec<SerializableMachineContext>, JsError> {
        let contexts = self.machine.collect_nested_contexts();
        let serializable_contexts: Vec<_> = contexts
            .into_iter()
            .map(|ctx| SerializableMachineContext::from_uplc_context_with_ids(&ctx, &self.term_ids))
            .collect();
        Ok(serializable_contexts)
    }

    pub fn get_logs(&self) -> Result<String, JsError> {
        let traces = self.get_logs_inner()?;
        Ok(serde_json::to_string(&traces)
            .map_err(|e| DebuggerError::MachineError(e.to_string()))?)
    }

    pub(crate) fn get_logs_inner(&self) -> Result<Vec<String>, JsError> {
        let traces = self.machine
            .traces
            .iter()
            .map(|trace| trace.to_string())
            .collect::<Vec<String>>();
        Ok(traces)
    }

    pub fn get_machine_state(&self) -> Result<String, JsError> {
        let state = self.get_machine_state_inner()?;
        Ok(serde_json::to_string(&state)
            .map_err(|e| DebuggerError::MachineError(e.to_string()))?)
    }

    pub(crate) fn get_machine_state_inner(&self) -> Result<SerializableMachineState, JsError> {
        let state = self.machine.current_state();
        let serializable_state = SerializableMachineState::from_uplc_machine_state_with_ids(state, &self.term_ids);
        Ok(serializable_state)
    }

    pub fn get_budget(&self) -> Result<String, JsError> {
        let budget = self.get_budget_inner()?;
        Ok(serde_json::to_string(&budget)
            .map_err(|e| DebuggerError::MachineError(e.to_string()))?)
    }
    
    pub(crate) fn get_budget_inner(&self) -> Result<SerializableBudget, JsError> {
        let spent_budget = self.machine.ex_budget;
        let image_budget = self.image_budget.clone();
        let cpu_diff = image_budget.cpu - spent_budget.cpu;
        let mem_diff = image_budget.mem - spent_budget.mem;
        let budget = SerializableBudget {
            ex_units_spent: cpu_diff,
            // Only a session that was GIVEN a limit reports one. `image_budget` is the machine's
            // cap (ExBudget::max(), so a script that overspends is still steppable), never a
            // denominator to divide by.
            ex_units_available: self.declared_budget.map(|b| b.cpu),
            memory_units_spent: mem_diff,
            memory_units_available: self.declared_budget.map(|b| b.mem),
        };
        Ok(budget)
    }

    pub fn get_script(&self) -> Result<String, JsError> {
        let script = self.get_script_inner()?;
        Ok(script.to_json()
            .map_err(|e| DebuggerError::MachineError(e.to_string()))?)
    }

    pub(crate) fn get_script_inner(&self) -> Result<SerializableTerm, JsError> {
        let term = self.entry_term.as_ref();
        let serializable_term = SerializableTerm::from_uplc_term(term);
        Ok(serializable_term)
    }

    pub fn get_current_term_id(&self) -> Result<i32, JsError> {
        match self.machine.current_state() {
            MachineState::Compute(_, _, term) => Ok(term.uniq_id() as i32),
            MachineState::Done(term) => match term {
                // Error result: the real failing source term manual_machine captured.
                Term::Error { uniq_id } => Ok(*uniq_id as i32),
                // A success result is a DISCHARGED value with a synthetic id not in the source, so
                // point at the last real source term that ran instead — "where execution finished".
                _ => Ok(self.machine.last_term_id() as i32),
            },
            // A Return state is mid-reduction with a value in hand (no single "current term").
            MachineState::Return(_, _) => Ok(-1),
        }
    }

    pub(crate) fn get_current_env_inner(&self) -> Result<SerializableEnv, JsError> {
        match self.machine.current_state() {
            MachineState::Compute(_, env, _) => {
                let serializable_env: SerializableEnv = SerializableEnv::from_uplc_env_with_ids(env, &self.term_ids);
                Ok(serializable_env)
            }
            _ => Ok(SerializableEnv {
                values: vec![],
            }),
        }
    }

    pub fn get_redeemer(&self) -> Result<String, JsError> {
        Ok(self.redeemer.clone())
    }

    pub fn get_current_env(&self) -> Result<String, JsError> {
        let env = self.get_current_env_inner()?;
        Ok(serde_json::to_string(&env)
            .map_err(|e| DebuggerError::MachineError(e.to_string()))?)
    }

    fn step_inner(&mut self) -> Result<super::StepResult, JsError> {
        let term_id = self.get_current_term_id()?;
        self.version += 1;
        let status: &uplc::manual_machine::ExecutionStatus = self.machine.step();
        let serializable_status: SerializableExecutionStatus = status.into();
        
        Ok(super::StepResult {
            term_id,
            status: serializable_status,
        })
    }

    pub fn step(&mut self) -> Result<String, JsError> {
        let result = self.step_inner()?;
        Ok(serde_json::to_string(&result)
            .map_err(|e| DebuggerError::MachineError(e.to_string()))?)
    }

    /// Creates (or restarts) the profile runner: a SECOND machine over the same entry term, cost
    /// model and language. The debug session's machine, its position and its trace buffer are not
    /// touched — which is why profiling is allowed while the session is paused.
    ///
    /// Runs under v2 attribution: a Return step is charged to the apply site it returns into,
    /// not to whatever node happened to execute last. v1 stays constructible — `tests.rs` profiles
    /// the same program under both rules — but it is not what a session reports.
    pub fn profile_start(&mut self) -> Result<(), JsError> {
        self.profile_runner = Some(Box::new(ProfileRunner::new(
            self.language.clone(),
            self.cost_model.clone(),
            &self.entry_term,
            &self.term_ids,
            ProfileAttribution::ApplySite,
        )?));
        Ok(())
    }

    /// Runs one chunk of the profile, at most `max_steps` steps. `max_steps` bounds the CHUNK, not
    /// the run: exhausting it on an unfinished program returns `Running`, and the cap on the whole
    /// run (plus cancellation) is the host's — the engine never emits `Limit` or `Cancelled`.
    pub fn profile_run(&mut self, max_steps: u32) -> Result<String, JsError> {
        let runner = self.profile_runner.as_mut().ok_or_else(|| {
            DebuggerError::MachineError("No profile run in progress: call profile_start() first.".to_string())
        })?;
        let result = runner.run_chunk(max_steps);
        Ok(serde_json::to_string(&result)
            .map_err(|e| DebuggerError::MachineError(e.to_string()))?)
    }

    /// The full profile of whatever has run so far. Valid mid-run (`outcome: Running`) and after a
    /// script failure (`outcome: Error`) — a partial profile is still a truthful one.
    pub fn profile_report(&self) -> Result<String, JsError> {
        let runner = self.profile_runner.as_ref().ok_or_else(|| {
            DebuggerError::MachineError("No profile to report: call profile_start() first.".to_string())
        })?;
        // Only what the caller DECLARED. A tx session takes it from the redeemer's ex_units and a
        // parts deep-link may carry it explicitly; neither is derivable from the program, so a
        // session without one reports no limit rather than a percentage of ExBudget::default().
        let (cpu_limit, mem_limit) = match self.declared_budget {
            Some(b) => (Some(b.cpu), Some(b.mem)),
            None => (None, None),
        };
        let report = runner.report(&self.entry_term, cpu_limit, mem_limit);
        // Serialise into a PRE-SIZED buffer rather than `to_string`. A `String` that grows by
        // doubling reaches its final size having also allocated ~2x it in abandoned buffers, and the
        // report is the largest single allocation the profiler makes: measured on a 262k-node term
        // (29.7 MB of JSON) the engine heap went 44 MB → 125 MB across this one call. One row is
        // ~118 bytes of JSON; reserving that up front turns the growth into a single allocation.
        let mut buf = Vec::with_capacity(report.terms.len() * 128 + 64 * 1024);
        serde_json::to_writer(&mut buf, &report)
            .map_err(|e| DebuggerError::MachineError(e.to_string()))?;
        Ok(String::from_utf8(buf)
            .map_err(|e| DebuggerError::MachineError(e.to_string()))?)
    }

    /// The profile runner, for the invariant tests (they check our step accounting against the
    /// machine's own `spend_counter`).
    #[cfg(test)]
    pub(crate) fn profile_runner(&self) -> Option<&ProfileRunner> {
        self.profile_runner.as_deref()
    }

    /// The parsed program, for the subtree test: `total == self + Σ children.total` is a statement
    /// about the AST, and the report alone carries no structure to check it against.
    #[cfg(test)]
    pub(crate) fn entry_term(&self) -> &Term<NamedDeBruijn> {
        &self.entry_term
    }

    /// Resets the session program back to its initial state
    pub fn reset(&mut self) -> Result<(), JsError> {
        self.version += 1;
        
        // Create a new machine with the original entry term and initial budget
        let new_machine = ManualMachine::new(
            self.language.clone(),
            self.cost_model.clone(),
            self.image_budget.clone(),
            DEFAULT_SLIPPAGE,
            (*self.entry_term).clone(),
        )
        .map_err(|e| {
            DebuggerError::MachineError(format!("Failed to reset manual machine: {:?}", e))
        })?;

        // Replace the current machine with the new one
        self.machine = Box::new(new_machine);

        // Clear any last error
        self.last_error = None;

        // Drop the profile runner with it: Start / Restart / Stop all land here, and a runner that
        // outlived the machine it was started next to would answer profile_report() for a session
        // that no longer exists. The host reads this as "Continue profiling is no longer possible".
        self.profile_runner = None;

        Ok(())
    }

    pub fn get_last_error(&self) -> Option<String> {
        self.last_error.clone()
    }

    /// Gets the current version number of the session controller
    pub fn get_version(&self) -> u64 {
        self.version
    }
    
    /// Get machine state with lazy loading support
    /// 
    /// # Arguments
    /// * `path` - JSON array of path segments to navigate to specific element
    /// * `return_full_object` - If true, returns full object at path; if false, returns object with children 1 level deep only
    pub fn get_machine_state_lazy(&self, path: String, return_full_object: bool) -> Result<String, JsError> {
        let path_segments = LazySessionApi::parse_path(&path)?;
        LazySessionApi::get_machine_state_lazy(&self.machine, &self.term_ids, path_segments, return_full_object)
    }
    
    /// Get current environment with lazy loading support
    /// 
    /// # Arguments
    /// * `path` - JSON array of path segments to navigate to specific element
    /// * `return_full_object` - If true, returns full object at path; if false, returns object with children 1 level deep only
    pub fn get_current_env_lazy(&self, path: String, return_full_object: bool) -> Result<String, JsError> {
        let path_segments = LazySessionApi::parse_path(&path)?;
        LazySessionApi::get_current_env_lazy(&self.machine, &self.term_ids, path_segments, return_full_object)
    }
    
    /// Get machine context with lazy loading support
    /// 
    /// # Arguments
    /// * `path` - JSON array of path segments to navigate to specific element (e.g., ["0", "env", "values", "2"])
    /// * `return_full_object` - If true, returns full object at path; if false, returns object with children 1 level deep only
    pub fn get_machine_context_lazy(&self, path: String, return_full_object: bool) -> Result<String, JsError> {
        let path_segments = LazySessionApi::parse_path(&path)?;
        LazySessionApi::get_machine_context_lazy(&self.machine, &self.term_ids, path_segments, return_full_object)
    }
}


/// The purpose name of a TYPED context (tx mode). V1/V2's `ScriptPurpose` is `ScriptInfo<()>` and
/// V3's carries the datum, so one generic match covers both — and the names it produces are the
/// same ones `script_purpose_name_from_data` reads out of raw context Data in parts mode.
fn purpose_name(context: &ScriptContext) -> &'static str {
    fn named<T>(info: &uplc::tx::script_context::ScriptInfo<T>) -> &'static str {
        use uplc::tx::script_context::ScriptInfo;
        match info {
            ScriptInfo::Minting(..) => "Minting",
            ScriptInfo::Spending(..) => "Spending",
            ScriptInfo::Rewarding(..) => "Rewarding",
            ScriptInfo::Certifying(..) => "Certifying",
            ScriptInfo::Voting(..) => "Voting",
            ScriptInfo::Proposing(..) => "Proposing",
        }
    }
    match context {
        ScriptContext::V1V2 { purpose, .. } => named(purpose.as_ref()),
        ScriptContext::V3 { purpose, .. } => named(purpose.as_ref()),
    }
}

fn collect_term_ids(term: &Term<NamedDeBruijn>, term_ids: &mut HashSet<i32>) {
    // First, collect the current term's ID
    let uniq_id = match term {
        Term::Var { uniq_id, .. }
        | Term::Delay { uniq_id, .. }
        | Term::Lambda { uniq_id, .. }
        | Term::Apply { uniq_id, .. }
        | Term::Constant { uniq_id, .. }
        | Term::Force { uniq_id, .. }
        | Term::Error { uniq_id, .. }
        | Term::Builtin { uniq_id, .. }
        | Term::Constr { uniq_id, .. }
        | Term::Case { uniq_id, .. } => *uniq_id as i32,
    };
    
    term_ids.insert(uniq_id);
    
    // Then recursively collect IDs from nested terms
    match term {
        Term::Delay { body, .. } => {
            collect_term_ids(body, term_ids);
        }
        Term::Lambda { body, .. } => {
            collect_term_ids(body, term_ids);
        }
        Term::Apply { function, argument, .. } => {
            collect_term_ids(function, term_ids);
            collect_term_ids(argument, term_ids);
        }
        Term::Force { body, .. } => {
            collect_term_ids(body, term_ids);
        }
        Term::Constr { fields, .. } => {
            for field in fields {
                collect_term_ids(field, term_ids);
            }
        }
        Term::Case { constr, branches, .. } => {
            collect_term_ids(constr, term_ids);
            for branch in branches {
                collect_term_ids(branch, term_ids);
            }
        }
        // These variants don't contain nested terms
        Term::Var { .. }
        | Term::Constant { .. }
        | Term::Error { .. }
        | Term::Builtin { .. } => {
            // No nested terms to process
        }
    }
}
