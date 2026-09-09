/**
 * Cut the prose out of the console. Aaron, 2026-09-09, on the R-16 console: "there
 * should be none... just get straight to the point, no bullshit, throughout the
 * entire frontend."
 *
 * The rule: a static string in a component is a LABEL, not a sentence. It names a
 * thing or a control. If it explains what a control does, the control's own label
 * already does that. If it carries a fact, the fact belongs in the data, not in the
 * chrome.
 *
 * A one-time pass rots, so this walks the tree the way `type-scale.test.ts` does --
 * the file list is never typed out here, and a component added tomorrow is covered
 * the day it lands. Three sources of static copy are read, because the prose this
 * exists to catch lived in all three: string literals, JSX text between tags, and
 * the copy-bearing double-quoted JSX attributes. A detector that read only string
 * literals would have missed every view heading and subtitle that started this.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CONSOLE_DIR = join(process.cwd(), 'src', 'console');
const MAX_LENGTH = 60;
const MAX_WORDS_BEFORE_FULL_STOP = 3;

/** Attributes whose double-quoted value is copy the operator reads or hears. */
const COPY_ATTRS = /\b(?:placeholder|title|alt|aria-label|aria-description)="([^"]*)"/g;
/** JSX text: a run between `>` and `<` carrying no braces and no tag syntax. */
const JSX_TEXT = />([^<>{}=;]+)</g;
/** A run that spans lines is not JSX text: it is the body between two TypeScript
 *  generics, whose angle brackets read as a tag pair. */
const SPANS_LINES = /[\n]/;
const SINGLE_QUOTED = /'((?:[^'\\\n]|\\.)*)'/g;
const BACKTICK = /`((?:[^`\\]|\\.)*)`/g;

/**
 * Style objects, class names, paths and ids are code, not copy. They are excluded by
 * shape rather than by name, so the exclusion cannot be widened one string at a time:
 * anything carrying CSS units, a CSS function, a path separator or a URL scheme is
 * not something an operator reads.
 */
const NOT_COPY = /var\(--|rgba?\(|minmax\(|\d\s*(?:px|fr|em|rem|vh|vw)\b|:\/\/|(?:^|\s)\.{0,2}\//;

/** The allowlist starts empty. Every entry needs a reason in a comment beside it, the
 *  way `type-scale.test.ts` names its one display-number exception. Keyed by file and
 *  exact string, so an entry can never cover a second offender by accident. */
const COPY_ALLOWLIST: Array<[string, string]> = [];

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

/** Comments carry prose on purpose; only what ships is under the rule. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** `${...}` holes stand for data, not chrome, so they measure as one character. The
 *  stand-in is a digit rather than a letter, so an ordinal (`${i + 1}. ${item}`) is
 *  not read as the end of a sentence. */
function collapseHoles(text: string): string {
  return text.replace(/\$\{[^}]*\}/g, '1');
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The rule itself, in one place: what makes a static string a sentence. */
function verdict(copy: string): string | null {
  const text = collapseHoles(copy).trim();
  if (!text || !/[A-Za-z]/.test(text)) return null;
  if (NOT_COPY.test(text)) return null;
  if (text.length > MAX_LENGTH) return `${text.length} characters, over ${MAX_LENGTH}`;
  if (/[A-Za-z]\.\s/.test(text)) return 'two sentences';
  if (/[A-Za-z]\.$/.test(text) && words(text) > MAX_WORDS_BEFORE_FULL_STOP) return 'a sentence, not a label';
  return null;
}

function copyIn(source: string): string[] {
  const text = stripComments(source);
  const out: string[] = [];
  for (const pattern of [SINGLE_QUOTED, BACKTICK, COPY_ATTRS]) {
    for (const match of text.matchAll(pattern)) out.push(match[1] ?? '');
  }
  for (const match of text.matchAll(JSX_TEXT)) {
    const run = match[1] ?? '';
    if (!SPANS_LINES.test(run)) out.push(run);
  }
  return out;
}

describe('the console says it in labels, not sentences', () => {
  const components = walk(CONSOLE_DIR, '.tsx');

  it('finds the components to check', () => {
    expect(components.length).toBeGreaterThan(10);
  });

  it('carries no sentence in its chrome', () => {
    const allowed = new Set(COPY_ALLOWLIST.map(([file, copy]) => `${file} ${copy}`));
    const bad: string[] = [];
    for (const path of components) {
      const rel = relative(path);
      for (const copy of copyIn(readFileSync(path, 'utf8'))) {
        const why = verdict(copy);
        if (why === null) continue;
        if (allowed.has(`${rel} ${copy.trim()}`)) continue;
        bad.push(`${rel}: ${JSON.stringify(copy.trim())} -- ${why}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('prints the allowlist it honours, so an exception is never silent', () => {
    expect(COPY_ALLOWLIST).toEqual([]);
  });
});
