/**
 * End-to-end proof, run by hand: the row Settings marks "in use" is the row a launch
 * picks, and holding it back from the GUI moves the launch somewhere else.
 *
 * Runs against a COPY of the real registry under a scratch `FORGE_HOME`, seeded by the
 * caller. The live registry is shared with a console already running on this machine and
 * with any worker it launches, so flipping a flag in it to prove a point would be
 * reaching into another session's state. Same code, same data shape, no interference.
 *
 * Not part of the suite. Delete or keep as a hand tool; it asserts nothing on its own.
 */
import { accountsRegistryPath, loadAccounts, pickAccount, updateAccount } from '../src/forge/accounts.js';
import { readAccountUsage } from '../src/forge/accounts-usage.js';
import {
  AccountsService, diskWriters, launchAccountDecision, type AccountsServiceDeps,
} from '../src/forge/accounts-service.js';

function service(): AccountsService {
  const deps: AccountsServiceDeps = {
    loadAccounts: () => loadAccounts(accountsRegistryPath()),
    readUsage: () => readAccountUsage(),
    recordReading: diskWriters.recordReading,
    recordReadError: diskWriters.recordReadError,
    liveRuns: () => ({}),
    // No fleet row: this proof is about the registry's own rows, and the machine login
    // is the thing the refusal exists to stop a launch borrowing.
    fleetConfigDir: () => null,
    // Never the network here: the seeded usage store is the reading, so the run is
    // repeatable and spends nothing.
    probe: async () => { throw new Error('probe disabled for this proof'); },
    staleMs: Number.MAX_SAFE_INTEGER,
  };
  return new AccountsService(deps);
}

function show(label: string): void {
  const svc = service();
  const items = svc.list();
  console.log(`\n--- ${label} ---`);
  for (const item of items) {
    console.log(
      `  ${item.id}  provider=${item.provider}  selected=${item.selected === true}`
      + `  lastResort=${item.lastResort === true}  maxConcurrent=${item.maxConcurrent ?? 'none'}`,
    );
  }
  const picked = svc.list().find((item) => item.selected && item.provider === 'claude');
  console.log(`  Settings marks in use: ${picked?.id ?? '(none)'}`);
}

function decide(): void {
  const svc = service();
  const usage = readAccountUsage();
  const records = loadAccounts(accountsRegistryPath());
  // The same call `cli.ts` makes, minus the refresh (no network in this proof).
  const picked = pickAccount(records, usage, {}, Date.now(), 'claude');
  const decision = launchAccountDecision(picked, svc.exhaustion('claude'), Date.now());
  console.log(`  a launch would use: ${
    decision.refused ? `REFUSED -- ${decision.reason}` : decision.account?.id ?? '(machine login)'
  }`);
}

const target = process.argv[2];
if (!target) {
  console.error('usage: proof-selection.ts <account-id-to-hold-back>');
  process.exit(2);
}

show('before');
decide();

const verdict = updateAccount(target, { lastResort: true }, accountsRegistryPath());
console.log(`\nheld back ${target}: ${verdict.ok ? 'written' : `REFUSED -- ${verdict.reason}`}`);

show('after holding it back');
decide();
