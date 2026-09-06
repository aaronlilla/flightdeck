import { describe, it, expect } from 'vitest';
import { consoleLabel } from '../labels';

describe('consoleLabel', () => {
  it('names the head when this app started the console', () => {
    expect(consoleLabel('started', 'main @ 643fb25')).toBe('Forge — main @ 643fb25 (started)');
  });

  it('falls back to a plain "started" label when the head is unknown', () => {
    expect(consoleLabel('started', undefined)).toBe('Forge — started');
  });

  it('never claims a head for an attached console', () => {
    expect(consoleLabel('attached', 'main @ 643fb25')).toBe('Forge — attached to running console');
  });
});
