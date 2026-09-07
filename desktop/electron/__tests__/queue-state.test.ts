import { describe, expect, it } from 'vitest';
import { queueIsOn } from '../queue-state';

describe('queueIsOn', () => {
  it('is false when FORGE_QUEUE is unset', () => {
    expect(queueIsOn({})).toBe(false);
  });

  it('is true only when FORGE_QUEUE is exactly "1"', () => {
    expect(queueIsOn({ FORGE_QUEUE: '1' })).toBe(true);
  });

  it('is false for any other value, never truthy-coerced', () => {
    expect(queueIsOn({ FORGE_QUEUE: 'true' })).toBe(false);
    expect(queueIsOn({ FORGE_QUEUE: 'yes' })).toBe(false);
  });
});
