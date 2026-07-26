import type { ReactNode } from 'react';
import { Codicon } from './Codicon';

/**
 * The one placeholder: icon + title + hint + optional action. It replaces the ad-hoc
 * `<div className="muted" style={{padding: …}}>` placeholders that had drifted into four different
 * paddings and two different alignments — an empty panel and an empty tab should not
 * look like two different kinds of nothing.
 *
 * Styled inline rather than through a class because it is used OUTSIDE the profiler (tabs, trees)
 * and must not depend on a stylesheet a given surface may not have loaded.
 */
export function EmptyState({ icon, title, hint, action, compact }: {
  /** Codicon id, without the `codicon-` prefix. */
  icon?: string;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  /** Inside a sidebar panel or a tree, where a 24px block would dominate the card. */
  compact?: boolean;
}) {
  return (
    <div
      className="empty-state"
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: compact ? 4 : 8,
        padding: compact ? '10px 8px' : '28px 24px', textAlign: 'center', color: 'var(--fg-muted)',
      }}
    >
      {icon && <span style={{ fontSize: compact ? 15 : 20, color: 'var(--fg-dim)' }}><Codicon name={icon} /></span>}
      <div style={{ color: 'var(--fg)', fontWeight: 600, fontSize: compact ? 12.5 : 13 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 420 }}>{hint}</div>}
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </div>
  );
}
