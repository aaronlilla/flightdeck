import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every write the console can make has a control somewhere a person can click.
 *
 * Measured, not listed. On 2026-09-12 a sweep of `api.ts` against the rest of the front
 * end found thirteen mutating calls that no screen offered: putting work into the queue,
 * taking it back out, pausing the queue, pausing a lane, retiring one, capping its spend,
 * re-auditing it, amending its brief, merging everything ready, clearing the finished
 * lanes, bringing back a dismissed proposal. The server had taken all of them since the
 * day they were written. A ticket could not be taken from the queue to a merge without
 * leaving the console for a terminal.
 *
 * So this counts rather than remembers: a route added with no button fails here.
 *
 * What it can and cannot see. A control counts when the front end names the call, either
 * through the action registry or directly -- so it catches a call nothing references at
 * all, and it does NOT catch one referenced by a component that never renders. That
 * narrowness is the reason `tests/console/queue-add.test.tsx` and its siblings exist
 * beside it, asserting on rendered controls; this is the backstop that notices a whole
 * capability going missing.
 */

const EXEMPT: Record<string, string> = {
  // The "Not now" button on an ask posts `dismiss <token>` through the command grammar,
  // which reaches the same place. The client function is the other route to it.
  dismissAsk: 'reachable through the ask card\'s "Not now", which posts the grammar\'s own dismiss',
  // A production publish is a decision an operator makes explicitly, never a default the
  // console ships wired to a click (standing order 9). The server half refuses too, by
  // name, until that decision is made.
  promoteQueueItem: 'a production publish is deliberately not wired to a button (standing order 9)',
};

function read(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { read(path, out); continue; }
    if (!/\.tsx?$/.test(name)) continue;
    if (name === 'api.ts' || name === 'stub-server.ts' || name === 'actions.ts') continue;
    out.push(readFileSync(path, 'utf8'));
  }
  return out;
}

/** Every exported function in `api.ts` that changes something on the server. */
function mutatingCalls(): string[] {
  const api = readFileSync(join(process.cwd(), 'src', 'console', 'api.ts'), 'utf8');
  const found: string[] = [];
  for (const match of api.matchAll(/export (?:async )?function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = match;
    if (!name || !body) continue;
    if (body.includes('post<') || body.includes("method: 'PATCH'") || body.includes("method: 'DELETE'")) {
      found.push(name);
    }
  }
  return found;
}

describe('every write the console can make', () => {
  const calls = mutatingCalls();
  const frontEnd = read(join(process.cwd(), 'src', 'console')).join('\n');

  it('finds the calls at all, so an empty sweep never reads as full coverage', () => {
    expect(calls.length).toBeGreaterThan(30);
  });

  it('has a control somewhere, or a written reason why not', () => {
    const orphans = calls.filter((name) => (
      !Object.hasOwn(EXEMPT, name)
      && !frontEnd.includes(`ACTIONS.${name}`)
      && !new RegExp(`\\b${name}\\s*\\(`).test(frontEnd)
    ));
    expect(orphans, 'these server writes have no control on any screen').toEqual([]);
  });

  it('keeps no exemption for a call that no longer exists', () => {
    const stale = Object.keys(EXEMPT).filter((name) => !calls.includes(name));
    expect(stale, 'these exemptions name a call api.ts no longer has').toEqual([]);
  });
});
