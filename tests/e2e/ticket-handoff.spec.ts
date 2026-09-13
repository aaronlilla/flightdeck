import { expect, test } from '@playwright/test';

/**
 * Handing a ticket on, pressed in a browser rather than read in the source.
 *
 * The claim this file exists to refuse is "the console can do it now" being true of a
 * control that renders and does nothing when pressed. The route and the module are
 * proven on their own; nothing in either says the button reaches them.
 *
 * The sheet's own network call is watched, so a press that renders a receipt without
 * writing anything fails here.
 */
test('the sheet can hand a ticket on, and says what each of the three writes did', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();

  const handoff = sheet.getByTestId('lane-handoff');
  await expect(handoff).toBeVisible();
  await handoff.click();

  await sheet.getByTestId('lane-handoff-to').selectOption('qa');
  await sheet.getByTestId('lane-handoff-comment').fill('merged, the deposit screen is the one to look at');

  // The press has to reach the server. A receipt rendered off a call that never happened
  // is exactly the failure this spec is here for.
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/ticket/') && r.url().endsWith('/handoff') && r.method() === 'POST'),
    sheet.getByTestId('lane-handoff-submit').click(),
  ]);
  expect(request.postDataJSON()).toMatchObject({
    to: 'qa',
    comment: 'merged, the deposit screen is the one to look at',
  });

  // Irreversible, so the first press only asks. It says what it is about to do, and
  // nothing has been written yet.
  await expect(sheet.getByTestId('lane-handoff-blast')).toContainText('comments, assigns and moves it');
  await expect(sheet.getByTestId('lane-handoff-result')).toHaveCount(0);
  await sheet.getByTestId('lane-handoff-submit').click();

  const result = sheet.getByTestId('lane-handoff-result');
  await expect(result).toBeVisible();
  // Every step named, not one verdict for three writes.
  await expect(result).toContainText('comment: commented');
  await expect(result).toContainText('assign: assigned to QA');
  await expect(result).toContainText('transition: moved');
});

test('it will not post a blank comment', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await sheet.getByTestId('lane-handoff').click();

  await expect(sheet.getByTestId('lane-handoff-submit')).toBeDisabled();
  await sheet.getByTestId('lane-handoff-comment').fill('   ');
  await expect(sheet.getByTestId('lane-handoff-submit')).toBeDisabled();
});
