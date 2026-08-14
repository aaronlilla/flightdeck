/**
 * Portable settings: carrying plugins between machines.
 *
 * Skills are directories, so bootstrap can link them. Plugins are not. A plugin
 * lives in a versioned cache the engine owns, and what switches it on is a pair
 * of entries in ~/.claude/settings.json. Those entries are the part worth
 * committing. This module merges them in and lets the engine fetch the plugin
 * itself on next launch.
 *
 * The merge only ever adds. A machine that has already been configured holds
 * decisions somebody made deliberately, including a plugin switched off on
 * purpose, and a setup step that quietly reverses those is worse than one that
 * does nothing. So an existing key is never rewritten and a key absent from the
 * repo is never removed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeHome } from './links.ts';

/**
 * The keys worth carrying between machines. Everything else in settings.json is
 * local. `env` is here because a plugin's opt-out switch belongs with the line
 * that enables the plugin: shipping impeccable without IMPECCABLE_NO_TELEMETRY
 * would turn telemetry back on for whoever bootstraps next.
 */
const PORTABLE_KEYS = ['enabledPlugins', 'extraKnownMarketplaces', 'env'] as const;

export type SettingsStatus = 'ok' | 'added' | 'source-missing' | 'unreadable';

export interface SettingsPlan {
  /** The declaration in the checkout. */
  source: string;
  /** The machine's settings file. */
  target: string;
}

export interface SettingsReport {
  plan: SettingsPlan;
  status: SettingsStatus;
  /** Dotted names this run wrote, e.g. `enabledPlugins.superpowers@official`. */
  added: string[];
  /** Dotted names the machine already had, left exactly as they were. */
  alreadyPresent: string[];
  detail: string;
}

export function settingsPlan(repoRoot: string, home = os.homedir()): SettingsPlan {
  return {
    source: path.join(repoRoot, 'doctrine', 'settings.portable.json'),
    target: path.join(claudeHome(home), 'settings.json'),
  };
}

type Bag = Record<string, unknown>;

function readJson(file: string): Bag | null | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined; // no file
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Bag) : null;
  } catch {
    return null; // present but not usable
  }
}

/** Work out what a merge would change, without changing it. */
function diff(plan: SettingsPlan): {
  status: SettingsStatus;
  added: string[];
  alreadyPresent: string[];
  merged: Bag | null;
  detail: string;
} {
  const portable = readJson(plan.source);
  if (portable === undefined) {
    return {
      status: 'source-missing',
      added: [],
      alreadyPresent: [],
      merged: null,
      detail: `nothing at ${plan.source}`,
    };
  }
  if (portable === null) {
    return {
      status: 'unreadable',
      added: [],
      alreadyPresent: [],
      merged: null,
      detail: `${plan.source} is not valid json`,
    };
  }

  const current = readJson(plan.target);
  if (current === null) {
    // A settings file that will not parse is somebody's problem to fix by hand.
    // Rewriting it would replace a broken file with a lossy one.
    return {
      status: 'unreadable',
      added: [],
      alreadyPresent: [],
      merged: null,
      detail: `${plan.target} is not valid json, so it was left untouched`,
    };
  }

  // Mutating the parsed object keeps the machine's existing key order intact and
  // appends anything new at the end, so the diff a human sees stays small.
  const merged: Bag = current ?? {};
  const added: string[] = [];
  const alreadyPresent: string[] = [];

  for (const key of PORTABLE_KEYS) {
    const wanted = portable[key];
    if (!wanted || typeof wanted !== 'object') continue;

    const existing = merged[key];
    const into: Bag = existing && typeof existing === 'object' ? (existing as Bag) : {};
    merged[key] = into;

    for (const [name, value] of Object.entries(wanted as Bag)) {
      if (Object.hasOwn(into, name)) {
        alreadyPresent.push(`${key}.${name}`);
        continue;
      }
      into[name] = value;
      added.push(`${key}.${name}`);
    }
  }

  return {
    status: added.length ? 'added' : 'ok',
    added,
    alreadyPresent,
    merged,
    detail: added.length ? `${added.length} to add` : 'machine already declares all of them',
  };
}

export function inspectSettings(plan: SettingsPlan): SettingsReport {
  const { status, added, alreadyPresent, detail } = diff(plan);
  return { plan, status: status === 'added' ? 'added' : status, added, alreadyPresent, detail };
}

export function applySettings(plan: SettingsPlan): SettingsReport {
  const result = diff(plan);
  if (result.status !== 'added' || !result.merged) {
    return {
      plan,
      status: result.status,
      added: result.added,
      alreadyPresent: result.alreadyPresent,
      detail: result.detail,
    };
  }

  mkdirSync(path.dirname(plan.target), { recursive: true });
  // Write beside the target and rename over it, so an interrupted run cannot
  // leave a half-written settings file behind.
  const scratch = `${plan.target}.flightdeck-tmp`;
  writeFileSync(scratch, `${JSON.stringify(result.merged, null, 2)}\n`);
  renameSync(scratch, plan.target);

  return {
    plan,
    status: 'ok',
    added: result.added,
    alreadyPresent: result.alreadyPresent,
    detail: `added ${result.added.length}`,
  };
}

export function describeSettings(report: SettingsReport): string {
  const name = 'settings.json';
  if (report.status === 'source-missing') return `  ok    ${name.padEnd(14)} ${report.detail}`;
  if (report.status === 'unreadable') return `  FAIL  ${name.padEnd(14)} ${report.detail}`;
  const kept = report.alreadyPresent.length;
  const parts = [`${report.added.length} added`, `${kept} already declared`];
  const head = `  ok    ${name.padEnd(14)} ${parts.join(', ')}`;
  return report.added.length ? `${head}\n           ${report.added.join('\n           ')}` : head;
}
