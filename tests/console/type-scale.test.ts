/**
 * W3: one type scale, nothing under 12px. Walks every `.tsx` under `src/console/`
 * and `src/console/styles.css` (the file list computed from the tree, never
 * hand-typed) looking for a `fontSize`/`font-size`/`font:` value and fails on any
 * numeric size under 12, or any px literal at all inside a `.tsx` component --
 * once the scale lands, a component should reach for a `var(--fs-*)` token, not
 * a literal pixel size.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = join(HERE, '..', '..', 'src', 'console');
const STYLES_CSS = join(CONSOLE_DIR, 'styles.css');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function consoleTsxFiles(): string[] {
  return walk(CONSOLE_DIR);
}

/** A `fontSize:`/`font-size:`/`font:` declaration's own numeric px value, however
 *  it is spelled (a JS object literal, an inline style string, or CSS). Matches a
 *  bare number too (JS lets `fontSize: 11` mean px) since that is exactly the shape
 *  this sweep exists to catch. */
const FONT_SIZE_DECL = /font(?:Size|-size)\s*[:=]\s*(?:['"`])?\s*(\d+(?:\.\d+)?)(px)?/g;
/** `font:` shorthand: `font: 600 9.5px 'IBM Plex Mono',monospace` or the JS
 *  equivalent `font: '600 9.5px ...'` -- the size is the first `<num>px` token. */
const FONT_SHORTHAND_PX = /font:\s*['"`]?[^'"`;,\n]*?(\d+(?:\.\d+)?)px/g;

export interface Violation {
  file: string;
  match: string;
  value: number;
}

/** Every below-12px font size declaration in `text`, plus (for `.tsx` sources
 *  only) every px-literal font size regardless of value -- once the scale lands, a
 *  component should reach for `var(--fs-*)`, never a literal pixel number. */
export function findViolations(file: string, text: string): Violation[] {
  const isTsx = file.endsWith('.tsx');
  const violations: Violation[] = [];
  for (const re of [FONT_SIZE_DECL, FONT_SHORTHAND_PX]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const value = Number(m[1]);
      const isPx = re === FONT_SHORTHAND_PX || m[2] === 'px' || !text.slice(m.index, m.index + m[0].length + 3).includes('rem');
      if (value < 12 || (isTsx && isPx)) {
        violations.push({ file, match: m[0], value });
      }
    }
  }
  return violations;
}

describe('type scale (W3): nothing under 12px, and no px literal survives in a component', () => {
  it('has zero sub-12px or literal-px font sizes across src/console/**/*.tsx and styles.css', () => {
    const files = [...consoleTsxFiles(), STYLES_CSS];
    expect(files.length).toBeGreaterThan(10);
    const all = files.flatMap((file) => findViolations(file, readFileSync(file, 'utf8')));
    expect(all).toEqual([]);
  });

  it('styles.css defines the --fs-* scale variables and a 14px html base', () => {
    const css = readFileSync(STYLES_CSS, 'utf8');
    for (const token of ['--fs-body: 14px', '--fs-ui: 13px', '--fs-meta: 12px', '--fs-title: 16px', '--fs-heading: 20px']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/html\s*\{[^}]*font-size:\s*14px/);
  });
});
