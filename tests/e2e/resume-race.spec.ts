import { expect, test } from '@playwright/test';

// Cut-line #1: answering a question on a run that already resumed -- the
// stub's own `runCommand` handler for `answer` looks for a parked lane with a
// live question and, finding none, replies "nothing is parked right now"
// rather than erroring or resuming a second time. The `resume-race` scenario
// puts the lane back in `running` while its stale question card is still on
// the thread (the shape a second operator tab, or a worker resuming on its
// own, would leave behind).
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=resume-race');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('answering a question whose lane already resumed gets a graceful reply, not a second resume or a crash', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-402')).toHaveAttribute('data-state', 'running');

  await page.getByText('NOT NULL', { exact: true }).click();

  await expect(page.getByTestId('rail-thread')).toContainText("nothing is parked right now");
  // Still exactly one lane, still running -- the stale click never spawned a
  // second resume or flipped the lane to some other state.
  await expect(page.locator('[data-testid^="lane-"]')).toHaveCount(1);
  await expect(page.getByTestId('lane-FLT-402')).toHaveAttribute('data-state', 'running');
});
