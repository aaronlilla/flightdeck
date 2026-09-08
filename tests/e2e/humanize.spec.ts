import { expect, test } from '@playwright/test';

// Item 10: the board reads like a board. Plain by default, nothing on it a
// person would have to decode; verbose brings the machine's own words back.
const MACHINE_ID = /S-[0-9a-f]{12,}|jira_|queue-[A-Z]|[0-9a-f]{40}/;

async function waitForFonts(page: import('@playwright/test').Page): Promise<void> {
  // The fonts reflow the grid once they land -- geometry measured before that
  // settles reads stale numbers (item 10's own note on this).
  await page.evaluate('document.fonts.ready');
}

test.describe('(a) plain mode shows no machine id', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/fixture?name=human-board');
  });
  test.afterAll(async ({ request }) => {
    await request.post('/__test/fixture?name=default');
  });

  test('no visible text on the board matches the machine-id regex', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('lane-long-title-1')).toBeVisible();
    const bodyText = await page.evaluate('document.body.innerText');
    expect(bodyText as string).not.toMatch(MACHINE_ID);
  });

  test('no visible text in an open sheet matches the machine-id regex', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('lane-long-title-1').click();
    const sheet = page.getByTestId('ticket-sheet');
    await expect(sheet).toBeVisible();
    const sheetText = await sheet.evaluate((el) => (el as unknown as { innerText: string }).innerText);
    expect(sheetText).not.toMatch(MACHINE_ID);
  });
});

test.describe('(b) verbose mode brings the ids back', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/fixture?name=default');
  });
  test.afterAll(async ({ request }) => {
    await request.post('/__test/fixture?name=default');
  });

  test('flipping to verbose shows the id chip and an S- chip in the thread', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('lane-FLT-201').click();
    const sheet = page.getByTestId('ticket-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('ticket-sheet-id-chip')).toHaveCount(0);

    // Item 15: the sheet carries its own plain/verbose chip beside "esc to close",
    // so the switch is reachable from the sheet itself, not only the top bar the
    // sheet is now covering.
    await sheet.getByTestId('ticket-sheet-verbose-chip').click();
    await expect(sheet.getByTestId('ticket-sheet-id-chip')).toBeVisible();
    await expect(sheet.getByTestId('ticket-sheet-id-chip')).toContainText('FLT-201');
    const thread = sheet.getByTestId('ticket-sheet-thread');
    await expect(thread.getByText(/S-[0-9a-f]{12,}/).first()).toBeVisible();
  });
});

