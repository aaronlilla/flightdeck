/**
 * Overlays: everything that belongs to one machine and to no repository.
 *
 * The old harness registered employer specific hooks in a file it then tried to
 * keep project agnostic, which is a contradiction no amount of care survives.
 * Here the manifest lives outside the repository and is never committed, so the
 * separation is structural rather than a rule the contamination check has to
 * enforce after the fact.
 *
 * Absent, unreadable and malformed all mean the same thing: no overlays. A
 * missing manifest is the normal case on a fresh machine, and refusing to start
 * over it would make the common path the loud one.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Overlay {
  name: string;
  root: string;
  /** Directories of skills this overlay contributes. */
  skillDirs: string[];
  /** Directories of agent definitions this overlay contributes. */
  agentDirs: string[];
  /** Path fragments the authorship guard should treat as quotation, not credit. */
  authorshipExempt: string[];
}

export interface OverlayLoad {
  overlays: Overlay[];
  /** Problems worth showing rather than swallowing. */
  problems: string[];
  manifestPath: string;
  manifestFound: boolean;
}

export function manifestPath(home = os.homedir()): string {
  return path.join(home, '.flightdeck', 'overlays.json');
}

interface RawManifest {
  overlays?: Array<{ name?: unknown; path?: unknown }>;
}

interface RawOverlayConfig {
  skills?: unknown;
  agents?: unknown;
  authorship_exempt?: unknown;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** Read one overlay repository's own declaration of what it contributes. */
export function loadOverlay(name: string, root: string): { overlay: Overlay | null; problem?: string } {
  if (!existsSync(root)) {
    return { overlay: null, problem: `overlay ${name}: nothing at ${root}` };
  }
  const configPath = path.join(root, 'harness.json');
  const config = readJson<RawOverlayConfig>(configPath) ?? {};
  const resolve = (entries: string[]) =>
    entries.map((entry) => path.resolve(root, entry)).filter((dir) => existsSync(dir));

  const declaredSkills = asStringArray(config.skills);
  const declaredAgents = asStringArray(config.agents);

  return {
    overlay: {
      name,
      root,
      // An overlay that declares nothing still gets the conventional layout, so
      // dropping a skills directory in is enough to be picked up.
      skillDirs: resolve(declaredSkills.length ? declaredSkills : ['skills']),
      agentDirs: resolve(declaredAgents.length ? declaredAgents : ['agents']),
      authorshipExempt: asStringArray(config.authorship_exempt).map((f) => f.toLowerCase()),
    },
  };
}

export function loadOverlays(home = os.homedir()): OverlayLoad {
  const file = manifestPath(home);
  const empty: OverlayLoad = {
    overlays: [],
    problems: [],
    manifestPath: file,
    manifestFound: false,
  };
  if (!existsSync(file)) return empty;

  const raw = readJson<RawManifest>(file);
  if (!raw) {
    return { ...empty, manifestFound: true, problems: [`${file} is not readable JSON`] };
  }

  const overlays: Overlay[] = [];
  const problems: string[] = [];
  for (const [index, entry] of (raw.overlays ?? []).entries()) {
    const root = typeof entry?.path === 'string' ? entry.path : '';
    const name = typeof entry?.name === 'string' && entry.name ? entry.name : `overlay-${index}`;
    if (!root) {
      problems.push(`${name}: no path`);
      continue;
    }
    const { overlay, problem } = loadOverlay(name, root);
    if (problem) problems.push(problem);
    if (overlay) overlays.push(overlay);
  }
  return { overlays, problems, manifestPath: file, manifestFound: true };
}

/** Authorship exemptions contributed by every overlay on this machine. */
export function exemptFragments(load: OverlayLoad): string[] {
  return [...new Set(load.overlays.flatMap((o) => o.authorshipExempt))];
}
