import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { persistentRuntimeBundle } from '../../src/core/persistent-runtime.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTaskRegistry } from '../../src/core/registry.ts';
import { captureRemote } from '../../src/core/remote-persistent.ts';
import type { TaskRecord } from '../../src/persistent/client.ts';

test('runtime bundle digest matches immutable asset bytes', () => {
  const first = persistentRuntimeBundle();
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(first.files).sort(([a], [b]) => a.localeCompare(b))));
  assert.equal(first.sha256, createHash('sha256').update(canonical).digest('hex'));
  assert.equal(first.protocol, 1);
  assert.deepEqual(Object.keys(first.files).sort(), ['daemon.mjs', 'remote-bridge.mjs', 'shared.mjs', 'supervisor.mjs', 'windows-tree.mjs']);
  first.files['daemon.mjs'] = 'mutated by consumer';
  assert.notEqual(persistentRuntimeBundle().files['daemon.mjs'], 'mutated by consumer');
});

test('remote cache resumes interrupted chunks without duplicates and pins methods', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bg-remote-'));
  try {
    const bytes = Buffer.alloc(70000, 97);
    let interrupt = true;
    const offsets: number[] = [];
    const record: TaskRecord = { ownerSession: 'session-A', id: 'remote1', cwd: '/remote', name: 'task', command: 'cmd', status: 'completed', startedAt: 1, outputFile: '/DO-NOT-READ', outputBytes: bytes.length };
    const provider = { id: 'endpoint', cwd: '/remote', spawn() { throw new Error('no fallback'); }, persistent: {
      async start() { return record; }, async get() { return record; }, async cancel() { return record; }, async list() { return Object.assign([], { diagnostics: [] }); },
      async logs(_id: string, offset: number, count: number) {
        assert.ok(count <= 49152);
        offsets.push(offset);
        if (offset > 0 && interrupt) { interrupt = false; throw new Error('disconnect'); }
        const data = bytes.subarray(offset, offset + count);
        return { data: data.toString('base64'), nextOffset: offset + data.length, size: bytes.length, eof: offset + data.length === bytes.length };
      },
    } };
    const client = captureRemote(provider, cwd, 100000, 'session-A')!;
    provider.persistent.get = async () => { throw new Error('retargeted'); };
    await assert.rejects(client.get('remote1'), /disconnect/);
    const result = await client.get('remote1');
    assert.deepEqual(offsets, [0, 49152, 49152]);
    assert.deepEqual(await readFile(result.outputFile), bytes);
    assert.ok(result.outputFile.startsWith(cwd));
    await assert.rejects(client.get('wrong'), /ID mismatch/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('registry publishes only cached terminal output and restoration is monitoring-only', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bg-registry-'));
  let cancelled = 0;
  let notifications = 0;
  let published = '';
  const record: TaskRecord = { ownerSession: 'session-A', id: 'remote2', cwd: '/remote', name: 'task', command: 'cmd', status: 'completed', startedAt: 1, outputFile: '/remote/output', outputBytes: 4 };
  const provider = { id: 'endpoint', cwd: '/remote', spawn() { throw new Error('fallback'); }, persistent: {
    async start() { return record; }, async get() { return record; }, async cancel() { cancelled++; return record; },
    async list() { const { ownerSession: _owner, ...legacy } = record; return Object.assign([record, { ...legacy, id: 'legacy' }, { ...record, id: 'foreign', ownerSession: 'session-B' }], { diagnostics: [] }); },
    async logs() { return { data: Buffer.from('done').toString('base64'), nextOffset: 4, size: 4, eof: true }; },
  } };
  const ctx = { sessionId: 'session-A', cwd, modelRegistry: { getAll: () => [] } };
  let publicationDone: () => void = () => {};
  const publication = new Promise<void>(resolve => { publicationDone = resolve; });
  const registry = new BackgroundTaskRegistry({ makeTaskId: () => 'remote2', resolveExecution: () => provider,
    sendCompletionNotification: () => { notifications++; publicationDone(); }, publishTerminal: task => { published = task.outputPath; } });
  const restored = new BackgroundTaskRegistry({ resolveExecution: () => provider, sendCompletionNotification: () => { notifications++; } });
  try {
    const task = await registry.startTask(ctx, 'cmd');
    await publication;
    assert.equal(task.status, 'completed');
    assert.equal(await readFile(published, 'utf8'), 'done');
    assert.equal(notifications, 1);
    registry.setShuttingDown(true);
    await restored.restoreRemoteTasks(ctx);
    assert.deepEqual(restored.allTasks().map(task => task.id), ['remote2']);
    assert.equal(restored.allTasks()[0]?.status, 'completed');
    assert.equal(notifications, 1);
    assert.equal(cancelled, 0);
    const isolated = new BackgroundTaskRegistry({ resolveExecution: () => provider, sendCompletionNotification: () => {} });
    try {
      await isolated.restoreRemoteTasks({ ...ctx, sessionId: 'session-B' });
      assert.deepEqual(isolated.allTasks().map(task => task.id), ['foreign']);
      assert.throws(() => isolated.resolveTask(task.id), /Unknown/);
      await assert.rejects(isolated.stopTask(task, 'user'), /owner mismatch/);
      await assert.rejects(restored.restoreRemoteTasks({ ...ctx, sessionId: 'session-B' }), /session mismatch/);
    } finally { isolated.setShuttingDown(true); }
  } finally {
    registry.setShuttingDown(true); restored.setShuttingDown(true);
    await rm(cwd, { recursive: true, force: true });
  }
});
