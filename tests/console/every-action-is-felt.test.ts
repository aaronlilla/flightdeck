import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/**
 * Every action a screen can run reads its own in-flight state.
 *
 * Aaron, 2026-09-13: "if i click a button anywhere in the application i expect to feel
 * immediately feedback". The board's lane commands were fixed one control at a time, and
 * one-at-a-time is how this comes back: a screen grows a new button, nobody reads the
 * pending flag for it, and the click sits there looking unpressed until the next poll.
 *
 * So the rule is computed rather than listed. Every `useAction(...)` binding in the
 * console is found by reading the source, and each one has to have its `pending` read
 * somewhere in the same file. A binding whose pending state nothing reads is a control
 * that cannot tell anybody it was pressed.
 *
 * What this does not prove: that the flag reaches the right button, or that the label is
 * the right word. `a-click-is-felt.test.tsx` drives those against a rendered tree. This
 * one exists so a NEW control cannot be added with no feedback at all.
 */

/** Tracked files only, and `--others` so a file added but not yet committed is checked
 *  on the run that would otherwise wave it through. */
function consoleSources(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src/console'], { encoding: 'utf8' });
  return out.split(String.fromCharCode(10)).map((line) => line.trim())
    .filter((line) => line.endsWith('.ts') || line.endsWith('.tsx'));
}

/** `const merge = useAction(ACTIONS.mergeRun);` and the destructured form. */
const BINDING = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*useAction\(/g;

interface Binding { file: string; name: string }

function bindings(): Binding[] {
  const found: Binding[] = [];
  for (const file of consoleSources()) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(BINDING)) found.push({ file, name: match[1]! });
  }
  return found;
}

describe('a control that runs an action', () => {
  const all = bindings();

  it('finds the console\'s actions at all, so an empty sweep cannot pass', () => {
    // A regex that stops matching would otherwise turn this whole rule into a no-op.
    expect(all.length, 'no useAction bindings found -- the sweep is broken, not the code').toBeGreaterThan(10);
  });

  it.each(all.map((b) => [`${b.file} :: ${b.name}`, b] as const))(
    'reads its own pending state (%s)',
    (_label, binding) => {
      const text = readFileSync(binding.file, 'utf8');
      const reads = text.includes(`${binding.name}.pending`);
      expect(reads, `${binding.file}: nothing reads \`${binding.name}.pending\`, so pressing it shows nothing`).toBe(true);
    },
  );
});
