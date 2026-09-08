// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildPaletteItems, CommandPalette } from '../../src/console/components/CommandPalette.js';
import type { JournalEntry, Lane } from '../../src/shared/console-model.js';

function lane(id: string, stepText: string): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id, ticket: id, model: 'sonnet-5', modelId: null, className: null, repo: 'flightdeck-rn', attempt: 1,
    state: 'running', reason: null, stepN: 1, stepTotal: 3, stepText, ctxTokens: 0, ctxCeiling: 200_000,
    ctxCompactAt: 180_000, tokens: 0, tokenCap: null, tokensPerMin: 0, fails: 0, hop: 1, hopStatus: 'live',
    observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(), startedAt: Date.now(),
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
  };
}

function journalEntry(jid: string, text: string): JournalEntry {
  return { jid, ts: Date.now(), kind: 'action', text, actor: 'operator', run: null, undoable: false, undone: false };
}

describe('buildPaletteItems', () => {
  it('builds a lane subtitle from state and stepText, not the repo', () => {
    const items = buildPaletteItems('FLT', [lane('FLT-201', 'provisioning sandbox')], [], vi.fn(), vi.fn(), vi.fn());
    expect(items[0]?.sub).toBe('running · provisioning sandbox');
  });

  it('caps lane matches at 6 and journal matches at the last 3, before any overall cap', () => {
    const lanes = Array.from({ length: 10 }, (_, i) => lane(`FLT-${i}`, 'working'));
    const journal = Array.from({ length: 10 }, (_, i) => journalEntry(`J-${i}`, 'did a thing'));
    const items = buildPaletteItems('', lanes, journal, vi.fn(), vi.fn(), vi.fn());
    const laneItems = items.filter((i) => i.kind === 'lane');
    const journalItems = items.filter((i) => i.kind === 'journal');
    expect(laneItems).toHaveLength(6);
    expect(journalItems).toHaveLength(3);
    expect(journalItems.map((i) => i.title)).toEqual(['J-7', 'J-8', 'J-9']);
  });

  it('opens the journal sheet for a selected journal result instead of doing nothing', () => {
    const onOpenJournal = vi.fn();
    const items = buildPaletteItems('J-1', [], [journalEntry('J-1', 'paused FLT-187')], vi.fn(), vi.fn(), onOpenJournal);
    items[0]?.go();
    expect(onOpenJournal).toHaveBeenCalledWith('J-1');
  });

  it('lists views in Title Case, matching on the display label', () => {
    const items = buildPaletteItems('review', [], [], vi.fn(), vi.fn(), vi.fn());
    expect(items.map((i) => i.title)).toEqual(['Flight review']);
  });

  it('lists all four views Title Case with no query', () => {
    const items = buildPaletteItems('', [], [], vi.fn(), vi.fn(), vi.fn());
    const viewTitles = items.filter((i) => i.kind === 'view').map((i) => i.title);
    expect(viewTitles).toEqual(['Board', 'Queue', 'Settings', 'Flight review']);
  });

  // Sweep #12: the palette had no way to reach the Queue view at all.
  it('navigates to the Queue view from the palette', () => {
    const onNav = vi.fn();
    const items = buildPaletteItems('queue', [], [], vi.fn(), onNav, vi.fn());
    const queueItem = items.find((i) => i.title === 'Queue');
    expect(queueItem).toBeDefined();
    queueItem?.go();
    expect(onNav).toHaveBeenCalledWith('queue');
  });

  // H2.6: the palette searches the ticket key and the title, never the run id.
  it('never matches a query against the run id alone', () => {
    const l = lane('jira_AB-12_1788460932645', 'working');
    l.ticket = null;
    l.title = 'the withdrawal fee is off by one';
    const items = buildPaletteItems('jira_AB', [l], [], vi.fn(), vi.fn(), vi.fn());
    expect(items.filter((i) => i.kind === 'lane')).toHaveLength(0);
  });

  it('matches a query against the ticket key', () => {
    const l = lane('run-1', 'working');
    l.ticket = 'FLT-42';
    const items = buildPaletteItems('flt-42', [l], [], vi.fn(), vi.fn(), vi.fn());
    expect(items.filter((i) => i.kind === 'lane')).toHaveLength(1);
  });

  it('matches a query against the title when the lane has one', () => {
    const l = lane('run-1', 'working');
    l.ticket = null;
    l.title = 'the withdrawal fee is off by one';
    const items = buildPaletteItems('withdrawal', [l], [], vi.fn(), vi.fn(), vi.fn());
    expect(items.filter((i) => i.kind === 'lane')).toHaveLength(1);
  });

  it('shows the ticket, or the title, or the run id in that order as the lane result\'s title', () => {
    const withTicket = lane('run-1', 'working');
    withTicket.ticket = 'FLT-1';
    const withTitleOnly = lane('run-2', 'working');
    withTitleOnly.ticket = null;
    withTitleOnly.title = 'a titled lane';
    const items = buildPaletteItems('', [withTicket, withTitleOnly], [], vi.fn(), vi.fn(), vi.fn());
    const laneItems = items.filter((i) => i.kind === 'lane');
    expect(laneItems.map((i) => i.title)).toEqual(['FLT-1', 'a titled lane']);
  });
});

describe('CommandPalette', () => {
  it('highlights the first result row, matching what Enter opens', () => {
    const items = [
      { kind: 'lane' as const, title: 'FLT-201', sub: 'running', go: vi.fn() },
      { kind: 'lane' as const, title: 'FLT-202', sub: 'running', go: vi.fn() },
    ];
    render(<CommandPalette query="" items={items} onQueryChange={vi.fn()} onClose={vi.fn()} />);
    const rows = screen.getAllByText(/FLT-20/).map((el) => el.closest('div[style*="cursor: pointer"]') as HTMLElement);
    expect(rows[0]?.style.background).toBe('var(--panel2)');
    expect(rows[1]?.style.background).toBe('transparent');
  });
});
