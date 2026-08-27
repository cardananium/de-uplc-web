use std::collections::HashSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use pallas_primitives::conway::Language;
use uplc::{
    ast::{NamedDeBruijn, Term},
    builtins::DefaultFunction,
    machine::{
        cost_model::{CostModel, ExBudget, StepKind},
        value::Value,
        Context, MachineState, BUILTIN_COUNT, TERM_COUNT,
    },
    manual_machine::{ExecutionStatus, ManualMachine},
};

use crate::debugger_engine::DebuggerError;
use crate::wasm_tools::JsError;

/// The profile run drives its OWN machine one CEK step at a time, so slippage MUST be 1: with a
/// larger slippage the machine batches step costs and a single `step()` would carry the cost of
/// several earlier steps — exactly what per-step attribution cannot untangle. It is also what
/// makes the builtin/machine split exact: at slippage 1 a Compute step charges its own step kind
/// and nothing else, and a Return step charges nothing but the builtin that fired on it.
const PROFILE_SLIPPAGE: u32 = 1;

/// Timeline sample budget. Samples are thinned by halving (drop every other one, double the
/// interval) whenever the buffer fills, so a run of ANY length ends up as 256..512 evenly spaced
/// cumulative samples without knowing the step count in advance.
const TIMELINE_SAMPLES: usize = 512;

/// How many traces a profile keeps. Measured: 100k traces cost ~8.6 MB of engine heap during the run
/// and turned a 0.02 MB report into 7.3 MB, and nothing bounds the count but the script's loop. The
/// prefix is what is worth keeping, and `traces_dropped` reports the rest.
const TRACE_CAP: usize = 10_000;

/// The nine machine step kinds in `spend_counter` order. Written out rather than derived from
/// `StepKind::try_from` so the index ↔ kind mapping this file assumes is the one the machine uses:
/// `spend_counter[i * 2]` is mem and `[i * 2 + 1]` is cpu of `MACHINE_STEP_KINDS[i]`.
const MACHINE_STEP_KINDS: [StepKind; TERM_COUNT] = [
    StepKind::Constant,
    StepKind::Var,
    StepKind::Lambda,
    StepKind::Apply,
    StepKind::Delay,
    StepKind::Force,
    StepKind::Builtin,
    StepKind::Constr,
    StepKind::Case,
];

// ── Data model ───────────────────────────────────────────────────────────────

/// A finished (or interrupted) profile of one program: where its ExUnits went, per node of the
/// source term, per builtin and per machine step kind. This is a profile of TERM NODES, not of
/// functions — UPLC has none, and recursion collapses into one node with many hits.
#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SerializableProfile {
    pub totals: ProfileTotals,
    /// One row per term node that actually executed (`hits > 0`). Nodes that never ran are NOT
    /// emitted — a 200k-node program would otherwise pay for 200k zero rows on every report, and
    /// the report derives "never evaluated" from `termLocations` minus these rows anyway.
    /// A node runs only if its parent ran, so every node with a non-zero subtree cost is present.
    pub terms: Vec<ProfileTerm>,
    /// Only builtins that actually fired, in `DefaultFunction` order.
    pub builtins: Vec<ProfileBuiltin>,
    /// All nine machine step kinds in `StepKind` order (zeros included — the report renders them as
    /// a fixed table) plus a tenth `StartUp` row. StartUp is not a machine step but the flat
    /// charge in `ManualMachine::new`; it is here because the invariant it feeds is
    /// `Σ builtins + Σ steps == cpu_spent`, and the startup charge belongs to no node.
    pub steps: Vec<ProfileStep>,
    pub timeline: Vec<ProfileSample>,
    /// The first `TRACE_CAP` traces the profiled run emitted, in order. Capped because a script that
    /// traces per iteration is otherwise unbounded: 100k traces measured at ~8.6 MB of engine heap
    /// and a 7.3 MB report, and nothing about the machine stops that growing with the loop count.
    pub traces: Vec<ProfileTrace>,
    /// Traces past the cap. Non-zero means `traces` is a prefix, and the UI has to say so rather
    /// than present a truncated log as the whole log ("no silent caps").
    pub traces_dropped: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTotals {
    pub steps: u64,
    pub cpu_spent: i64,
    pub mem_spent: i64,
    /// The flat charge `ManualMachine::new` takes before the first step. Part of `cpu_spent`, but
    /// attributed to no term node — hence node self-costs sum to `cpu_spent - startup_cpu`.
    pub startup_cpu: i64,
    pub startup_mem: i64,
    /// The ExUnits DECLARED by the session's redeemer, or `None` when the session has no redeemer
    /// (scriptOnly / parts). Without this the report would show a plausible-looking percentage of
    /// `ExBudget::default()` — a generic reference budget unrelated to this script's declared units.
    pub cpu_limit: Option<i64>,
    pub mem_limit: Option<i64>,
    pub attribution: ProfileAttribution,
    pub outcome: ProfileOutcome,
}

