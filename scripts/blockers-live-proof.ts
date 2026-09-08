#!/usr/bin/env -S npx tsx
/**
 * Iteration 6, item 5: detection-only proof that `gatherBlockers` and `detectBlockers`
 * find real blockers against today's actual `~/.forge` fleet.
 *
 * Read-only. Builds the same `gather()` `server.ts` wires into `BlockersRoutes`, calls it
 * once, runs `detectBlockers`/`orderChains` over the result, and prints the blockers and
 * chains as JSON. Never calls a confirmer or a restarter, and never writes to the
 * `blockers.jsonl` ledger `BlockersRoutes` itself would -- this script only reads.
 *
 * Usage: npx tsx scripts/blockers-live-proof.ts
 */
import { Inbox } from '../src/forge/inbox.js';
import { Registry } from '../src/forge/registry.js';
import { QueueStore } from '../src/forge/intake/queueStore.js';
import { IntegrationsRegistry } from '../src/forge/console/integrations.js';
import { ActionsLedger, actionsLedgerPath } from '../src/forge/console/actions-ledger.js';
import { ConsoleReads } from '../src/forge/console/reads.js';
import { gatherBlockers } from '../src/forge/console/blockers-gather.js';
import { detectBlockers, orderChains } from '../src/forge/console/blockers.js';
import {
  forgeHome, inboxDir, queuePath, registryDir,
} from '../src/forge/paths.js';

async function main(): Promise<void> {
  const inbox = new Inbox(inboxDir());
  const registry = new Registry(registryDir());
  const queueStore = new QueueStore(queuePath());
  const consoleReads = new ConsoleReads({ forgeHomeDir: forgeHome() });
  const integrations = new IntegrationsRegistry({
    journalPath: `${forgeHome()}/fleet.jsonl`, ledger: new ActionsLedger(actionsLedgerPath()),
  });

  const gather = gatherBlockers({
    inbox, integrations, registry, queueStore,
    lanesView: () => consoleReads.lanesResponse(true, false),
    jiraSite: process.env['FORGE_JIRA_SITE'] ?? null,
  });

  const inputs = await gather();
  const live = detectBlockers(inputs);
  const chains = orderChains(live);

  process.stdout.write(`${JSON.stringify({ blockers: live, chains }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
