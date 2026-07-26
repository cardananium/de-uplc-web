import { Codicon } from './Codicon';

/**
 * A sortable column header: `<th aria-sort>` with a real `<button>` inside. The
 * `aria-sort` lives on the `th` — exactly ONE header in a table may carry anything but `none`, so
 * the caller passes the active key rather than each header deciding for itself.
 *
 * The chevron is on the active column only; `hint` becomes the button's `title`, which is where the
 * Subtree column tells the truth about what sorting by it degenerates into.
 * Classes are defined in `apps/web/src/profile/profile.css` (the only table that sorts).
 */
export function SortHeader<K extends string>({ label, sub, sortKey, active, dir, onSort, hint, className, muted }: {
  label: string;
  /** The column's second line — the denominator the cells below print under their value. */
  sub?: string;
  sortKey: K;
  active: K;
  dir: 'asc' | 'desc';
  onSort: (key: K) => void;
  hint?: string;
  className?: string;
  /** Dimmed: the column is present but currently carries no number (Σ% under a foreign sort). */
  muted?: boolean;
}) {
  const isActive = sortKey === active;
  return (
    <th
      className={`prof-th${isActive ? ' is-sorted' : ''}${muted ? ' is-muted' : ''}${className ? ` ${className}` : ''}`}
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      scope="col"
    >
      <button type="button" className="prof-sort" onClick={() => onSort(sortKey)} title={hint ?? `Sort by ${label}`}>
        <span>{label}</span>
        {isActive && <Codicon name={dir === 'asc' ? 'chevron-up' : 'chevron-down'} />}
      </button>
      {sub && <span className="prof-sub">{sub}</span>}
    </th>
  );
}
