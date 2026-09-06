import type { Caps } from '../../shared/console-model.js';

export function seedCaps(): Caps {
  return {
    dailyUsd: 60,
    runUsd: 20,
    hardUsd: 100,
    enforcement: 'on',
    spentTodayUsd: 94.63,
    overrides: { 'FLT-204': 8 },
  };
}