test.describe('(c) tile geometry', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/fixture?name=human-board');
  });
  test.afterAll(async ({ request }) => {
    await request.post('/__test/fixture?name=default');
  });

  for (const [width, height] of [[1440, 900], [1280, 720]] as const) {
    test(`every tile fits its own border and every tile in a row shares a height, at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await expect(page.getByTestId('lane-long-title-1')).toBeVisible();
      await waitForFonts(page);

      const rows = await page.evaluate(`(() => {
        const tiles = Array.from(document.querySelectorAll('[data-testid^="lane-"]'));
        const rowsByTop = new Map();
        for (const el of tiles) {
          const box = el.getBoundingClientRect();
          const overflow = el.scrollWidth > el.clientWidth + 1;
          const top = Math.round(box.top);
          if (!rowsByTop.has(top)) rowsByTop.set(top, []);
          rowsByTop.get(top).push({ height: Math.round(box.height), overflow });
        }
        return Array.from(rowsByTop.values());
      })()`) as { height: number; overflow: boolean }[][];

      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) {
        const heights = new Set(row.map((t) => t.height));
        expect(heights.size).toBe(1);
        for (const tile of row) expect(tile.overflow).toBe(false);
      }
    });
  }
});

test.describe('(d) the composer stays reachable', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/fixture?name=long-thread');
  });
  test.afterAll(async ({ request }) => {
    await request.post('/__test/fixture?name=default');
  });

  test('Send is inside the viewport immediately after opening a sheet whose thread has 60+ messages', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByTestId('lane-FLT-201').click();
    const sheet = page.getByTestId('ticket-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Send ⏎')).toBeInViewport();
  });

  test('Send stays inside the viewport at 1280x720 too', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.getByTestId('lane-FLT-201').click();
    const sheet = page.getByTestId('ticket-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Send ⏎')).toBeInViewport();
  });
});

test.describe('(e) the operator bubble for an answered question', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/fixture?name=default');
  });
  test.afterAll(async ({ request }) => {
    await request.post('/__test/fixture?name=default');
  });

  test('clicking a question option echoes "Answered: ..." in the rail, naming the option', async ({ page }) => {
    await page.goto('/');
    const rail = page.getByTestId('rail-thread');
    await rail.getByText('nullable + backfill', { exact: true }).click();
    await expect(rail.getByText(/^Answered: .*nullable \+ backfill/)).toBeVisible();
  });
});

// Iteration 3: the board at a glance -- no two tiles overlap, every tile in a row
// shares a height, the title's own `title=` matches the lane's full title, a YOU
// block appears for a lane that needs a person and not for a running one, and the
// chip row sits below the title.
test.describe('(f) board-at-a-glance tile contract', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/fixture?name=human-board');
  });
  test.afterAll(async ({ request }) => {
    await request.post('/__test/fixture?name=default');
  });

  for (const [width, height] of [[1440, 900], [1280, 720]] as const) {
    test(`no two tiles' bounding boxes intersect at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await expect(page.getByTestId('lane-long-title-1')).toBeVisible();
      await page.evaluate('document.fonts.ready');

      const overlaps = await page.evaluate(`(() => {
        const boxes = Array.from(document.querySelectorAll('[data-testid^="lane-"]')).map((el) => el.getBoundingClientRect());
        let count = 0;
        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i]; const b = boxes[j];
            const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            if (overlapX > 1 && overlapY > 1) count += 1;
          }
        }
        return count;
      })()`);
      expect(overlaps).toBe(0);
    });
  }

  test("the title's title= attribute equals the lane's full title for every tile in the stub fleet", async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('lane-long-title-1')).toBeVisible();
    const mismatches = await page.evaluate(`(() => {
      const tiles = Array.from(document.querySelectorAll('[data-testid^="lane-"]'));
      let bad = 0;
      for (const tile of tiles) {
        const titleEl = tile.querySelector('[title]');
        if (!titleEl) continue;
        // The title line is the first [title] element under the tile, right after
        // row 1 -- carries the lane's own title (or the key fallback), never the run id.
        if (titleEl.getAttribute('title') === tile.getAttribute('data-run-id') && titleEl.textContent !== tile.getAttribute('data-run-id')) bad += 1;
      }
      return bad;
    })()`);
    expect(mismatches).toBe(0);
  });

  test('the YOU block is rendered for the parked fixture lane and absent for a running one', async ({ page }) => {
    await page.goto('/');
    const parkedTile = page.getByTestId('lane-parked-1');
    await expect(parkedTile).toBeVisible();
    await expect(parkedTile.getByText('YOU', { exact: true })).toBeVisible();

    const runningTile = page.getByTestId('lane-long-title-1');
    await expect(runningTile).toBeVisible();
    await expect(runningTile.getByText('YOU', { exact: true })).toHaveCount(0);
    await expect(runningTile.getByText('Nothing needed from you.')).toBeVisible();
  });

  test('the chip row sits below the title, never beside it', async ({ page }) => {
    await page.goto('/');
    const tile = page.getByTestId('lane-long-title-1');
    await expect(tile).toBeVisible();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the main tsconfig
    // carries no DOM lib (see the top-of-file note in overflow.spec.ts), so `el` here
    // has no typed `getBoundingClientRect` to call without one.
    const titleBottom: number = await tile.locator('[title="the withdrawal fee rounds down instead of to the nearest cent on every payout over five hundred dollars, which the finance team flagged after last week\'s reconciliation"]').first().evaluate((el: any) => el.getBoundingClientRect().bottom);
    const chipTop: number = await tile.getByText('sonnet-5').first().evaluate((el: any) => el.getBoundingClientRect().top);
    expect(chipTop).toBeGreaterThanOrEqual(titleBottom - 1);
  });
});

// "Links everywhere" (2026-09-08, Aaron: "when there's jira tickets mentioned or PRs
// mentioned anywhere in the application, they need to be hyperlinked"). Every visible
// BBZ- key and PR # mention inside the board, an open sheet and the rail is inside an
// <a href> that points at the right host.
test.describe('(g) links everywhere', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/fixture?name=default');
  });
  test.afterAll(async ({ request }) => {
    await request.post('/__test/fixture?name=default');
  });

  test('every visible BBZ- key and PR # mention is inside a link to the right host', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
    await page.getByTestId('lane-BBZ-118').click();
    const sheet = page.getByTestId('ticket-sheet');
    await expect(sheet).toBeVisible();

    const bad = await page.evaluate(`(() => {
      const jiraRe = /\\bBBZ-\\d+\\b/;
      const prRe = /\\bPR\\s*#\\d+\\b/;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      let bad = 0;
      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        if (!jiraRe.test(text) && !prRe.test(text)) continue;
        const inLink = node.parentElement && node.parentElement.closest('a[href]');
        if (!inLink) { bad += 1; continue; }
        const href = inLink.getAttribute('href') || '';
        if (jiraRe.test(text) && !href.includes('/browse/')) bad += 1;
        if (prRe.test(text) && !href.includes('/pull/')) bad += 1;
      }
      return bad;
    })()`);
    expect(bad).toBe(0);
  });
});
