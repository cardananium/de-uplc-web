import { create } from 'zustand';
import { toast } from 'sonner';
import {
  DebuggerManager,
  ContextFillError,
  type IDebuggerEngine,
  type LazyKind,
  createProviderResolver,
  serializeTerm,
  serializeTermUplc,
  termAtLineForBreakpoint,
  type Budget,
  type DebuggerManagerEvents,
  type DebuggerTypes,
  type TermLocation,
  type TermHintInfo,
} from '@de-uplc/core';
import { connectEngine, type EngineHandle } from '@de-uplc/engine-worker';
import { settingsStore, networkPrompt } from './platform/settings';
import { useSettings, type TermView, type ProfileMetric, type ProfileScope } from './platform/settings';
import { buildProfileIndex, type ProfileIndex } from './profile/profile-index';
import { useTabsStore, TERM_TAB } from './editor/tabs-store';
import { buildShareUrl, type UrlLaunch } from './url-launch';
import {
  CHOOSE_REDEEMER, NO_REDEEMERS_AVAILABLE, isConcreteRedeemer, toggleMainAction, type SessionState,
} from './panels/button-states';

export interface Breakpoint { id: number; active: boolean }

/** A validator + manually-supplied Data args (the URL deep-link "parts" mode). Everything but
 *  `script` is optional; `redeemer`/`datum` are PlutusData CBOR hex; `context` is PlutusData CBOR
 *  hex OR a named ScriptContext JSON (leading `{`); `cost_models` = flat i64 list. */
export interface ProgramParts {
  script: string;
  language: string;
  context?: string;
  redeemer?: string;
  datum?: string;
  cost_models?: number[];
}

interface AppState {
  status: SessionState;
  loading: boolean;
  locked: boolean;
  // True when the live session was opened from a plain UPLC program (no transaction/redeemer/context).
  // Drives the session-aware UI gates that otherwise key off a concrete redeemer.
  scriptOnly: boolean;
  // True in scriptOnly "parts" mode when a script-context CBOR was supplied — "Show context" then
  // renders that decoded Data (a bare program has none).
  scriptHasContext: boolean;
  txId?: string;
  fileName?: string;
  redeemers: string[];
  currentRedeemer?: string;
  scriptHash?: string;
  plutusLang?: string;
  budget?: Budget;
  currentTermId?: number;
  // A request to reveal+flash a term's line in the editor (from the inspector trees' "reveal"
  // button). The nonce makes repeated clicks on the same term re-trigger the reveal.
  revealRequest?: { termId: number; nonce: number };
  logs: string[];
  error?: string;
  /** Severity behind `error`, so the persistent banner styles a neutral script-failure differently
   *  from an engine crash / load failure (the toast layer already distinguishes them). */
  errorTone?: 'crash' | 'script' | 'load';
  finalStatus?: 'Done' | 'Error';
  runMs?: number;

  // inspector trees (lazy roots)
  machineStateLazy?: DebuggerTypes.MachineStateLazy;
  contextsLazy: DebuggerTypes.MachineContextLazy[];
  currentEnvLazy?: DebuggerTypes.EnvLazy;
  treeGeneration: number;

  // breakpoints (termId-based)
  breakpoints: Breakpoint[];

  // term editor model (text + line↔termId locations + inlay hints), set on session init
  termText?: string;
  termLocations: TermLocation[];
  termHints: TermHintInfo[];
  // term rendering style: 'tree' (debug tree) or 'uplc' (canonical UPLC syntax)
  termView: TermView;

  // inlay hints UI state (global on/off toggle)
  inlayHintsEnabled: boolean;

  // ── profiler ──────────────────────────────────────────────────────────────────
  // A profile describes the PROGRAM, not a run, so it deliberately survives Start / Step /
  // Restart / Stop; only a new script (or a new redeemer) invalidates it. See PROFILE_RESET.
  /** The last report. Partial reports (cancelled / limit / script error) are kept and labelled. */
  profile?: DebuggerTypes.Profile;
  /** Derived join of `profile` × `termLocations` — rebuilt on metric/term-view change only. */
  profileIndex?: ProfileIndex;
  /** `termEpoch` when the profile was taken. */
  profileTermEpoch?: number;
  /** The term was re-rendered from the engine since: numbers still valid, editor no longer painted.
   *  Only meaningful while `profile` is set — read it as `profile && profileStale`. */
  profileStale: boolean;
  profileStatus: 'idle' | 'running' | 'ready' | 'error';
  /** How the run ended. `Limit`/`Cancelled` are HOST labels — the engine has no such outcomes. */
  profileOutcome?: 'Done' | 'Error' | 'Limit' | 'Cancelled';
  /** Engine failure text (`profileStatus: 'error'`), not a script failure. */
  profileError?: string;
  /** Live counters of the current/last run (`elapsedMs` accumulates across Continue). `cap` is the
   *  whole-run step ceiling THIS run was bounded by — the `Limit` sentence prints it rather than
   *  `profileMaxSteps`, because a Continue lifts the cap above what already ran. */
  profileRun?: { steps: number; cpu: number; mem: number; startedAt: number; elapsedMs: number; cap: number };
  /** The runner in the worker survived the last action, so `continueProfile()` is possible. */
  profileRunnerLive: boolean;
  profileMetric: ProfileMetric;
  profileScope: ProfileScope;
  profileHeat: boolean;
  /** Term id selected in the report / from the editor. */
  profileSelected?: number;

