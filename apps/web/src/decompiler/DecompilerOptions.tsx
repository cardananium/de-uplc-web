import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useDecompiler } from './decompiler-store';
import {
  getAtPath,
  setAtPath,
  type OptionCatalogue,
  type OptionChoice,
  type OptionDescriptor,
  type OptionGroup,
  type OptionsObject,
} from './catalogue';
import { Codicon } from '../components/Codicon';

function hintOf(detail: string[]): string | undefined {
  const text = detail.join('\n').trim();
  return text.length > 0 ? text : undefined;
}

/** Catalogue `detail` on a help icon — same placement as dehosk, but a real card:
 *  native `title` truncates the multi-paragraph crate prose. Portaled so the
 *  scrolling sidebar does not clip it. */
function HelpHint({ hint }: { hint: string }) {
  const iconRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelHide = () => {
    if (hideTimer.current !== undefined) clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
  };
  const show = () => { cancelHide(); setOpen(true); };
  const hideSoon = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => setOpen(false), 120);
  };

  useLayoutEffect(() => {
    if (!open || !iconRef.current) return;
    const r = iconRef.current.getBoundingClientRect();
    const width = 320;
    const maxH = Math.min(360, window.innerHeight - 24);
    const left = Math.min(r.right + 8, window.innerWidth - width - 8);
    let top = r.top;
    if (top + maxH > window.innerHeight - 8) top = window.innerHeight - 8 - maxH;
    setPos({ top: Math.max(8, top), left: Math.max(8, left) });
  }, [open]);

  useEffect(() => () => cancelHide(), []);

  return (
    <>
      <button
        ref={iconRef}
        type="button"
        className="dc-hint"
        aria-label="More info"
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={hideSoon}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
      >
        <Codicon name="question" />
      </button>
      {open && createPortal(
        <div
          className="dc-hint-pop"
          role="tooltip"
          style={{ top: pos.top, left: pos.left }}
          onMouseEnter={show}
          onMouseLeave={hideSoon}
        >
          {hint}
        </div>,
        document.body,
      )}
    </>
  );
}

function selectedValue(desc: OptionDescriptor, current: unknown): string {
  if (desc.kind.type !== 'choice') return '';
  if (current == null) return '';
  if (typeof current === 'string') return current;
  if (typeof current === 'object') {
    const match = desc.kind.choices.find(
      (c) => c.payload != null && Object.prototype.hasOwnProperty.call(current, c.payload.key),
    );
    return match ? match.value : '';
  }
  return '';
}

function valueForChoice(choice: OptionChoice): unknown {
  if (choice.payload == null) return choice.value;
  return { [choice.payload.key]: choice.payload.default };
}

function Toggle({
  path,
  label,
  description,
  hint,
  checked,
  onChange,
}: {
  path: string;
  label: string;
  description?: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="dc-check" data-option-path={path} data-option-kind="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="dc-check-text">
        <span className="dc-check-label">
          {label}
          {hint && <HelpHint hint={hint} />}
        </span>
        {description && <span className="muted dc-option-summary">{description}</span>}
      </span>
    </label>
  );
}

/** Pipeline depth for the output-layer slider. Left = earlier stop, right = full.
 *  `PolarityReport` is a diagnostic, not a stop on this axis — it is omitted. */
const LAYER_DEPTH: Record<string, number> = {
  UplcCanonical: 0,
  Uplc: 1,
  RawPseudo: 2,
  PostPipeline: 3,
  Decompiled: 4,
};

function layerSteps(choices: OptionChoice[]): OptionChoice[] {
  return choices
    .filter((c) => c.value !== 'PolarityReport' && LAYER_DEPTH[c.value] !== undefined)
    .sort((a, b) => LAYER_DEPTH[a.value] - LAYER_DEPTH[b.value]);
}

