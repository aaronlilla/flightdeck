import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The linker has to be rendered by something.
 *
 * The escape, found on 2026-09-12: `Linkify` was written on 2026-09-08 for Aaron ("when
 * there's jira tickets mentioned or PRs mentioned anywhere in the application, they need
 * to be hyperlinked"), the server computed and shipped the `links` field it needs, the
 * store held it — and **no component ever rendered it**. Every part of the supply chain
 * existed except the last wire, its own unit tests were green throughout, and the feature
 * was never once on screen. It was noticed four days later only because a hover built on
 * top of it did not appear either.
 *
 * A component with no caller is not covered by its own tests. This counts the callers.
 *
 * SCOPE, stated because it is narrower than it looks: this checks per FILE, not per
 * rendered node. A component that links one string and leaves another bare still passes
 * here — proven by unwiring the strip's own heading and watching this stay green. The
 * per-node claims live in `identifier-links.test.tsx`, which renders the real components
 * and asserts the anchors. This is the coarse backstop: it catches a whole surface going
 * unwired, which is the failure that actually happened.
 */

const COMPONENTS = join(process.cwd(), 'src/console/components');

function sources(): Array<{ name: string; text: string }> {
  return readdirSync(COMPONENTS)
    .filter((name) => name.endsWith('.tsx') && name !== 'Linkify.tsx')
    .map((name) => ({ name, text: readFileSync(join(COMPONENTS, name), 'utf8') }));
}

/**
 * Every surface that renders prose a person reads, and where an identifier turns up in
 * it. Named rather than inferred: whether a component shows free text is a fact about
 * what it is for, and a heuristic over JSX would either miss one or invent one.
 */
const MUST_LINK = [
  'QuestionCard.tsx',   // the Needs-you strip, the rail's question, the lane sheet
  'LaneTile.tsx',       // the board tile's own status sentence
  'BlockersView.tsx',   // a blocker's headline and what clears it
  'QueueView.tsx',      // a queue row's reason
  'ConductorRail.tsx',  // what the agent said
];

describe('the identifier linker is rendered by something', () => {
  it('is imported by at least one component', () => {
    const callers = sources().filter((file) => /from '\.\/Linkify\.js'/.test(file.text));
    expect(callers.map((file) => file.name).sort().length).toBeGreaterThan(0);
  });

  it('is rendered, not merely imported', () => {
    const rendering = sources().filter((file) => /<Linkify\b/.test(file.text));
    expect(rendering.length, 'no component renders <Linkify />').toBeGreaterThan(0);
  });

  it('is rendered somewhere in every surface that shows prose a person reads', () => {
    const rendering = new Set(sources().filter((file) => /<Linkify\b/.test(file.text)).map((file) => file.name));
    const missing = MUST_LINK.filter((name) => !rendering.has(name));
    expect(missing, 'these render free text and would show a bare identifier').toEqual([]);
  });

  it('names only components that exist, so the list cannot rot quietly', () => {
    const present = new Set(sources().map((file) => file.name));
    expect(MUST_LINK.filter((name) => !present.has(name))).toEqual([]);
  });
});
