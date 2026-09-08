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
