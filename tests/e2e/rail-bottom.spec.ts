import { expect, test } from '@playwright/test';

/** The scroll metrics this suite reads off the real list element. Spelled out because
 *  the e2e tsconfig has no DOM lib: these specs run in node and talk to a browser. */
interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  dispatchEvent: (event: unknown) => void;
}

/**
 * R-75 item 2, the referee. The jsdom test asserts on a scroll metric; this one opens
 * the real console in a real browser against the stub server and asks the only question
 * that matters: is the newest message in view without anyone scrolling?
 *
 * Aaron, 2026-09-11: "the chat needs to default to hugging the bottom of the chat until
 * you scroll up with a fast scroll-to-bottom functionality that keeps it sticking to
 * the bottom, like normal chatroom style."
 */
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=long-conversation');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the rail opens with its last message in view, with no scroll', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByTestId('rail-thread');
  await expect(rail).toBeVisible();

  // The thread is long enough that the bottom is not the top.
  const metrics = await rail.evaluate((el) => { const box = el as unknown as ScrollBox; return { scrollHeight: box.scrollHeight, clientHeight: box.clientHeight, scrollTop: box.scrollTop }; });
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

  const last = rail.getByText('The last word in the rail.');
  await expect(last).toBeInViewport();

  // And the first message is not: the list really is scrolled, not merely short.
  await expect(rail.getByText('Turn 1: what is the lane doing?')).not.toBeInViewport();
  expect(metrics.scrollTop).toBeGreaterThan(0);
});

test('scrolling up unpins, a new message is counted, and the jump button re-pins', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByTestId('rail-thread');
  await expect(rail).toBeVisible();

  await rail.evaluate((el) => { const box = el as unknown as ScrollBox; box.scrollTop = 0; box.dispatchEvent(new Event('scroll')); });
  await expect(rail.getByText('Turn 1: what is the lane doing?')).toBeInViewport();

  // Messages arrive while the reader is up the thread: the operator's own line and
  // whatever the Conductor says back, through the real command route.
  const composer = page.locator('#rail-composer');
  await composer.fill("what's stuck");
  await composer.press('Enter');

  const jump = page.getByTestId('rail-jump');
  await expect(jump).toBeVisible({ timeout: 15_000 });
  await expect(jump).toHaveText(/^↓ \d+ new$/);

  await jump.click();
  await expect(jump).toHaveCount(0);
  // Back at the bottom, and the newest row -- whatever the Conductor last said -- is
  // the one in view. The reply is what arrived last, so it is what a reader lands on.
  await expect(rail.getByTestId('rail-row').last()).toBeInViewport();
  const after = await rail.evaluate((el) => { const box = el as unknown as ScrollBox; return box.scrollHeight - box.scrollTop - box.clientHeight; });
  expect(after).toBeLessThanOrEqual(24);
});
