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

/**
 * A gate that runs and exits non-zero answers 502 with `{ ok:false, message }` and no
 * `error` field (`run-actions.ts` gateAction and reopenRun). The reader only looked at
 * `error`, so the one thing worth showing -- the last lines of the gate's own output,
 * sitting in `message` -- was thrown away and the operator got "the server did not say
 * why" on a refusal the server had explained in full.
 */
describe('a failure whose explanation is in message', () => {
  it('shows the message when there is no error field', () => {
    expect(redactErrorBody(JSON.stringify({ ok: false, jid: 'j1', message: 'gate exited 1 | 2 checks failed', undoable: false })))
      .toBe('gate exited 1 | 2 checks failed');
  });

  it('still prefers error when both are present', () => {
    expect(redactErrorBody(JSON.stringify({ error: 'not wired', message: 'ignore me' })))
      .toBe('not wired');
  });

  it('redacts a path out of the message the same way', () => {
    expect(redactErrorBody(JSON.stringify({ ok: false, message: 'gate failed in C:\\dev\\flightdeck' })))
      .toBe('gate failed in [path]');
  });

  it('keeps the flat fallback when the body explains nothing', () => {
    expect(redactErrorBody(JSON.stringify({ ok: false, undoable: false })))
      .toBe('the server did not say why');
  });
});