  /** Profile the whole program from the start (a second machine; the debug session is untouched). */
  runProfile: () => Promise<void>;
  /** Resume after `Limit`/`Cancelled`, while `profileRunnerLive`. */
  continueProfile: () => Promise<void>;
  /** Ask the chunk loop to stop; the partial report is still fetched and kept. */
  cancelProfile: () => void;
  clearProfile: () => void;
  setProfileMetric: (m: ProfileMetric) => void;
  setProfileScope: (s: ProfileScope) => void;
  toggleProfileHeat: () => void;
  selectProfileNode: (termId?: number) => void;

  loadTransaction: (content: string, fileName?: string) => Promise<void>;
  /** Load a plain UPLC program (text or hex) for context-free debugging. `language` is "V1"|"V2"|"V3". */
  loadProgram: (programSrc: string, language: string) => Promise<void>;
  /** Load a validator + manually-supplied Data args (script context / redeemer / datum CBOR + cost
   *  models) — the URL deep-link "parts" mode. The args are applied to the program directly (no tx). */
  loadProgramParts: (parts: ProgramParts) => Promise<void>;
  selectRedeemer: (redeemer: string) => Promise<void>;
  toggleMain: () => Promise<void>;
  step: () => Promise<void>;
  refresh: () => Promise<void>;
  stop: () => Promise<void>;
  showContext: () => Promise<void>;
  /** Build a shareable deep-link for the current session (program / parts / full transaction), or
   *  null when nothing is loaded. The Share dialog displays + copies it. */
  getShareUrl: () => Promise<string | null>;
  /** The live session's applied script context as CBOR hex (PlutusData), or "" if none. */
  exportContextCbor: () => Promise<string>;
  /** The live session's named ScriptContext as serde JSON (`SerializableScriptContext`), or "". */
  exportContextJson: () => Promise<string>;
  addBreakpoint: (termId: number) => void;
  removeBreakpoint: (termId: number) => void;
  toggleBreakpoint: (termId: number) => void;
  /** Gutter/F9 toggle: resolve an editor line to its term, then add (active) or remove that breakpoint. */
  toggleBreakpointAtLine: (line: number) => void;
  toggleInlayHints: () => void;
  /** Switch the term rendering style; re-serializes the cached script term in place. */
  setTermView: (view: TermView) => void;
  /** Dismiss the persistent error banner (the failure reason). Cleared automatically on next run. */
  clearError: () => void;
}


let handle: EngineHandle | undefined;
let manager: DebuggerManager | undefined;
let session: IDebuggerEngine | undefined;
let currentTerm: DebuggerTypes.Term | undefined; // cached script AST, re-serialized on view switch
// Set when debugging a plain UPLC program (no tx). A fresh run re-opens THIS program instead of
// re-initialising a redeemer session, so Start/Restart return to the program's initial state.
let bareProgram: { src: string; lang: string } | undefined;
// Set when debugging a validator + manually-supplied Data args (the URL deep-link "parts" mode);
// holds the PartsConfig JSON. A fresh run re-applies THIS config (reset-if-same keeps term ids).
let bareParts: string | undefined;
// Set when a full transaction is loaded — the raw content the user opened (CBOR hex or
// {transaction,utxos} JSON), kept so "Share link" can reproduce the tx session.
let txContent: string | undefined;
let runStartedAt = 0;
// Epoch bumped on every `session = …` (re)assign (see the `sessionGeneration += 1` at each site)
// so in-flight async reads can capture it and bail if a session swap resolved under them.
let sessionGeneration = 0;
// `sessionGeneration` snapshot taken at each run/step start. A completion callback (onFinished/
// onError/onBreakpoint) whose `runGen` no longer matches `sessionGeneration` belongs to a run the
// user already abandoned (Restart / Stop / redeemer-change) — it must not stamp a stale terminal
// result (or a bogus runMs) onto the fresh session.
let runGen = -1;
// Profiling is a READ, so it rides `sessionGeneration` and never touches `runGen` (that would make
// a live run's callbacks look stale). Three module-level slots, by the same convention as above:
/** Set by cancelProfile(); read BETWEEN chunks, so cancel latency ≈ one chunk (~120 ms). */
let profileCancel = false;
/** Grows ONLY inside loadTermForSession — i.e. when the engine re-renders the term. `setTermView`
 *  must NOT bump it: it re-serialises the SAME cached term, so line numbers change but term ids
 *  don't. A text fingerprint would be wrong for exactly that reason. */
let termEpoch = 0;
/** Owner of the current profile run. The `finally` that un-wedges `profileStatus` is guarded by
 *  THIS, not by the generation: Start/Restart/Stop bump `sessionGeneration` but deliberately keep
 *  the profile, so a generation-guarded finally would leave `profileStatus: 'running'` forever. */
let profileToken = 0;

/**
 * The single invalidation payload, applied at all seven reset sites (six in the invalidation
 * matrix + the user's `clearProfile`), each time in the SAME synchronous block as that site's
 * existing `set()` and next to a `profileCancel = true`.
 */
const PROFILE_RESET = {
  profile: undefined, profileIndex: undefined, profileOutcome: undefined,
  profileSelected: undefined, profileStatus: 'idle', profileRunnerLive: false,
  // `profileStale` is only meaningful while `profile` is set, and `staleFor()` reads nothing but
  // `profileTermEpoch` — so leaving the epoch behind would latch `profileStale: true` on the next
  // `loadTermForSession` for a profile that no longer exists. Both consumers that read the flag
  // without a `profile &&` gate (`gotoHot`, `showInProfile`) would then be off with nothing to show.
  profileTermEpoch: undefined, profileStale: false,
} as const;

