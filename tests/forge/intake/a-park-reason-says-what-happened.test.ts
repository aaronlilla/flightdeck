import { describe, expect, it } from 'vitest';

import { parkReasonFor, PARK_VERDICTS } from '../../../src/forge/intake/parkReason.js';

/**
 * A parked card says what happened, not the one word the machine stopped on.
 *
 * Aaron, 2026-09-13: "the console constantly has stale or wrong or useless information."
 * A ticket relaunched three times, parked within thirty seconds each time, and the queue
 * gave up on it with:
 *
 *   queue.recovery-declined: recovered 3 times already and parked again;
 *                            a person needs to read this one
 *
 * The whole of what there was to read, on the card and in the record, was the word
 * "stopped". The park took the run's verdict -- a single token, meant for a switch
 * statement -- and used it as the sentence a person reads.
 *
 * Every verdict below is enumerated rather than sampled, so a verdict added later cannot
 * quietly fall through as a bare word again.
 */
describe('the sentence on a parked card', () => {
  it.each(PARK_VERDICTS)('says something a person can act on for "%s"', (verdict) => {
    const said = parkReasonFor(verdict, 'gate');
    expect(said.split(' ').length, `"${said}" is not a sentence`).toBeGreaterThan(3);
    expect(said.toLowerCase(), `"${said}" is the bare verdict`).not.toBe(verdict);
  });

  it('names the hop it stopped at, so the same word means different things honestly', () => {
    expect(parkReasonFor('stopped', 'gate')).not.toBe(parkReasonFor('stopped', 'run'));
  });

  it('leaves a real sentence alone rather than wrapping it twice', () => {
    const real = 'run finished done but no PR was found in its evidence or on its branch';
    expect(parkReasonFor(real, 'gate')).toBe(real);
  });

  it('answers something for a verdict nobody wrote a line for', () => {
    const said = parkReasonFor('some-new-verdict', 'run');
    expect(said).toContain('some-new-verdict');
    expect(said.split(' ').length).toBeGreaterThan(3);
  });

  it('never answers blank, whatever it is handed', () => {
    for (const input of ['', '   ', null as unknown as string, undefined as unknown as string]) {
      expect(parkReasonFor(input, 'run').trim().length).toBeGreaterThan(3);
    }
  });

  // The words on the card go through the same cleaning every other reason does, so this
  // must not smuggle machine vocabulary back onto a screen.
  it('carries no word that belongs to the machine', () => {
    for (const verdict of PARK_VERDICTS) {
      const said = parkReasonFor(verdict, 'gate').toLowerCase();
      for (const word of ['transcript', 'off-brief', 'drift']) {
        expect(said, `"${said}" says ${word}`).not.toContain(word);
      }
    }
  });
});
