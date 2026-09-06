/**
 * Production wiring for the intake queue in `intake/queue.ts`, the same split
 * `chain-wire.ts` keeps from `chain.ts`: nothing in `queue.ts` touches the network,
 * reads `~/.forge`, or reads `process.env`; every real Jira call and every real launch
 * dependency lives here instead, built once by `forge up` when `FORGE_QUEUE=1`.
 *
 * The launch side is not reinvented: `chainLauncher`, `chainGh`, `chainCouncil` and
 * `chainGate` from `chain-wire.ts` are reused outright, unchanged. The only new wiring
 * this file adds is Jira: `queueSearch` resolves a `query`/`backlog` add to ticket keys,
 * and `queuePlanner` turns a ticket (or a pasted brief) into a routed brief file, the
 * same two steps `chain-wire.ts#chainIntake` already runs for a poll-sourced packet,
 * just triggered by an operator's own add instead of a poll cycle.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chainCouncil, chainGate, chainGh, chainLauncher } from './chain-wire.js';
import type { ChainEnv } from './chain-env.js';
import type { CliResult, ForgeDeps } from './cli.js';
import type { Packet, PollSourceName, Watermark } from './contracts.js';
import type { QueuePlannedBrief, QueuePlanner, QueueRuntimeDeps, QueueTicketSearch } from './intake/queue.js';
import { createJiraFeed, type JiraConfig } from './intake/jira.js';
import type { PollItemDetail } from './intake/poller.js';
import { planFromPacket } from './intake/planner.js';
import { resolvePlanProvider } from './intake/reasoner.js';
import { parseRepoMap, routeRepo } from './intake/repoRoute.js';
import { Journal } from './journal.js';
import { loadPolicy } from './policy.js';
import { queueBriefsDir, journalPath, killSwitchPath } from './paths.js';
import { reasonerFor } from './reasoner-claude.js';
import { readKillSwitch } from './supervisor.js';
import { readQueuePaused } from './console/queue-pause.js';

const JIRA_ENV_VARS = ['FORGE_JIRA_SITE', 'FORGE_JIRA_EMAIL', 'FORGE_JIRA_TOKEN'] as const;

/** `undefined` when any of `FORGE_JIRA_SITE`/`FORGE_JIRA_EMAIL`/`FORGE_JIRA_TOKEN` is
 *  unset -- read fresh on every call, never cached, so a credential set after `forge up`
 *  started still takes effect on the queue's next add or tick. */
export function jiraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JiraConfig | undefined {
  const missing = JIRA_ENV_VARS.filter((name) => !env[name]);
  if (missing.length) return undefined;
  return {
    site: env['FORGE_JIRA_SITE']!, email: env['FORGE_JIRA_EMAIL']!, token: env['FORGE_JIRA_TOKEN']!,
  };
}

const EMPTY_WATERMARK: Watermark = { source: 'jira' as PollSourceName, committedAt: 0, idsAtCommittedAt: [] };

/**
 * `queueSearch`: a `query`/`backlog` add resolves its JQL through the same
 * `createJiraFeed` a poll cycle already uses -- `fetchSince` ignores whatever
 * watermark it is handed (`jira.ts`'s own contract), so a fixed empty one reads
 * every match every time, which is exactly what a one-off add needs.
 *
 * Requirement 2's own honesty rule lives here: with no Jira credentials configured,
 * this throws a message naming exactly which environment variables are missing, rather
 * than resolving to zero tickets and looking like an empty result.
 */
export function queueSearch(configFn: () => JiraConfig | undefined = jiraConfigFromEnv): QueueTicketSearch {
  return {
    async searchKeys(jql) {
      const config = configFn();
      if (!config) {
        const missing = JIRA_ENV_VARS.filter((name) => !process.env[name]);
        throw new Error(`jira not configured: missing ${missing.join(', ')}`);
      }
      const feed = createJiraFeed({ ...config, jql });
      const items = await feed.fetchSince(EMPTY_WATERMARK);
      return items.map((item) => item.id);
    },
  };
}

