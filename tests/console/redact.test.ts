import { describe, expect, it } from 'vitest';
import { redactErrorBody } from '../../src/console/redact.js';

describe('redactErrorBody reason folding', () => {
  it('appends a worded reason to the error text', () => {
    expect(redactErrorBody(JSON.stringify({ error: 'not wired', reason: 'no repo/PR on record for run x' })))
      .toBe('not wired: no repo/PR on record for run x');
  });
  it('drops a bare machine-code reason', () => {
    expect(redactErrorBody(JSON.stringify({ error: 'reaudit needs review, not blocked', reason: 'wrong-state' })))
      .toBe('reaudit needs review, not blocked');
  });
});