/** Current session (for building tree root nodes in the panels). */
export function getSession(): IDebuggerEngine | undefined {
  return session;
}

// Dev HMR: tear down the live worker before this module is swapped, so editing the store
// doesn't leak an orphaned Worker each hot-reload. No-op in production.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    try { handle?.dispose(); } catch { /* ignore */ }
    manager = undefined; handle = undefined; session = undefined; currentTerm = undefined; bareProgram = undefined; bareParts = undefined; txContent = undefined;
  });
}

/**
 * Open a lazy NODE EXPLORER tab rooted at a tree node — navigate its substructure on demand
 * (via getLazy, same as the left panel) instead of dumping the whole object as JSON, which can
 * be huge. The explorer re-resolves the node's children against the live session.
 */
export function openNodeInTab(
  path: string[],
  dataSource: 'machineState' | 'context' | 'env',
  label: string,
  nodeKind: LazyKind,
): void {
  if (!session) { toast.info('No active session'); return; }
  useTabsStore.getState().openNodeTab(label || 'Node', dataSource, path, nodeKind);
}

/**
 * Reveal a term in the term editor: switch to the Term tab and flash-highlight that term's line
 * (the web equivalent of the extension's "jump to term"). Used by the inspector trees' reveal
 * button on term-bearing rows, e.g. "Term to compute (Term ID: 1343)". The bumped nonce makes a
 * repeat click on the same term re-trigger the reveal.
 */
export function revealTermInEditor(termId: number): void {
  useTabsStore.getState().setActive(TERM_TAB);
  useStore.setState((s) => ({ revealRequest: { termId, nonce: (s.revealRequest?.nonce ?? 0) + 1 } }));
}

