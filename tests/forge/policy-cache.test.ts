/**
 * `loadPolicy` reads its file only when the file changed.
 *
 * The failure this closes: it read the file on every call and compared the text, so
 * `priceFor` and `aliasOf`, which run once per journal event, read model-policy.json
 * tens of thousands of times per `/state`: 40% of the 4120 server's CPU on 2026-09-09.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPolicy } from '../../src/forge/policy.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'policy-cache-'));
  path = join(dir, 'model-policy.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadPolicy', () => {
  it('hands back the same parsed object while the file is unchanged', () => {
    writeFileSync(path, JSON.stringify({ classes: { a: { model: 'sonnet' } }, aliases: {} }), 'utf8');
    const first = loadPolicy(path);
    expect(loadPolicy(path)).toBe(first);
    expect(loadPolicy(path)).toBe(first);
  });

  it('re-reads once the file is rewritten', () => {
    writeFileSync(path, JSON.stringify({ classes: { a: { model: 'sonnet' } }, aliases: {} }), 'utf8');
    const first = loadPolicy(path);
    writeFileSync(path, JSON.stringify({ classes: { a: { model: 'opus' }, b: { model: 'haiku' } }, aliases: {} }), 'utf8');
    // A rewrite inside the same millisecond would share an mtime; move it on to be sure
    // the test measures the content change and not the clock.
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    const second = loadPolicy(path);
    expect(second).not.toBe(first);
    expect(Object.keys(second.classes)).toEqual(['a', 'b']);
  });
});
