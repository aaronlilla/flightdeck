/**
 * X2: the glass system. The palette, radius, type scale and motion are
 * pinned to a source outside this repository (the forge-spine-sdk-workers
 * build-out doc, Section 6, lines 150-170), read directly rather than
 * copied by memory. This is a text-level conformance check on
 * `styles.css` rather than a pixel comparison: component tests in this repo
 * are behaviour, never pixels, and there is no rendering harness here that
 * could compute `backdrop-filter` or a gradient stop. What this can check,
 * and what a screenshot cannot cheaply prove for every value, is that the
 * literal tokens the source names are actually present in the stylesheet the
 * built page ships, not just described in a comment.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/console/styles.css'), 'utf8');

describe('X2: the glass system palette (spec lines 154-160)', () => {
  it('uses the source ground color, not an approximation', () => {
    expect(css).toMatch(/rgb\(248,\s*250,\s*252\)/);
  });

  it('carries the three radial washes named in the source: sky, mint, lime', () => {
    expect(css).toMatch(/rgba\(186,\s*230,\s*253,\s*\.?32\)/);
    expect(css).toMatch(/rgba\(190,\s*242,\s*220,\s*\.?35\)/);
    expect(css).toMatch(/rgba\(224,\s*247,\s*196,\s*\.?24\)/);
  });

  it('carries the accent gradient stops', () => {
    expect(css).toMatch(/#0F5C33/i);
    expect(css).toMatch(/#1A9B54/i);
    expect(css).toMatch(/#34C97A/i);
  });

  it('applies a blur budget rather than the flat cut-1 surfaces', () => {
    expect(css).toMatch(/--gd-glass-blur:\s*blur\(40px\)/);
    // At least three surfaces actually reach for it (command bar, lane tile,
    // inbox rail) -- defining the token alone would carry none of the visual
    // weight the source asks for.
    const uses = css.match(/backdrop-filter:\s*var\(--gd-glass-blur\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it('uses static grain, never a canvas element', () => {
    expect(css).toMatch(/grain/i);
    expect(css).not.toMatch(/<canvas/i);
  });

  it('carries the type scale: hero, h2 and body sizes from the source', () => {
    expect(css).toMatch(/--gd-type-hero/);
    expect(css).toMatch(/-1\.28px/);
    expect(css).toMatch(/--gd-type-h2/);
    expect(css).toMatch(/--gd-type-body/);
    expect(css).toMatch(/18\.5px/);
  });

  it('carries the hover and entrance motion timings', () => {
    expect(css).toMatch(/--gd-motion-hover:\s*(2[0-9]{2}|3[0-9]{2}|400)ms/);
    expect(css).toMatch(/--gd-motion-entrance:\s*(6[0-9]{2}|7[0-9]{2}|800)ms/);
  });
});