/// Which attribution rule charged the Return steps of this run. Read by the UI for the `≈` markers and the
/// attribution sentence — the marker only means anything while `last_term` is in effect.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, JsonSchema)]
pub enum ProfileAttribution {
    /// A Return step is charged to the last term that actually executed. Cheap, but it lands a
    /// builtin's cost on its ARGUMENT node. Still constructible (and pinned by the v1/v2 tests as
    /// the baseline the apply-site rule is compared against); no live session selects it.
    #[serde(rename = "last_term")]
    LastTerm,
    /// A Return step is charged to the apply site it returns into, tracked by a shadow stack of
    /// `Term::Apply` ids. What every session reports.
    #[serde(rename = "apply_site")]
    ApplySite,
}

/// How the profiled run ended. Internally tagged (like `SerializableExecutionStatus`) so the TS
/// union discriminates on `outcome_type`; `Limit` and `Cancelled` are host labels, not engine
/// outcomes — the step cap and the cancel flag live in the store.
#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "outcome_type")]
pub enum ProfileOutcome {
    /// The report was taken mid-run — the program has not finished.
    #[serde(rename = "Running")]
    Running,
    #[serde(rename = "Done")]
    Done,
    // `rename_all` on the enum would rename the VARIANTS, not their fields, so the payload of this
    // one carries its own — every field of the profile payload is camelCase; only the discriminant
    // `outcome_type` is not, and that name is fixed by the contract with the store.
    #[serde(rename = "Error", rename_all = "camelCase")]
    Error {
        message: String,
        /// The node the script died on, so "Go to failure" has somewhere to lead. `-1` when the
        /// machine could not name one.
        term_id: i32,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTerm {
    pub term_id: i32,
    pub hits: u64,
    pub self_cpu: i64,
    pub self_mem: i64,
    /// Self summed over this node's static AST descendants, plus its own self.
    pub total_cpu: i64,
    pub total_mem: i64,
    /// The part of self charged on Return steps. Under `last_term` attribution a row whose
    /// `return_cpu / self_cpu >= 0.5` is knowingly approximate (v1 puts a builtin's cost on its
    /// argument), and the report marks it `≈`.
    pub return_cpu: i64,
    pub return_mem: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBuiltin {
    /// The Plutus name as the term viewer renders it (`unConstrData`), not the Aiken snake_case one.
    pub name: String,
    pub calls: u64,
    pub cpu: i64,
    pub mem: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStep {
    pub kind: String,
    pub count: u64,
    pub cpu: i64,
    pub mem: i64,
}

/// A cumulative spend sample: `cpu`/`mem` are totals as of `step`, not deltas.
#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSample {
    pub step: u64,
    pub cpu: i64,
    pub mem: i64,
}

/// One `trace` emitted during the PROFILE run, from the runner's own machine buffer — the debug
/// session's log is a different buffer and this run does not touch it.
#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTrace {
    pub index: u32,
    pub message: String,
    pub term_id: i32,
    pub step: u64,
}

/// What one `profile_run(max_steps)` chunk reports back. `steps`/`cpu`/`mem` are cumulative since
/// `profile_start()`, and `outcome` is `Running` whenever the chunk merely ran out of its own
/// budget: `max_steps` bounds the CHUNK, never the run — the step cap is the host's.
#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRunResult {
    pub outcome: ProfileRunOutcome,
    pub steps: u64,
    pub cpu: i64,
    pub mem: i64,
}

/// Plain string union (`'Running' | 'Done' | 'Error'`) — the chunk result carries no payload, so it
/// needs no tag object; the failure message and node arrive with the report.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, JsonSchema)]
pub enum ProfileRunOutcome {
    #[serde(rename = "Running")]
    Running,
    #[serde(rename = "Done")]
    Done,
    #[serde(rename = "Error")]
    Error,
}

// ── Accumulators ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default)]
struct TermAcc {
    hits: u64,
    self_cpu: i64,
    self_mem: i64,
    return_cpu: i64,
    return_mem: i64,
}

#[derive(Clone, Copy, Debug, Default)]
struct BuiltinAcc {
    calls: u64,
    cpu: i64,
    mem: i64,
}

#[derive(Clone, Copy, Debug, Default)]
struct StepAcc {
    count: u64,
    cpu: i64,
    mem: i64,
}

/// Everything the attribution rule reads off the PRE-step state. Copy and tiny, so the immutable
/// borrow of the machine ends before `step()` takes a mutable one.
#[derive(Clone, Copy)]
enum PreStep {
    Compute {
        site: isize,
        kind: Option<StepKind>,
    },
    Return {
        /// The v1 site — and v2's fallback wherever a Return step has no apply site behind it.
        last_term: isize,
        frame: FrameOp,
        fun: Option<DefaultFunction>,
    },
    Done,
}

/// What a Return step does to the shadow stack of apply sites, read in O(1) off the frame
/// the step is about to consume — the frame `machine.current_context()` hands out, which we already
/// have destructured out of `current_state()`.
///
/// Derived from `return_compute`, one arm at a time: `FrameAwaitFunTerm` becomes `FrameAwaitArg`
/// (same site, still pending), `FrameAwaitArg` / `FrameAwaitFunValue` go into `apply_evaluate` (the
/// application HAPPENS, and this is the only place a builtin can fire on an application), a
/// `FrameCases` over a `Constr` becomes N `FrameAwaitFunValue` frames via `transfer_arg_stack`, and
/// `FrameForce` / `FrameConstr` / `NoFrame` never touch an apply site at all.
#[derive(Clone, Copy, PartialEq, Debug)]
enum FrameOp {
    /// `FrameAwaitFunTerm` → `FrameAwaitArg`: this step is part of the site, which stays pending.
    Keep,
    /// `FrameAwaitArg` / `FrameAwaitFunValue`: the frame is consumed here and is gone afterwards.
    Consume,
    /// `FrameCases` on a `Constr` of N fields: N applications appear that no `Term::Apply` opened.
    Transfer(usize),
    /// `FrameForce`, `FrameConstr`, `NoFrame`: the stack is untouched.
    Other,
}

// ── The runner ────────────────────────────────────────────────────────────────────

/// Runs a program to completion on its OWN machine and attributes every unit it spends.
///
/// The runner never touches `SessionController::machine`: the debug session keeps its state, its
/// breakpoint position and — because `traces` is a field of the machine — its log buffer. It always
/// runs at `ExBudget::max()`, like the debug session, so `OutOfExError` cannot end the run;
/// overspend against the declared redeemer units is a number the report shows, not a failure.
#[derive(Clone, Debug)]
pub struct ProfileRunner {
    machine: Box<ManualMachine>,
    /// Which attribution rule charges the Return steps of this run. Chosen once, at `new()`, and reported in
    /// `totals.attribution` — the UI reads it to decide whether the `≈` marker means anything.
    attribution: ProfileAttribution,
    /// The v2 shadow stack: one entry per pending application frame, innermost last. `Some(id)` is a
    /// source `Term::Apply` awaiting its function or its argument; `None` is an application the
    /// machine synthesised itself (`transfer_arg_stack` after a `case`), which no source node owns.
    /// It mirrors, exactly, the `FrameAwaitFunTerm`/`FrameAwaitArg`/`FrameAwaitFunValue` frames of
    /// the machine's context — frames are strictly LIFO, so the frame a Return step consumes is
    /// always the top entry here. Maintained under BOTH rules, so switching `attribution` changes
    /// where cost lands and nothing else.
    apply_stack: Vec<Option<isize>>,
    image_budget: ExBudget,
    startup: ExBudget,
    steps: u64,
    /// The lowest id in the session's `term_ids`; `terms` is indexed by `id - id_base`.
    id_base: i32,
    /// Dense accumulators covering `min..=max` of the session's term ids. Dense rather than a map
    /// because this is touched on every one of up to 10M steps. The range is NOT proof of
    /// membership: the id generator is global, monotonic and never reset in a live worker
    /// (`uplc/src/global_uniq.rs`), so a previously parsed program has already burned its stretch —
    /// which is why the report emits ids as-is and the UI reports the ones it cannot place.
    terms: Vec<TermAcc>,
    /// Anything charged to an id outside that range (the `-1` sentinel, a discharged value).
    synthetic: TermAcc,
    builtins: Vec<BuiltinAcc>,
    step_kinds: Vec<StepAcc>,
    timeline: Vec<ProfileSample>,
    timeline_interval: u64,
    /// `(term_id, step)` per trace, positionally aligned with `machine.traces`.
    trace_marks: Vec<(i32, u64)>,
    /// Traces discarded once `machine.traces` hit `TRACE_CAP` (see the field of the same name on
    /// `SerializableProfile`).
    traces_dropped: u64,
}

impl ProfileRunner {
    pub(crate) fn new(
        language: Language,
        cost_model: CostModel,
        entry_term: &Term<NamedDeBruijn>,
        term_ids: &HashSet<i32>,
        attribution: ProfileAttribution,
    ) -> Result<Self, JsError> {
        let startup = cost_model.machine_costs.get(StepKind::StartUp);
        let image_budget = ExBudget::max();
        let machine = Box::new(
            ManualMachine::new_debug(
                language,
                cost_model,
                image_budget,
                PROFILE_SLIPPAGE,
                entry_term.clone(),
            )
            .map_err(|e| {
                DebuggerError::MachineError(format!("Failed to create profile machine: {:?}", e))
            })?,
        );

        // An empty id set is impossible for a parsed program, but a zero-width dense range is still
        // correct: everything then lands in `synthetic`.
        let min = term_ids.iter().copied().min().unwrap_or(0);
        let max = term_ids.iter().copied().max().unwrap_or(min);
        let span = (max as i64 - min as i64 + 1).max(0) as usize;

        Ok(ProfileRunner {
            machine,
            attribution,
            apply_stack: Vec::new(),
            image_budget,
            startup,
            steps: 0,
            id_base: min,
            terms: vec![TermAcc::default(); span],
            synthetic: TermAcc::default(),
            builtins: vec![BuiltinAcc::default(); BUILTIN_COUNT],
            step_kinds: vec![StepAcc::default(); TERM_COUNT],
            timeline: Vec::new(),
            timeline_interval: 1,
            trace_marks: Vec::new(),
            traces_dropped: 0,
        })
    }

