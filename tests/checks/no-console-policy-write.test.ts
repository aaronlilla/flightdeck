/**
 * FD-7 (2026-09-06): `POST /caps` used to write straight into the tracked
 * `src/forge/model-policy.json` (the policy file's own `governor` block), which dirtied
 * that file on any live server, worktree or main checkout alike, and collided with the
 * next `git pull`. Every console cap now lives in `~/.forge/console/caps.json` instead
 * (`caps-read.ts`'s `CapsOverrides`), and nothing under `src/forge/console/` should ever
 * open the policy file for writing again.
 *
 * A live git-status check across the whole `tests/forge/console` suite would prove this
 * directly, but is slow to run on every change; this is the grep-style specimen the
 * round-3 brief allows instead. It is a proxy for "never writes the policy file", not a
 * substitute for reading the diff -- a rename of `writeFileSync` or `policyPath` would
 * slip past it undetected.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WRITE_CALL = /\b(?:writeFileSync|writeFile)\s*\(/;
const TOUCHES_POLICY_FILE = /\bpolicyPath\s*\(|model-policy\.json/;

/** Strips `/* ... *\/` block comments and `// ...` line comments so a doc comment that
 *  merely *mentions* `writeFileSync` or `model-policy.json` in prose (this file's own
 *  header, or a warning left in the source being scanned) never counts as code doing
 *  either. Naive on a `//` or `/*` inside a string literal, which the code under scan
 *  here never has a reason to write. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
}

/** `true` when `text`'s actual code both writes to the filesystem and references the
 *  policy file or its path helper -- the exact shape of the write `writeCaps`/
 *  `ensureHardUsd` used to make (`writeFileSync(path, ...)` where `path` came from
 *  `policyPath()`). A file that writes somewhere else entirely (`caps.json`, the actions
 *  ledger, the journal) never matches, because it never mentions `policyPath()` or the
 *  tracked file's name in code at all. */
export function writesThePolicyFile(text: string): boolean {
  const code = stripComments(text);
  return WRITE_CALL.test(code) && TOUCHES_POLICY_FILE.test(code);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = join(HERE, '..', '..', 'src', 'forge', 'console');

function consoleTsFiles(): string[] {
  return readdirSync(CONSOLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(CONSOLE_DIR, entry.name));
}

describe('writesThePolicyFile', () => {
  it('fires on the exact shape of the FD-7 escape: a write built off policyPath()', () => {
    const broken = `
      import { policyPath } from '../policy.js';
      export function writeCaps(body) {
        const path = policyPath();
        writeFileSync(path, JSON.stringify(policy), 'utf8');
      }
    `;
    expect(writesThePolicyFile(broken)).toBe(true);
  });

  it('fires on a write naming model-policy.json directly, no policyPath() needed', () => {
    const broken = 'writeFileSync(join(dir, "model-policy.json"), text, "utf8");';
    expect(writesThePolicyFile(broken)).toBe(true);
  });

  it('stays quiet on a write to an unrelated file, even one that also reads policyPath()', () => {
    const clean = `
      import { policyPath } from '../policy.js';
      export function ensureHardUsd(policyFilePath, overridesPath) {
        const governor = governorBudget(policyFilePath);
        writeFileSync(overridesPath, JSON.stringify({ hardUsd: governor.dailyUsd * 5 }), 'utf8');
      }
    `;
    expect(writesThePolicyFile(clean)).toBe(false);
  });

  it('stays quiet when both phrases appear only in a comment, never in code', () => {
    const clean = `
      /**
       * FD-7: this used to write into the tracked src/forge/model-policy.json via
       * writeFileSync(policyPath(), ...). It no longer does.
       */
      export function writeCaps(body) {
        writeFileSync(overridesPath, JSON.stringify(body), 'utf8');
      }
    `;
    expect(writesThePolicyFile(clean)).toBe(false);
  });

  it('stays quiet on a file that only reads the policy file and never writes anything', () => {
    const clean = `
      import { readFileSync } from 'node:fs';
      import { policyPath } from '../policy.js';
      export function readPolicy() {
        return JSON.parse(readFileSync(policyPath(), 'utf8'));
      }
    `;
    expect(writesThePolicyFile(clean)).toBe(false);
  });
});

describe('no code path under src/forge/console/ writes the tracked policy file', () => {
  it('never combines a filesystem write with a reference to the policy file or policyPath()', () => {
    const files = consoleTsFiles();
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => writesThePolicyFile(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
