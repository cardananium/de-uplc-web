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
import { useSettings, type TermView } from './platform/settings';
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

  /** Fetch the session's root script term and serialize it into the editor model. */
  const loadTermForSession = async () => {
    if (!session) return;
    const gen = sessionGeneration;
    try {
      const term = await session.getScript();
      if (gen !== sessionGeneration) return; // session swapped under us
      if (term) {
        currentTerm = term;
        const { text, locations, hints } = renderTerm(term);
        set({ termText: text, termLocations: locations, termHints: hints });
      } else {
        currentTerm = undefined;
        set({ termText: undefined, termLocations: [], termHints: [] });
      }
    } catch (e) {
      if (gen !== sessionGeneration) return;
      console.error('[store] failed to load/serialize term:', e);
      currentTerm = undefined;
      set({ termText: undefined, termLocations: [], termHints: [] });
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
    try { handle?.dispose(); } catch { /* ignore */ }
    manager = undefined; handle = undefined; session = undefined; currentTerm = undefined; bareProgram = undefined; bareParts = undefined; txContent = undefined;
    sessionGeneration += 1;
    set({
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
    set({ status: 'running', error: undefined, errorTone: undefined, finalStatus: undefined });
    await session.start();
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

    async loadTransaction(content, fileName) {
      useTabsStore.getState().reset();
      currentTerm = undefined;
      bareProgram = undefined; bareParts = undefined; txContent = undefined; // switching back to transaction mode
      set({
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
      bareParts = undefined; txContent = undefined; // plain-program mode, not parts/tx mode
      set({
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
      bareProgram = undefined; txContent = undefined;
      set({
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
      if (!isConcreteRedeemer(redeemer)) {
        session = undefined; sessionGeneration += 1;
        currentTerm = undefined;
        set({
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
      set({ locked: true });
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
        set({ status: 'stopped', finalStatus: undefined, budget: undefined, error: undefined, errorTone: undefined });
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
      const hit = termAtLineForBreakpoint(line, get().termLocations);
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
      // Re-render the cached term in place (no engine round-trip), keeping breakpoints.
      if (currentTerm) {
        const { text, locations, hints } = renderTerm(currentTerm, view);
        set({ termText: text, termLocations: locations, termHints: hints });
      }
    },

    clearError() { set({ error: undefined, errorTone: undefined }); },
  };
});
