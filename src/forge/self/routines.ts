/**
 * F.6, second half: a routine is a `routines/<slug>.md` file (tracked, agnostic --
 * check:agnostic runs over this directory the same as every other tracked file) with a
 * small front-matter block naming what it applies to. `matchRoutines` is the loader's
 * other half: given a packet, which routines apply, so the launcher/planner can append
 * them to a worker's own brief under `## Routines` before it starts.
 *
 * Deliberately no `routines/index.ts`: the front matter is the index, and a new routine
 * needs no second file updated to register it. Front matter is a narrow, hand-rolled
 * parse (one `tags: [a, b, c]` line) rather than a YAML dependency -- the whole shape
 * this needs is a list of strings, and pulling in a parser for that trades a real
 * dependency for a feature this file will never use.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface Routine {
  slug: string;
  tags: string[];
  body: string;
  path: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseTags(frontMatter: string): string[] {
  const line = frontMatter.split(/\r?\n/).find((l) => /^tags\s*:/.test(l));
  if (!line) return [];
  const value = line.slice(line.indexOf(':') + 1).trim();
  const bracketed = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return bracketed.split(',').map((tag) => tag.trim()).filter(Boolean);
}

/** Reads every `.md` file directly under `dir` as a routine. A directory that does not
 *  exist yet reads as no routines, never a thrown error -- a fleet that has never
 *  authored one is the ordinary starting state, not a fault. */
export function loadRoutines(dir: string): Routine[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .map((name) => {
      const path = join(dir, name);
      const text = readFileSync(path, 'utf8');
      const match = FRONT_MATTER.exec(text);
      const tags = match ? parseTags(match[1]!) : [];
      const body = (match ? match[2]! : text).trim();
      return { slug: basename(name, '.md'), tags, body, path };
    });
}

export interface RoutinePacket {
  repoKind?: string;
  keywords?: string[];
}

/** A routine matches when any of its tags equals the packet's `repoKind`, or any of its
 *  tags equals one of the packet's `keywords` -- case sensitive, on purpose: a tag is a
 *  short, deliberately chosen word, and quietly folding case would make two differently
 *  cased tags collide with no warning. */
export function matchRoutines(packet: RoutinePacket, routines: Routine[]): Routine[] {
  const wanted = new Set([packet.repoKind, ...(packet.keywords ?? [])].filter((v): v is string => Boolean(v)));
  return routines.filter((routine) => routine.tags.some((tag) => wanted.has(tag)));
}

/** Appends every matched routine's body under a `## Routines` heading. A brief with no
 *  matches comes back byte-for-byte unchanged, so a caller can always call this and never
 *  needs its own "were there any" branch. */
export function appendRoutinesSection(brief: string, routines: Routine[]): string {
  if (routines.length === 0) return brief;
  const section = ['## Routines', '', ...routines.map((routine) => routine.body)].join('\n\n');
  return `${brief}\n\n${section}`;
}

/**
 * Item 7, 2026-09-12: the whole brief a worker is handed, routines included.
 *
 * Lifted out of `queue-wire.ts#writeBrief` so a specimen can assert what a worker
 * actually reads rather than a copy of the assembly. The rule that matters most here
 * is `verify-before-commit`: commit before running the project's full check suite,
 * because anything past the 120-second foreground limit is moved to the background and
 * a run that ends its turn waiting on one dies with its work uncommitted -- six runs on
 * one ticket died exactly that way. The routine carrying that rule reaches every brief
 * only because `general` is always in the keywords and the routine is tagged `general`.
 * Nothing failed if either half changed, which is why this function exists to be tested.
 */
export function briefWithRoutines(text: string, routines: Routine[], repoKind?: string): string {
  const keywords = [...new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])];
  const matched = matchRoutines({ ...(repoKind ? { repoKind } : {}), keywords: ['general', ...keywords] }, routines);
  return appendRoutinesSection(text, matched);
}