    /// Steps the machine up to `max_steps` times, attributing each step by the active rule.
    pub(crate) fn run_chunk(&mut self, max_steps: u32) -> ProfileRunResult {
        let mut taken: u32 = 0;

        while taken < max_steps && self.machine.is_ready() {
            let pre = match self.machine.current_state() {
                MachineState::Compute(_, _, term) => PreStep::Compute {
                    site: term.uniq_id(),
                    kind: step_kind_of(term),
                },
                // A Return step has no term of its own. v1 charges it to the last node that really
                // executed; v2 charges it to the apply site whose frame it is consuming. Both
                // are read here, before `step()` takes the machine mutably.
                MachineState::Return(context, value) => PreStep::Return {
                    last_term: self.machine.last_term_id(),
                    frame: frame_op(context, value),
                    fun: firing_builtin(context, value),
                },
                MachineState::Done(_) => PreStep::Done,
            };

            let (site, kind, fun, is_return) = match pre {
                // `Done` is not a step: let the machine settle its status and stop counting.
                PreStep::Done => {
                    self.machine.step();
                    break;
                }
                PreStep::Compute { site, kind } => {
                    // A `Term::Apply` OPENS an apply site: `compute` pushes `FrameAwaitFunTerm`, and
                    // the site stays pending until that frame — by then in its `FrameAwaitArg` form
                    // — is consumed. The Compute step itself is charged to the Apply node under both
                    // rules; only the Return steps in between move.
                    if matches!(kind, Some(StepKind::Apply)) {
                        self.apply_stack.push(Some(site));
                    }
                    (site, kind, None, false)
                }
                PreStep::Return { last_term, frame, fun } => {
                    let site = match self.attribution {
                        ProfileAttribution::LastTerm => last_term,
                        // v2. `Keep`/`Consume` are exactly the frames a source `Term::Apply` puts on
                        // the stack, and the top entry is the one being consumed. A `None` there is a
                        // machine-synthesised application (a `case` branch applied to a constr field)
                        // and an empty stack is a Return outside any application at all — neither has
                        // an apply site, so both keep the v1 site rather than borrow an unrelated one.
                        ProfileAttribution::ApplySite => match frame {
                            FrameOp::Keep | FrameOp::Consume => {
                                self.apply_stack.last().copied().flatten().unwrap_or(last_term)
                            }
                            FrameOp::Transfer(_) | FrameOp::Other => last_term,
                        },
                    };
                    match frame {
                        FrameOp::Consume => {
                            self.apply_stack.pop();
                        }
                        // The N frames `transfer_arg_stack` pushes have to occupy the stack even
                        // though no source node owns them: otherwise the next `Consume` would pop a
                        // real apply site that is still pending, and every site above it would shift.
                        FrameOp::Transfer(n) => {
                            self.apply_stack.resize(self.apply_stack.len() + n, None);
                        }
                        FrameOp::Keep | FrameOp::Other => {}
                    }
                    (site, None, fun, true)
                }
            };

            // The builtin's own cost comes out of `spend_counter` EXACTLY: one slot read before and
            // after the step for the single candidate — O(1), no scan of the 87-builtin array.
            let before_builtin = fun.map(|fun| self.builtin_slot(fun));
            let before = self.machine.ex_budget;

            self.machine.step();

            let d_mem = before.mem - self.machine.ex_budget.mem;
            let d_cpu = before.cpu - self.machine.ex_budget.cpu;

            let (b_mem, b_cpu) = match (fun, before_builtin) {
                (Some(fun), Some((mem0, cpu0))) => {
                    let (mem1, cpu1) = self.builtin_slot(fun);
                    (mem1 - mem0, cpu1 - cpu0)
                }
                _ => (0, 0),
            };
            if let Some(fun) = fun {
                // A non-zero slot delta is what "the builtin fired" means: a step that only pushes
                // an argument into the runtime spends nothing, and no builtin costs zero.
                if b_mem != 0 || b_cpu != 0 {
                    let acc = &mut self.builtins[fun as usize];
                    acc.calls += 1;
                    acc.cpu += b_cpu;
                    acc.mem += b_mem;
                }
            }

            // What is left of the step is the machine's own step-kind charge. At slippage 1 that is
            // the whole delta on a Compute step and exactly zero on a Return step — the equality
            // `Σ builtins + Σ steps == cpu_spent` is what holds us to it, and tests.rs checks it.
            if let Some(kind) = kind {
                let acc = &mut self.step_kinds[kind as usize];
                acc.count += 1;
                acc.cpu += d_cpu - b_cpu;
                acc.mem += d_mem - b_mem;
            }

            let acc = self.term_acc_mut(site);
            acc.hits += 1;
            acc.self_cpu += d_cpu;
            acc.self_mem += d_mem;
            if is_return {
                acc.return_cpu += d_cpu;
                acc.return_mem += d_mem;
            }

            self.steps += 1;
            taken += 1;

            // `traces` only grows, and only the builtin that fired on THIS step can have appended to
            // it, so aligning marks positionally is exact and costs one length compare per step.
            while self.trace_marks.len() < self.machine.traces.len() {
                self.trace_marks.push((site as i32, self.steps));
            }

            // Bound the log. `ManualMachine.traces` is an unbounded `Vec` the machine appends to on
            // every `trace` call, so a loop that traces per iteration grows the ENGINE heap for the
            // whole run and then the report on top of it. Keeping the first `TRACE_CAP` and counting
            // the rest bounds both, and the prefix is the useful part: it is where a script says what
            // it decided before it went wrong. Truncating the runner's own machine cannot disturb the
            // debug session — that one has its own `ManualMachine`.
            if self.machine.traces.len() > TRACE_CAP {
                self.traces_dropped += (self.machine.traces.len() - TRACE_CAP) as u64;
                self.machine.traces.truncate(TRACE_CAP);
                self.trace_marks.truncate(TRACE_CAP);
            }

            if self.steps % self.timeline_interval == 0 {
                self.push_sample();
            }
        }

        let spent = self.spent();
        ProfileRunResult {
            outcome: match self.machine.status() {
                ExecutionStatus::Ready => ProfileRunOutcome::Running,
                ExecutionStatus::Done(_) => ProfileRunOutcome::Done,
                ExecutionStatus::Error(_) => ProfileRunOutcome::Error,
            },
            steps: self.steps,
            cpu: spent.cpu,
            mem: spent.mem,
        }
    }

