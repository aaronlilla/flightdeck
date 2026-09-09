// @vitest-environment jsdom
/**
 * Every narrated surface serves three registers, and each register stays where it
 * belongs: `glance` is on the screen, `detail` is behind a `more` disclosure a person
 * has to open, and `raw` -- the fact record, identifiers verbatim -- appears only under
 * `?verbose=1`. A screen that quietly promoted `detail` onto a tile, or printed `raw`
 * to somebody who never asked for it, fails here rather than in front of Aaron.
 *
 * The other half of the contract is the one that cannot be seen: a field the narrator
 * never touched -- person-authored text, or a console with `FORGE_NARRATE=off` -- has
 * all three registers equal, so it renders no disclosure at all.
 */
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BlockersView } from '../../src/console/components/BlockersView.js';
import { ConductorRail } from '../../src/console/components/ConductorRail.js';
import { FlightReview } from '../../src/console/components/FlightReview.js';
import { QueueView } from '../../src/console/components/QueueView.js';
import { Settings } from '../../src/console/components/Settings.js';
import { TicketSheet } from '../../src/console/components/TicketSheet.js';
import type {
  Blocker, Feed, Integration, Lane, Message, NarrationBag, ProposalsResponse, QueueItem,
} from '../../src/shared/console-model.js';
import { render } from './helpers/with-store.js';

const mocks = vi.hoisted(() => ({
  postQueueWidth: vi.fn().mockResolvedValue({ ok: true, jid: null, message: 'set', undoable: false }),
  applyProposal: vi.fn().mockResolvedValue({ ok: true, jid: 'J-1', message: 'applied', undoable: true }),
  dismissProposal: vi.fn().mockResolvedValue({ ok: true, jid: 'J-2', message: 'dismissed', undoable: true }),
  checkIntegration: vi.fn().mockResolvedValue({ items: [], checkedAt: 0, everyS: 30 }),
  getRunSummary: vi.fn(),
  getRunStory: vi.fn().mockResolvedValue({ id: 'r1', title: null, kind: 'ticket', ticket: null, brief: null, entries: [] }),
}));

vi.mock('../../src/console/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/console/api.js')>();
  return { ...actual, ...mocks };
});

const now = Date.now();

/** One narrated field: a short sentence, a fuller one, and the record behind both. */
function bag(field: string, glance: string, detail: string, raw: string): NarrationBag {
  return { [field]: { glance, detail, raw, narratedAt: now - 1000 } };
}

/** The three registers of one field, as the screen actually rendered them. */
function registers(id: string): { glance: string; detail: string | null; raw: string | null } {
  const more = screen.queryByTestId(`${id}-more`);
  return {
    glance: screen.getByTestId(`${id}-glance`).textContent ?? '',
    detail: more ? within(more).getByTestId(`${id}-detail`).textContent : null,
    raw: screen.queryByTestId(`${id}-raw`)?.textContent ?? null,
  };
}

function queueItem(extra: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'q1', source: 'ticket', ticket: 'ABC-9', title: 'Cap the queue width', brief: null, repo: 'o/r',
    state: 'queued', addedAt: now - 60_000, startedAt: null, endedAt: null, runId: null, pr: null,
    reason: null, attempts: 0, whyNext: 'First in the queue, from Ready for Dev.',
    startsIn: 'Starts when a slot frees.', ...extra,
  } as QueueItem;
}

function integration(extra: Partial<Integration> = {}): Integration {
  return {
    id: 'aws', name: 'AWS', status: 'ok', desc: 'Secrets and logs.', scope: 'us-east-1', cause: null,
    effect: null, dependents: [], checkedAt: now - 120_000, canConnect: false,
    words: { status: 'Connected', note: 'us-east-1 - Secrets and logs.' },
    ...extra,
  } as Integration;
}

function blocker(extra: Partial<Blocker> = {}): Blocker {
  return {
    id: 'billing:o/r', kind: 'billing', title: 'Billing is off', detail: 'GitHub refused the run.',
    youCanResolve: true, howToResolve: 'Buy Actions minutes.', who: 'You',
    whoNote: 'Your card is on the account.', links: [], blocks: [{ laneId: 'ABC-3', label: 'ABC-3' }],
    blockedBy: [], state: 'open', since: now - 600_000, checkedAt: null, resolvedAt: null,
    thenWhat: 'The checks re-run on their own.', lastCheck: null, ...extra,
  } as Blocker;
}

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    id: 'r1', title: 'Cap the queue width', kind: 'ticket', sourceUrl: null, plain: 'Writing the test.',
    mergeable: null, attempts: 1, retiredAt: null, ticket: 'ABC-1', model: 'sonnet-5', modelId: 'claude-sonnet-5',
    className: 'implement', repo: 'o/r', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6,
    stepText: 'working', ctxTokens: 1, ctxCeiling: 2, ctxCompactAt: 2, tokens: 1, tokenCap: null, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: now, verifiedAt: now, heart: true, since: now - 60_000,
    startedAt: now - 60_000, endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null,
    runaway: false, needsAaron: null, live: { alive: true, pid: 1, lastEventAt: now, checkedAt: now },
    did: 'Read the ticket.', now: 'Writing the test.', you: 'Nothing yet.', ...extra,
  } as Lane;
}

