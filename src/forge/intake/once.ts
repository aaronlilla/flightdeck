/**
 * `forge intake --once`: one real poll cycle, through the interfaces this stream built
 * (`runPoll`, `PacketStore`, `performExternalWrite`'s `intent` stamp), rather than the
 * fixture-only path `--dry-run` runs. No live call happens here either: `FORGE_JIRA_TOKEN`
 * (decision 1) still does not exist anywhere in this codebase, so a run that would create
 * a ticket stops at `external.intent` and never reaches a real sink. `runOnce` takes its
 * feeds and its watermark store as parameters precisely so a specimen can inject fakes and
 * a real caller (the CLI, the console's router once cut 2 lands) can pass whatever client
 * it eventually builds without this function changing shape.
 *
 * The packet this stage writes is mechanical, not triangulated: one packet per newly
 * observed item, built straight from the item itself. Nothing here reads code, a repo, or
 * a stack trace to decide what a finding actually is -- that judgment is real triangulation
 * work no stream has built yet, named as a gap rather than faked with a plausible-looking
 * summary.
 */
import type { Packet, PollSourceName, Watermark } from '../contracts.js';
import type { FakePollFeed } from './poller.js';
import { runPoll } from './poller.js';
import { PacketStore } from './packetStore.js';
import { routeRepo, type RepoRule } from './repoRoute.js';

export interface WatermarkStore {
  get(source: PollSourceName): Watermark;
  set(source: PollSourceName, mark: Watermark): void;
}

export interface IntakeOnceEvent {
  event: 'source.observed' | 'packet.written' | 'external.intent';
  [key: string]: unknown;
}

export interface IntakeOnceResult {
  sourcesPolled: PollSourceName[];
  observed: number;
  packetsWritten: number;
  intentsRaised: number;
  /** forge-council-live, additive per decision 4: every packet this cycle actually
   *  wrote, so a caller (`cli.ts`) can hand one to the planner without re-deriving it
   *  from the `packet.written` events above. */
  writtenPackets: Packet[];
  /** R1: every packet this cycle wrote whose repository stayed `'unknown'`, with the
   *  labels and components it saw, so `cli.ts` can print one line per ticket telling
   *  the operator what to add to `FORGE_INTAKE_REPO_MAP`. */
  unrouted: { ticket: string; labels: string[]; components: string[] }[];
}

/**
 * One poll cycle over every feed passed in. A feed is a real client (Jira REST, Sentry,
 * CloudWatch, Slack, `gh`) once one exists behind `FakePollFeed`'s interface; every
 * specimen here injects the same fixture-backed fake `poller.test.ts` already uses.
 */
export async function runIntakeOnce(
  feeds: FakePollFeed[],
  watermarks: WatermarkStore,
  emit: (event: IntakeOnceEvent) => void,
  packetStore: PacketStore = new PacketStore(),
  repoRules: RepoRule[] = [],
): Promise<IntakeOnceResult> {
  let observed = 0;
  let packetsWritten = 0;
  let intentsRaised = 0;
  const sourcesPolled: PollSourceName[] = [];
  const writtenPackets: Packet[] = [];
  const unrouted: IntakeOnceResult['unrouted'] = [];

  for (const feed of feeds) {
    sourcesPolled.push(feed.name);
    const mark = watermarks.get(feed.name);
    const result = await runPoll(feed, mark, (event) => {
      observed += 1;
      emit({ ...event });

      // J2: a Jira item carries its own text (summary, description, status, issue type,
      // priority) on `event.detail`; the planner sees the ticket itself rather than a
      // bare key. A source with no detail (every fixture that predates this stream)
      // degrades to the id-only line it always wrote.
      const labels = event.detail?.labels ?? [];
      const components = event.detail?.components ?? [];
      // R1: the router turns a ticket's labels, components, issue type and project key
      // into a repository, first matching rule wins. No rules, or nothing matching,
      // leaves it 'unknown' and the ticket is recorded below so `cli.ts` can print it.
      const repo = routeRepo(repoRules, {
        ticket: event.sourceId, labels, components, issuetype: event.detail?.issuetype ?? '',
      });
      const packet = {
        id: event.key,
        ticket: event.sourceId,
        what: event.detail
          ? `${event.detail.summary} (${event.detail.issuetype}, ${event.detail.priority}, ${event.detail.status})`
          : `observed via ${event.source}, not yet triangulated`,
        where: event.source,
        evidence: event.detail?.description ? [event.key, event.detail.description] : [event.key],
        confidence: 'low' as const,
        repo,
        blockedBy: [],
        at: event.updated,
      };
      const written = packetStore.write(packet);
      if (written.wrote) {
        packetsWritten += 1;
        writtenPackets.push(packet);
        emit({ event: 'packet.written', ticket: packet.ticket, packetId: packet.id });

        if (repo === 'unknown') {
          unrouted.push({ ticket: packet.ticket, labels, components });
        }

        intentsRaised += 1;
        emit({
          event: 'external.intent', kind: 'jira-ticket', idempotencyKey: packet.id,
          ticket: packet.ticket,
        });
      }
    });
    watermarks.set(feed.name, result.watermark);
  }

  return { sourcesPolled, observed, packetsWritten, intentsRaised, writtenPackets, unrouted };
}
