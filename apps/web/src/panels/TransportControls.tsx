import { useStore } from '../store';
import { Codicon } from '../components/Codicon';
import { buttonStates, mainIconClass, statusBadge, isConcreteRedeemer } from './button-states';

/**
 * Debug transport toolbar (start/pause · step · restart · stop) + run status, with the profiler
 * trigger in its OWN pill beside it. Profiling is not transport — putting the flame between Step
 * and Restart would say it is — but it acts on the same session, so it stays next to it.
 * Lives above the term editor: the controls sit with the thing they act on.
 */
export function TransportControls() {
  // Per-field selectors (not `useStore()`) so the header toolbar doesn't re-render on every
  // inspector pull / treeGeneration bump — only when its own inputs change. Actions are stable.
  const status = useStore((s) => s.status);
  const locked = useStore((s) => s.locked);
  const finalStatus = useStore((s) => s.finalStatus);
  const runMs = useStore((s) => s.runMs);
  const currentRedeemer = useStore((s) => s.currentRedeemer);
  const scriptOnly = useStore((s) => s.scriptOnly);
  const toggleMain = useStore((s) => s.toggleMain);
  const step = useStore((s) => s.step);
  const refresh = useStore((s) => s.refresh);
  const stop = useStore((s) => s.stop);
  const profileStatus = useStore((s) => s.profileStatus);
  const profileRun = useStore((s) => s.profileRun);
  const budget = useStore((s) => s.budget);
  const runProfile = useStore((s) => s.runProfile);
  const cancelProfile = useStore((s) => s.cancelProfile);
  const bs = buttonStates(status);
  const badge = statusBadge(status, finalStatus);
  const mainLabel = bs.mainIcon === 'start' ? 'Start' : bs.mainIcon === 'pause' ? 'Pause' : 'Continue';
  // Starting needs something runnable: a concrete redeemer (tx mode) OR a loaded UPLC program
  // (scriptOnly) — don't arm a green Start that's a no-op + toast.
  const canStart = scriptOnly || isConcreteRedeemer(currentRedeemer);
  const profiling = profileStatus === 'running';
  const mainDisabled = !bs.toggleMain || locked || profiling || (bs.mainIcon === 'start' && !canStart);
  // The debug session is genuinely still Ready/Paused while a profile runs — `statusBadge` is not
  // allowed to lie about that — so profiling gets its own pill instead of colouring that one.
  const busy = profiling ? 'Busy — profiling' : undefined;

  // There is no honest "% done" (the total step count is unknowable in advance), so the progress
  // shown is cpu-so-far against the DECLARED cpu limit, and it is labelled that way in the panel.
  // A session that declared none reports `exUnitsAvailable: null` — no percent then, rather than
  // one measured against the engine's default budget. That is a property of the SESSION, not of
  // scriptOnly: a parts deep-link carrying `exUnits` has a real limit and no redeemer.
  const cpuLimit = budget?.exUnitsAvailable;
  const pct = profiling && profileRun && cpuLimit
    ? Math.min(100, Math.round((profileRun.cpu / cpuLimit) * 100))
    : undefined;

  return (
    <div className="transport-bar">
      <div className="icon-box">
        <button className={`icon-button accent-${bs.mainIcon}`} title={busy ?? mainLabel} aria-label={mainLabel}
          disabled={mainDisabled} onClick={() => void toggleMain()}>
          <Codicon name={mainIconClass(bs.mainIcon).replace('codicon-', '')} />
        </button>
        <button className="icon-button accent-step" title={busy ?? 'Step'} aria-label="Step"
          disabled={!bs.step || locked || profiling} onClick={() => void step()}>
          <Codicon name="debug-step-over" />
        </button>
        <button className="icon-button accent-restart" title={busy ?? 'Restart'} aria-label="Restart"
          disabled={!bs.refresh || locked || profiling} onClick={() => void refresh()}>
          <Codicon name="debug-restart" />
        </button>
        <button className="icon-button accent-stop" title={busy ?? 'Stop'} aria-label="Stop"
          disabled={!bs.stop || locked || profiling} onClick={() => void stop()}>
          <Codicon name="debug-stop" />
        </button>
      </div>

      {/* Profiler — its own box. While a profile runs the SAME button cancels it, so the control
          the user needs is exactly where they left their pointer.
          Labelled, unlike the transport: ▶/⏸/↻/■ are a vocabulary every debugger shares, a flame is
          not, and this button starts a seconds-long job. The word collapses on a narrow titlebar
          (the bar scrolls), leaving the icon — which is why the icon still carries the title. */}
      <div className="icon-box">
        {profiling ? (
          <button className="icon-button accent-stop is-labelled" title="Cancel profiling" aria-label="Cancel profiling"
            onClick={cancelProfile}>
            <Codicon name="debug-stop" />
            <span className="pill-word">Cancel</span>
          </button>
        ) : (
          <button className="icon-button accent-profile is-labelled" title="Profile" aria-label="Profile"
            disabled={!bs.profile || locked || !canStart} onClick={() => void runProfile()}>
            <Codicon name="flame" />
            <span className="pill-word">Profile</span>
          </button>
        )}
      </div>

      <span className={`status-badge tone-${badge.tone}`}>
        <Codicon name={badge.icon} spin={badge.tone === 'running'} />
        {badge.label}
      </span>
      {profiling && (
        <span className="status-badge tone-profile">
          <Codicon name="loading" spin />
          {/* Below the narrow threshold the word collapses and the percentage stays — a bare
              "Profiling" with no number is the half worth losing. */}
          <span className="pill-word">Profiling</span>
          {pct !== undefined && <span>{pct}%</span>}
        </span>
      )}
      {/* run duration belongs to a finished/errored run only — don't carry it into the next state */}
      {status === 'stopped' && finalStatus && typeof runMs === 'number' && <span className="status-meta">· {runMs} ms</span>}
    </div>
  );
}
