import { expect, test } from '@playwright/test';

// Sweep #14: clicking the "epic…" quick-fill chip on the query source inserted the
// literal `parent = KEY` and left it there. The KEY placeholder must be selected for
// typing over, and Add must refuse to submit while it is still present.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the epic chip selects the KEY placeholder, and Add refuses while it remains', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  await page.getByText('query', { exact: true }).click();
  await page.getByText('epic…', { exact: true }).click();

  const input = page.locator('input.inp');
  await expect(input).toHaveValue('parent = KEY');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selected = await input.evaluate((el: any) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)) as string;
  expect(selected).toBe('KEY');

  await page.getByText('Add ⏎', { exact: true }).click();
  // Still on the placeholder text -- nothing was added.
  await expect(input).toHaveValue('parent = KEY');

  await input.fill('parent = BB-42');
  await expect(input).toHaveValue('parent = BB-42');
  await page.getByText('Add ⏎', { exact: true }).click();
  await expect(input).toHaveValue('');
});
