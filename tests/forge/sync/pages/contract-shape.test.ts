import { describe, expect, it } from 'vitest';

import type { PageSyncStage, StageResult as ContractStageResult } from '../../../../src/shared/sync-contract.ts';
import type { StageResult as StreamCStageResult } from '../../../../src/forge/sync/pages/sessions.ts';
import { syncAccounts } from '../../../../src/forge/sync/pages/accounts.ts';
import { syncInbox } from '../../../../src/forge/sync/pages/inbox.ts';
import { syncLanes } from '../../../../src/forge/sync/pages/lanes.ts';
import { syncMachine } from '../../../../src/forge/sync/pages/machine.ts';
import { syncSessions } from '../../../../src/forge/sync/pages/sessions.ts';

/**
 * A compile-time proof, not a runtime one: if `src/forge/sync/pages/sessions.ts` ever
 * re-declares `StageResult` instead of re-exporting the contract's own type, or one of
 * the five page functions stops matching `PageSyncStage<Deps>`, this fails to typecheck
 * (`npm run typecheck`); the runtime assertions exist only so the file has something to
 * fail red on before the types existed at all.
 */
type AssertSame<A, B> = A extends B ? (B extends A ? true : never) : never;
const _stageResultSameShape: AssertSame<ContractStageResult, StreamCStageResult> = true;

const _sessionsIsPageSyncStage: typeof syncSessions extends PageSyncStage<Parameters<typeof syncSessions>[0]> ? true : never = true;
const _accountsIsPageSyncStage: typeof syncAccounts extends PageSyncStage<Parameters<typeof syncAccounts>[0]> ? true : never = true;
const _machineIsPageSyncStage: typeof syncMachine extends PageSyncStage<Parameters<typeof syncMachine>[0]> ? true : never = true;
const _inboxIsPageSyncStage: typeof syncInbox extends PageSyncStage<Parameters<typeof syncInbox>[0]> ? true : never = true;
const _lanesIsPageSyncStage: typeof syncLanes extends PageSyncStage<Parameters<typeof syncLanes>[0]> ? true : never = true;

describe('page sync contract parity', () => {
  it('StageResult re-exports the contract type, not a local re-declaration', () => {
    expect(_stageResultSameShape).toBe(true);
  });

  it('every page sync function matches PageSyncStage<Deps>', () => {
    expect(_sessionsIsPageSyncStage).toBe(true);
    expect(_accountsIsPageSyncStage).toBe(true);
    expect(_machineIsPageSyncStage).toBe(true);
    expect(_inboxIsPageSyncStage).toBe(true);
    expect(_lanesIsPageSyncStage).toBe(true);
  });
});
