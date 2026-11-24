import { createHash } from 'node:crypto';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { replaceFileDurable } from './durable-fs.ts';

const EXCLUSIONS = Symbol.for('pi-background-tasks.monitor-exclusions.v1');
const exclusionProcess = process as NodeJS.Process & { [EXCLUSIONS]?: Set<string> };
const remembered = exclusionProcess[EXCLUSIONS] ??= new Set<string>();

export async function ensureSafeCacheDir(localCwd: string, root: string): Promise<void> {
  for (const directory of [join(localCwd, '.pi'), join(localCwd, '.pi', 'tasks'), join(localCwd, '.pi', 'tasks', 'remote'), root]) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(directory)).isDirectory()) throw new Error('Unsafe remote cache directory');
  }
}

export function monitorExclusion(root: string, localCwd: string, owner: string, executionId: string, cwd: string, id: string, startedAt: number) {
  const identity = JSON.stringify([1, resolve(localCwd), owner, executionId, cwd, id, startedAt]);
  const path = join(root, `forgotten-${createHash('sha256').update(identity).digest('hex')}.json`);
  return {
    isRemembered(): boolean { return remembered.has(identity); },
    async has(): Promise<boolean> {
      if (remembered.has(identity)) return true;
      try {
        for (const directory of [join(localCwd, '.pi'), join(localCwd, '.pi', 'tasks'), join(localCwd, '.pi', 'tasks', 'remote'), root]) {
          if (!(await lstat(directory)).isDirectory()) throw new Error('Unsafe remote cache directory');
        }
        if (!(await lstat(path)).isFile()) return remembered.has(identity);
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        return remembered.has(identity) || JSON.stringify(value) === identity;
      }
      catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return remembered.has(identity); throw error; }
    },
    async persist(): Promise<void> {
      await ensureSafeCacheDir(localCwd, root);
      await replaceFileDurable(path, identity);
      remembered.add(identity);
    },
  };
}
