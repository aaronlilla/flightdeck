/**
 * An irreversible console route answers 202 with a confirm token until the operator
 * confirms; this repeats the same request with `{ confirm: token }` in the body, the
 * way the console's own confirm card does, and returns the action's real answer. A
 * route that answered anything but 202 is returned as it was.
 */
export async function fetchConfirmed(url: string, init: RequestInit = {}): Promise<Response> {
  const first = await fetch(url, init);
  if (first.status !== 202) return first;
  const pending = await first.json() as { token: string };
  const previous = typeof init.body === 'string' && init.body ? JSON.parse(init.body) as Record<string, unknown> : {};
  const headers = { ...(init.headers as Record<string, string> | undefined), 'content-type': 'application/json' };
  return fetch(url, { ...init, headers, body: JSON.stringify({ ...previous, confirm: pending.token }) });
}
