/**
 * Dispatcher decision 7: weekly chaos runs are Phase 7, not this stream. The stub
 * refuses with "not built" rather than faking a pass.
 */
import { describe, expect, it } from 'vitest';

import { runChaos } from '../../../src/forge/self-iteration/chaos.js';

describe('runChaos', () => {
  it('always refuses with "not built"', () => {
    expect(runChaos()).toEqual({ ran: false, reason: 'not built' });
  });
});
