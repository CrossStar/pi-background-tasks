import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTaskRegistry } from '../../src/core/registry.ts';
import type { TaskRecord } from '../../src/persistent/client.ts';

test('forget is local, preserves logs and excludes delayed discovery and fresh registries by identity', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forget-'));
  let calls = 0;
  let release: (() => void) | undefined;
  let delayed = false;
  const record: TaskRecord = { slurm: {jobId: '42'}, ownerSession: 's', id: 'task1', cwd: '/remote', name: 'task', command: 'cmd', status: 'running', startedAt: 42, outputFile: '/remote/out', outputBytes: 4 };
  const provider = { id: 'ssh', cwd: '/remote', spawn() { throw Error('spawn'); }, persistent: {
    async start() { calls++; return record; }, async get() { calls++; return record; }, async cancel() { calls++; throw Error('cancel'); },
    async list() { calls++; if (delayed) await new Promise<void>(r => { release = r; }); return Object.assign([{ ...record }], { diagnostics: [] }); },
    async logs() { calls++; return { data: Buffer.from('logs').toString('base64'), nextOffset: 4, size: 4, eof: true }; },
  } };
  const ctx = { cwd, sessionId: 's', modelRegistry: { getAll: () => [] } };
  const make = () => new BackgroundTaskRegistry({ resolveExecution: () => provider, sendCompletionNotification() { throw Error('notification'); } });
  const registry = make();
  const fresh = make();
  try {
    await registry.restoreRemoteTasks(ctx);
    const task = registry.allTasks()[0]!;
    delayed = true;
    const pending = registry.restoreRemoteTasks(ctx);
    const before = calls;
    await assert.rejects(registry.forgetTask(ctx, 'task'), /Exact/);
    await registry.forgetTask(ctx, task.id);
    assert.equal(calls, before);
    assert.equal(task.status, 'running');
    assert.equal(await readFile(task.outputAbsPath, 'utf8'), 'logs');
    release!(); await pending;
    assert.equal(registry.allTasks().length, 0);
    delayed = false;
    await fresh.restoreRemoteTasks(ctx);
    assert.equal(fresh.allTasks().length, 0);
    for (const variation of ['endpoint', 'owner', 'cwd'] as const) {
      const isolatedRecord = { ...record,
        ...(variation === 'owner' ? { ownerSession: 'other-owner' } : {}),
        ...(variation === 'cwd' ? { cwd: '/other-remote' } : {}),
      };
      const isolatedProvider = { ...provider,
        id: variation === 'endpoint' ? 'other-endpoint' : provider.id,
        cwd: isolatedRecord.cwd,
        persistent: { ...provider.persistent,
          async list() { return Object.assign([isolatedRecord], { diagnostics: [] }); },
          async get() { return isolatedRecord; },
        },
      };
      const isolated = new BackgroundTaskRegistry({ resolveExecution: () => isolatedProvider, sendCompletionNotification() {} });
      try {
        await isolated.restoreRemoteTasks({ ...ctx, sessionId: variation === 'owner' ? 'other-owner' : ctx.sessionId });
        assert.equal(isolated.allTasks().length, 1, variation);
        await isolated.allTasks()[0]?.metadataWriteChain;
      } finally { isolated.detachHost(); }
    }
    record.startedAt++;
    await fresh.restoreRemoteTasks(ctx);
    assert.equal(fresh.allTasks().length, 1);
  } finally { registry.detachHost(); fresh.detachHost(); await rm(cwd, { recursive: true, force: true }); }
});
