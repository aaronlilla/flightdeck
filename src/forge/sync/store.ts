/**
 * R-68 item 4: the last `SyncRunRecord` per scope, `~/.forge/console/sync.json`
 * (`syncStatePath()`). One flat JSON object keyed by scope -- there is only ever one
 * "last run" worth keeping per scope, so this is not an append-only log like every other
 * store in this directory; `GET /sync` and `/sync/:scope` read straight off it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SyncRunRecord, SyncScope } from '../../shared/sync-contract.js';
import { syncStatePath } from '../paths.js';

const ALL_SCOPES: readonly SyncScope[] = ['full', 'queue', 'sessions', 'accounts', 'machine', 'inbox', 'lanes'];

export class SyncStore {
  constructor(private readonly path: string = syncStatePath()) {}

  private readAll(): Partial<Record<SyncScope, SyncRunRecord>> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Record<SyncScope, SyncRunRecord>>;
    } catch {
      return {};
    }
  }

  get(scope: SyncScope): SyncRunRecord | null {
    return this.readAll()[scope] ?? null;
  }

  all(): Record<SyncScope, SyncRunRecord | null> {
    const data = this.readAll();
    const result = {} as Record<SyncScope, SyncRunRecord | null>;
    for (const scope of ALL_SCOPES) result[scope] = data[scope] ?? null;
    return result;
  }

  save(record: SyncRunRecord): void {
    const data = this.readAll();
    data[record.scope] = record;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data), 'utf8');
  }
}
