/**
 * Live escape 2026-09-14: three ticket workers each opened with 2-3 `forge_ask`
 * questions before writing any code -- "are we matching on the message string or is
 * there a distinct error code", "toast, modal, or inline banner, does it need a CTA",
 * "does this flow need its own copy" -- none of them a business decision, all of them
 * an engineering judgment call a competent developer makes and documents. The tool's
 * entire instruction to a worker was one permissive line with no guidance on when NOT
 * to ask, so every implementation detail became a park-wait-restart cycle. This pins
 * that the description now tells a worker to decide and proceed by default.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FORGE_ASK_DESCRIPTION } from '../../src/adapter/engine.js';

const engineSourcePath = fileURLToPath(new URL('../../src/adapter/engine.ts', import.meta.url));

describe('forge_ask tool guidance', () => {
  it('tells a worker to decide implementation details itself rather than ask', () => {
    const description = FORGE_ASK_DESCRIPTION.toLowerCase();
    expect(description).toContain('best-effort');
    expect(description).toMatch(/ui treatment|copy wording|implementation detail/);
    expect(description).toMatch(/decide|keep going|note the assumption/);
  });

  it('still names the kind of question worth asking', () => {
    const description = FORGE_ASK_DESCRIPTION.toLowerCase();
    expect(description).toMatch(/business|product|compliance|money-safety/);
    expect(description).toContain('cannot be inferred');
  });

  it('is wired into the actual tool registration, not just exported unused', () => {
    const source = readFileSync(engineSourcePath, 'utf8');
    expect(source).toMatch(/tool\('forge_ask',\s*FORGE_ASK_DESCRIPTION/);
  });
});
