import { describe, it, expect } from 'vitest';
import {
  buttonStates, toggleMainAction, mainIconClass, redeemerOptions, isConcreteRedeemer,
  compareRedeemerLists, statusBadge, CHOOSE_REDEEMER, NO_REDEEMERS_AVAILABLE,
  type SessionState,
} from './button-states';

// The authoritative (state × button) table, transcribed from updateButtonStates + body.<state> CSS,
// plus the profiler cell.
// Columns: mainIcon, toggleMain, step, refresh, stop, showContext, profile, budgetVisible, budgetLoading
const TABLE: Record<SessionState, [string, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean]> = {
  empty:   ['start',    false, false, false, false, false, false, false, false],
  stopped: ['start',    true,  false, false, false, true,  true,  false, false],
  running: ['pause',    true,  false, true,  true,  true,  false, true,  true ],
  pause:   ['continue', true,  true,  true,  true,  true,  true,  true,  false],
};

describe('buttonStates truth-table', () => {
  (Object.keys(TABLE) as SessionState[]).forEach((state) => {
    const [icon, toggleMain, step, refresh, stop, showContext, profile, budgetVisible, budgetLoading] = TABLE[state];
    it(`${state} matches the table`, () => {
      expect(buttonStates(state)).toEqual({
        mainIcon: icon, toggleMain, step, refresh, stop, showContext, profile, budgetVisible, budgetLoading,
      });
    });
  });
});

describe('profile cell', () => {
  it('is offered exactly in the two states that do not own the worker', () => {
    // `running` is the only hard no (one worker, the run has it); `pause` is a yes because the
    // profile runner builds its own machine and never touches the paused session.
    expect(buttonStates('empty').profile).toBe(false);
    expect(buttonStates('stopped').profile).toBe(true);
    expect(buttonStates('running').profile).toBe(false);
    expect(buttonStates('pause').profile).toBe(true);
  });
});

describe('toggleMainAction', () => {
  it('maps each state to its action', () => {
    expect(toggleMainAction('empty')).toBeNull();
    expect(toggleMainAction('stopped')).toBe('start');
    expect(toggleMainAction('running')).toBe('pause');
    expect(toggleMainAction('pause')).toBe('continue');
  });
});

describe('mainIconClass', () => {
  it('maps icons to codicon classes', () => {
    expect(mainIconClass('start')).toBe('codicon-debug-start');
    expect(mainIconClass('pause')).toBe('codicon-debug-pause');
    expect(mainIconClass('continue')).toBe('codicon-debug-continue');
  });
});

describe('redeemer helpers', () => {
  it('prepends "Choose redeemer" when real redeemers exist', () => {
    expect(redeemerOptions(['Spend:0', 'Mint:1'])).toEqual([CHOOSE_REDEEMER, 'Spend:0', 'Mint:1']);
  });
  it('shows the no-redeemers sentinel for an empty list', () => {
    expect(redeemerOptions([])).toEqual([NO_REDEEMERS_AVAILABLE]);
  });
  it('isConcreteRedeemer rejects sentinels and empties', () => {
    expect(isConcreteRedeemer('Spend:0')).toBe(true);
    expect(isConcreteRedeemer(CHOOSE_REDEEMER)).toBe(false);
    expect(isConcreteRedeemer(NO_REDEEMERS_AVAILABLE)).toBe(false);
    expect(isConcreteRedeemer(undefined)).toBe(false);
  });
});

describe('compareRedeemerLists', () => {
  it('treats lists equal ignoring "Choose redeemer"', () => {
    expect(compareRedeemerLists(['Spend:0', 'Mint:1'], [CHOOSE_REDEEMER, 'Mint:1', 'Spend:0'])).toBe(true);
  });
  it('detects different lists', () => {
    expect(compareRedeemerLists(['Spend:0'], ['Spend:0', 'Mint:1'])).toBe(false);
    expect(compareRedeemerLists(['Spend:0'], undefined)).toBe(false);
  });
  it('same reference is equal', () => {
    const l = ['a'];
    expect(compareRedeemerLists(l, l)).toBe(true);
  });
});

describe('statusBadge', () => {
  it('maps run states to a coloured tone + label', () => {
    expect(statusBadge('running')).toMatchObject({ label: 'Running', tone: 'running' });
    expect(statusBadge('pause')).toMatchObject({ label: 'Paused', tone: 'paused' });
    expect(statusBadge('empty')).toMatchObject({ label: 'No session', tone: 'idle' });
    expect(statusBadge('stopped')).toMatchObject({ label: 'Ready', tone: 'idle' });
  });
  it('reflects the terminal result on a stopped run', () => {
    expect(statusBadge('stopped', 'Done')).toMatchObject({ label: 'Finished', tone: 'done' });
    expect(statusBadge('stopped', 'Error')).toMatchObject({ label: 'Error', tone: 'error' });
  });
  it('a terminal result never overrides an in-flight run state', () => {
    // running/paused take precedence (a finalStatus only exists once stopped).
    expect(statusBadge('running', 'Done').label).toBe('Running');
    expect(statusBadge('pause', 'Error').label).toBe('Paused');
  });
  it('always provides an icon', () => {
    for (const s of ['empty', 'stopped', 'running', 'pause'] as SessionState[]) {
      expect(statusBadge(s).icon).toBeTruthy();
    }
  });
});
