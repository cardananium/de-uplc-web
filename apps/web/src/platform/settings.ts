import { create } from 'zustand';
import type { Network, SettingsStore, NetworkPrompt } from '@de-uplc/core';

// Browser settings, persisted to localStorage. Two faces of the same keys:
//  - `useSettings` — reactive store for the Settings UI + theme.
//  - `settingsStore` — the core SettingsStore port, read fresh each call so engine
//    runs always see the latest values (matches the extension's getConfiguration).

export type ThemePref = 'light' | 'dark' | 'system';
/** Term editor rendering: the debug tree, or canonical UPLC syntax. */
export type TermView = 'tree' | 'uplc';
/** Which cost the profiler ranks and colours by. Global: heat, ruler, F8, tables, hover. */
export type ProfileMetric = 'cpu' | 'mem';
/** Which cost the REPORT TABLE sorts by. Heat/ruler/F8/top-5 always use `self`. */
export type ProfileScope = 'self' | 'subtree';

export interface Settings {
  apiKey: string;
  timeout: number;
  retryAttempts: number;
  defaultNetwork: Network;
  inlayHints: boolean;
  theme: ThemePref;
  termView: TermView;
  /** Max levels the node-explorer deep search auto-loads (bounded so it never dumps everything). */
  searchDepth: number;
  /** ms to pause between machine steps during a run, so it can be watched (0 = full speed). */
  stepDelay: number;
  // ── profiler ──
  // The first three are ALSO store fields (dual-written like termView/inlayHints), because the
  // sidebar and the report drive them live; the last three are read from here at the point of use.
  /** Metric the profiler opens on. */
  profileMetric: ProfileMetric;
  /** Cost scope the report table opens on. */
  profileScope: ProfileScope;
  /** Paint the cost lane in the term editor. */
  profileHeat: boolean;
  /** Show per-line costs as inlay hints at line ends. */
  profileInlay: boolean;
  /** Hide report rows below this share of the run, in PERCENT (0 = show everything). */
  profileMinShare: number;
  /** Whole-run step cap. Reaching it stops the profile and reports it as partial (`Limit`). */
  profileMaxSteps: number;
}

const KEYS = {
  apiKey: 'deuplc.providers.koios.apiKey',
  timeout: 'deuplc.providers.timeout',
  retryAttempts: 'deuplc.providers.retryAttempts',
  defaultNetwork: 'deuplc.providers.network',
  inlayHints: 'deuplc.enableInlayHints',
  theme: 'deuplc.theme',
  termView: 'deuplc.termView',
  searchDepth: 'deuplc.searchDepth',
  stepDelay: 'deuplc.stepDelay',
  profileMetric: 'deuplc.profile.metric',
  profileScope: 'deuplc.profile.scope',
  profileHeat: 'deuplc.profile.heat',
  profileInlay: 'deuplc.profile.inlay',
  profileMinShare: 'deuplc.profile.minShare',
  profileMaxSteps: 'deuplc.profile.maxSteps',
} as const;

const NETWORKS: Network[] = ['mainnet', 'preview', 'preprod'];
const THEMES: ThemePref[] = ['light', 'dark', 'system'];
const TERM_VIEWS: TermView[] = ['tree', 'uplc'];
export const PROFILE_METRICS: ProfileMetric[] = ['cpu', 'mem'];
export const PROFILE_SCOPES: ProfileScope[] = ['self', 'subtree'];

const DEFAULTS: Settings = {
  apiKey: '',
  timeout: 30000,
  retryAttempts: 3,
  defaultNetwork: 'mainnet',
  inlayHints: true,
  theme: 'system',
  termView: 'tree',
  searchDepth: 5,
  stepDelay: 0,
  profileMetric: 'cpu',
  profileScope: 'self',
  profileHeat: true,
  profileInlay: true,
  profileMinShare: 0.1,
  profileMaxSteps: 50_000_000,
};

function readStr(key: string, fallback: string): string {
  const v = localStorage.getItem(key);
  return v === null ? fallback : v;
}
function readNum(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
/** Like readNum but allows 0 (for delays/counts where 0 = off / full speed). */
function readNum0(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
function readBool(key: string, fallback: boolean): boolean {
  const v = localStorage.getItem(key);
  return v === null ? fallback : v === 'true';
}
function readEnum<T extends string>(key: string, allowed: T[], fallback: T): T {
  const v = localStorage.getItem(key) as T | null;
  return v !== null && allowed.includes(v) ? v : fallback;
}

function load(): Settings {
  return {
    apiKey: readStr(KEYS.apiKey, DEFAULTS.apiKey),
    timeout: readNum(KEYS.timeout, DEFAULTS.timeout),
    retryAttempts: readNum(KEYS.retryAttempts, DEFAULTS.retryAttempts),
    defaultNetwork: readEnum(KEYS.defaultNetwork, NETWORKS, DEFAULTS.defaultNetwork),
    inlayHints: readBool(KEYS.inlayHints, DEFAULTS.inlayHints),
    theme: readEnum(KEYS.theme, THEMES, DEFAULTS.theme),
    termView: readEnum(KEYS.termView, TERM_VIEWS, DEFAULTS.termView),
    searchDepth: readNum(KEYS.searchDepth, DEFAULTS.searchDepth),
    stepDelay: readNum0(KEYS.stepDelay, DEFAULTS.stepDelay),
    profileMetric: readEnum(KEYS.profileMetric, PROFILE_METRICS, DEFAULTS.profileMetric),
    profileScope: readEnum(KEYS.profileScope, PROFILE_SCOPES, DEFAULTS.profileScope),
    profileHeat: readBool(KEYS.profileHeat, DEFAULTS.profileHeat),
    profileInlay: readBool(KEYS.profileInlay, DEFAULTS.profileInlay),
    // 0 is a legal threshold ("show everything"), so readNum0, not readNum.
    profileMinShare: readNum0(KEYS.profileMinShare, DEFAULTS.profileMinShare),
    profileMaxSteps: readNum(KEYS.profileMaxSteps, DEFAULTS.profileMaxSteps),
  };
}

function persist<K extends keyof Settings>(key: K, value: Settings[K]): void {
  localStorage.setItem(KEYS[key], String(value));
}

interface SettingsState extends Settings {
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  reset(): void;
}

export const useSettings = create<SettingsState>((set) => ({
  ...load(),
  set(key, value) {
    persist(key, value);
    set({ [key]: value } as Pick<Settings, typeof key>);
  },
  reset() {
    (Object.keys(DEFAULTS) as (keyof Settings)[]).forEach((k) => persist(k, DEFAULTS[k]));
    set({ ...DEFAULTS });
  },
}));

// ── Theme ────────────────────────────────────────────────────────────────────────

/** Resolve a theme preference to a concrete light/dark (matchMedia for 'system'). */
export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

// ── Core ports ───────────────────────────────────────────────────────────────────

/** Core SettingsStore port — reads localStorage fresh each call. */
export const settingsStore: SettingsStore = {
  getProviderSettings() {
    const s = load();
    return {
      apiKey: s.apiKey || undefined,
      timeout: s.timeout,
      retryAttempts: s.retryAttempts,
      offlineEnabled: false, // offline-file bundle is a later addition
      defaultNetwork: s.defaultNetwork,
    };
  },
  getOfflineData() {
    return undefined;
  },
};

/** Network prompt — defaults to the configured network; the full-context fixture carries its own. */
export const networkPrompt: NetworkPrompt = {
  async selectNetwork() {
    return { network: load().defaultNetwork };
  },
};

