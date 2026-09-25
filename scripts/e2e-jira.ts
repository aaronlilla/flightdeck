/**
 * Drives the FDTES sandbox for the factory board's intake tests (flightdeck-factory
 * e2e/intake.spec.ts). Jira credentials are read inside this process from the Windows
 * user environment (HKCU\Environment, the same place console.env.cmd reads them) and
 * never printed. Output is only keys, ids and short status lines.
 *
 *   create <summary> [description] [--assign-me] [--label] [--desc-mention]  -> the new key
 *   comment <KEY> <text> [--mention-me]                                      -> the comment id
 *   done <KEY>                                                                -> "<KEY> closed"
 *   mentions-since <hours>                                                    -> JSON ["KEY:commentId", ...]
 */
import { execFileSync } from 'node:child_process';

const ME = '712020:89770d27-0cf9-4cf1-8fef-fc4ec70d46ac';

function userEnv(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8' });
  const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(name));
  const value = line?.trim().split(/\s{2,}|\t/).slice(2).join(' ').trim();
  if (!value) throw new Error(`${name} is not set in the user environment`);
  return value;
}

const site = userEnv('FORGE_JIRA_SITE').replace(/\/+$/, '');
const auth = `Basic ${Buffer.from(`${userEnv('FORGE_JIRA_EMAIL')}:${userEnv('FORGE_JIRA_TOKEN')}`).toString('base64')}`;
const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));

const adf = (text: string, mention: boolean): unknown => ({
  type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
    ...(mention ? [{ type: 'mention', attrs: { id: ME, text: '@Aaron Lilla' } }] : []),
    { type: 'text', text: mention ? ` ${text.replace(/^[\s,]+/, '')}` : text },
  ] }],
});

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${site}/rest/api/3${path}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`Jira ${r.status} on ${method} ${path}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? {} : r.json();
}

async function main(): Promise<void> {
  if (cmd === 'create') {
    const fields: Record<string, unknown> = {
      project: { key: 'FDTES' },
      issuetype: { name: 'Task' },
      summary: `[e2e] ${args[0] ?? 'intake test'}`,
      labels: flags.has('--label') ? ['fd-e2e'] : [],
      description: adf(args[1] ?? 'Throwaway ticket for the factory board intake tests.', flags.has('--desc-mention')),
    };
    if (flags.has('--assign-me')) fields['assignee'] = { accountId: ME };
    console.log((await call('POST', '/issue', { fields })).key);
  } else if (cmd === 'comment') {
    console.log((await call('POST', `/issue/${args[0]}/comment`, { body: adf(args[1] ?? '', flags.has('--mention-me')) })).id);
  } else if (cmd === 'done') {
    await call('PUT', `/issue/${args[0]}/assignee`, { accountId: null });
    const { transitions } = await call('GET', `/issue/${args[0]}/transitions`);
    const done = (transitions as any[]).find((t) => t.to?.statusCategory?.key === 'done');
    if (done) await call('POST', `/issue/${args[0]}/transitions`, { transition: { id: done.id } });
    console.log(`${args[0]} closed`);
  } else if (cmd === 'mentions-since') {
    const hours = Number(args[0] ?? 24);
    const since = Date.now() - hours * 3.6e6;
    const found: string[] = [];
    let next: string | undefined;
    do {
      const page = await call('POST', '/search/jql', {
        jql: `project in (BBZ, FDTES) AND updated >= -${hours}h`, fields: ['comment'], maxResults: 50,
        ...(next ? { nextPageToken: next } : {}),
      });
      for (const issue of page.issues ?? []) {
        const total = issue.fields.comment?.total ?? 0;
        let comments = issue.fields.comment?.comments ?? [];
        if (total > comments.length) comments = (await call('GET', `/issue/${issue.key}/comment?maxResults=5000`)).comments ?? [];
        for (const c of comments) {
          if (c.author?.accountId === ME) continue;
          if (Date.parse(c.created) < since) continue;
          if (JSON.stringify(c.body).includes(ME)) found.push(`${issue.key}:${c.id}`);
        }
      }
      next = page.isLast ? undefined : page.nextPageToken;
    } while (next);
    console.log(JSON.stringify(found));
  } else {
    console.error('usage: create|comment|done|mentions-since');
    process.exit(2);
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
