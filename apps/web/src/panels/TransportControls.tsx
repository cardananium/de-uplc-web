import { useStore } from '../store';
import { Codicon } from '../components/Codicon';
import { buttonStates, mainIconClass, statusBadge, isConcreteRedeemer } from './button-states';

/**
 * Debug transport toolbar (start/pause · step · restart · stop) + run status.
 * Lives above the term editor — it drives the run while the term is shown
 * read-only, so the controls sit with the thing they act on.
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
  const bs = buttonStates(status);
  const badge = statusBadge(status, finalStatus);
  const mainLabel = bs.mainIcon === 'start' ? 'Start' : bs.mainIcon === 'pause' ? 'Pause' : 'Continue';
  // Starting needs something runnable: a concrete redeemer (tx mode) OR a loaded UPLC program
  // (scriptOnly) — don't arm a green Start that's a no-op + toast.
  const canStart = scriptOnly || isConcreteRedeemer(currentRedeemer);
  const mainDisabled = !bs.toggleMain || locked || (bs.mainIcon === 'start' && !canStart);

  return (
    <div className="transport-bar">
      <div className="icon-box">
        <button className={`icon-button accent-${bs.mainIcon}`} title={mainLabel} aria-label={mainLabel}
          disabled={mainDisabled} onClick={() => void toggleMain()}>
          <Codicon name={mainIconClass(bs.mainIcon).replace('codicon-', '')} />
        </button>
        <button className="icon-button accent-step" title="Step" aria-label="Step"
          disabled={!bs.step || locked} onClick={() => void step()}>
          <Codicon name="debug-step-over" />
        </button>
        <button className="icon-button accent-restart" title="Restart" aria-label="Restart"
          disabled={!bs.refresh || locked} onClick={() => void refresh()}>
          <Codicon name="debug-restart" />
        </button>
        <button className="icon-button accent-stop" title="Stop" aria-label="Stop"
          disabled={!bs.stop || locked} onClick={() => void stop()}>
          <Codicon name="debug-stop" />
        </button>
      </div>

      <span className={`status-badge tone-${badge.tone}`}>
        <Codicon name={badge.icon} spin={badge.tone === 'running'} />
        {badge.label}
      </span>
      {/* run duration belongs to a finished/errored run only — don't carry it into the next state */}
      {status === 'stopped' && finalStatus && typeof runMs === 'number' && <span className="status-meta">· {runMs} ms</span>}
    </div>
  );
}
