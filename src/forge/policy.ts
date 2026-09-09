/**
 * Which model runs what, and how much context it is allowed to carry.
 *
 * One file answers it, and Forge owns that file. Before 2026-09-04 four separate places
 * answered it and disagreed; the copy that ran unattended escalated a goal to Opus after
 * two resumes, and a resume is what a bloated context causes, so the bloat that made a
 * run expensive also bought it a five times tier. Four hours cost roughly $6,250 that way.
 *
 * The rule that follows: a class decides the model, a brief may name a harder class, and
 * nothing a run does to itself changes its tier. There is deliberately no function here
 * that takes a failure count.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { forgeHome } from './paths.js';

/**
 * Which side reasons a class: `codex` for the runtime master and planner (the
 * 2026-09-04 13:20 astra decision), `claude` for everything else. A class this file
 * does not name defaults to `claude` in `providerFor` below, which is every class the
 * policy shipped with today except `master` and `plan`.
 */
export type Provider = 'codex' | 'claude';

export interface ClassSpec {
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxContext: number;
  maxTurns: number;
  /** Data-driven per P3.2. Missing on an older policy fixture reads as `claude`. */
  provider?: Provider;
  /** GATE.md item 3: this class's own `Reasoner.call` budget, overriding the fleet-wide
   *  `reasoner.timeoutMs`. A class carrying none (every class an older policy file
   *  shipped with) falls back to that fleet-wide value, unchanged. */
  timeoutMs?: number;
  /** C.2: the per-hunk line cap a council lens's diff is read at before the rest of that
   *  hunk is summarised away, tuning a token spend as a data change rather than a code
   *  change. A class carrying none (every class before this field existed) falls back to
   *  `DEFAULT_MAX_DIFF_LINES`. */
  maxDiffLines?: number;
  /** R-23: the ceiling on real model calls this class may make in a rolling hour. The
   *  narration layer is the first class with one: it is called from a read route, so
   *  without a cap a board nobody is watching could narrate forever. A class carrying
   *  none is uncapped, which is every class that shipped before this field. */
  maxCallsPerHour?: number;
}

/**
 * Aaron-set budgets the Governor queues against and never silently exceeds. Missing
 * entirely (an older fixture, or a policy file this stream's field has not reached yet)
 * reads as no cap at all, which is the same "unset means unlimited" shape `priceFor`
 * already uses for a tier nobody priced -- a guess wearing the policy's authority is
 * worse than an honest absence.
 */
export interface GovernorBudget {
  dailyUsd: number;
  usdPerRun: Record<string, number>;
  /** The console's org-wide ceiling: nothing a console write sets (a daily cap, a
   *  per-run cap) may go above this. Missing reads as five times `dailyUsd`, the same
   *  "unset means a computed default, not unlimited" the console's caps read already
   *  uses -- added for the Flightdeck board (`src/forge/console/caps-write.ts`), read
   *  nowhere else in this file. */
  hardUsd?: number;
}

