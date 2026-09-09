// @vitest-environment jsdom
/**
 * W2: at most four cards in a row, at any width. Aaron, 2026-09-08, on the live
 * console: "we only need to be able to fit four cards in a row at maximum screen size
 * ... literally double the width of what they are now".
 *
 * Both grids read the same constant. The falsifier this closes: "four a row" reads
 * green while broken if only one of the two grids was changed, so the test renders
 * both and reads the style off the element the browser actually lays out.
 */
import type { ReactElement } from 'react';
import { render as rtlRender } from '@testing-library/react';
import { useReducer } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { BOARD_GRID_COLUMNS, CARD_MIN_PX } from '../../src/console/grid.js';
import { LanesGrid } from '../../src/console/components/LanesGrid.js';
import { QueueView } from '../../src/console/components/QueueView.js';
import { StoreContext, initialState, reducer } from '../../src/console/store.js';
import type { Lane, QueueItem } from '../../src/shared/console-model.js';

function Wrapper({ node }: { node: ReactElement }): ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  return <StoreContext.Provider value={{ state, dispatch }}>{node}</StoreContext.Provider>;
}
function render(node: ReactElement): ReturnType<typeof rtlRender> {
  return rtlRender(<Wrapper node={node} />);
}

function lane(id: string): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id, ticket: id, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 200_000, tokenCap: 2_000_000, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null, live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 }, did: null, now: '', you: null,
  };
}

function queueItem(id: string): QueueItem {
  return {
    id, source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: null, briefPath: null,
    branch: null, worktreePath: null, base: null, state: 'queued', reason: null, runKey: null,
    pr: null, journalIds: [], createdAt: 0, updatedAt: 0, title: null,
  };
}

function gridOf(container: HTMLElement): HTMLElement {
  const grid = [...container.querySelectorAll<HTMLElement>('div')].find((el) => el.style.display === 'grid');
  if (!grid) throw new Error('no grid element rendered');
  return grid;
}

describe('the board caps a row at four cards', () => {
  it('states the cap in one constant both grids can read', () => {
    expect(CARD_MIN_PX).toBe(430);
    // The 25% track is what caps the count at four however wide the window is; the
    // 430px floor is what stops five narrow cards squeezing in below that.
    expect(BOARD_GRID_COLUMNS).toContain('max(430px');
    expect(BOARD_GRID_COLUMNS).toContain('25%');
  });

  // 2026-09-09 (design 2/3, `doctrine/design/FD Board.dc.html`): the Board grid is
  // fixed at two columns of eight cards, not the auto-fill four-across layout this
  // constant still governs for the queue. `LanesGrid` reads its own `BOARD_COLUMNS`
  // now instead of the shared constant -- this asserts that fixed layout directly
  // rather than against `BOARD_GRID_COLUMNS`, which no longer applies here.
  it("lays the run board out on the design's fixed two-column grid", () => {
    const { container } = render(
      <LanesGrid
        lanes={[lane('A'), lane('B')]} filter="all" sort="state" feedLive now={Date.now()}
        showProbes={false} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()}
      />,
    );
    expect(gridOf(container).style.gridTemplateColumns).toBe('repeat(2, 1fr)');
  });

  it('lays the queue out on the same constant', () => {
    const { container } = render(
      <QueueView items={[queueItem('Q-1'), queueItem('Q-2')]} paused={false} maxInFlight={2} onToast={vi.fn()} />,
    );
    expect(gridOf(container).style.gridTemplateColumns).toBe(BOARD_GRID_COLUMNS);
  });
});
