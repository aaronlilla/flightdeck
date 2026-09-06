import { expect, test } from '@playwright/test';

// Runs last (file order) because answering the seed's one parked lane mutates
// shared stub-server state that the earlier board/needs-you specs depend on.
test('answering a parked lane resumes it and posts a receipt to the rail', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('lane-BBZ-118')).toHaveAttribute('data-state', 'parked');
  await page.getByText('nullable + backfill', { exact: true }).click();
  await expect(page.getByTestId('rail-thread')).toContainText(/resumed/);
  await expect(page.getByTestId('lane-BBZ-118')).toHaveAttribute('data-state', 'running');
});
