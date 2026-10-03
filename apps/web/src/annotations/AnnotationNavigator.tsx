import { useState, type ReactNode } from 'react';
import { Codicon } from '../components/Codicon';
import type { AnnotationSeverity } from './annotations';
import { HintCard, SEVERITY_ICON } from './line-annotations';

export interface NavEntry {
  title: string;
  hint?: string;
  severity: AnnotationSeverity;
  /** `found`: highlighted in the editor; `missing`: no target here; `stale`: lines no longer apply. */
  status: 'found' | 'missing' | 'stale';
  /** Where it landed (`Ln 12`) or why it did not. */
  where: string;
}

/**
 * Compact annotation navigator floating over an editor: the focused entry, `2 / 5`, previous /
 * next, the full list (with the entries that did not resolve, marked and with their hints) and
 * dismiss-all. A focused entry that is not in the editor shows its hint card here instead.
 */
export function AnnotationNavigator({ entries, focus, onFocus, onDismiss, notes, actions }: {
  entries: readonly NavEntry[];
  focus: number;
  onFocus: (index: number) => void;
  onDismiss: () => void;
  /** Set-wide remarks (ignored link options, stale lines), shown in the list. */
  notes?: readonly string[];
  /** Extra buttons for the list footer. */
  actions?: ReactNode;
}) {
  const [listOpen, setListOpen] = useState(false);
  const cur = entries[focus];
  if (!cur) return null;
  const notFound = entries.filter((e) => e.status !== 'found').length;
  const many = entries.length > 1;
  return (
    <div className="ann-nav" role="toolbar" aria-label="Link annotations">
      <div className="ann-nav-bar">
        <span className={`ann-sev-icon ann-${cur.severity}`}><Codicon name={SEVERITY_ICON[cur.severity]} /></span>
        <span className="ann-nav-title" title={cur.title}>{cur.title}</span>
        {cur.status !== 'found' && <span className="ann-badge">{cur.status === 'stale' ? 'stale' : 'not found'}</span>}
        <span className="ann-nav-pos">{focus + 1} / {entries.length}</span>
        <button type="button" className="ann-icon-btn" disabled={!many} title="Previous annotation" aria-label="Previous annotation"
          onClick={() => onFocus(focus - 1)}>
          <Codicon name="chevron-up" />
        </button>
        <button type="button" className="ann-icon-btn" disabled={!many} title="Next annotation" aria-label="Next annotation"
          onClick={() => onFocus(focus + 1)}>
          <Codicon name="chevron-down" />
        </button>
        <button type="button" className={`ann-icon-btn${listOpen ? ' is-active' : ''}`} aria-pressed={listOpen}
          title={notFound ? `All annotations (${notFound} not shown in the editor)` : 'All annotations'}
          aria-label="All annotations" onClick={() => setListOpen((v) => !v)}>
          <Codicon name="list-unordered" />
          {(notFound > 0 || (notes?.length ?? 0) > 0) && <span className="ann-dot" />}
        </button>
        <button type="button" className="ann-icon-btn" title="Dismiss all annotations" aria-label="Dismiss all annotations" onClick={onDismiss}>
          <Codicon name="close-all" />
        </button>
      </div>
      {cur.status !== 'found' && !listOpen && (
        <HintCard
          severity={cur.severity}
          title={cur.title}
          hint={cur.hint}
          note={`${cur.status === 'stale' ? 'Stale' : 'Not found'} — ${cur.where}`}
        />
      )}
      {listOpen && (
        <div className="ann-list">
          {notes?.map((n) => <div key={n} className="ann-list-note"><Codicon name="info" /> {n}</div>)}
          <ol>
            {entries.map((e, i) => (
              <li key={i}>
                <button type="button" className={`ann-list-item${i === focus ? ' is-focus' : ''}`} onClick={() => onFocus(i)}>
                  <span className={`ann-sev-icon ann-${e.severity}`}><Codicon name={SEVERITY_ICON[e.severity]} /></span>
                  <span className="ann-list-text">
                    <span className="ann-list-title">{e.title}</span>
                    <span className={`ann-list-where${e.status !== 'found' ? ' is-missing' : ''}`}>
                      {e.status === 'found' ? e.where : `${e.status === 'stale' ? 'stale' : 'not found'} — ${e.where}`}
                    </span>
                    {e.status !== 'found' && e.hint && <span className="ann-list-hint">{e.hint}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {actions && <div className="ann-list-actions">{actions}</div>}
        </div>
      )}
    </div>
  );
}
