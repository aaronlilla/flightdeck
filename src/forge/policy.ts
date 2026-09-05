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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ClassSpec {
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxContext: number;
  maxTurns: number;
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

let cache: { path: string; text: string; policy: Policy } | undefined;

/**
 * The policy, re-read whenever the file changes.
 *
 * Cached on the file's own text rather than its mtime: a fixture written twice inside one
 * millisecond has the same mtime and different contents, and a stale read in a test is a
 * green row that proves nothing.
 */
export function loadPolicy(path = policyPath()): Policy {
  const text = readFileSync(path, 'utf8');
  if (cache && cache.path === path && cache.text === text) return cache.policy;
  const policy = JSON.parse(text) as Policy;
  cache = { path, text, policy };
  return policy;
}

export function classNames(path?: string): string[] {
  return Object.keys(loadPolicy(path).classes);
}

/** One class's full record. A name nobody declared throws rather than falling back. */
export function classFor(name: string, path?: string): ClassSpec {
  const spec = loadPolicy(path).classes[name];
  if (!spec) throw new Error(`no model class named ${name} in ${policyPath()}`);
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
