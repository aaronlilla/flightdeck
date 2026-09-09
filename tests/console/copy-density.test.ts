/**
 * The console shows labels, not sentences. Aaron, 2026-09-09, off the board: "there
 * should be none... just get straight to the point, no bullshit, throughout the entire
 * frontend."
 *
 * A string in a component names a thing or a control. If it explains what a control
 * does, the control's own label already did that job. If it carries a fact, the fact
 * belongs in the data. So two rules, checked over the source the same way
 * `type-scale.test.ts` checks font sizes: nothing over `MAX_CHARS`, and nothing shaped
 * like a sentence.
 *
 * Both the text between tags and whole string literals are read, because copy hides in
 * both. The file list is walked off the tree, so a component added tomorrow is covered
 * the day it lands. Sentences the server composes (`src/forge/console/**`) are out of
 * scope here; they are their own pass.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CONSOLE_DIR = join(process.cwd(), 'src', 'console');

/** Long enough for "Compact and resume" or a placeholder, short of a sentence. */
const MAX_CHARS = 60;

function walk(dir: string, ext: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, ext));
    else if (entry.name.endsWith(ext)) found.push(path);
  }
  return found;
}

function relative(path: string): string {
  return path.slice(process.cwd().length + 1).split(String.fromCharCode(92)).join('/');
}

/**
 * Every complete single-quoted and back-quoted literal in the source, skipping line and
 * block comments so a doc comment's prose is not read as copy. Walked character by
 * character rather than matched with a regex: a pattern for `'...'` happily spans the
 * gap between two adjacent literals and reports the code in between as a sentence.
 */
function literals(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '`' || c === '"') {
      const quote = c;
      let text = '';
      let closed = false;
      i += 1;
      while (i < source.length) {
        const ch = source[i]!;
        if (ch === '\\') { text += source[i + 1] ?? ''; i += 2; continue; }
        if (ch === quote) { closed = true; i += 1; break; }
        if (ch === '\n' && quote !== '`') break;
        text += ch;
        i += 1;
      }
      if (closed) out.push(text);
      continue;
    }
    i += 1;
  }
  return out;
}

/** The text a person reads between two tags: `>Queue off<`. */
function jsxText(source: string): string[] {
  return [...source.matchAll(/>([^<>{}\n]+)</g)].map((m) => m[1]!);
}

/** A string is not copy if it is a style value, an identifier, a path or a selector. */
const NOT_COPY = [
  /^[a-z-]+\.[a-z]/i,                  // module paths, file names
  /^[.#[]/,                            // selectors
  /^(var|calc|rgba?|oklch|linear-gradient|inset|minmax|repeat|translate)\(/,
  /^[\d\s.%/,()-]+$/,                  // digits and punctuation only: never prose
  /^(https?|data|file):/,
  /^\//,
  /\d\s*(px|em|rem|fr|vh|vw|ms)\b/,    // a css length, which needs its number
  /\b(solid|dashed|transparent|currentColor|nowrap|ellipsis|tabular-nums|inherit|space-between|flex-start|flex-end|border-box|sans-serif)\b/,
  /^[A-Z][A-Z0-9_]*$/,                 // constants
  /[<>{}=]/,                           // code, not copy
];

/**
 * Every exception, with the reason it is not chrome. An entry is the exact string, so
 * adding one is a decision reviewed here rather than argued inside a component.
 */
const ALLOWED = new Map<string, string>([
  ['Confirm · cannot be undone', 'the warning is the point of the card'],
  ['esc to close ✕', 'the only place the key is named'],
]);

function isCopy(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  if (ALLOWED.has(trimmed)) return false;
  if (!/[a-z]{3}/.test(trimmed)) return false;
  if (!trimmed.includes(' ')) return false;
  if (/\$\{/.test(trimmed) && trimmed.replace(/\$\{[^}]*\}/g, '').trim().length < 8) return false;
  return !NOT_COPY.some((pattern) => pattern.test(trimmed));
}

/** Sentence-shaped: a full stop with words either side, or a trailing full stop. */
function readsAsSentence(text: string): boolean {
  const trimmed = text.trim();
  if (/[a-z]{2}[.!?]\s+[A-Za-z]/.test(trimmed)) return true;
  return /[a-z]{2}[.!?]$/.test(trimmed) && trimmed.split(/\s+/).length > 3;
}

/** The visible length, with any interpolation counted as the value it stands in for. */
function visibleLength(text: string): number {
  return text.replace(/\$\{[^}]*\}/g, 'x'.repeat(8)).trim().length;
}

function offenders(): string[] {
  const bad: string[] = [];
  for (const path of walk(CONSOLE_DIR, '.tsx')) {
    const rel = relative(path);
    // Fixtures are stand-in data for the stub server, not the console's own chrome.
    if (rel.includes('/fixtures/')) continue;
    const source = readFileSync(path, 'utf8');
    for (const text of [...literals(source), ...jsxText(source)]) {
      if (!isCopy(text)) continue;
      const shown = text.trim();
      if (visibleLength(text) > MAX_CHARS) bad.push(`${rel}: ${visibleLength(text)} chars — "${shown}"`);
      else if (readsAsSentence(text)) bad.push(`${rel}: reads as a sentence — "${shown}"`);
    }
  }
  return [...new Set(bad)].sort();
}

describe('the console shows labels, not sentences', () => {
  it('finds the components to check', () => {
    expect(walk(CONSOLE_DIR, '.tsx').length).toBeGreaterThan(10);
  });

  it('has no string over the character ceiling and none shaped like a sentence', () => {
    expect(offenders()).toEqual([]);
  });

  it('prints the exceptions it honours, so none of them is silent', () => {
    expect([...ALLOWED.keys()]).toEqual(['Confirm · cannot be undone', 'esc to close ✕']);
  });
});
