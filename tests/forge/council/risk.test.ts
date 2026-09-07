import { describe, expect, it } from 'vitest';
describe('money and identity code is never a small diff', () => {
  it.each([
    'BoltBetz.ManagementSystem/Controllers/FinancialController.cs',
    'src/features/machine/components/Tips.tsx',
    'BoltBetz.ManagementSystem/Services/WithdrawalFeeService.cs',
    'src/api/plaidApi.ts',
  ])('%s matches a risky path', async (path) => {
    const { diffRisk } = await import('../../../src/forge/council/risk.js');
    const risk = diffRisk({ changedLines: 12, paths: [path] });
    expect(risk.level).toBe('large');
    expect(risk.matchedRiskyPath).not.toBeNull();
  });
});
