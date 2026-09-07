import { expect, test } from '@playwright/test';

// Cut-line #2: one card per `MessageType` (`message-gallery`,
// `src/console/fixtures/scenarios.ts#galleryThread`), matching
// `ConductorRail.tsx`'s own `MessageCard` switch one for one.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=message-gallery');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the rail renders every message type: event, operator, reply, question, plan, confirm, receipt, refusal, pr, thinking', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByTestId('rail-thread');

  await expect(rail.getByText('FLT-501 parked -- needs an answer')).toBeVisible(); // event
  await expect(rail.getByText('pause everything')).toBeVisible(); // operator
  await expect(rail.getByText('Recommend killing it.', { exact: false })).toBeVisible(); // reply
  await expect(rail.getByText('Question · from FLT-501')).toBeVisible(); // question
  await expect(rail.getByText('Plan · 2 actions')).toBeVisible(); // plan
  await expect(rail.getByText('Confirm — irreversible')).toBeVisible(); // confirm
  await expect(rail.getByText('J-90001')).toBeVisible(); // receipt
  await expect(rail.getByText('Refused', { exact: true })).toBeVisible(); // refusal
  await expect(rail.getByText('draft PR #9 opened')).toBeVisible(); // pr
  await expect(rail.getByText('conductor is planning')).toBeVisible(); // thinking
});

test('the plan card shows both a reversible and an irreversible action, distinctly labeled', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByTestId('rail-thread');
  const plan = rail.locator('.plate', { hasText: 'Plan · 2 actions' });
  await expect(plan.getByText('irreversible', { exact: true })).toBeVisible();
  await expect(plan.getByText('reversible', { exact: true })).toBeVisible();
});

test('the question card offers its two options plus a free-text answer field', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByTestId('rail-thread');
  const question = rail.locator('div', { hasText: 'Question · from FLT-501' }).first();
  await expect(page.getByText('NOT NULL', { exact: true })).toBeVisible();
  await expect(page.getByText('nullable + backfill', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('or type an answer, ⏎')).toBeVisible();
  void question;
});
