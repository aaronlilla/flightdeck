import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A button that cannot be pressed has to look it.
 *
 * The console's dimming was keyed on `aria-disabled` alone, so every button using the
 * native `disabled` attribute rendered at full strength: Answer with no option picked,
 * Send with an empty box, Add with an empty box. Each one read as live and did nothing
 * when clicked, which is the exact shape of control this console keeps being wrong about.
 *
 * Read from the stylesheet rather than from a rendered tree on purpose: jsdom computes no
 * styles, so a render test here would pass whatever the rule said. This is coarse, and
 * saying so is part of it -- it catches the rule going missing, not a wrong opacity.
 */
const CSS = readFileSync(join(process.cwd(), 'src', 'console', 'styles.css'), 'utf8');

describe('a button that cannot be pressed', () => {
  it('is dimmed when it carries the native disabled attribute', () => {
    const rule = CSS.split('\n').find((line) => line.startsWith('.btn[aria-busy'));
    expect(rule, 'the button dimming rule is gone entirely').toBeTruthy();
    expect(rule).toContain('.btn:disabled');
  });

  it('does not light up on hover while it is disabled', () => {
    expect(CSS).toContain('.btn:disabled:hover');
  });
});
