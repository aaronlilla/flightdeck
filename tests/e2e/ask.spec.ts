import { expect, test } from '@playwright/test';

// W1/W2 (ask-cards-and-type-scale): a lane parked on an ask that already carries
// four options and a recommendation (`ask-recommended`, `src/console/fixtures/
// scenarios.ts#askRecommendedLanes` + `#askRecommendedThread`).
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=ask-recommended');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('picking the recommended option sends it and clears the ask from Needs You', async ({ page }) => {
  await page.goto('/');

  const rail = page.getByTestId('rail-thread');
  await expect(rail.getByText('Question · from FLT-410')).toBeVisible();
  await expect(rail.getByText('the retry backoff should cap at 30s or keep doubling forever?')).toBeVisible();

  const options = rail.getByTestId('question-options');
  await expect(options.getByText('Cap at 30s', { exact: true })).toBeVisible();
  await expect(options.getByText('Keep doubling forever', { exact: true })).toBeVisible();
  await expect(options.getByText('Cap at 60s', { exact: true })).toBeVisible();
  await expect(options.getByText('Something else, I will type it', { exact: true })).toBeVisible();

  const recommendedRow = options.locator('span.btnA', { hasText: 'Cap at 30s' });
  await expect(recommendedRow.getByText('Recommended', { exact: true })).toBeVisible();

  const strip = page.getByText('Needs you').locator('../..');
  await expect(strip.getByText(/asks: /)).toBeVisible();

  await recommendedRow.click();

  await expect(rail.getByText('resumed: Cap at 30s')).toBeVisible();
  await expect(strip.getByText(/asks: /)).toHaveCount(0);
});
