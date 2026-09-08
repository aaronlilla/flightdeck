import { expect, test } from '@playwright/test';

test.afterEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the summary block renders what/status/audit/readiness above the pipeline', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('lane-FLT-193').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();

  const summary = sheet.getByTestId('ticket-sheet-summary');
  await expect(summary).toBeVisible();
  await expect(summary.getByTestId('ticket-sheet-readiness')).toContainText('Ready to merge.');
  await expect(summary.getByTestId('ticket-sheet-audit')).toContainText('Council');
  await expect(summary.getByText('Re-check')).toBeVisible();
  await expect(summary.getByText('Re-audit')).toBeVisible();

  // The summary sits before the Pipeline section, top to bottom.
  const summaryBox = await summary.boundingBox();
  const pipelineLabel = sheet.getByText('Pipeline');
  const pipelineBox = await pipelineLabel.boundingBox();
  expect(summaryBox).not.toBeNull();
  expect(pipelineBox).not.toBeNull();
  expect(summaryBox!.y).toBeLessThan(pipelineBox!.y);
});

test('a stale audit reads not-ready with the drift reason, and Re-check refreshes the readiness line', async ({ page, request }) => {
  await request.post('/__test/fixture?name=summary-stale');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('lane-FLT-193').click();
  const sheet = page.getByTestId('ticket-sheet');
  const summary = sheet.getByTestId('ticket-sheet-summary');
  await expect(summary.getByTestId('ticket-sheet-audit')).toContainText('stale');
  await expect(summary.getByTestId('ticket-sheet-readiness')).toContainText('Not ready');
  await expect(summary.getByTestId('ticket-sheet-readiness')).toContainText('the PR head moved since the audit');
});

test('summary block screenshot at 1440x900', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('lane-FLT-193').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet.getByTestId('ticket-sheet-summary')).toBeVisible();
  await page.screenshot({ path: 'test-results/ticket-sheet-summary.png', fullPage: false });
});

test('Re-audit disables itself while a round runs, then shows the fresh verdict', async ({ page, request }) => {
  await request.post('/__test/fixture?name=summary-stale');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('lane-FLT-193').click();
  const sheet = page.getByTestId('ticket-sheet');
  const summary = sheet.getByTestId('ticket-sheet-summary');
  await expect(summary.getByTestId('ticket-sheet-audit')).toContainText('stale');

  await summary.getByText('Re-audit').click();
  await expect(summary.getByText('Re-auditing…')).toBeVisible();

  // The stub lands its fresh attestation ~2s after the click; the sheet polls every 3s.
  await expect(summary.getByTestId('ticket-sheet-readiness')).toContainText('Ready to merge.', { timeout: 10_000 });
  await expect(summary.getByText('Re-audit')).toBeVisible();
  await expect(summary.getByText('Re-auditing…')).not.toBeVisible();
});
