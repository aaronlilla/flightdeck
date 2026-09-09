/**
 * Every class a component names must exist in the stylesheet.
 *
 * Found the hard way: Settings' MCP servers plate rendered its words run together --
 * `filesystemsandbox-scoped read/write · 6 tools4 msconnected · ✓ 1s ago` -- because
 * `IntegrationsPanel.tsx` asked for `className="row"` and `styles.css` has no `.row`
 * rule. An unstyled block laid its six inline children out with no separator. Nothing
 * caught it: `integrations-panel.test.tsx` was ten green tests over the broken markup,
 * because jsdom does no layout, so no render test can see two words touching.
 *
 * A class name that styles nothing is invisible to every test that renders and to
 * TypeScript, but it is trivially visible off disk, which is where this looks. The
 * file list is walked rather than typed out, so a component added tomorrow is covered
 * the day it lands.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CONSOLE_DIR = join(process.cwd(), 'src', 'console');
const STYLESHEET = join(CONSOLE_DIR, 'styles.css');

/** `className="a b"` and `className={`a ${x} b`}` -- the static words in both. A fully
 *  computed name (`className={cls}`) has no static word and is not checked; the point
 *  is to catch the name that was written down and never defined. */
const CLASS_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;

/** A class selector in the stylesheet. Read as a token rather than tested name by name:
 *  a per-name regex is one escaping slip away from `.` matching any character, which is
 *  exactly how the first draft of this file reported `.row` as defined. */
const CSS_CLASS = /\.([A-Za-z_-][A-Za-z0-9_-]*)/g;

/** `--name:` where the stylesheet declares a custom property, and `var(--name)` where a
 *  component reads one. */
const CSS_TOKEN_DECL = /--([A-Za-z0-9-]+)\s*:/g;
const TSX_TOKEN_USE = /var\(--([A-Za-z0-9-]+)\)/g;

/** Class names the stylesheet does not own and does not need to: the framework and the
 *  test harness define their own. Empty until something earns a place here. */
const CLASS_ALLOWLIST: string[] = [];

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

/** Comments are prose. A class name written in one defines nothing, so they come out
 *  before the selectors are read. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Every class the stylesheet defines, in any compound or grouped rule, so
 *  `.rowMerge>.key` contributes both `rowMerge` and `key`. */
function definedClasses(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of stripCssComments(css).matchAll(CSS_CLASS)) names.add(match[1] ?? '');
  return names;
}

/** The words in a className, with `${...}` holes dropped: a hole is a runtime value,
 *  not a name this file can check. */
function classNamesIn(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(CLASS_ATTR)) {
    const value = match[1] ?? match[2] ?? '';
    for (const word of value.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (word) names.push(word);
    }
  }
  return names;
}

describe('every class a component names is defined in the stylesheet', () => {
  const components = walk(CONSOLE_DIR, '.tsx');
  const css = readFileSync(STYLESHEET, 'utf8');
  const defined = definedClasses(css);

  it('finds the components to check', () => {
    expect(components.length).toBeGreaterThan(10);
  });

  it('reads the stylesheet it checks against', () => {
    // A selector set that came back empty would pass every file below vacuously.
    expect(defined.size).toBeGreaterThan(10);
    expect(defined.has('rowMerge')).toBe(true);
    expect(defined.has('key')).toBe(true);
  });

  it('leaves no class naming a rule that does not exist', () => {
    const allowed = new Set(CLASS_ALLOWLIST);
    const undefinedClasses: string[] = [];
    for (const path of components) {
      for (const name of classNamesIn(readFileSync(path, 'utf8'))) {
        if (allowed.has(name) || defined.has(name)) continue;
        const entry = `${relative(path)}: .${name}`;
        if (!undefinedClasses.includes(entry)) undefinedClasses.push(entry);
      }
    }
    expect(undefinedClasses).toEqual([]);
  });

  it('leaves no custom property naming a token that does not exist', () => {
    // The same defect one layer down, and found the same way: `IntegrationsPanel`'s
    // `LED_COLOR` named `--run`, `--hand`, `--park` and `--block`, none of which the
    // stylesheet defines, so every state dot in the MCP plate painted nothing. An
    // undefined `var()` is silent -- the declaration is simply dropped.
    const declared = new Set<string>();
    for (const match of stripCssComments(css).matchAll(CSS_TOKEN_DECL)) declared.add(match[1] ?? '');
    expect(declared.size).toBeGreaterThan(10);

    const undefinedTokens: string[] = [];
    for (const path of components) {
      for (const match of readFileSync(path, 'utf8').matchAll(TSX_TOKEN_USE)) {
        const name = match[1] ?? '';
        if (declared.has(name)) continue;
        const entry = `${relative(path)}: var(--${name})`;
        if (!undefinedTokens.includes(entry)) undefinedTokens.push(entry);
      }
    }
    expect(undefinedTokens).toEqual([]);
  });

  it('prints the allowlist it honours, so an exception is never silent', () => {
    expect(CLASS_ALLOWLIST).toEqual([]);
  });
});
