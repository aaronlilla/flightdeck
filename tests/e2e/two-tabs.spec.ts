import { expect, test } from '@playwright/test';

// Cut-line #2: two tabs on the same console -- an action in one has to reach
// the other. There is no live push for a kill (`/events` only carries
// heartbeats and journal-event chips), so the second tab picks it up on its
// own 5s poll, same as it would from a second operator's machine.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('a kill confirmed in one tab shows up in a second tab within one poll cycle', async ({ browser }) => {
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await tabA.goto('/');
  await tabB.goto('/');

  await expect(tabA.getByTestId('lane-FLT-201')).toHaveAttribute('data-state', 'running');
  await expect(tabB.getByTestId('lane-FLT-201')).toHaveAttribute('data-state', 'running');

  await tabA.getByTestId('lane-FLT-201').click();
  await tabA.getByTestId('ticket-sheet').getByText('Kill', { exact: true }).click();
  await tabA.getByText('Confirm', { exact: true }).click();

  await expect(tabA.getByTestId('lane-FLT-201')).toHaveAttribute('data-state', 'killed');
  // tabB never clicked anything -- its own poll (or the `/events` chip that
  // triggers an early refresh) has to bring the kill across on its own.
  await expect(tabB.getByTestId('lane-FLT-201')).toHaveAttribute('data-state', 'killed', { timeout: 10_000 });

  await context.close();
});

test('a caps change made in one tab is reflected in a second tab', async ({ browser }) => {
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await tabA.goto('/');
  await tabB.goto('/');

  await tabA.getByText('Settings').click();
  const dailyInput = tabA.locator('input').first();
  await dailyInput.fill('9000000');
  await tabA.getByText('Save caps →').click();

  // Settings seeds its draft input from the caps prop on mount only (it never
  // resyncs on a later poll while already mounted), so tabB has to pick up
  // the change on its own 5s poll before it opens the panel, not after.
  await tabB.waitForTimeout(6_000);
  await tabB.getByText('Settings').click();
  await expect(tabB.locator('input').first()).toHaveValue('9000000');

  await context.close();
});