export const useStore = create<AppState>((set, get) => {
  // Breakpoint pushes are serialized on a single tail promise so two rapid toggles can't race
  // (term ids recur in CEK eval, so a just-removed breakpoint must not win over a later add).
  // Each link re-reads the current store, so the engine always ends on the latest set.
  let syncTail: Promise<void> = Promise.resolve();
  const syncBreakpoints = (): Promise<void> => {
    syncTail = syncTail
      .then(() => session?.setBreakpointsList(get().breakpoints.filter((b) => b.active).map((b) => b.id)))
      .catch((e) => { console.error('[store] breakpoint sync failed:', e); });
    return syncTail;
  };

  /** Pull budget/term/logs + the three lazy tree roots; bump treeGeneration to remount the trees. */
  const pullInspectors = async () => {
    if (!session) return;
    const gen = sessionGeneration;
    const [budget, currentTermId, logs, ms, ctxs, env] = await Promise.all([
      session.getBudget(),
      session.getCurrentTermId(),
      session.getLogs(),
      session.getMachineStateLazy('', false),
      session.getMachineContextLazy('', false),
      session.getCurrentEnvLazy('', false),
    ]);
    if (gen !== sessionGeneration) return; // a session swap resolved under us — drop the stale read
    set((s) => ({
      budget, currentTermId, logs,
      machineStateLazy: ms as DebuggerTypes.MachineStateLazy | undefined,
      contextsLazy: (ctxs ?? []) as DebuggerTypes.MachineContextLazy[],
      currentEnvLazy: env as DebuggerTypes.EnvLazy | undefined,
      treeGeneration: s.treeGeneration + 1,
    }));
  };

  /** Serialize a term with the renderer for the active view (debug tree vs canonical UPLC). */
  const renderTerm = (term: DebuggerTypes.Term, view: TermView = get().termView) =>
    view === 'uplc' ? serializeTermUplc(term) : serializeTerm(term);

  /** Is a profile taken at `profileTermEpoch` stale against the CURRENT `termEpoch`? A profile
   *  that was never taken is not stale — it is absent. */
  const staleFor = (profileTermEpoch: number | undefined) =>
    profileTermEpoch !== undefined && profileTermEpoch !== termEpoch;

  /** Fetch the session's root script term and serialize it into the editor model. */
  const loadTermForSession = async () => {
    if (!session) return;
    const gen = sessionGeneration;
    // A term that arrives from the ENGINE is a new term — including the failure branches, where a
    // term that didn't load must invalidate exactly like one that did. All three `set()`s below
    // bump the epoch, and this is the only function that does.
    try {
      const term = await session.getScript();
      if (gen !== sessionGeneration) return; // session swapped under us
      if (term) {
        currentTerm = term;
        const { text, locations, hints } = renderTerm(term);
        termEpoch += 1;
        set((s) => ({ termText: text, termLocations: locations, termHints: hints, profileStale: staleFor(s.profileTermEpoch) }));
      } else {
        currentTerm = undefined;
        termEpoch += 1;
        set((s) => ({ termText: undefined, termLocations: [], termHints: [], profileStale: staleFor(s.profileTermEpoch) }));
      }
    } catch (e) {
      if (gen !== sessionGeneration) return;
      console.error('[store] failed to load/serialize term:', e);
      currentTerm = undefined;
      termEpoch += 1;
      set((s) => ({ termText: undefined, termLocations: [], termHints: [], profileStale: staleFor(s.profileTermEpoch) }));
    }
  };

  // A completion/break callback from a run the user already moved on from (its `runGen` no longer
  // matches the live `sessionGeneration`) must be ignored — see `runGen` above.
  const isStaleRun = () => runGen !== sessionGeneration;

  const events: DebuggerManagerEvents = {
    onBreakpoint: (termId) => { if (isStaleRun()) return; set({ status: 'pause', currentTermId: termId }); void pullInspectors(); },
    // Throttled-run tick: re-pull inspectors so the run animates. Return the promise — the engine
    // awaits it (state is readable between steps) before the next step + delay.
    onStep: () => pullInspectors(),
    onFinished: (_term, termId) => {
      if (isStaleRun()) return;
      set({ status: 'stopped', finalStatus: 'Done', currentTermId: termId, runMs: Date.now() - runStartedAt, error: undefined, errorTone: undefined });
      toast.success('Execution finished');
      void pullInspectors();
    },
    onError: (message, termId, isInfraError) => {
      if (isStaleRun()) return;
      // A script that fails validation is the RESULT you're debugging (neutral), not a crash (alarm).
      set({ status: 'stopped', finalStatus: 'Error', error: message, errorTone: isInfraError ? 'crash' : 'script', currentTermId: termId, runMs: Date.now() - runStartedAt });
      if (isInfraError) toast.error(`Engine error: ${message}`);
      else toast.warning(`Script failed: ${message}`);
      void pullInspectors();
    },
  };

  // The worker died unrecoverably — reset to a clean slate and drop the dead singletons so the
  // next loadTransaction respawns a fresh worker (ensureManager). Recoverable, not a hard wedge.
  // Same wording on the toast and the persistent banner; points at the actual recovery affordance
  // ("Open transaction") rather than the overloaded word "reload" (which reads as a page refresh and
  // collides with the ErrorBoundary's literal Reload button).
  const CRASH_MSG = 'Engine crashed — use Open transaction to recover.';
  const onFatalWorker = (info: string) => {
    console.error('[store] engine worker died:', info);
    // Comlink promises have no reject path and `terminate()` settles nothing, so an in-flight
    // `profileRun` NEVER resolves and neither its catch nor its finally will run. This handler is
    // the ONLY thing that un-wedges the profiler: it drops the profile (with the report tab) and
    // puts the status back to idle. The abandoned promise stays unsettled on purpose.
    useTabsStore.getState().reset();
    profileCancel = true;
    try { handle?.dispose(); } catch { /* ignore */ }
    manager = undefined; handle = undefined; session = undefined; currentTerm = undefined; bareProgram = undefined; bareParts = undefined; txContent = undefined;
    sessionGeneration += 1;
    set({
      ...PROFILE_RESET,
      profileRun: undefined, profileError: undefined,
      status: 'empty', loading: false, locked: false, scriptOnly: false, scriptHasContext: false, finalStatus: undefined,
      budget: undefined, currentTermId: undefined,
      // Drop every session-derived field so the screen collapses to a clean crashed state instead of
      // showing a populated-but-dead Session panel / stale term that contradicts the crash banner.
      redeemers: [], currentRedeemer: undefined, scriptHash: undefined, plutusLang: undefined,
      termText: undefined, termLocations: [], termHints: [],
      machineStateLazy: undefined, contextsLazy: [], currentEnvLazy: undefined,
      breakpoints: [],
      error: CRASH_MSG, errorTone: 'crash',
    });
    toast.error(CRASH_MSG);
  };

  const ensureManager = (): DebuggerManager => {
    if (!manager) {
      const worker = new Worker(new URL('./engine/engine.worker.ts', import.meta.url), { type: 'module' });
      handle = connectEngine(worker, onFatalWorker);
      const providers = createProviderResolver(settingsStore, handle.refScriptResolver);
      manager = new DebuggerManager(handle.engine, { providers, networkPrompt, events });
    }
    return manager;
  };

  // Build a FRESH session for the current mode: re-open the bare program, or re-init the selected
  // redeemer. Returns undefined when there's nothing runnable (no manager / no concrete redeemer).
  const freshSession = async (): Promise<IDebuggerEngine | undefined> => {
    if (!manager) return undefined;
    if (bareParts !== undefined) return manager.openProgramParts(bareParts);
    if (bareProgram) return manager.openProgram(bareProgram.src, bareProgram.lang);
    const redeemer = get().currentRedeemer;
    if (!isConcreteRedeemer(redeemer)) return undefined;
    return manager.initDebugSession(redeemer);
  };

  const runFromStart = async () => {
    if (!manager || (!bareProgram && bareParts === undefined && !isConcreteRedeemer(get().currentRedeemer))) {
      toast.info('Load a program or select a redeemer first');
      return;
    }
    // Stop any in-flight run before re-initialising. The engine is a SINGLE shared instance, so a
    // Restart-while-running would otherwise leave the old run loop executing under the new session
    // (mirrors the stop-first guard already in loadTransaction / selectRedeemer). Bump the generation
    // BEFORE the drain so the old loop's final in-flight callback fails isStaleRun() and is dropped,
    // not transiently stamped onto the store.
    if (session) { sessionGeneration += 1; try { await session.stop(); } catch { /* ignore */ } }
    const next = await freshSession();
    if (!next) { toast.info('Load a program or select a redeemer first'); return; }
    session = next; sessionGeneration += 1;
    await syncBreakpoints();
    session.setStepDelay(useSettings.getState().stepDelay); // 0 = full speed; >0 = animated playback
    runStartedAt = Date.now(); runGen = sessionGeneration; // this run owns the current generation
    // freshSession() went through SessionController::reset(), which drops the profile runner —
    // the numbers survive (a profile describes the program), but Continue no longer can.
    set({ status: 'running', error: undefined, errorTone: undefined, finalStatus: undefined, profileRunnerLive: false });
    await session.start();
  };

  /**
   * The profile chunk loop. It lives HERE and not in the host-runner because everything it needs
   * is host state: the cancel flag, the whole-run step cap, and the session generation. No
   * `onProfileProgress` event, no Comlink proxy callback, no `ports.ts` change.
   *
   * The chunk size self-tunes on wall time (~120 ms → ~8 UI updates/s and ~8 cancel checks/s), so
   * neither the refresh rate nor the cancel latency depends on the machine. It starts small
   * (20 000) because `profileCancel` is only read BETWEEN chunks: a 250 000-step first chunk would
   * be seconds on a slow machine. `max(1, ms)` keeps an instant chunk from producing Infinity.
   *
   * `gen` is checked BEFORE every await (don't burn WASM time in a controller whose runner is
   * gone) and AFTER it (never write a superseded session's result). `resume = true` is Continue:
   * no `profileStart()`, and the cap is lifted above what already ran.
   */
  const runProfileLoop = async (resume: boolean): Promise<void> => {
    const tok = ++profileToken;
    const gen = sessionGeneration;
    const epoch = termEpoch;
    const prev = resume ? get().profileRun : undefined;
    const startedAt = Date.now();
    const baseMs = prev?.elapsedMs ?? 0;   // Continue must not bill itself the pause between runs
    const cap = (prev?.steps ?? 0) + useSettings.getState().profileMaxSteps;
    let capped = false;
    let chunk = 20_000;
    profileCancel = false;
    // `cap` travels WITH the counters: the `Limit` sentence names the ceiling this run stopped at,
    // and after a Continue that is no longer `profileMaxSteps` (it sits that far above what already
    // ran). Reading the setting at print time would say 50 M under a run that reached 100 M.
    set({ profileStatus: 'running', profileOutcome: undefined, profileError: undefined,
          profileRun: prev ? { ...prev, cap } : { steps: 0, cpu: 0, mem: 0, startedAt, elapsedMs: 0, cap } });
    try {
      if (gen !== sessionGeneration || !session) return;
      if (!resume) await session.profileStart();
      for (;;) {
        // `session` is the same object for the life of the worker (DebuggerManager returns
        // `this.engine`), so only the generation distinguishes sessions.
        if (gen !== sessionGeneration || !session) return;
        if (profileCancel) break;
        const t0 = performance.now();
        const r = await session.profileRun(chunk);
        if (gen !== sessionGeneration) return;              // superseded — leave silently
        const ms = Math.max(1, performance.now() - t0);
        chunk = Math.min(5_000_000, Math.max(10_000, Math.round((chunk * 120) / ms)));
        set({ profileRun: { steps: r.steps, cpu: r.cpu, mem: r.mem, startedAt, cap,
                            elapsedMs: baseMs + (Date.now() - startedAt) } });
        if (r.outcome !== 'Running') break;                 // Done | Error
        if (r.steps >= cap) { capped = true; break; }       // host-side cap → the 'Limit' label
        if (profileCancel) break;                           // we still take the report
      }
      if (gen !== sessionGeneration || !session) return;
      const report = await session.profileReport();
      if (gen !== sessionGeneration) return;
      set({
        profile: report,
        profileIndex: buildProfileIndex(report, get().termLocations, get().termView, get().profileMetric),
        profileTermEpoch: epoch,
        profileStale: epoch !== termEpoch,
        profileStatus: 'ready',
        // The engine can only have reached here as Done or Error: the loop left either on a
        // non-Running outcome or on cancel/cap, and those two carry their own host label.
        profileOutcome: profileCancel ? 'Cancelled' : capped ? 'Limit'
                      : report.totals.outcome.outcome_type === 'Error' ? 'Error' : 'Done',
        profileRunnerLive: capped || profileCancel,
      });
    } catch (e) {
      // Real rejections only (e.g. a JsError thrown inside profile_run). A DEAD WORKER never lands
      // here — see onFatalWorker.
      if (gen === sessionGeneration) set({ profileStatus: 'error', profileError: String(e) });
    } finally {
      if (tok === profileToken && get().profileStatus === 'running') set({ profileStatus: 'idle' });
    }
  };

  return {
    status: 'empty',
    loading: false,
    locked: false,
    scriptOnly: false,
    scriptHasContext: false,
    redeemers: [],
    logs: [],
    contextsLazy: [],
    treeGeneration: 0,
    breakpoints: [],
    termLocations: [],
    termHints: [],
    termView: useSettings.getState().termView,
    inlayHintsEnabled: useSettings.getState().inlayHints,
    // Seeded from settings, then dual-written back on every change (like termView / inlayHints).
    profileStale: false,
    profileStatus: 'idle',
    profileRunnerLive: false,
    profileMetric: useSettings.getState().profileMetric,
    profileScope: useSettings.getState().profileScope,
    profileHeat: useSettings.getState().profileHeat,

    async loadTransaction(content, fileName) {
      useTabsStore.getState().reset();
      currentTerm = undefined;
      profileCancel = true; // a new script: the profile in flight (if any) is about to be dropped
      bareProgram = undefined; bareParts = undefined; txContent = undefined; // switching back to transaction mode
      set({
        ...PROFILE_RESET,
        loading: true, locked: true, scriptOnly: false, scriptHasContext: false, fileName, error: undefined, errorTone: undefined, finalStatus: undefined,
        budget: undefined, currentTermId: undefined, logs: [], scriptHash: undefined, plutusLang: undefined,
        machineStateLazy: undefined, contextsLazy: [], currentEnvLazy: undefined,
        termText: undefined, termLocations: [], termHints: [],
        // A new script's term ids are unrelated to the previous one's — drop stale breakpoints
        // (the subsequent syncBreakpoints / next run pushes the now-empty list to the engine).
        breakpoints: [],
      });
      try {
        const mgr = ensureManager();
        // Bump before the drain so the old loop's final callback fails isStaleRun() (see runFromStart).
        if (session) { sessionGeneration += 1; try { await session.stop(); } catch { /* ignore */ } session = undefined; }
        await mgr.openTransaction(content);
        // Share the FULLY-RESOLVED context (tx + utxos + protocol params, incl. anything fetched
        // from Koios) so the link is self-contained and reopens with no network; fall back to the
        // raw content if the manager didn't retain a resolved context.
        txContent = mgr.getResolvedContextJson() ?? content;
        const [redeemers, txId] = await Promise.all([mgr.getRedeemers(), mgr.getTransactionId()]);
        set({
          status: 'stopped', redeemers, txId,
          currentRedeemer: redeemers.length ? CHOOSE_REDEEMER : NO_REDEEMERS_AVAILABLE,
        });
        toast.success('Transaction loaded');
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // A failed load leaves no "loaded" indicators (stale fileName/txId would otherwise survive
        // and contradict the error banner). The banner alone signals the failure.
        set({ status: 'empty', redeemers: [], currentRedeemer: undefined, error, errorTone: 'load', fileName: undefined, txId: undefined });
        // A declined network prompt is a user choice, not a failure — reset quietly.
        if (!(e instanceof ContextFillError && e.reason === 'network-cancelled')) {
          const hint = e instanceof ContextFillError && e.reason === 'utxos-unfetchable'
            ? ' (check the network / Koios API key in Settings)' : '';
          toast.error(`Failed to load transaction: ${error}${hint}`);
        }
      } finally {
        set({ loading: false, locked: false });
      }
    },

    async loadProgram(programSrc, language) {
      useTabsStore.getState().reset();
      currentTerm = undefined;
      profileCancel = true;
      bareParts = undefined; txContent = undefined; // plain-program mode, not parts/tx mode
      set({
        ...PROFILE_RESET,
        loading: true, locked: true, scriptOnly: true, scriptHasContext: false,
        fileName: undefined, txId: undefined, redeemers: [], currentRedeemer: undefined,
        error: undefined, errorTone: undefined, finalStatus: undefined,
        budget: undefined, currentTermId: undefined, logs: [], scriptHash: undefined, plutusLang: undefined,
        machineStateLazy: undefined, contextsLazy: [], currentEnvLazy: undefined,
        termText: undefined, termLocations: [], termHints: [],
        // A new script's term ids are unrelated to the previous one's — drop stale breakpoints
        // (the subsequent syncBreakpoints / next run pushes the now-empty list to the engine).
        breakpoints: [],
      });
      try {
        const mgr = ensureManager();
        if (session) { sessionGeneration += 1; try { await session.stop(); } catch { /* ignore */ } session = undefined; }
        bareProgram = { src: programSrc, lang: language };
        session = await mgr.openProgram(programSrc, language); sessionGeneration += 1;
        await syncBreakpoints();
        await loadTermForSession();
        const [scriptHash, plutusLang] = await Promise.all([
          session.getScriptHash(), session.getPlutusLanguageVersion(),
        ]);
        set({
          // a context-free program has no on-chain script hash (engine returns "") — show "—"
          scriptHash: scriptHash || undefined, plutusLang, status: 'stopped',
          error: undefined, errorTone: undefined, finalStatus: undefined, budget: undefined,
        });
        await pullInspectors();
        toast.success('UPLC program loaded');
      } catch (e) {
        bareProgram = undefined;
        const error = e instanceof Error ? e.message : String(e);
        set({ status: 'empty', scriptOnly: false, scriptHasContext: false, error, errorTone: 'load' });
        toast.error(`Failed to load program: ${error}`);
      } finally {
        set({ loading: false, locked: false });
      }
    },

    async loadProgramParts(parts) {
      useTabsStore.getState().reset();
      currentTerm = undefined;
      profileCancel = true;
      bareProgram = undefined; txContent = undefined;
      set({
        ...PROFILE_RESET,
        loading: true, locked: true, scriptOnly: true, scriptHasContext: !!parts.context,
        fileName: undefined, txId: undefined, redeemers: [], currentRedeemer: undefined,
        error: undefined, errorTone: undefined, finalStatus: undefined,
        budget: undefined, currentTermId: undefined, logs: [], scriptHash: undefined, plutusLang: undefined,
        machineStateLazy: undefined, contextsLazy: [], currentEnvLazy: undefined,
        termText: undefined, termLocations: [], termHints: [],
        // A new script's term ids are unrelated to the previous one's — drop stale breakpoints
        // (the subsequent syncBreakpoints / next run pushes the now-empty list to the engine).
        breakpoints: [],
      });
      try {
        const mgr = ensureManager();
        if (session) { sessionGeneration += 1; try { await session.stop(); } catch { /* ignore */ } session = undefined; }
        const configJson = JSON.stringify(parts);
        bareParts = configJson;
        session = await mgr.openProgramParts(configJson); sessionGeneration += 1;
        await syncBreakpoints();
        await loadTermForSession();
        const [scriptHash, plutusLang] = await Promise.all([
          session.getScriptHash(), session.getPlutusLanguageVersion(),
        ]);
        set({
          scriptHash: scriptHash || undefined, plutusLang, status: 'stopped',
          error: undefined, errorTone: undefined, finalStatus: undefined, budget: undefined,
        });
        await pullInspectors();
        toast.success('Script + context loaded');
      } catch (e) {
        bareParts = undefined;
        const error = e instanceof Error ? e.message : String(e);
        set({ status: 'empty', scriptOnly: false, scriptHasContext: false, error, errorTone: 'load' });
        toast.error(`Failed to load script: ${error}`);
      } finally {
        set({ loading: false, locked: false });
      }
    },

    async selectRedeemer(redeemer) {
      useTabsStore.getState().reset();
      profileCancel = true; // either branch replaces the script the profile was taken on
      if (!isConcreteRedeemer(redeemer)) {
        session = undefined; sessionGeneration += 1;
        currentTerm = undefined;
        set({
          ...PROFILE_RESET,
          currentRedeemer: redeemer, status: 'stopped',
          scriptHash: undefined, plutusLang: undefined, budget: undefined, currentTermId: undefined,
          machineStateLazy: undefined, contextsLazy: [], currentEnvLazy: undefined,
          termText: undefined, termLocations: [], termHints: [],
          error: undefined, errorTone: undefined, finalStatus: undefined,
        });
        return;
      }
      // After a worker crash `manager` is null; the select is still populated, so a recovery attempt
      // here would silently no-op. Surface the same guidance the crash banner gives instead.
      if (!manager) { toast.error('Engine not running — use Open transaction to recover.'); return; }
      // The profile of the PREVIOUS redeemer is meaningless for this one. Dropped in the same
      // synchronous block as the existing lock — before the generation bump below, no await between.
      set({ ...PROFILE_RESET, locked: true });
      try {
        // Bump before the drain so a stale callback from the old run is dropped by isStaleRun().
        if (session) { sessionGeneration += 1; try { await session.stop(); } catch { /* ignore */ } }
        session = await manager.initDebugSession(redeemer); sessionGeneration += 1;
        await syncBreakpoints();
        await loadTermForSession();
        const [scriptHash, plutusLang] = await Promise.all([
          session.getScriptHash(), session.getPlutusLanguageVersion(),
        ]);
        set({
          currentRedeemer: redeemer, scriptHash, plutusLang, status: 'stopped',
          error: undefined, errorTone: undefined, finalStatus: undefined, budget: undefined,
        });
        await pullInspectors();
      } finally {
        set({ locked: false });
      }
    },

    async toggleMain() {
      // Ignore a re-click fired during an in-flight transition (init/pause/continue) — without this
      // a rapid double-click double-starts the shared engine. start()/continue() only kick off the
      // run loop and return immediately, so the lock spans the transition, not the whole run.
      if (get().locked) return;
      set({ locked: true });
      try {
        const action = toggleMainAction(get().status);
        if (action === 'start') {
          await runFromStart();
        } else if (action === 'pause') {
          if (!session) return;
          await session.pause();
          set({ status: 'pause' });
          await pullInspectors();
        } else if (action === 'continue') {
          if (!session) return;
          // Re-sync breakpoints first: term ids recur in CEK eval, so a just-removed
          // breakpoint must reach the engine before we resume or it re-triggers.
          await syncBreakpoints();
          session.setStepDelay(useSettings.getState().stepDelay);
          runStartedAt = Date.now(); runGen = sessionGeneration; // this resume owns the current generation
          set({ status: 'running' });
          await session.continue();
        }
      } catch (e) {
        // A transport reject would otherwise leave the UI stuck (status running, locked) —
        // fall back to a runnable terminal state and surface it.
        set({ status: 'stopped' });
        toast.error(`Run control failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        set({ locked: false });
      }
    },

    async step() {
      if (!session || get().status !== 'pause' || get().locked) return;
      set({ locked: true });
      try {
        runGen = sessionGeneration; // this step belongs to the current session
        // A step can complete the program: `finished` true means onFinished/onError already set the
        // terminal state (Done/Error) + pulled — so we must NOT re-mark the session paused (the old
        // code left single-stepping to the end stuck on "paused" forever).
        const finished = await session.step();
        if (finished) return;
        await pullInspectors();
        set({ status: 'pause' });
      } catch (e) {
        set({ status: 'stopped' });
        toast.error(`Step failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        set({ locked: false });
      }
    },

    async refresh() {
      if (get().locked) return;
      set({ locked: true });
      try {
        await runFromStart();
      } catch (e) {
        set({ status: 'stopped' });
        toast.error(`Restart failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        set({ locked: false });
      }
    },

    async stop() {
      if (!session || get().locked) return;
      set({ locked: true });
      try {
        // Bump before the drain so the stopped run's final callback fails isStaleRun() and is dropped
        // (it would otherwise transiently stamp a terminal result before the set() below).
        sessionGeneration += 1;
        await session.stop();
        // The profile itself SURVIVES a stop (it describes the program, not this run); only the
        // worker-side runner doesn't — freshSession() below resets the controller.
        set({ status: 'stopped', finalStatus: undefined, budget: undefined, error: undefined, errorTone: undefined, profileRunnerLive: false });
        // Re-prep a fresh session at the initial state (bare program OR selected redeemer).
        const next = await freshSession();
        if (next) {
          session = next; sessionGeneration += 1;
          await syncBreakpoints();
          await pullInspectors();
        }
      } catch (e) {
        set({ status: 'stopped' });
        toast.error(`Stop failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        set({ locked: false });
      }
    },

    async showContext() {
      if (!session) { toast.info('Select a redeemer first'); return; }
      try {
        const ctx = await session.getTxScriptContext();
        // Mirror the extension's uplc-data-viewer: pretty JSON with field-name
        // quotes stripped, rendered with the plutus-types-json grammar. Anchor the match to the
        // start of an indented line and forbid escapes in the key, so it can only unquote real
        // property names — never a string VALUE that happens to contain `\":`.
        const content = JSON.stringify(ctx, null, 2).replace(/^(\s*)"([^"\\]+)":/gm, '$1$2:');
        useTabsStore.getState().openDataTab('Script Context', content, 'plutus-types-json');
      } catch (e) {
        toast.error(`Show context failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    async getShareUrl() {
      const r = get().currentRedeemer;
      const launch: UrlLaunch | null = bareProgram
        ? { kind: 'program', script: bareProgram.src, version: bareProgram.lang }
        : bareParts !== undefined
          ? { kind: 'parts', parts: JSON.parse(bareParts) as ProgramParts }
          : txContent !== undefined
            // Full tx: carry the selected redeemer so the link reopens on the same one.
            ? { kind: 'transaction', tx: txContent, redeemer: isConcreteRedeemer(r) ? r : undefined }
            : null;
      return launch ? buildShareUrl(launch) : null;
    },

    async exportContextCbor() {
      if (!session) return '';
      try { return await session.getContextCbor(); } catch { return ''; }
    },

    /** The live session's named ScriptContext as serde JSON (the `SerializableScriptContext` shape).
     *  Feed it back as a `parts` `context` to round-trip via the forward encoder, or build a
     *  `?context=<json>` deep-link. "" if there's no context. */
    async exportContextJson() {
      if (!session) return '';
      try { return JSON.stringify(await session.getTxScriptContext()); } catch { return ''; }
    },

    addBreakpoint(termId) {
      if (get().breakpoints.some((b) => b.id === termId)) return;
      set((s) => ({ breakpoints: [...s.breakpoints, { id: termId, active: true }] }));
      void syncBreakpoints();
    },
    removeBreakpoint(termId) {
      set((s) => ({ breakpoints: s.breakpoints.filter((b) => b.id !== termId) }));
      void syncBreakpoints();
    },
    toggleBreakpoint(termId) {
      set((s) => ({ breakpoints: s.breakpoints.map((b) => (b.id === termId ? { ...b, active: !b.active } : b)) }));
      void syncBreakpoints();
    },

    toggleBreakpointAtLine(line) {
      // The view decides how a location's line range is read (the two renderers disagree about
      // `endLine`), so it must be passed — the default would silently mis-resolve canonical UPLC.
      const hit = termAtLineForBreakpoint(line, get().termLocations, get().termView);
      if (!hit) return;
      if (get().breakpoints.some((b) => b.id === hit.termId)) {
        get().removeBreakpoint(hit.termId);
      } else {
        get().addBreakpoint(hit.termId);
      }
    },

    toggleInlayHints() {
      const next = !get().inlayHintsEnabled;
      set({ inlayHintsEnabled: next });
      useSettings.getState().set('inlayHints', next); // persist to localStorage
    },

    setTermView(view) {
      if (get().termView === view) return;
      set({ termView: view });
      useSettings.getState().set('termView', view); // persist to localStorage
      // Re-render the cached term in place (no engine round-trip), keeping breakpoints. NOT a new
      // term — `termEpoch` stays put and the profile stays valid — but every line number moved, so
      // the index is rebuilt in the SAME set() as the text it indexes, or a render would see one
      // with the other's line numbers.
      if (currentTerm) {
        const { text, locations, hints } = renderTerm(currentTerm, view);
        const p = get().profile;
        set({
          termText: text, termLocations: locations, termHints: hints,
          profileIndex: p ? buildProfileIndex(p, locations, view, get().profileMetric) : undefined,
        });
      }
    },

    // ── profiler ────────────────────────────────────────────────────────────────

    // One runner in one worker: a second loop would interleave its chunks with the first's and
    // both would report the same cumulative counters. The button is already a Cancel while a
    // profile runs; this guard covers every other caller.
    runProfile() {
      if (get().profileStatus === 'running') return Promise.resolve();
      return runProfileLoop(false);
    },

    continueProfile() {
      // Only meaningful while the worker-side runner is still alive (no Start/Restart/Stop since).
      if (get().profileStatus === 'running' || !get().profileRunnerLive) return Promise.resolve();
      return runProfileLoop(true);
    },

    /** Read between chunks, so this lands within about one chunk (~120 ms in steady state). */
    cancelProfile() { profileCancel = true; },

    clearProfile() {
      profileCancel = true;
      set({ ...PROFILE_RESET });
    },

    setProfileMetric(m) {
      // Buckets are shares of the ACTIVE metric's total, so the index is metric-dependent and is
      // rebuilt here (and only here + setTermView — `scope` doesn't reach it).
      const p = get().profile;
      set({ profileMetric: m,
            profileIndex: p ? buildProfileIndex(p, get().termLocations, get().termView, m) : undefined });
      useSettings.getState().set('profileMetric', m);
    },

    setProfileScope(s) {
      set({ profileScope: s });
      useSettings.getState().set('profileScope', s);
    },

    toggleProfileHeat() {
      const next = !get().profileHeat;
      set({ profileHeat: next });
      useSettings.getState().set('profileHeat', next);
    },

    selectProfileNode(termId) { set({ profileSelected: termId }); },

    clearError() { set({ error: undefined, errorTone: undefined }); },
  };
});