function packetFor(ticket: string, repo: string, detail: PollItemDetail | undefined): Packet {
  return {
    id: `queue-${ticket}`,
    ticket,
    what: detail
      ? `${detail.summary} (${detail.issuetype}, ${detail.priority}, ${detail.status})`
      : `queued by ticket key, not yet triangulated`,
    where: 'jira',
    evidence: detail?.description ? [ticket, detail.description] : [ticket],
    confidence: 'low',
    repo,
    blockedBy: [],
    at: Date.now(),
  };
}

/**
 * `queuePlanner`: a ticket key becomes a routed brief the same way `chain-wire.ts`'s own
 * intake does -- one Jira lookup for the ticket's own text, `routeRepo` against
 * `FORGE_INTAKE_REPO_MAP`, then one `planFromPacket` call through the Reasoner. A pasted
 * brief skips both: there is no ticket to look up, so `routeRepo` runs against an empty
 * `labels`/`components`/`issuetype`, which only ever resolves through a `default` rule
 * in the map (or stays `'unknown'`, reported honestly rather than guessed at).
 */
export function queuePlanner(configFn: () => JiraConfig | undefined = jiraConfigFromEnv): QueuePlanner {
  const repoRules = parseRepoMap(process.env['FORGE_INTAKE_REPO_MAP']);
  const briefsDir = queueBriefsDir();
  mkdirSync(briefsDir, { recursive: true });

  async function writeBrief(id: string, text: string): Promise<string> {
    const path = join(briefsDir, `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`);
    writeFileSync(path, text, 'utf8');
    return path;
  }

  return {
    async planTicket(ticket): Promise<QueuePlannedBrief> {
      const config = configFn();
      let repo = routeRepo(repoRules, { ticket, labels: [], components: [], issuetype: '' });
      let detail: PollItemDetail | undefined;
      if (config) {
        const feed = createJiraFeed({ ...config, jql: `key = ${ticket}` });
        const [item] = await feed.fetchSince(EMPTY_WATERMARK);
        detail = item?.detail;
        if (detail) {
          repo = routeRepo(repoRules, {
            ticket, labels: detail.labels ?? [], components: detail.components ?? [], issuetype: detail.issuetype,
          });
        }
      }
      const packet = packetFor(ticket, repo, detail);
      const journal = new Journal(journalPath());
      try {
        const reasoner = reasonerFor(resolvePlanProvider(loadPolicy().reasoner), { journal });
        const planned = await planFromPacket(packet, reasoner);
        const briefPath = await writeBrief(planned.packetId, planned.text);
        return { ticket, repo, briefPath };
      } finally {
        journal.close();
      }
    },

    async planBrief(text): Promise<QueuePlannedBrief> {
      const id = `queue-brief-${Date.now()}`;
      const repo = routeRepo(repoRules, { ticket: id, labels: [], components: [], issuetype: '' });
      const briefPath = await writeBrief(id, text);
      return { ticket: id, repo, briefPath };
    },
  };
}

export function buildQueueRuntimeDeps(
  chainEnv: ChainEnv, fleetConfigDir: string, deps: ForgeDeps, store: QueueRuntimeDeps['store'], maxInFlight = 2,
): QueueRuntimeDeps {
  return {
    planner: queuePlanner(),
    launcher: chainLauncher(chainEnv, fleetConfigDir),
    gh: chainGh(),
    council: chainCouncil(deps),
    gate: chainGate(deps),
    clock: () => Date.now(),
    killSwitch: () => readKillSwitch(killSwitchPath()).engaged,
    paused: () => readQueuePaused(),
    maxInFlight,
    append: (event) => {
      const journal = new Journal(journalPath());
      try {
        return journal.append(event);
      } finally {
        journal.close();
      }
    },
    store,
  };
}

// Re-exported so `cli.ts` never needs its own import of `ForgeDeps`/`CliResult` just to
// satisfy this file's own type signature above.
export type { CliResult, ForgeDeps };
