import { expect, test } from '@playwright/test';

// Cut-line #1: "a write whose mechanism does not exist yet answers 501
// {error, reason}; the rail renders that as a refusal card and never pretends
// the action ran" (console-model.ts's own route table). The `refusal-501`
// scenario's one lane sits on the stub's `UNBUILT_REPO` sentinel, so its
// compact action always 501s no matter which stream builds the real one.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=refusal-501');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

// D2.1: fixed in App.tsx -- `runAction` now keeps every receipt/refusal card it
// appends in a short-lived local list (`localCardsRef`) and `refresh()` merges any
// of those still missing from the server's own `/thread` back in, the same way it
// already did for the unconfirmed confirm card.
test('a 501 write renders as a dashed refusal card, and the lane never flips to done', async ({ page }) => {
  await page.goto('/');
  const tile = page.getByTestId('lane-FLT-401');
  await expect(tile).toBeVisible();
  await tile.getByText('Compact + resume →', { exact: true }).click();

  const refusal = page.getByText('Refused', { exact: true });
  await expect(refusal).toBeVisible();
  // The same sentence now also renders inline beside the control, so scope to the
  // dashed refusal card in the rail thread to keep this assertion unambiguous.
  await expect(page.getByTestId('rail-thread').getByText('compaction has no successor worker built yet')).toBeVisible();

  // Never pretends the action ran: still exhausted, never quietly promoted.
  await expect(tile).toHaveAttribute('data-state', 'exhausted');
});