const feed: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: now };

describe('the queue card', () => {
  it('shows the glance sentence and keeps the fuller one behind a closed disclosure', async () => {
    const narration: NarrationBag = {
      ...bag('whyNext', 'Next up, straight from Ready for Dev.',
        'It is first in the queue because it came off Ready for Dev ahead of everything else waiting.',
        '{"surface":"queue.whyNext","facts":{"position":1,"source":"ticket"}}'),
      ...bag('startsIn', 'Starts as soon as a slot frees.',
        'Nothing starts it by hand; the moment one of the running agents finishes, this one takes the slot.',
        '{"surface":"queue.startsIn","facts":{"state":"queued"}}'),
    };
    render(<QueueView items={[queueItem({ narration })]} paused={false} maxInFlight={4} working={1} />);

    const why = registers('queue-why');
    expect(why.glance).toBe('Next up, straight from Ready for Dev.');
    expect(why.detail).toContain('ahead of everything else waiting');
    expect(why.raw).toBeNull();
    // The detail is inside the disclosure, not beside it: a closed `<details>` is what
    // keeps a long sentence off a row that is meant to be read at a glance.
    const more = screen.getByTestId('queue-why-more');
    expect(more.tagName).toBe('DETAILS');
    expect((more as HTMLDetailsElement).open).toBe(false);
    await userEvent.click(within(more).getByText('more'));
    expect((more as HTMLDetailsElement).open).toBe(true);

    expect(registers('queue-starts').glance).toBe('Starts as soon as a slot frees.');
  });

  it('under verbose shows the fact record, identifiers intact', () => {
    const narration = bag('whyNext', 'Next up.', 'It is first in the queue.',
      '{"surface":"queue.whyNext","facts":{"position":1,"source":"ticket"}}');
    render(<QueueView items={[queueItem({ narration })]} paused={false} maxInFlight={4} verbose />);
    expect(registers('queue-why').raw).toContain('"surface":"queue.whyNext"');
    expect(screen.getByTestId('queue-why-raw').tagName).toBe('PRE');
  });

  it('a title nobody narrated renders as written, with no disclosure', () => {
    render(<QueueView items={[queueItem()]} paused={false} maxInFlight={4} verbose />);
    const title = registers('queue-title');
    expect(title.glance).toBe('Cap the queue width');
    expect(title.detail).toBeNull();
    // Verbose is on, so a `raw` that differed from the glance would be on screen. It is
    // the same string, which is the whole point of person-authored text.
    expect(title.raw).toBe('Cap the queue width');
  });
});

describe('the Settings source rows', () => {
  it('serve all three registers for the state and the note', () => {
    const narration: NarrationBag = {
      ...bag('status', 'Connected.', 'Connected and answering; the last check came back clean.',
        '{"surface":"integration.status","facts":{"status":"ok","blocks":0,"scope":"us-east-1"}}'),
      ...bag('note', 'Secrets and logs, us-east-1.',
        'It holds the secrets and the logs for us-east-1, so nothing is waiting on it right now.',
        '{"surface":"integration.note","facts":{"status":"ok","blocks":0,"scope":"us-east-1"}}'),
    };
    const { unmount } = render(<Settings integrations={[integration({ narration })]} caps={null} now={now} maxInFlight={4} theme="dark" onTheme={vi.fn()} />);
    expect(registers('source-status').glance).toBe('Connected.');
    expect(registers('source-status').detail).toContain('came back clean');
    expect(registers('source-status').raw).toBeNull();
    // The clock stays next to the narration rather than inside it: the freshness suffix
    // is the client's, so it can move every second without touching a cache key.
    expect(screen.getByTestId('source-note-glance').parentElement?.textContent).toContain('checked');
    unmount();

    render(<Settings integrations={[integration({ narration })]} caps={null} now={now} maxInFlight={4} theme="dark" onTheme={vi.fn()} verbose />);
    expect(registers('source-note').raw).toContain('"surface":"integration.note"');
  });
});

