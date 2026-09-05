/**
 * R1: `FORGE_INTAKE_REPO_MAP` routing (parse + evaluate), specimens named in the brief.
 */
import { describe, expect, it } from 'vitest';

import { parseRepoMap, routeRepo, type RepoRule } from '../../../src/forge/intake/repoRoute.js';

const NO_MATCH = { ticket: 'ZZZ-1', labels: [], components: [], issuetype: 'Task' };

describe('parseRepoMap', () => {
  it('parses label, component, type, key and default rules in order', () => {
    const rules = parseRepoMap(
      'label:mobile=owner/frontend,component:api=owner/backend,type:bug=owner/backend,'
        + 'key:ABC=owner/tools,default=owner/misc',
    );
    expect(rules).toEqual<RepoRule[]>([
      { kind: 'label', value: 'mobile', repo: 'owner/frontend' },
      { kind: 'component', value: 'api', repo: 'owner/backend' },
      { kind: 'type', value: 'bug', repo: 'owner/backend' },
      { kind: 'key', value: 'ABC', repo: 'owner/tools' },
      { kind: 'default', repo: 'owner/misc' },
    ]);
  });

  it('returns no rules for an unset or empty map', () => {
    expect(parseRepoMap(undefined)).toEqual([]);
    expect(parseRepoMap('')).toEqual([]);
    expect(parseRepoMap('   ')).toEqual([]);
  });

  it('rejects an entry with no rule=owner/name shape', () => {
    expect(() => parseRepoMap('mobile=owner/frontend')).toThrow(/malformed/);
  });

  it('rejects an unknown rule kind', () => {
    expect(() => parseRepoMap('platform:web=owner/frontend')).toThrow(/unknown rule kind/);
  });
});

describe('routeRepo', () => {
  it('a label rule routes a ticket carrying that label', () => {
    const rules = parseRepoMap('label:mobile=owner/frontend');
    expect(routeRepo(rules, { ...NO_MATCH, labels: ['mobile'] })).toBe('owner/frontend');
  });

  it('a component rule routes by component', () => {
    const rules = parseRepoMap('component:api=owner/backend');
    expect(routeRepo(rules, { ...NO_MATCH, components: ['api'] })).toBe('owner/backend');
  });

  it('a type rule routes by issue type', () => {
    const rules = parseRepoMap('type:bug=owner/backend');
    expect(routeRepo(rules, { ...NO_MATCH, issuetype: 'Bug' })).toBe('owner/backend');
  });

  it('a key rule routes by the ticket\'s project prefix', () => {
    const rules = parseRepoMap('key:ABC=owner/tools');
    expect(routeRepo(rules, { ...NO_MATCH, ticket: 'ABC-42' })).toBe('owner/tools');
  });

  it('default catches whatever no other rule matched', () => {
    const rules = parseRepoMap('label:mobile=owner/frontend,default=owner/misc');
    expect(routeRepo(rules, NO_MATCH)).toBe('owner/misc');
  });

  it('with no map, or no rule matching, the repository stays unknown', () => {
    expect(routeRepo([], NO_MATCH)).toBe('unknown');
    const rules = parseRepoMap('label:mobile=owner/frontend');
    expect(routeRepo(rules, NO_MATCH)).toBe('unknown');
  });

  it('order matters: the first matching rule wins even when a later one would also match', () => {
    const rules = parseRepoMap('label:mobile=owner/frontend,component:api=owner/backend');
    expect(routeRepo(rules, { ...NO_MATCH, labels: ['mobile'], components: ['api'] })).toBe('owner/frontend');
  });

  it('names match case-insensitively for labels, components, types and keys', () => {
    const rules = parseRepoMap('label:Mobile=owner/frontend,component:API=owner/backend,'
      + 'type:Bug=owner/backend2,key:abc=owner/tools');
    expect(routeRepo(rules, { ...NO_MATCH, labels: ['MOBILE'] })).toBe('owner/frontend');
    expect(routeRepo(rules, { ...NO_MATCH, components: ['ApI'] })).toBe('owner/backend');
    expect(routeRepo(rules, { ...NO_MATCH, issuetype: 'bug' })).toBe('owner/backend2');
    expect(routeRepo(rules, { ...NO_MATCH, ticket: 'ABC-1' })).toBe('owner/tools');
  });
});
