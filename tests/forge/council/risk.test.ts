import { describe, expect, it } from 'vitest';
describe('money and identity code is never a small diff', () => {
  it.each([
    'Backend.Api/Controllers/FinancialController.cs',
    'src/features/machine/components/Tips.tsx',
    'Backend.Api/Services/WithdrawalFeeService.cs',
    'src/api/plaidApi.ts',
  ])('%s matches a risky path', async (path) => {
    const { diffRisk } = await import('../../../src/forge/council/risk.js');
    const risk = diffRisk({ changedLines: 12, paths: [path] });
    expect(risk.level).toBe('large');
    expect(risk.matchedRiskyPath).not.toBeNull();
  });

  it.each([
    'src/money.js',
    'src/ledger.js',
    'lib/currency/convert.ts',
    'app/services/refund_service.rb',
    'internal/billing/invoice.go',
    'src/balance.ts',
  ])('%s matches a risky path by generic money vocabulary', async (path) => {
    // The policy's risky paths were named after one product's vendors (Plaid, Sila,
    // Worldpay). A money file that happens not to use those words earned exactly one
    // reviewer and no independent lane -- which is how a 36-line rounding change to
    // src/money.js got a single lens. Blast radius in money code is decoupled from
    // line count, so the vocabulary has to be generic.
    const { diffRisk } = await import('../../../src/forge/council/risk.js');
    const risk = diffRisk({ changedLines: 36, paths: [path] });
    expect(risk.matchedRiskyPath).not.toBeNull();
    expect(risk.level).toBe('large');
    expect(risk.needsCodex).toBe(true);
  });

  it('gives a money diff three lenses, never one', async () => {
    const { diffRisk, lensCountFor } = await import('../../../src/forge/council/risk.js');
    const risk = diffRisk({ changedLines: 36, paths: ['src/money.js'] });
    expect(lensCountFor(risk)).toBe(3);
  });
});
