/**
 * Coverage of the action catalog is computed, never remembered. `src/console/api.ts`
 * is read as source, every exported function that issues a non-GET request is listed,
 * and a call missing from `ACTIONS` fails this test. A new mutating endpoint therefore
 * cannot reach the console without a catalog entry saying what it is called, whether
 * it can be undone, and where its effect can be seen.
 *
 * The scanner is proven rather than trusted: `mutatingExports` is exercised against a
 * fixture module carrying an unregistered mutating export, and against one carrying a
 * read that must not be mistaken for a write.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ACTIONS, ACTION_LIST, EFFECT_SLICES } from '../../src/console/actions.js';

const API_PATH = fileURLToPath(new URL('../../src/console/api.ts', import.meta.url));

/** Every `export function` in a module whose body issues a request that is not a GET.
 *  The two shapes `api.ts` uses are the local `post<T>(...)` helper and an explicit
 *  `method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'` on `call`. */
export function mutatingExports(source: string): string[] {
  const found: string[] = [];
  const pattern = /export function (\w+)\([\s\S]*?\n\}/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1] as string;
    const body = match[0];
    const writes = /\bpost[<(]/.test(body) || /method:\s*'(POST|PUT|PATCH|DELETE)'/.test(body);
    if (writes) found.push(name);
  }
  return found;
}

describe('the scanner itself', () => {
  it('finds a mutating export and ignores a read', () => {
    const fixture = `
export function getThings(): Promise<T> {
  return call<T>('/things');
}
export function nukeThings(id: string): Promise<T> {
  return post<T>('/things/' + id + '/nuke', {});
}
`;
    expect(mutatingExports(fixture)).toEqual(['nukeThings']);
  });

  it('finds a write spelled as an explicit method on call', () => {
    const fixture = `
export function dropThing(id: string): Promise<T> {
  return call<T>('/things/' + id, { method: 'DELETE' });
}
`;
    expect(mutatingExports(fixture)).toEqual(['dropThing']);
  });

  it('reports an unregistered mutating export as missing', () => {
    // The specimen the real assertion below would catch: a new write with no entry.
    const fixture = `
export function nukeThings(id: string): Promise<T> {
  return post<T>('/nuke', {});
}
`;
    const missing = mutatingExports(fixture).filter((name) => !(name in ACTIONS));
    expect(missing).toEqual(['nukeThings']);
  });
});

describe('action catalog coverage', () => {
  const source = readFileSync(API_PATH, 'utf8');
  const writes = mutatingExports(source);

  it('finds the mutating calls at all', () => {
    // A scanner that matched nothing would make every assertion below vacuous.
    expect(writes.length).toBeGreaterThan(20);
    expect(writes).toContain('killRun');
    expect(writes).not.toContain('getLanes');
  });

  it('has a catalog entry for every mutating export of api.ts', () => {
    const missing = writes.filter((name) => !(name in ACTIONS));
    expect(missing).toEqual([]);
  });

  it('names no entry that api.ts does not export as a write', () => {
    const stale = Object.keys(ACTIONS).filter((id) => !writes.includes(id));
    expect(stale).toEqual([]);
  });
});

describe('every catalog entry is well formed', () => {
  it('keys itself by its own id', () => {
    for (const [key, entry] of Object.entries(ACTIONS)) expect(entry.id).toBe(key);
  });

  it('carries a label, a literal reversible and a known effect', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/console/actions.ts', import.meta.url)), 'utf8');
    for (const entry of ACTION_LIST) {
      expect(entry.label, entry.id).toBeTruthy();
      expect(typeof entry.reversible, entry.id).toBe('boolean');
      expect(EFFECT_SLICES[entry.effect], entry.id).toBeDefined();
      // `reversible` is written out, never computed: the confirm gate is readable
      // from the catalog alone rather than from whatever a helper decided at runtime.
      const at = source.indexOf(`id: '${entry.id}',`);
      expect(at, entry.id).toBeGreaterThan(-1);
      const declaration = source.slice(at, at + 200);
      expect(declaration.includes('reversible: true') || declaration.includes('reversible: false'), entry.id).toBe(true);
    }
  });

  it('takes a confirm token on every irreversible entry', () => {
    for (const entry of ACTION_LIST.filter((e) => e.reversible === false)) {
      // arity 2 means the call signature is (args, confirm) -- an irreversible entry
      // that ignored the token could never get past the server's 202.
      expect(entry.call.length, entry.id).toBe(2);
    }
  });
});
