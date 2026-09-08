import { expect, test } from '@playwright/test';

// Sweep #27: the cold-load refresh fired every fetch through `Promise.all` with a bare
// catch, so one failing read (here, /proposals) threw the whole batch away and left the
// board blank even though /lanes itself came back fine. `Promise.allSettled` must let
// every successful read land on its own.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('a single failing cold-load fetch never blanks the lanes that did come back, and names itself', async ({ page }) => {
  await page.route('**/proposals', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
  await expect(page.getByText(/could not load: proposals/)).toBeVisible();
});
