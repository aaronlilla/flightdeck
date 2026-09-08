/**
 * W3: one type scale for the console. Aaron, 2026-09-08, off the live board: "no text
 * should be below like 12px".
 *
 * The rule this enforces is stronger than "nothing under 12" on purpose. A component
 * may not name a pixel size for text at all -- it names a token (`var(--fs-meta)` and
 * friends), and `styles.css` is the one place a number appears. A hard-coded 12 passes
 * a floor check and still drifts the scale apart card by card, which is how the board
 * got to 126 different sizes in the first place.
 *
 * The file list is walked off the tree, never typed out here: a component added
 * tomorrow is covered the day it lands.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CONSOLE_DIR = join(process.cwd(), 'src', 'console');
const FLOOR_PX = 12;

function walk(dir: string, ext: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, ext));
    else if (entry.name.endsWith(ext)) found.push(path);
  }
  return found;
}

/** `fontSize: 11`, `fontSize: '10.5px'`, `fontSize:"9"` -- every literal form, but not
 *  `fontSize: 'var(--fs-ui)'`, which carries no digits before the closing quote. */
const TSX_FONT_SIZE = /fontSize:\s*(['"]?)([0-9][0-9.]*)(px)?\1/g;
/** A `font:` shorthand in a component style object, e.g. `font: '11.5px/1.3 ...'`. */
const TSX_FONT_SHORTHAND = /\bfont:\s*['"][^'"]*?\b([0-9][0-9.]*)px/g;
/** `font-size:11px` and the size slot of a `font:` shorthand, in the stylesheet. */
const CSS_FONT_SIZE = /font-size:\s*([0-9][0-9.]*)px/g;
const CSS_FONT_SHORTHAND = /\bfont:\s*[^;{}]*?\b([0-9][0-9.]*)px/g;

function relative(path: string): string {
  return path.slice(process.cwd().length + 1).split(String.fromCharCode(92)).join('/');
}

function offenders(text: string, path: string, pattern: RegExp, size: (m: RegExpExecArray) => number): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = size(match as RegExpExecArray);
    out.push(`${relative(path)}: ${match[0].trim()} (${value}px)`);
  }
  return out;
}

describe('the console type scale', () => {
  const components = walk(CONSOLE_DIR, '.tsx');

  it('finds the components to check', () => {
    expect(components.length).toBeGreaterThan(10);
  });

  it('names a token for every text size in a component, never a pixel number', () => {
    const bad: string[] = [];
    for (const path of components) {
      const text = readFileSync(path, 'utf8');
      bad.push(...offenders(text, path, TSX_FONT_SIZE, (m) => Number(m[2])));
      bad.push(...offenders(text, path, TSX_FONT_SHORTHAND, (m) => Number(m[1])));
    }
    expect(bad).toEqual([]);
  });

  it('keeps every size in the stylesheet at or above the 12px floor', () => {
    const css = readFileSync(join(CONSOLE_DIR, 'styles.css'), 'utf8');
    const under = [
      ...offenders(css, join(CONSOLE_DIR, 'styles.css'), CSS_FONT_SIZE, (m) => Number(m[1])),
      ...offenders(css, join(CONSOLE_DIR, 'styles.css'), CSS_FONT_SHORTHAND, (m) => Number(m[1])),
    ].filter((line) => {
      const px = Number(/\(([0-9.]+)px\)$/.exec(line)?.[1]);
      return px < FLOOR_PX;
    });
    expect(under).toEqual([]);
  });

  it('defines the scale itself, once, on :root', () => {
    const css = readFileSync(join(CONSOLE_DIR, 'styles.css'), 'utf8');
    for (const token of ['--fs-meta', '--fs-ui', '--fs-body', '--fs-title', '--fs-heading']) {
      expect(css).toContain(`${token}:`);
    }
    const meta = /--fs-meta:\s*([0-9.]+)px/.exec(css);
    expect(Number(meta?.[1])).toBeGreaterThanOrEqual(FLOOR_PX);
  });
});
