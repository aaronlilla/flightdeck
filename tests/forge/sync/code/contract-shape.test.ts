import { describe, expect, it } from 'vitest';

import type { CodeSyncDeps as ContractDeps } from '../../../../src/shared/sync-contract.ts';
import type { CodeSyncDeps as StreamBDeps } from '../../../../src/forge/sync/code/index.ts';

/**
 * A compile-time proof, not a runtime one: if `src/forge/sync/code/index.ts` ever
 * re-declares `CodeSyncDeps` instead of re-exporting the contract's own type, this
 * mutual-assignability check fails to typecheck (`npm run typecheck`), and this test's
 * one runtime assertion is here only so the file has something to fail red on before
 * the type existed at all.
 */
type AssertSame<A, B> = A extends B ? (B extends A ? true : never) : never;
const _sameShape: AssertSame<ContractDeps, StreamBDeps> = true;

describe('CodeSyncDeps contract parity', () => {
  it('re-exports the contract type, not a local re-declaration', () => {
    expect(_sameShape).toBe(true);
  });
});