describe('the Flight review tiles', () => {
  it('put the tile note on screen and its fuller reading behind `more`', () => {
    const metrics = {
      ticketsIn: 4, mergedToday: 2, handedToQa: 1, blockersCleared: 3, tokensToday: 120_000,
      tokensPerMerge: 60_000, humanWaitMin: 0, slowestHop: { name: 'Waiting for review', minutes: 12 },
      notes: { mergedToday: 'Merged by the fleet today.' },
      narration: bag('mergedToday', 'Two landed today.',
        'Two pull requests merged today, both from the fleet rather than by hand.',
        '{"surface":"review.mergedToday","facts":{"count":2}}'),
    } as unknown as ProposalsResponse['metrics'];
    const proposals = { rules: [], metrics } as unknown as ProposalsResponse;
    render(<FlightReview proposals={proposals} now={now} tokensToday={120_000} dailyTokens={400_000} />);
    expect(registers('review-mergedToday').glance).toBe('Two landed today.');
    expect(registers('review-mergedToday').detail).toContain('rather than by hand');
    expect(registers('review-mergedToday').raw).toBeNull();
  });
});

describe('the blocker card', () => {
  it('keeps every fuller line under one disclosure, and shows the records only under verbose', () => {
    const narration: NarrationBag = {
      ...bag('detail', 'GitHub refused the run.',
        'GitHub refused to start the run because the account has no Actions minutes left.',
        '{"surface":"blocker.detail","facts":{"kind":"billing","blocks":1}}'),
      ...bag('howToResolve', 'Buy Actions minutes.',
        'Buy Actions minutes on the GitHub billing page; nothing here can do it for you.',
        '{"surface":"blocker.howToResolve","facts":{"kind":"billing","you":true}}'),
    };
    const { unmount } = render(<BlockersView blockers={[blocker({ narration })]} chains={[]} />);
    const more = screen.getByTestId('blocker-more-billing:o/r');
    expect(within(more).getByTestId('blocker-detail-detail').textContent).toContain('no Actions minutes left');
    expect(within(more).getByTestId('blocker-howToResolve-detail').textContent).toContain('billing page');
    expect(screen.queryByTestId('blocker-detail-raw')).toBeNull();
    unmount();

    render(<BlockersView blockers={[blocker({ narration })]} chains={[]} verbose />);
    expect(screen.getByTestId('blocker-detail-raw').textContent).toContain('"surface":"blocker.detail"');
  });

  it('a card the narrator never saw opens no disclosure at all', () => {
    render(<BlockersView blockers={[blocker()]} chains={[]} verbose />);
    expect(screen.queryByTestId('blocker-more-billing:o/r')).toBeNull();
  });
});

describe('the rail', () => {
  it('narrates the repo own row and leaves a person words exactly as typed', () => {
    const event = {
      k: 'm1', type: 'event', at: now - 30_000, text: 'PR #12 opened at 09:14.',
      narration: bag('text', 'PR #12 opened at 09:14.',
        'The agent opened pull request #12 at 09:14 and the checks started straight away.',
        '{"surface":"rail.event","facts":{"pr":12,"time1":"09:14"}}'),
    } as unknown as Message;
    const typed = { k: 'm2', type: 'operator', at: now - 10_000, text: 'limit per user or per IP?' } as unknown as Message;
    render(<ConductorRail thread={[event, typed]} feed={feed} now={now} composer="" onComposerChange={vi.fn()} onSend={vi.fn()} onCommand={vi.fn()} onUndo={vi.fn()} />);
    const glances = screen.getAllByTestId('rail-glance').map((el) => el.textContent);
    expect(glances).toEqual(['PR #12 opened at 09:14.']);
    // The operator's own line never reaches the narrated component at all -- it is
    // printed as typed, so there is no register to promote and nothing to disclose.
    expect(screen.getByText('limit per user or per IP?')).toBeTruthy();
    expect(screen.getAllByTestId('rail-more')).toHaveLength(1);
    expect(screen.getAllByTestId('rail-more')[0]!.textContent).toContain('checks started straight away');
  });
});

describe('the lane sheet', () => {
  it('serves the summary sentences in three registers', async () => {
    mocks.getRunSummary.mockResolvedValue({
      what: ['Read the ticket and wrote the test.'], status: 'Writing the test.', next: 'Nothing yet.',
      audit: null, readiness: null,
      narration: {
        ...bag('what', 'Read the ticket and wrote the test.',
          'It read ABC-1, then wrote the failing test the fix has to turn green.',
          '{"surface":"summary.what","facts":{"lane":"ABC-1"}}'),
        ...bag('status', 'Writing the test.', 'It is on the test now, six steps in.',
          '{"surface":"lane.now","facts":{"state":"running"}}'),
      },
    });
    render(<TicketSheet lane={lane()} now={now} onClose={vi.fn()} onCommand={vi.fn()} onSendLane={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('sheet-what-glance').textContent).toBe('Read the ticket and wrote the test.'));
    expect(screen.getByTestId('sheet-what-more').textContent).toContain('failing test');
    expect(screen.queryByTestId('sheet-what-raw')).toBeNull();
    expect(screen.getByTestId('sheet-status-glance').textContent).toBe('Writing the test.');
  });
});
