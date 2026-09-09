import { expect, test } from '@playwright/test';

// The Conductor agent on the rail (2026-09-08): "remove <lane>" shows a tool receipt
// the moment the agent proposes, then the confirm card; Confirm retires the lane and it
// leaves the board. The stub plays the agent's shape (`stub-server.ts#runCommand`).
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('typing "remove <lane>": a receipt row, then the confirm card, then the lane leaves the board on Confirm', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-215')).toBeVisible();
  const rail = page.getByTestId('rail-thread');
  const composer = page.getByPlaceholder(/command…/);
  await composer.fill('remove FLT-215');
  await composer.press('Enter');

  const receipt = rail.getByText('remove proposed for FLT-215, waiting on Confirm');
  await expect(receipt).toBeVisible();
  const card = rail.getByText('Confirm — irreversible');
  await expect(card).toBeVisible();
  // The receipt sits above the card: the agent's tool ran before its reply arrived.
  const receiptBox = await receipt.boundingBox();
  const cardBox = await card.boundingBox();
  expect(receiptBox!.y).toBeLessThan(cardBox!.y);
  await expect(rail.getByTestId('reply-label').filter({ hasText: /^Conductor$/ }).first()).toBeVisible();

  await rail.getByText('Confirm', { exact: true }).click();
  await expect(rail.getByText('retired FLT-215')).toBeVisible();
  await expect(page.getByTestId('lane-FLT-215')).toHaveCount(0);
});

test('a message typed into a ticket sheet shows the Conductor working, then its reply, inside the sheet', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click({ position: { x: 4, y: 4 } });
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();
  const input = sheet.getByPlaceholder(/Tell this run something/);
  await input.fill('status of the migration?');
  await input.press('Enter');
  const thread = sheet.getByTestId('ticket-sheet-thread');
  await expect(thread.getByText('status of the migration?')).toBeVisible();
  await expect(thread.getByText('Told FLT-201: status of the migration?')).toBeVisible();
  await expect(thread.getByText('sent to FLT-201')).toBeVisible();
  await expect(thread.getByTestId('conductor-working')).toHaveCount(0);
});