    /// Builds the full report. Subtree costs are one post-order walk of the entry term done HERE and
    /// not maintained per step: `total` is a pure function of the `self` accumulators plus the
    /// static AST, and walking 200k nodes once beats touching every ancestor on every step.
    pub(crate) fn report(
        &self,
        entry_term: &Term<NamedDeBruijn>,
        cpu_limit: Option<i64>,
        mem_limit: Option<i64>,
    ) -> SerializableProfile {
        let mut subtotals = vec![(0i64, 0i64); self.terms.len()];
        self.walk_subtree(entry_term, &mut subtotals);

        let mut terms: Vec<ProfileTerm> = self
            .terms
            .iter()
            .enumerate()
            .filter(|(_, acc)| acc.hits > 0)
            .map(|(i, acc)| ProfileTerm {
                term_id: self.id_base + i as i32,
                hits: acc.hits,
                self_cpu: acc.self_cpu,
                self_mem: acc.self_mem,
                total_cpu: subtotals[i].0,
                total_mem: subtotals[i].1,
                return_cpu: acc.return_cpu,
                return_mem: acc.return_mem,
            })
            .collect();
        if self.synthetic.hits > 0 {
            // No id, so no source location and no subtree: it is reported, not hidden, because its
            // cost is part of the run and the percentages have to add up.
            terms.push(ProfileTerm {
                term_id: -1,
                hits: self.synthetic.hits,
                self_cpu: self.synthetic.self_cpu,
                self_mem: self.synthetic.self_mem,
                total_cpu: self.synthetic.self_cpu,
                total_mem: self.synthetic.self_mem,
                return_cpu: self.synthetic.return_cpu,
                return_mem: self.synthetic.return_mem,
            });
        }

        let builtins = self
            .builtins
            .iter()
            .enumerate()
            .filter(|(_, acc)| acc.calls > 0)
            .filter_map(|(i, acc)| {
                DefaultFunction::try_from(i as u8).ok().map(|fun| ProfileBuiltin {
                    name: fun.to_string(),
                    calls: acc.calls,
                    cpu: acc.cpu,
                    mem: acc.mem,
                })
            })
            .collect();

        let mut steps: Vec<ProfileStep> = MACHINE_STEP_KINDS
            .iter()
            .map(|kind| {
                let acc = self.step_kinds[*kind as usize];
                ProfileStep {
                    kind: step_kind_name(*kind).to_string(),
                    count: acc.count,
                    cpu: acc.cpu,
                    mem: acc.mem,
                }
            })
            .collect();
        steps.push(ProfileStep {
            kind: step_kind_name(StepKind::StartUp).to_string(),
            count: 1,
            cpu: self.startup.cpu,
            mem: self.startup.mem,
        });

        let mut timeline = self.timeline.clone();
        let spent = self.spent();
        // The thinned series can end well before the last step; close it so the curve reaches the
        // totals the rest of the report shows.
        if timeline.last().map(|s| s.step) != Some(self.steps) {
            timeline.push(ProfileSample {
                step: self.steps,
                cpu: spent.cpu,
                mem: spent.mem,
            });
        }

        let traces = self
            .machine
            .traces
            .iter()
            .enumerate()
            .map(|(i, trace)| {
                let (term_id, step) = self.trace_marks.get(i).copied().unwrap_or((-1, 0));
                ProfileTrace {
                    index: i as u32,
                    message: trace.to_string(),
                    term_id,
                    step,
                }
            })
            .collect();

        SerializableProfile {
            totals: ProfileTotals {
                steps: self.steps,
                cpu_spent: spent.cpu,
                mem_spent: spent.mem,
                startup_cpu: self.startup.cpu,
                startup_mem: self.startup.mem,
                cpu_limit,
                mem_limit,
                attribution: self.attribution,
                outcome: self.outcome(),
            },
            terms,
            builtins,
            steps,
            timeline,
            traces,
            traces_dropped: self.traces_dropped,
        }
    }

