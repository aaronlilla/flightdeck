/**
 * R-101: production wiring for the Jira feed (`intake/jiraFeed.ts`) -- the real search,
 * the real comment write (readability-gated inside `jira.ts`), the account behind the
 * token, the on-disk ledger, the inbox and the lane send. `server.ts` hands the result to
 * `JiraWatcher`, so the feed runs, stops and restarts with the watcher's own switch.
 */
import type { Reasoner } from '../contracts.js';
import type { Inbox } from '../inbox.js';
import type { JiraConfig } from '../intake/jira.js';
import { createJiraWriteClient, probeJira } from '../intake/jira.js';
import {
  fetchFeedIssues, fileFeedLedger, runFeedActivity, type FeedLedgerStore, type FeedMe,
} from '../intake/jiraFeed.js';
import type { QueueStore } from '../intake/queueStore.js';
import { addTicketItem } from '../intake/queue.js';
import { parseRepoMap } from '../intake/repoRoute.js';
import type { Journal } from '../journal.js';
import { jiraFeedLedgerPath } from '../paths.js';
import { RunInbox } from '../runinbox.js';
import type { JiraFeedActivity } from './watcher-state.js';
import { readSelfTestUntil } from './feed-self-test.js';
import { loadContract } from '../intake/readability.js';
import { readabilityDir } from '../paths.js';
import { AI_VOCABULARY_WORDS } from '../rules/humanizer.js';

export interface JiraFeedWireOptions {
  jiraConfig: () => JiraConfig | undefined;
  store: QueueStore;
  inbox: Inbox;
  journal: Pick<Journal, 'append'>;
  reasoner: Reasoner;
  ledger?: FeedLedgerStore;
  env?: NodeJS.ProcessEnv;
}

/** `FORGE_JIRA_FEED_NAMES`, comma-separated, or the first word of the account's display
 *  name: the words that mark a comment as naming the operator. */
export function feedNames(displayName: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env['FORGE_JIRA_FEED_NAMES'] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (configured.length) return configured;
  const first = displayName.trim().split(/\s+/)[0] ?? '';
  return first ? [first] : [];
}

/**
 * The repositories a claim may route work into, read off the same
 * `FORGE_INTAKE_REPO_MAP` the watcher's own intake already routes by, so a claimed ticket
 * cannot land somewhere the planner would not have sent it anyway. A malformed map is a
 * configuration error, not a reason to claim into the void: it reads as no repos, which
 * turns every claim into a defer.
 */
export function claimRepos(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return [...new Set(parseRepoMap(env['FORGE_INTAKE_REPO_MAP']).map((rule) => rule.repo))];
  } catch {
    return [];
  }
}

/** `FORGE_JIRA_CLAIM` must be `on` for the feed to take a ticket. Absent or anything else
 *  leaves the feed reply-only, exactly as it behaved before 2026-09-18. */
export function claimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['FORGE_JIRA_CLAIM'] ?? '').trim().toLowerCase() === 'on';
}

export function buildJiraFeedActivity(options: JiraFeedWireOptions): JiraFeedActivity {
  const ledger = options.ledger ?? fileFeedLedger(jiraFeedLedgerPath());
  // The comment check's own word list, plus the humanizer rule's vocabulary, read once.
  // Both refuse at write time; naming them in the prompt saves a rewording round.
  let banned: string[] | null = null;
  const avoidWords = (): string[] => {
    if (banned === null) {
      const loaded = loadContract(readabilityDir());
      const contractWords = loaded.ok ? [...loaded.contract.banned_words] : [];
      banned = [...new Set([...contractWords, ...AI_VOCABULARY_WORDS])];
    }
    return banned;
  };
  let me: (FeedMe & { displayName: string }) | null = null;

  const readMe = async (): Promise<FeedMe | null> => {
    if (me) return me;
    const config = options.jiraConfig();
    if (!config) return null;
    const probe = await probeJira(config);
    if (!probe.ok || !probe.accountId) return null;
    me = { accountId: probe.accountId, displayName: probe.displayName ?? '', names: feedNames(probe.displayName ?? '', options.env) };
    return me;
  };

  return {
    reset(now) {
      ledger.write({ ...ledger.read(), startedAt: now, lastPollAt: null });
      options.journal.append({ event: 'feed.started', actor: 'feed', at: now } as never);
    },
    async run(project) {
      const config = options.jiraConfig();
      if (!config) throw new Error('no Jira credentials');
      const write = createJiraWriteClient(config);
      const result = await runFeedActivity({
        project,
        me: readMe,
        operatorName: () => me?.displayName || 'the developer',
        fetchIssues: (jql) => fetchFeedIssues(config, jql),
        ledger,
        reasoner: options.reasoner,
        post: (ticket, body) => write.comment(ticket, body),
        raise: (ask) => options.inbox.raise(ask),
        inboxEntries: () => options.inbox.all(),
        queueItems: () => options.store.all(),
        sendTo: (runKey, text) => { new RunInbox(runKey).send(text, 'jira'); },
        journal: { append: (row) => { options.journal.append(row as never); } },
        // Read on every pass, so turning the self-test off (or its end time passing)
        // takes effect on the next pass with no restart.
        selfTest: () => readSelfTestUntil() !== null,
        avoidWords,
        // The claim half. Switched off unless FORGE_JIRA_CLAIM is on, and dark anyway
        // when the repo map names nothing, so turning it on is one variable and turning
        // it off again is the same.
        ...(claimEnabled(options.env) && claimRepos(options.env).length > 0
          ? {
            claim: {
              repos: () => claimRepos(options.env),
              assign: (ticket: string, accountId: string) => write.assign(ticket, accountId),
              // The same call the watcher makes for a ticket already assigned to the
              // operator, so a claimed ticket and an assigned one are one queue item
              // shape and one pipeline from here on.
              enqueue: (ticket: string) => { addTicketItem(options.store, ticket); },
            },
          }
          : {}),
      });
      return result;
    },
  };
}
