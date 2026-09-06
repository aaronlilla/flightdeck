import type { Caps } from '../../shared/console-model.js';

export function seedCaps(): Caps {
  return {
    dailyTokens: 12_000_000,
    runTokens: 4_000_000,
    hardTokens: 20_000_000,
    enforcement: 'on',
    tokensToday: 18_926_000,
    overrides: { 'FLT-204': 1_600_000 },
    sources: { dailyTokens: 'policy', runTokens: 'policy', hardTokens: 'policy' },
  };
}