    /// The runner's machine — for the invariant tests, which check our own step accounting against
    /// the machine's `spend_counter`.
    #[cfg(test)]
    pub(crate) fn machine(&self) -> &ManualMachine {
        &self.machine
    }

    /// The v2 shadow stack, innermost last — for the test that pins it against the machine's own
    /// context stack after every single step. Nothing outside the tests may read it: the stack is
    /// an implementation detail of the attribution rule, not part of the report.
    #[cfg(test)]
    pub(crate) fn apply_stack(&self) -> &[Option<isize>] {
        &self.apply_stack
    }

    fn outcome(&self) -> ProfileOutcome {
        match self.machine.status() {
            ExecutionStatus::Ready => ProfileOutcome::Running,
            ExecutionStatus::Done(_) => ProfileOutcome::Done,
            ExecutionStatus::Error(error) => ProfileOutcome::Error {
                message: error.to_string(),
                // On failure the machine parks the id of the term that failed in the Done state, so
                // the report can point at the node the script died on.
                term_id: match self.machine.current_state() {
                    MachineState::Done(Term::Error { uniq_id }) => *uniq_id as i32,
                    _ => -1,
                },
            },
        }
    }

    /// Everything spent so far, startup charge included (the image budget is what
    /// `ManualMachine::new` started from, before it took the startup charge out).
    fn spent(&self) -> ExBudget {
        ExBudget {
            cpu: self.image_budget.cpu - self.machine.ex_budget.cpu,
            mem: self.image_budget.mem - self.machine.ex_budget.mem,
        }
    }

