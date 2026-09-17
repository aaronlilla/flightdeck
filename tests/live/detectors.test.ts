/**
 * G1: every detector D1 through D7 watched failing on a deliberately broken specimen.
 *
 * Each case is a pair. The clean specimen is what a working console produces and the
 * detector must stay silent on it; the broken one is that same specimen with exactly one
 * thing wrong, and the detector must name it. A detector that only ever has the broken
 * half tested can be a function that returns a constant, which is why both halves are
 * here (standing order 2).
 *
 * These run in the normal suite: the detectors are pure functions over a capture, so they
 * need neither a browser nor a live fleet. What needs the live fleet is producing the
 * captures, and that is `drive.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  detectD1, detectD2, detectD3, detectD4, detectD5, detectD6, detectD7,
  STALE_ACTIONABLE_MS,
  type OfferedAsk, type ScreenCapture,
} from './model.js';

const NOW = 1_789_200_000_000;

function screen(patch: Partial<ScreenCapture> = {}): ScreenCapture {
  return {
    view: 'board',
    reached: 'click',
    consoleErrors: [],
    pageErrors: [],
    requiredRegions: [{ testid: 'why', label: 'Why it is asking', text: 'BB-86 is still To Do' }],
    cards: [{
      head: 'BBZ-169 · Wallet home screen',
      prompt: 'Build it here, or hold until BB-86 lands?',
      stamp: 'asked 6 min ago',
      options: ['Build it here', 'Hold'],
      evidenceLines: 2,
    }],
    controls: [{ testid: 'nav-queue', label: 'Queue', domChanged: true, requests: 1, journalDelta: 0 }],
    claims: [{ label: 'Queue rows', rendered: '2', expected: '2', source: '/queue' }],
    textLength: 4_000,
    ...patch,
  };
}

function ask(patch: Partial<OfferedAsk> = {}): OfferedAsk {
  return {
    uid: 'card:question-abc',
    kind: 'question',
    content: 'Build the Wallet home screen here, or hold until BB-86 lands?',
    askedAt: NOW - 6 * 60_000,
    actionTargets: [],
    actionLive: true,
    ...patch,
  };
}

describe('D1 — placeholder render', () => {
  it('is silent on a card carrying a real title and body', () => {
    expect(detectD1(screen())).toEqual([]);
  });

  it('fires when a required region renders empty', () => {
    const found = detectD1(screen({ requiredRegions: [{ testid: 'why', label: 'Why it is asking', text: '' }] }));
    expect(found).toHaveLength(1);
    expect(found[0]?.what).toContain('Why it is asking');
  });

  it('fires when the title is a fallback constant', () => {
    const found = detectD1(screen({ cards: [{ ...screen().cards[0]!, head: 'confirm?' }] }));
    expect(found[0]?.what).toContain('confirm?');
  });

  it('fires when the title and the body are the same string', () => {
    const found = detectD1(screen({ cards: [{ ...screen().cards[0]!, head: 'Ship it?', prompt: 'Ship it?' }] }));
    expect(found[0]?.what).toContain('same string');
  });
});

describe('D2 — dead control', () => {
  it('is silent on a control that changed the page', () => {
    expect(detectD2(screen())).toEqual([]);
  });

  it('is silent on a control that issued a request without redrawing', () => {
    expect(detectD2(screen({ controls: [{ testid: 'x', label: 'Re-check', domChanged: false, requests: 1, journalDelta: 0 }] }))).toEqual([]);
  });

  it('is silent on a control the driver deliberately skipped', () => {
    expect(detectD2(screen({ controls: [{ testid: 'x', label: 'Confirm', domChanged: false, requests: 0, journalDelta: 0, skipped: 'not on the safe-control allowlist' }] }))).toEqual([]);
  });

  it('fires when a click produced no DOM change, no request and no journal row', () => {
    const found = detectD2(screen({ controls: [{ testid: 'dud', label: 'Retry sync', domChanged: false, requests: 0, journalDelta: 0 }] }));
    expect(found).toHaveLength(1);
    expect(found[0]?.what).toContain('does nothing');
  });
});

describe('D3 — unreachable route', () => {
  it('is silent when every declared view was reached', () => {
    expect(detectD3({ declaredViews: ['board', 'queue'], screens: [screen({ view: 'board' }), screen({ view: 'queue' })] })).toEqual([]);
  });

  it('fires on a view the router declares that no click reached', () => {
    const found = detectD3({
      declaredViews: ['board', 'queue', 'ledger'],
      screens: [screen({ view: 'board' }), screen({ view: 'queue' }), screen({ view: 'ledger', reached: 'unreachable' })],
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.view).toBe('ledger');
  });
});

describe('D4 — drift', () => {
  it('is silent when the screen agrees with its endpoint', () => {
    expect(detectD4(screen())).toEqual([]);
  });

  it('fires when the server moved underneath the render', () => {
    const found = detectD4(screen({ claims: [{ label: 'Queue rows', rendered: '2', expected: '3', source: '/queue' }] }));
    expect(found).toHaveLength(1);
    expect(found[0]?.what).toContain('/queue says "3"');
  });
});

describe('D5 — page error', () => {
  it('is silent on a clean page', () => {
    expect(detectD5(screen())).toEqual([]);
  });

  it('fires on a console error', () => {
    expect(detectD5(screen({ consoleErrors: ['boom'] }))[0]?.what).toContain('boom');
  });

  it('fires on an unhandled rejection', () => {
    expect(detectD5(screen({ pageErrors: ['no account registered'] }))[0]?.what).toContain('no account registered');
  });
});

describe('D6 — stale-actionable', () => {
  it('is silent on a fresh ask', () => {
    expect(detectD6([ask()], NOW)).toEqual([]);
  });

  it('is silent on an old ask whose action still works — that is a backlog, not a defect', () => {
    expect(detectD6([ask({ askedAt: NOW - 10 * STALE_ACTIONABLE_MS, actionLive: true })], NOW)).toEqual([]);
  });

  it('is silent on a fresh ask whose action is momentarily dead — that is a race', () => {
    expect(detectD6([ask({ actionLive: false })], NOW)).toEqual([]);
  });

  it('fires when an ask is both old and unanswerable', () => {
    const found = detectD6([ask({ askedAt: NOW - 5 * STALE_ACTIONABLE_MS, actionLive: false, actionTargets: ['gone'] })], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]?.what).toContain('addresses nothing that exists');
  });
});

describe('D7 — buried', () => {
  it('is silent when every ask carries content', () => {
    expect(detectD7([ask(), ask({ uid: 'b' })])).toEqual([]);
  });

  it('is silent when the contentless ones sit behind the readable ones', () => {
    expect(detectD7([ask(), ask({ uid: 'empty', content: '' })])).toEqual([]);
  });

  it('fires when a contentless ask ranks ahead of a readable one, and counts the clicks', () => {
    const found = detectD7([
      ask({ uid: 'e1', content: '' }),
      ask({ uid: 'e2', content: 'confirm?' }),
      ask({ uid: 'real' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence['clicksToFirstReadable']).toBe(2);
    expect(found[0]?.evidence['buried']).toBe(2);
  });

  it('counts every buried item, not only the ones before the first readable one', () => {
    // Interleaved: one readable card leads, so nothing is "ahead of the first readable
    // one", but a contentless card still sits in front of the last readable one.
    const found = detectD7([
      ask({ uid: 'real1' }),
      ask({ uid: 'e1', content: 'confirm?' }),
      ask({ uid: 'real2' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence['buried']).toBe(1);
    expect(found[0]?.what).not.toMatch(/^0 /);
  });
});
