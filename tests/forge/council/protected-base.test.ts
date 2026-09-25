import { describe, expect, it } from 'vitest';
import { protectedBaseRefusal } from '../../../src/forge/council/gh.js';

const BBZ = 'BOLTBETZ-LLC/v2-React-Native';

describe('protectedBaseRefusal', () => {
  it('lets a BoltBetz develop or feature base through', () => {
    expect(protectedBaseRefusal('develop', BBZ)).toBeNull();
    expect(protectedBaseRefusal('feature/bbz-12', BBZ)).toBeNull();
  });
  it('refuses a BoltBetz main, master, production or release base', () => {
    for (const ref of ['main', 'master', 'Main', 'production', 'release/1.2', 'release-3', 'release']) {
      expect(protectedBaseRefusal(ref, BBZ)).toMatch(/protected branch/);
    }
  });
  it('leaves FlightDeck merging into its own main', () => {
    expect(protectedBaseRefusal('main', 'aaronlilla/flightdeck')).toBeNull();
  });
  it('refuses when the base cannot be read', () => {
    expect(protectedBaseRefusal('', BBZ)).toMatch(/could not read/);
  });
});