    /// `(mem, cpu)` of one builtin's `spend_counter` slot. `new_debug` always installs the counter,
    /// so the `None` arm is unreachable; it costs one branch and cannot panic.
    fn builtin_slot(&self, fun: DefaultFunction) -> (i64, i64) {
        match &self.machine.spend_counter {
            Some(counter) => {
                let i = (fun as usize + TERM_COUNT) * 2;
                (counter[i], counter[i + 1])
            }
            None => (0, 0),
        }
    }

    fn term_acc_mut(&mut self, id: isize) -> &mut TermAcc {
        match usize::try_from(id - self.id_base as isize) {
            Ok(i) if i < self.terms.len() => &mut self.terms[i],
            _ => &mut self.synthetic,
        }
    }

    fn slot(&self, id: isize) -> Option<usize> {
        match usize::try_from(id - self.id_base as isize) {
            Ok(i) if i < self.terms.len() => Some(i),
            _ => None,
        }
    }

    /// Post-order: a node's subtree cost is its own self plus the subtree cost of its AST children,
    /// so `children + self == subtree` holds exactly at every node.
    fn walk_subtree(&self, term: &Term<NamedDeBruijn>, out: &mut Vec<(i64, i64)>) -> (i64, i64) {
        let slot = self.slot(term.uniq_id());
        let (mut cpu, mut mem) = match slot {
            Some(i) => (self.terms[i].self_cpu, self.terms[i].self_mem),
            None => (0, 0),
        };

        match term {
            Term::Delay { body, .. } | Term::Lambda { body, .. } | Term::Force { body, .. } => {
                let (c, m) = self.walk_subtree(body, out);
                cpu += c;
                mem += m;
            }
            Term::Apply {
                function, argument, ..
            } => {
                let (c, m) = self.walk_subtree(function, out);
                cpu += c;
                mem += m;
                let (c, m) = self.walk_subtree(argument, out);
                cpu += c;
                mem += m;
            }
            Term::Constr { fields, .. } => {
                for field in fields {
                    let (c, m) = self.walk_subtree(field, out);
                    cpu += c;
                    mem += m;
                }
            }
            Term::Case {
                constr, branches, ..
            } => {
                let (c, m) = self.walk_subtree(constr, out);
                cpu += c;
                mem += m;
                for branch in branches {
                    let (c, m) = self.walk_subtree(branch, out);
                    cpu += c;
                    mem += m;
                }
            }
            Term::Var { .. } | Term::Constant { .. } | Term::Error { .. } | Term::Builtin { .. } => {}
        }

        if let Some(i) = slot {
            out[i] = (cpu, mem);
        }
        (cpu, mem)
    }