export interface Price {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface WardenConfig {
  contextHigh: number;
  cacheReadRatio: number;
  turnsWithoutWrite: number;
}

export interface Policy {
  version: number;
  escalation: string;
  fallback: Record<string, string[]>;
  aliases: Record<string, string>;
  interactive: { warnContext: number; model?: string };
  prices: Record<string, Price>;
  classes: Record<string, ClassSpec>;
  brief_tiers: Record<string, string>;
  subagents: Record<string, string>;
  warden?: WardenConfig;
  governor?: GovernorBudget;
  /**
   * Optional: added for Forge Intake (P4.3), read by nothing else today. `astra` gates
   * whether the Intake planner may reach gpt-6-astra through Codex at all; `'off'`
   * (the shipped default) means the planner's `plan` seam always resolves to `claude`,
   * and only `'planning-only'` turns astra on, per the 2026-09-04 16:40 amendment. A
   * policy file written before this field existed has no `reasoner` key at all, which
   * every reader here treats identically to `{ astra: 'off' }`.
   */
  reasoner?: {
    astra: 'off' | 'planning-only';
    /** How long a single `Reasoner.call` may run before it times out and gets journaled
     *  as `reasoner.timeout`, in milliseconds. A policy file written before this field
     *  existed, or one that leaves it out on purpose, falls back to the 120s default
     *  below. */
    timeoutMs?: number;
  };
  /**
   * Council's diff-risk thresholds (roadmap P4.4, decision 5) plus its two allow-lists
   * (forge-council-live). Optional: a file written before this stream has none, and
   * `council/risk.ts` falls back to its own defaults.
   *
   * `allowedRepos` and `autoMerge` are never populated with a real repo name in this
   * checked-in file -- flightdeck stays project-agnostic (`check:agnostic`), so a real
   * repo name lives only in an operator's own environment (`FORGE_COUNCIL_REPOS`,
   * `FORGE_COUNCIL_AUTOMERGE`, both comma-separated) or a local, untracked policy
   * override, never in source. Both default to empty, which `council/risk.ts` reads as
   * "review nothing" / "merge nothing" rather than "allow everything" -- fail-closed.
   */
  council?: {
    smallMaxLines: number;
    largeMinLines: number;
    riskyPaths: string[];
    codex?: 'on' | 'off';
    allowedRepos?: string[];
    autoMerge?: string[];
  };
  /** X4: the console's rail-thread router. Off by default -- a policy file with no
   *  `router` key at all (every fixture written before this field existed) reads the
   *  same as `{ enabled: false }`, never as an error. */
  router?: { enabled: boolean };
  /** The Conductor agent behind `POST /command` (2026-09-08). On by default: a policy
   *  file with no `conductor` key at all routes the rail to the agent, and only an
   *  explicit `{ agent: { enabled: false } }` keeps every message on the regex grammar. */
  conductor?: { agent?: { enabled?: boolean }; rounds?: Partial<RoundsPolicy> };
  /**
   * The protected-capability classifier's own config (roadmap P4.6, decision 6): file
   * globs and, where a path alone will not tell, an added-text pattern to search a
   * diff for. Optional -- a policy file written before this stream has none, and
   * `self-iteration/classify.ts` falls back to its own hardcoded defaults, the same
   * pattern `council/risk.ts` already uses for its own thresholds.
   */
  selfIteration?: {
    protected: Record<string, { filePatterns: string[]; symbolPatterns?: string[] }>;
  };
}

/** The spec's own illustrative numbers, used when a policy file predates this field. */
export const DEFAULT_WARDEN_CONFIG: WardenConfig = {
  contextHigh: 300_000,
  cacheReadRatio: 0.9,
  turnsWithoutWrite: 30,
};

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the policy lives. The environment override exists so a test can point at a
 * fixture, and so a machine can pin a different file without editing the runner.
 */
export function policyPath(): string {
  return process.env['FORGE_POLICY_PATH'] ?? join(HERE, 'model-policy.json');
}

let cache: { path: string; text: string; policy: Policy; size: number; mtimeMs: number } | undefined;

/**
 * The policy, re-read whenever the file changes.
 *
 * Cached on the file's own text rather than its mtime: a fixture written twice inside one
 * millisecond has the same mtime and different contents, and a stale read in a test is a
 * green row that proves nothing.
 */
export function loadPolicy(path = policyPath()): Policy {
  // The file is read again only when its size or mtime moved. Reading it on every
  // call was 40% of the 4120 server's CPU on 2026-09-09: `priceFor` and `aliasOf` run
  // once per journal event, tens of thousands of times per `/state`.
  const stat = statSync(path);
  if (cache && cache.path === path && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) return cache.policy;
  const text = readFileSync(path, 'utf8');
  const policy = cache && cache.path === path && cache.text === text ? cache.policy : JSON.parse(text) as Policy;
  cache = { path, text, policy, size: stat.size, mtimeMs: stat.mtimeMs };
  return policy;
}

export function classNames(path?: string): string[] {
  return Object.keys(loadPolicy(path).classes);
}

/** One class's full record. A name nobody declared throws rather than falling back. */
export function classFor(name: string, path?: string): ClassSpec {
  const spec = loadPolicy(path).classes[name];
  if (!spec) throw new Error(`no model class named ${name} in ${path ?? policyPath()}`);
  return spec;
}

export function modelFor(name: string, path?: string): string {
  return classFor(name, path).model;
}

export function contextFor(name: string, path?: string): number {
  return classFor(name, path).maxContext;
}

export function turnsFor(name: string, path?: string): number {
  return classFor(name, path).maxTurns;
}

export function effortFor(name: string, path?: string): ClassSpec['effort'] {
  return classFor(name, path).effort;
}

/**
 * The full model id for a tier alias.
 *
 * An alias nobody declared comes back unchanged. Inventing a mapping here would be a
 * guess wearing the policy's authority, and the SDK will say so more clearly than we can.
 */
export function modelIdFor(alias: string, path?: string): string {
  return loadPolicy(path).aliases[alias] ?? alias;
}

/** The short name for a model id, point releases included: claude-fable-5-1 is fable. */
export function aliasOf(modelId: string, path?: string): string {
  const base = (modelId ?? '').split('[')[0] ?? '';
  const aliases = loadPolicy(path).aliases;
  for (const [alias, full] of Object.entries(aliases)) {
    if (base === full || base === alias) return alias;
  }
  for (const alias of Object.keys(aliases)) {
    if (base.toLowerCase().includes(alias)) return alias;
  }
  return base;
}

/** Whether `alias` names a tier this policy actually prices. */
export function isKnownAlias(alias: string, path?: string): boolean {
  return alias in loadPolicy(path).prices;
}

/**
 * The price for a tier alias.
 *
 * An alias this policy has never priced used to fall back to Opus rates, which is a
 * guess wearing the policy's authority: a fallback reroute to a model nobody priced would
 * bill as if it were the most expensive tier rather than the unknown cost it actually is.
 * Zero here on purpose -- `journal.ts`'s replay is what records that this happened, via
 * `isKnownAlias`, rather than silently paying for it.
 */
export function priceFor(alias: string, path?: string): Price {
  const prices = loadPolicy(path).prices;
  const found = prices[alias];
  if (found) return found;
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

export function fallbackFor(alias: string, path?: string): string[] {
  return loadPolicy(path).fallback[alias] ?? [];
}

export function classForSubagent(subagentType: string, path?: string): string {
  const table = loadPolicy(path).subagents;
  return table[subagentType] ?? table['default'] ?? 'research';
}

/** X4: whether the console's router is allowed to act on a live message. Defaults to
 *  off -- a policy file written before this field existed, or one that omits it on
 *  purpose, is off, never a crash. */
export function routerEnabled(path?: string): boolean {
  return loadPolicy(path).router?.enabled === true;
}

/** Whether `POST /command` hands a message to the Conductor agent before the grammar.
 *  Defaults to on; only an explicit `conductor.agent.enabled: false` turns it off. */
export function conductorAgentEnabled(path?: string): boolean {
  return loadPolicy(path).conductor?.agent?.enabled !== false;
}

/** The Conductor's rounds (`console/rounds-route.ts`): the walk around the board that
 *  clears merged rows, relaunches dead workers, restarts what nothing holds, and hands
 *  open asks to the Conductor. `enabled` runs the ticker; `apply` lets it act, and is
 *  off until the operator has read a dry-run sheet and turned it on. */
export interface RoundsPolicy {
  enabled: boolean;
  apply: boolean;
  everyMinutes: number;
  silentMinutes: number;
  orphanHours: number;
  maxRelaunches: number;
}

export const DEFAULT_ROUNDS_POLICY: RoundsPolicy = {
  enabled: true, apply: false, everyMinutes: 10, silentMinutes: 30, orphanHours: 24, maxRelaunches: 2,
};

export function roundsConfig(path?: string): RoundsPolicy {
  return { ...DEFAULT_ROUNDS_POLICY, ...(loadPolicy(path).conductor?.rounds ?? {}) };
}

/**
 * Which provider a class reasons on, read from the file rather than a map hardcoded in
 * TypeScript (P3.2). A name nobody declared throws, same as `classFor`: guessing a
 * provider would carry the policy's authority for a class the policy never named.
 */
export function providerFor(name: string, path?: string): Provider {
  return classFor(name, path).provider ?? 'claude';
}

/** The default when a policy file names no `reasoner.timeoutMs` of its own. */
export const DEFAULT_REASONER_TIMEOUT_MS = 120_000;

/** How long the `claude` provider gives a single `Reasoner.call` before it times out
 *  and journals `reasoner.timeout`, per `reasoner.timeoutMs`. Missing entirely -- a
 *  policy file written before this field existed, or one that omits it on purpose --
 *  reads as `DEFAULT_REASONER_TIMEOUT_MS`, never as an error. */
export function reasonerTimeoutMs(path?: string): number {
  return loadPolicy(path).reasoner?.timeoutMs ?? DEFAULT_REASONER_TIMEOUT_MS;
}

/**
 * How long a single `Reasoner.call` for `className` may run, per GATE.md item 3: the
 * BBZ-99 round's `correctness` and `scope-conformance` lenses both timed out at the bare
 * fleet-wide 120s while the same round's Codex lane was budgeted 900s for the identical
 * diff. `classes.<name>.timeoutMs` overrides `reasonerTimeoutMs()` for one class; a class
 * that sets none (every class before this field existed) keeps the fleet-wide value
 * exactly as before.
 */
export function reasonerTimeoutMsFor(className: string, path?: string): number {
  return loadPolicy(path).classes[className]?.timeoutMs ?? reasonerTimeoutMs(path);
}

/**
 * R-23: how many real model calls a class may make in a rolling hour, or null when the
 * policy sets none. Null reads as uncapped rather than as zero on purpose -- every class
 * that shipped before this field is uncapped today, and a silent zero would turn a policy
 * file that has not caught up into a fleet that never reasons.
 */
export function maxCallsPerHourFor(className: string, path?: string): number | null {
  return loadPolicy(path).classes[className]?.maxCallsPerHour ?? null;
}

/** The default when a class names no `maxDiffLines` of its own. */
export const DEFAULT_MAX_DIFF_LINES = 400;

/**
 * C.2: the per-hunk line cap `reasonerLensRunner` reads a lens's diff at before
 * summarising the rest of that hunk away, read from `classes.audit-lens.maxDiffLines` so
 * tuning it is a data change. A class that sets none (every class before this field
 * existed) reads as `DEFAULT_MAX_DIFF_LINES`, same shape as `reasonerTimeoutMsFor`.
 */
export function maxDiffLinesFor(className: string, path?: string): number {
  return loadPolicy(path).classes[className]?.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
}

/**
 * The Governor's budget block: an Aaron-set daily fleet cap and per-class ceilings. A
 * policy file that carries no `governor` block reads as no cap at all, so an older
 * fixture keeps behaving exactly as it did before this field existed.
 */
export function governorBudget(path?: string): GovernorBudget {
  return loadPolicy(path).governor ?? { dailyUsd: Number.POSITIVE_INFINITY, usdPerRun: {} };
}

interface ConsoleCapsOverrides {
  dailyUsd?: number;
  runUsd?: number;
  hardUsd?: number;
}

/** `~/.forge/console/caps.json`'s top-level fields, read the same defensive way every
 *  other reader of that file does: absent or unparseable reads as no override at all,
 *  never a crash. Duplicated here rather than imported from `console/caps-read.ts`
 *  because this file has no business depending on the console at all -- the console
 *  depends on this one, for `GovernorBudget` itself. */
function readConsoleCapsOverrides(forgeHomeDir: string): ConsoleCapsOverrides {
  const path = join(forgeHomeDir, 'console', 'caps.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConsoleCapsOverrides;
    return { dailyUsd: parsed.dailyUsd, runUsd: parsed.runUsd, hardUsd: parsed.hardUsd };
  } catch {
    return {};
  }
}

/**
 * `governorBudget()` merged with whatever the console has overridden in
 * `~/.forge/console/caps.json`, so `checkBudget` (`governor.ts`) enforces the same cap
 * `GET /caps` shows and `POST /caps` edits, instead of a policy-file figure the console
 * can display but never actually move. `governorBudget()` alone stays the policy file's
 * own answer, read nowhere near a console override -- this is the one function that
 * combines the two, called from admission and from `run-actions.ts`'s cap validation, so
 * a console-set cap binds the very next launch the same way an edited policy file would.
 */
export function effectiveGovernorBudget(policyFilePath?: string, forgeHomeDir: string = forgeHome()): GovernorBudget {
  const budget = governorBudget(policyFilePath);
  const overrides = readConsoleCapsOverrides(forgeHomeDir);
  const dailyUsd = overrides.dailyUsd ?? budget.dailyUsd;
  const usdPerRun = overrides.runUsd !== undefined
    ? { ...budget.usdPerRun, implement: overrides.runUsd, default: overrides.runUsd }
    : budget.usdPerRun;
  return {
    ...budget,
    dailyUsd,
    usdPerRun,
    ...(overrides.hardUsd !== undefined ? { hardUsd: overrides.hardUsd } : {}),
  };
}

/**
 * `tier: opus` has to be a line of its own.
 *
 * A brief that argues about Opus in a sentence is discussing the question, not answering
 * it, and a substring test cannot tell those apart: it reads the argument as the decision.
 */
const TIER_LINE = /^[ \t]*(?:-[ \t]*)?tier[ \t]*:[ \t]*([A-Za-z0-9_-]+)[ \t]*$/im;

/**
 * The implementation class a brief asks for.
 *
 * This takes the brief's text and nothing else. No run history reaches it, which is what
 * makes "nothing escalates by retry" a property of the code rather than a promise in a
 * comment.
 */
export function wardenConfig(path?: string): WardenConfig {
  return loadPolicy(path).warden ?? DEFAULT_WARDEN_CONFIG;
}

export function tierOfBrief(briefText: string, path?: string): string {
  const table = loadPolicy(path).brief_tiers;
  const fallback = table['default'] ?? 'implement';
  const found = TIER_LINE.exec(briefText ?? '');
  if (!found?.[1]) return fallback;
  return table[found[1].toLowerCase()] ?? fallback;
}
