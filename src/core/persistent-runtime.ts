import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface PersistentRuntimeBundle { protocol: 2; sha256: string; files: Record<string, string> }
let cached: PersistentRuntimeBundle | undefined;
/** Hash is SHA256 of canonical JSON object containing sorted UTF-8 assets. */
export function persistentRuntimeBundle(): PersistentRuntimeBundle {
  if (!cached) {
    const names = ['daemon.mjs', 'shared.mjs', 'supervisor.mjs', 'windows-tree.mjs', 'remote-bridge.mjs', 'log-sources.mjs', 'slurm-watch.mjs'].sort();
    const entries = names.map(name => {
      try { return [name, readFileSync(new URL(`../persistent/${name}`, import.meta.url), 'utf8')] as const; }
      catch (error) { throw new Error(`Persistent runtime asset unavailable: ${name}`, { cause: error }); }
    });
    cached = { protocol: 2, sha256: createHash('sha256').update(JSON.stringify(Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))))).digest('hex'), files: Object.fromEntries(entries) };
  }
  return { ...cached, files: { ...cached.files } };
}