    fn push_sample(&mut self) {
        let spent = self.spent();
        self.timeline.push(ProfileSample {
            step: self.steps,
            cpu: spent.cpu,
            mem: spent.mem,
        });
        if self.timeline.len() >= TIMELINE_SAMPLES {
            // Halve: keep every other sample and double the interval, so the series stays evenly
            // spaced and bounded without knowing the total step count up front.
            let mut keep = 0;
            self.timeline.retain(|_| {
                keep += 1;
                keep % 2 == 0
            });
            self.timeline_interval *= 2;
        }
    }
}

/// The step kind a Compute step will charge. `Term::Error` charges nothing — it fails the machine
/// before `step_and_maybe_spend` — so it has no kind.
fn step_kind_of(term: &Term<NamedDeBruijn>) -> Option<StepKind> {
    match term {
        Term::Var { .. } => Some(StepKind::Var),
        Term::Delay { .. } => Some(StepKind::Delay),
        Term::Lambda { .. } => Some(StepKind::Lambda),
        Term::Apply { .. } => Some(StepKind::Apply),
        Term::Constant { .. } => Some(StepKind::Constant),
        Term::Force { .. } => Some(StepKind::Force),
        Term::Builtin { .. } => Some(StepKind::Builtin),
        Term::Constr { .. } => Some(StepKind::Constr),
        Term::Case { .. } => Some(StepKind::Case),
        Term::Error { .. } => None,
    }
}

/// The single builtin that can fire on this Return step, if any — `eval_builtin_app` is reachable
/// only from `force_evaluate(value)` and `apply_evaluate(function, _)`, so the candidate is either
/// the value being returned or the function parked in the top frame.
///
/// The FRAME is checked first, and that order matters: with a builtin returning INTO
/// `FrameAwaitArg(builtin)` both are builtins, but only the frame's one is being applied — the
/// returned one is merely pushed as its argument.
/// The apply-site stack operation this Return step performs, from the frame it is about to consume.
/// O(1): one match on the top frame, no walk of the context chain.
fn frame_op(context: &Context, value: &Value) -> FrameOp {
    match context {
        Context::FrameAwaitFunTerm(_, _, _) => FrameOp::Keep,
        Context::FrameAwaitArg(_, _) | Context::FrameAwaitFunValue(_, _) => FrameOp::Consume,
        // Only a `Constr` reaches `transfer_arg_stack`; anything else fails the machine on this very
        // step, and the stack of a run that is over does not matter.
        Context::FrameCases(_, _, _) => match value {
            Value::Constr { fields, .. } => FrameOp::Transfer(fields.len()),
            _ => FrameOp::Other,
        },
        Context::NoFrame | Context::FrameForce(_) | Context::FrameConstr(_, _, _, _, _, _) => {
            FrameOp::Other
        }
    }
}

fn firing_builtin(context: &Context, value: &Value) -> Option<DefaultFunction> {
    if let Context::FrameAwaitArg(Value::Builtin { fun, .. }, _) = context {
        return Some(*fun);
    }
    match value {
        Value::Builtin { fun, .. } => Some(*fun),
        _ => None,
    }
}

fn step_kind_name(kind: StepKind) -> &'static str {
    match kind {
        StepKind::Constant => "Constant",
        StepKind::Var => "Var",
        StepKind::Lambda => "Lambda",
        StepKind::Apply => "Apply",
        StepKind::Delay => "Delay",
        StepKind::Force => "Force",
        StepKind::Builtin => "Builtin",
        StepKind::Constr => "Constr",
        StepKind::Case => "Case",
        StepKind::StartUp => "StartUp",
    }
}
