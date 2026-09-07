import { expect, test } from '@playwright/test';

// Cut-line #1: a write started before the feed drops has to read as "pending" --
// still on screen, still confirmable -- and stay visibly distinct from the feed
// itself reading "lost".
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

// App.tsx keeps an unconfirmed confirm card alive across a `/thread` refetch
// (`pendingConfirmRef`) specifically because the server's own `/thread` never
// echoes a client-only card back -- without that reattach, the 5s poll (or any
// `/events` frame) would silently erase the one thing standing between the
// operator and an irreversible click. This proves the reattach itself: the
// card survives a live, successful refresh cycle, not just an aborted one.
test('a pending confirm card survives a live refetch that does not carry it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();

  await page.getByTestId('lane-FLT-201').click();
  await expect(page.getByTestId('ticket-sheet')).toBeVisible();
  await page.getByTestId('ticket-sheet').getByText('Kill', { exact: true }).click();
  const confirm = page.getByText('Confirm — irreversible');
  await expect(confirm).toBeVisible();

  // The stub's own `/thread` never received this card (it is client-only until
  // Confirm is clicked) -- so the next poll cycle (every 5s) refetches a
  // `/thread` that omits it. Waiting past that interval exercises the reattach
  // rather than merely asserting the card was never touched.
  await page.waitForTimeout(5_500);
  await expect(confirm).toBeVisible();
  await expect(page.getByText('Kill FLT-201?')).toBeVisible();
});

test('a total feed drop shows the lost banner while the pending confirm from before the drop stays put', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();

  await page.getByTestId('lane-FLT-201').click();
  await expect(page.getByTestId('ticket-sheet')).toBeVisible();
  await page.getByTestId('ticket-sheet').getByText('Kill', { exact: true }).click();
  const confirm = page.getByText('Confirm — irreversible');
  await expect(confirm).toBeVisible();

  await page.route('**/lanes*', (route) => route.abort());
  await page.route('**/thread', (route) => route.abort());
  await page.route('**/journal*', (route) => route.abort());
  await page.route('**/integrations', (route) => route.abort());
  await page.route('**/caps', (route) => route.abort());
  await page.route('**/proposals', (route) => route.abort());
  await page.route('**/queue', (route) => route.abort());

  // "lost": the banner appears and the composer disables.
  await expect(page.getByText(/live feed lost/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Composer disabled/)).toBeVisible();

  // "pending": distinct from "lost" -- the card started before the drop is
  // still there and still names the same lane, not silently cleared or
  // conflated with the generic disconnected state.
  await expect(confirm).toBeVisible();
  await expect(page.getByText('Kill FLT-201?')).toBeVisible();
});
