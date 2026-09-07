import { expect, test } from '@playwright/test';

// Cut-line #1: every lane state crossed with its own call to action, one lane
// per row of the HANDOFF's CTA table (`states-matrix`, `src/console/fixtures/
// scenarios.ts#statesLanes`) -- `laneCta()` in `laneVM.ts` is the source of
// truth this asserts against.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=states-matrix');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

const ROWS: [id: string, cta: string][] = [
  ['FLT-301', 'Watch live'],
  ['FLT-302', 'Kill attempt'],
  ['FLT-303', 'View council'],
  ['FLT-304', 'Resume ▶'],
  ['FLT-305', 'Answer →'],
  ['FLT-306', 'Merge now →'],
  ['FLT-307', 'Open PR ↗'],
  ['FLT-308', 'Gate log →'],
  ['FLT-309', 'Reconnect AWS →'],
  ['FLT-310', 'Compact + resume →'],
  ['FLT-311', 'Reopen'],
  ['FLT-312', 'Verify →'],
];

for (const [id, cta] of ROWS) {
  test(`${id} shows exactly its state's own CTA: ${cta}`, async ({ page }) => {
    await page.goto('/');
    const tile = page.getByTestId(`lane-${id}`);
    await expect(tile).toBeVisible();
    await expect(tile.getByText(cta, { exact: true })).toBeVisible();
  });
}

test('the board renders all twelve rows of the CTA table with no duplicate CTA text inside one tile', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid^="lane-"]')).toHaveCount(ROWS.length);
  for (const [id] of ROWS) {
    const tile = page.getByTestId(`lane-${id}`);
    // Exactly one CTA element (`.btnP`/`.btnA`/`.btnR`/`.btnS`) sits in the tile's
    // own action row, distinct from the state label above it.
    const ctaRow = tile.locator('.btnP, .btnA, .btnR, .btnS');
    await expect(ctaRow).toHaveCount(1);
  }
});
