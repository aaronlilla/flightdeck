import { describe, expect, it } from 'vitest';

import { findHaipingHandoff } from '../../../src/forge/council/handoffScan.ts';

const HANDOFF = {
  ticket: 'BBZ-1', pr: 'acme/widgets#105', deployKind: 'ota',
  perPlatform: { android: 'abc123', ios: 'def456' },
  steps: ['open the app', 'confirm the banner shows'],
  notVisuallyVerified: [],
};

describe('findHaipingHandoff', () => {
  it('finds a complete handoff inside a fenced json block', () => {
    const body = `Some notes.\n\n\`\`\`json\n${JSON.stringify(HANDOFF)}\n\`\`\`\n\nMore notes.`;
    expect(findHaipingHandoff(body)).toEqual(HANDOFF);
  });

  it('returns undefined when the body has no fenced block at all', () => {
    expect(findHaipingHandoff('just prose, no handoff here')).toBeUndefined();
  });

  it('returns undefined when the only fenced block is incomplete', () => {
    const body = `\`\`\`json\n${JSON.stringify({ ticket: 'BBZ-1' })}\n\`\`\``;
    expect(findHaipingHandoff(body)).toBeUndefined();
  });

  it('skips an unparseable fenced block and still finds a later valid one', () => {
    const body = `\`\`\`json\nnot json\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(HANDOFF)}\n\`\`\``;
    expect(findHaipingHandoff(body)).toEqual(HANDOFF);
  });
});