function layerTick(label: string): string {
  const head = label.split(/[\s(]/, 1)[0] ?? label;
  if (/^full$/i.test(head)) return 'Full';
  if (/^uplc$/i.test(head) && /canonical/i.test(label)) return 'Canon';
  if (/^uplc$/i.test(head)) return 'UPLC';
  if (/^raw$/i.test(head)) return 'Raw';
  if (/^post/i.test(head)) return 'Post';
  return head;
}

function LayerSlider({
  desc,
  options,
  onChange,
}: {
  desc: OptionDescriptor;
  options: OptionsObject;
  onChange: (next: OptionsObject) => void;
}) {
  if (desc.kind.type !== 'choice') return null;
  const steps = layerSteps(desc.kind.choices);
  if (steps.length === 0) return null;
  const selected = selectedValue(desc, getAtPath(options, desc.path));
  const idx = Math.max(0, steps.findIndex((c) => c.value === selected));
  const current = steps[idx] ?? steps[0];
  const pick = (i: number) => {
    const choice = steps[i];
    if (choice) onChange(setAtPath(options, desc.path, valueForChoice(choice)));
  };
  const hint = hintOf(desc.detail);
  const fill = steps.length > 1 ? (idx / (steps.length - 1)) * 100 : 0;

  return (
    <div className="dc-field dc-field-slider" data-option-path={desc.path.join('.')} data-option-kind="layer">
      <span className="dc-field-label">
        <span className="dc-field-name">{desc.label}</span>
        {hint && <HelpHint hint={hint} />}
      </span>
      <div className="dc-layer">
        <input
          type="range"
          min={0}
          max={steps.length - 1}
          step={1}
          value={idx}
          aria-valuetext={current.label}
          onChange={(e) => pick(Number(e.target.value))}
          style={{ '--dc-layer-fill': `${fill}%` } as CSSProperties}
        />
        <div className="dc-layer-ticks">
          {steps.map((c, i) => (
            <button
              key={c.value}
              type="button"
              data-layer={c.value}
              className={i === idx ? 'is-active' : undefined}
              title={c.label}
              onClick={() => pick(i)}
            >
              {layerTick(c.label)}
            </button>
          ))}
        </div>
        <span className="muted dc-layer-current">{current.label}</span>
      </div>
    </div>
  );
}

function ChoiceControl({
  desc,
  options,
  onChange,
}: {
  desc: OptionDescriptor;
  options: OptionsObject;
  onChange: (next: OptionsObject) => void;
}) {
  if (desc.kind.type !== 'choice') return null;
  if (desc.path.length === 1 && desc.path[0] === 'output_layer') {
    return <LayerSlider desc={desc} options={options} onChange={onChange} />;
  }
  const kind = desc.kind;
  const current = getAtPath(options, desc.path);
  const selected = selectedValue(desc, current);
  const selectedChoice = kind.choices.find((c) => c.value === selected);
  const payload = selectedChoice?.payload ?? null;
  const countValue =
    payload != null &&
    current != null &&
    typeof current === 'object' &&
    typeof (current as Record<string, unknown>)[payload.key] === 'number'
      ? ((current as Record<string, unknown>)[payload.key] as number)
      : (payload?.default ?? 0);

  const hint = hintOf(desc.detail);
  return (
    <div
      className="dc-field"
      data-option-path={desc.path.join('.')}
      data-option-kind="choice"
    >
      <span className="dc-field-label">
        <span className="dc-field-name">{desc.label}</span>
        {hint && <HelpHint hint={hint} />}
      </span>
      <span className="dc-choice-stack">
        <select
          value={selected}
          onChange={(e) => {
            const picked = e.target.value;
            if (picked === '') {
              onChange(setAtPath(options, desc.path, null));
              return;
            }
            const choice = kind.choices.find((c) => c.value === picked);
            if (!choice) return;
            onChange(setAtPath(options, desc.path, valueForChoice(choice)));
          }}
        >
          {kind.unset !== null && <option value="">{kind.unset}</option>}
          {kind.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {payload != null && (
          <span className="dc-count">
            <span className="muted">{payload.key.replace(/_/g, ' ')}</span>
            <input
              type="number"
              min={payload.min}
              value={countValue}
              onChange={(e) =>
                onChange(
                  setAtPath(options, desc.path, {
                    [payload.key]: Math.max(payload.min, parseInt(e.target.value, 10) || 0),
                  }),
                )
              }
            />
          </span>
        )}
      </span>
    </div>
  );
}

function Control({
  desc,
  options,
  onChange,
}: {
  desc: OptionDescriptor;
  options: OptionsObject;
  onChange: (next: OptionsObject) => void;
}) {
  if (desc.kind.type === 'toggle') {
    return (
      <Toggle
        path={desc.path.join('.')}
        label={desc.label}
        description={desc.summary}
        hint={hintOf(desc.detail)}
        checked={getAtPath(options, desc.path) === true}
        onChange={(v) => onChange(setAtPath(options, desc.path, v))}
      />
    );
  }
  if (desc.kind.type === 'choice') {
    return <ChoiceControl desc={desc} options={options} onChange={onChange} />;
  }
  return (
    <div className="dc-unsupported" data-option-path={desc.path.join('.')} data-option-kind="unsupported">
      <Codicon name="warning" />
      <span>
        This build can't render a “{(desc.kind as { type: string }).type}” control. Set <code>{desc.path.join('.')}</code> another way.
      </span>
    </div>
  );
}

function MasteredGroup({
  group,
  options,
  onChange,
}: {
  group: OptionGroup;
  options: OptionsObject;
  onChange: (next: OptionsObject) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggles = group.options.filter((o) => o.kind.type === 'toggle');
  const all = toggles.length > 0 && toggles.every((o) => getAtPath(options, o.path) === true);
  const any = toggles.some((o) => getAtPath(options, o.path) === true);
  const setMaster = (v: boolean) => {
    onChange(toggles.reduce((acc, o) => setAtPath(acc, o.path, v), options));
  };
  const state = all ? 'all on' : any ? 'partial' : 'all off';

  return (
    <div className={`dc-group${open ? '' : ' is-collapsed'}`} data-option-group={group.id}>
      <div className="dc-group-bar">
        <button type="button" className="dc-group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="dc-group-head">
            <span className="dc-group-title">{group.title}</span>
            <span className="muted dc-group-desc">
              {group.summary} · {state}
            </span>
          </span>
        </button>
        {hintOf(group.detail) && <HelpHint hint={hintOf(group.detail)!} />}
        <button
          type="button"
          className="dc-link"
          data-group-master={group.id}
          onClick={() => setMaster(!all)}
        >
          {all ? 'disable all' : 'enable all'}
        </button>
      </div>
      <div className="dc-group-body dc-checks">
        {group.options.map((desc) => (
          <Control key={desc.path.join('.')} desc={desc} options={options} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}

function PlainGroup({
  group,
  options,
  onChange,
}: {
  group: OptionGroup;
  options: OptionsObject;
  onChange: (next: OptionsObject) => void;
}) {
  const choices = group.options.filter((o) => o.kind.type === 'choice');
  const rest = group.options.filter((o) => o.kind.type !== 'choice');
  return (
    <div className="dc-plain-group" data-option-group={group.id}>
      <div className="dc-plain-head">
        <span className="dc-group-title">
          {group.title}
          {hintOf(group.detail) && <HelpHint hint={hintOf(group.detail)!} />}
        </span>
        {group.summary && <span className="muted dc-group-desc">{group.summary}</span>}
      </div>
      {choices.length > 0 && (
        <div className="mc-section dc-fields">
          {choices.map((desc) => (
            <Control key={desc.path.join('.')} desc={desc} options={options} onChange={onChange} />
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div className="mc-section dc-checks">
          {rest.map((desc) => (
            <Control key={desc.path.join('.')} desc={desc} options={options} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DecompilerOptions() {
  const catalogue = useDecompiler((s) => s.catalogue);
  const options = useDecompiler((s) => s.options);
  const loadError = useDecompiler((s) => s.catalogueError);
  const setOptions = useDecompiler((s) => s.setOptions);
  const resetOptions = useDecompiler((s) => s.resetOptions);
  const loadCatalogue = useDecompiler((s) => s.loadCatalogue);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  if (loadError != null) {
    return (
      <div className="panel dc-options">
        <div className="panel-title-row">
          <span className="panel-title">Options</span>
        </div>
        <div className="app-error" role="alert" style={{ margin: 8 }}>
          <Codicon name="warning" />
          <span className="app-error-msg">{loadError}</span>
        </div>
        <p className="muted" style={{ margin: '0 10px 10px', fontSize: 11.5 }}>
          Decompiling still works — empty options use the wasm defaults.
        </p>
        <button type="button" className="dc-link" onClick={() => void loadCatalogue()}>
          <Codicon name="discard" /> retry
        </button>
      </div>
    );
  }

  if (catalogue == null || options == null) {
    return (
      <div className="panel dc-options">
        <div className="panel-title-row">
          <span className="panel-title">Options</span>
        </div>
        <div className="muted" style={{ padding: 12, fontSize: 12.5 }}>
          <Codicon name="loading" spin /> Loading options…
        </div>
      </div>
    );
  }

  return (
    <CataloguePanel catalogue={catalogue} options={options} onChange={setOptions} onReset={resetOptions} />
  );
}

function CataloguePanel({
  catalogue,
  options,
  onChange,
  onReset,
}: {
  catalogue: OptionCatalogue;
  options: OptionsObject;
  onChange: (next: OptionsObject) => void;
  onReset: () => void;
}) {
  return (
    <div className="panel dc-options">
      <div className="panel-title-row">
        <span className="panel-title">Options</span>
        <button className="dc-link" title="Reset all options to defaults" onClick={onReset}>
          <Codicon name="discard" /> reset
        </button>
      </div>

      {catalogue.groups.map((group) =>
        group.masterPath === null ? (
          <PlainGroup key={group.id} group={group} options={options} onChange={onChange} />
        ) : (
          <MasteredGroup key={group.id} group={group} options={options} onChange={onChange} />
        ),
      )}
    </div>
  );
}
