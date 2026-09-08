import { expect, test } from '@playwright/test';

// Cut-line #2: palette navigation -- typing a filter, Enter opening the first
// match, Escape closing mid-filter (CommandPalette.tsx's own contract: "Enter
// opens first match, Esc closes").
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('typing a query narrows the list, and Enter opens the first match', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();

  await page.getByPlaceholder('lane, ticket, journal id, view…').fill('FLT-204');
  await expect(palette.getByText('FLT-204', { exact: true })).toBeVisible();
  // Narrowed: FLT-201 (present with no filter) is no longer listed.
  await expect(palette.getByText('FLT-201', { exact: true })).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId('ticket-sheet')).toBeVisible();
  // FLT-204 shows up twice now (the big headline, and the ticket chip beside
  // it) -- .first() picks the headline, which is what "opened the right sheet"
  // actually needs to prove.
  await expect(page.getByTestId('ticket-sheet').getByText('FLT-204', { exact: true }).first()).toBeVisible();
});

test('Escape closes the palette mid-filter without acting on the typed text', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();

  await page.getByPlaceholder('lane, ticket, journal id, view…').fill('FLT-2');
  await expect(palette.getByText('FLT-201', { exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  // No sheet opened, no navigation happened -- Escape discarded the filter
  // rather than acting on whatever the top match happened to be.
  await expect(page.getByTestId('ticket-sheet')).toHaveCount(0);
  await expect(page.locator('.lbl', { hasText: 'Queue' })).toHaveCount(0);
});

test('a view query filters to matching views only, and Enter navigates there', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('lane, ticket, journal id, view…').fill('settings');
  const palette = page.getByTestId('command-palette');
  await expect(palette.getByText('Settings', { exact: true })).toBeVisible();
  await expect(palette.getByText('Board', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-view')).toBeVisible();
});
