import { expect, test } from '@playwright/test';

/**
 * G5, measured rather than described. Aaron, 2026-09-08, on the live console: "we only
 * need to be able to fit four cards in a row at maximum screen size ... no text should
 * be below like 12px".
 *
 * The unit tests assert the contract (one constant, one token per size). This asserts
 * the result, in a browser that actually lays the page out: how many cards really share
 * a row at his own window size, and what size the text really computes to. A card that
 * names the right constant and still lands five to a row fails here and nowhere else.
 *
 * tests/e2e falls under the root tsconfig, which carries no dom lib (fd7d3da), so every
 * page.evaluate body is a string: Playwright runs it in the page, TypeScript never
 * parses it for DOM globals.
 */
const WIDE = { width: 2560, height: 1440 };

const COUNT_PER_ROW = `(() => {
  const rows = new Map();
  for (const card of document.querySelectorAll('.lane')) {
    const top = Math.round(card.getBoundingClientRect().top);
    rows.set(top, (rows.get(top) ?? 0) + 1);
  }
  return [...rows.values()];
})()`;

const SMALL_TEXT = `(() => {
  const small = [];
  for (const el of document.querySelectorAll('*')) {
    const text = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join('');
    if (!text) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const size = Number.parseFloat(style.fontSize);
    if (size < 12) small.push(el.tagName.toLowerCase() + ' ' + size + 'px: ' + text.slice(0, 40));
  }
  return small;
})()`;

// Every test seeds its own fixture: the suite runs serially against one stub, so a
// test that leaves the queue matrix loaded is what the next one would measure.
test('the board fits at most four cards in a row on a 2560px window', async ({ page, request }) => {
  await request.post('/__test/fixture?name=default');
  await page.setViewportSize(WIDE);
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
  const perRow = await page.evaluate<number[]>(COUNT_PER_ROW);
  console.log(`board cards per row at ${WIDE.width}px: ${perRow.join(', ')}`);
  expect(perRow.length).toBeGreaterThan(0);
  expect(Math.max(...perRow)).toBeLessThanOrEqual(4);
});

test('the queue fits at most four cards in a row on a 2560px window', async ({ page, request }) => {
  await request.post('/__test/fixture?name=queue-matrix');
  await page.setViewportSize(WIDE);
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  await expect(page.locator('.lane').first()).toBeVisible();
  const perRow = await page.evaluate<number[]>(COUNT_PER_ROW);
  console.log(`queue cards per row at ${WIDE.width}px: ${perRow.join(', ')}`);
  expect(Math.max(...perRow)).toBeLessThanOrEqual(4);
});

for (const theme of ['dark', 'light'] as const) {
  test(`no text on the board computes below 12px, ${theme} theme`, async ({ page, request }) => {
    await request.post('/__test/fixture?name=default');
    await page.setViewportSize(WIDE);
    await page.goto('/');
    await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
    if (theme === 'light') await page.getByText('day mode').click();
    expect(await page.evaluate<string[]>(SMALL_TEXT)).toEqual([]);
  });
}

test('no text on the queue computes below 12px', async ({ page, request }) => {
  await request.post('/__test/fixture?name=queue-matrix');
  await page.setViewportSize(WIDE);
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  await expect(page.locator('.lane').first()).toBeVisible();
  expect(await page.evaluate<string[]>(SMALL_TEXT)).toEqual([]);
});

test('the rail holds a long question without scrolling sideways', async ({ page, request }) => {
  await request.post('/__test/fixture?name=long-thread');
  await page.setViewportSize(WIDE);
  await page.goto('/');
  await expect(page.getByTestId('rail-thread')).toBeVisible();
  const { scrollWidth, clientWidth } = await page.evaluate<{ scrollWidth: number; clientWidth: number }>(
    `(() => { const t = document.querySelector('[data-testid="rail-thread"]'); return { scrollWidth: t.scrollWidth, clientWidth: t.clientWidth }; })()`,
  );
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});
