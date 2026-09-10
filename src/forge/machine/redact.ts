/**
 * Masks credential-shaped fragments in a raw command line before it lands on a
 * `MachineSnapshot` process row -- the Machine page renders the full command line under
 * `?verbose=1`, so this is the only thing standing between a stray `--token=` and the
 * screen. `src/forge/redact.ts`'s generic 24-char scrub is tuned for exec dumps and
 * misses the short values a CLI flag typically carries (`--token=abc123`), so this is
 * a second, narrower helper rather than a reuse.
 *
 * Covers both `key=value`/`key: value` and `key value` (space-separated flag) shapes,
 * quoted values, `Authorization:`/`bearer` schemes with a following credential token,
 * and a `://user[:pass]@host` URL whether or not it carries a password segment
 * (`/critique`, 2026-09-10: the first cut missed all of these).
 *
 * The keyword match is deliberately NOT `\b`-bounded to the bare word: `\b` treats `_`
 * as a word character, so it cannot find `secret`/`key`/`token`/`password` inside an
 * env-var-style name like `AWS_SECRET_ACCESS_KEY=` or `DB_PASSWORD=` -- the standard
 * shape those exact command lines take (`/code-review high`, 2026-09-10). Matching the
 * whole `[\w.-]*keyword[\w.-]*` identifier instead accepts the (much safer than the
 * alternative) cost of over-redacting a plain word that happens to contain one of these
 * substrings, e.g. `--monkey=5`.
 */
const QUOTED_OR_BARE_VALUE = '("[^"]*"|\'[^\']*\'|\\S+)';
const KEY_VALUE_PATTERN = new RegExp(`([\\w.-]*(?:token|key|secret|password)[\\w.-]*)(\\s*[:=]\\s*|\\s+)${QUOTED_OR_BARE_VALUE}`, 'gi');
const AUTHORIZATION_HEADER = /(authorization\s*:\s*)(\S+(?:\s+\S+)?)/gi;
const BEARER_TOKEN = /(bearer\s+)(\S+)/gi;
// A credential segment before `@` in a URL: either `user:pass@` or a bare `user@`
// (a personal-access-token-as-username shape, e.g. `https://ghp_xxx@github.com/...`).
const CREDENTIALED_URL = /(:\/\/)([^\s/@:]+)(:([^\s/@]+))?(@)/g;

export function maskCommandLine(commandLine: string): string {
  if (!commandLine) return commandLine;
  return commandLine
    .replace(CREDENTIALED_URL, (_match, scheme: string, _user: string, _colonPass: string | undefined, _pass: string | undefined, at: string) =>
      _colonPass ? `${scheme}[REDACTED]:[REDACTED]${at}` : `${scheme}[REDACTED]${at}`)
    .replace(AUTHORIZATION_HEADER, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(BEARER_TOKEN, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(KEY_VALUE_PATTERN, (_match, keyword: string, separator: string) => `${keyword}${separator}[REDACTED]`);
}
