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
import type { Journal } from '../journal.js';
import { jiraFeedLedgerPath } from '../paths.js';
import { RunInbox } from '../runinbox.js';
import type { JiraFeedActivity } from './watcher-state.js';
import { readSelfTestUntil } from './feed-self-test.js';

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

export function buildJiraFeedActivity(options: JiraFeedWireOptions): JiraFeedActivity {
  const ledger = options.ledger ?? fileFeedLedger(jiraFeedLedgerPath());
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
      });
      return result;
    },
  };
}
