import { expect, test } from '@playwright/test';

// D2.4: the desktop status window already shows "Queue is off" when `/state` reports
// `queue_on: false` (`desktop/electron/status-page.ts`'s `#queue-banner`) -- the web
// console had no equivalent. `queue-off` is a dedicated fixture (rather than a default
// this stub always carries) so every other spec in the suite, none of which cares about
// this field, never sees a banner it never asked for.
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the top bar shows no queue banner when the queue is on', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Queue is off', { exact: false })).not.toBeVisible();
});

test('the top bar shows "Queue is off" when GET /state reports queue_on:false', async ({ page }) => {
  await page.request.post('/__test/fixture?name=queue-off');
  await page.goto('/');
  await expect(page.getByText('Queue is off', { exact: false })).toBeVisible();
});
