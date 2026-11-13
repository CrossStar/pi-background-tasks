import '../helpers/isolated-service.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTaskRegistry, type CompletionDeliveryState } from '../../src/core/registry.ts';
import type { TaskRecord, createClient } from '../../src/persistent/client.ts';

test('recovery honors disabled preferences and excludes foreign or unowned records', async () => {
  let sends = 0;
  const registry = new BackgroundTaskRegistry({ sendCompletionNotification: () => { sends++; }, getCompletionDeliveryState: () => 'delivered' });
  const client: ReturnType<typeof createClient> = Reflect.get(registry, 'durableClient');
  const record = (id: string): TaskRecord => ({ id, ownerSession: 'owner', cwd: '/tmp', name: id, command: 'never replay', status: 'failed', exitCode: 1, startedAt: 1, outputFile: `/tmp/${id}/output.log` });
  const unowned = record('unowned');
  delete unowned.ownerSession;
  client.list = async () => Object.assign([
    { ...record('disabled'), notifyOnCompletion: false, triggerOnCompletion: true },
    record('missing-flags'),
    { ...record('already-recorded'), notifyOnCompletion: true, triggerOnCompletion: true },
    { ...record('foreign'), ownerSession: 'another', notifyOnCompletion: true },
    unowned,
  ], { diagnostics: [] });
  try {
    await registry.restoreDurableTasks({ cwd: '/tmp', sessionId: 'owner', modelRegistry: { getAll: () => [] } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sends, 0);
    assert.deepEqual(registry.allTasks().map(task => task.id), ['disabled', 'missing-flags', 'already-recorded']);
    assert.equal(registry.resolveTask('disabled').notifyOnCompletion, false);
    assert.equal(registry.resolveTask('missing-flags').notifyOnCompletion, false);
    assert.equal(registry.resolveTask('already-recorded').notified, true);
  } finally { registry.setShuttingDown(true); registry.detachHost(); }
});


test('restored terminal delivery waits for receipts, retries with backoff and survives detach', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bg-receipt-'));
  let now = 10000;
  let state: CompletionDeliveryState = 'pending';
  let sends = 0;
  let throws = false;
  const errors: unknown[] = [];
  const record: TaskRecord = { ownerSession: 'owner', id: 'receipt', cwd: '/remote', name: 'task', command: 'never replay', status: 'completed', startedAt: 1, outputFile: '/remote/output', outputBytes: 0, notifyOnCompletion: true, triggerOnCompletion: true };
  const provider = { id: 'endpoint', cwd: '/remote', spawn() { throw new Error('replay'); }, persistent: {
    async start() { throw new Error('replay'); }, async get() { return record; }, async cancel() { throw new Error('cancel'); },
    async list() { return Object.assign([record], { diagnostics: [] }); },
    async logs() { return { data: '', nextOffset: 0, size: 0, eof: true }; },
  } };
  const bindings = { resolveExecution: () => provider, getCompletionDeliveryState: () => state,
    sendCompletionNotification: () => { sends++; registry.rebindHost(bindings); if (throws) throw new Error('sender failed'); } };
  const registry = new BackgroundTaskRegistry({ ...bindings, now: () => now, maxRecentTasks: 0, logger: { error: (...args) => errors.push(args) } });
  try {
    await registry.restoreRemoteTasks({ cwd, sessionId: 'owner', modelRegistry: { getAll: () => [] } });
    await new Promise(resolve => setTimeout(resolve, 30));
    const task = registry.resolveTask('receipt');
    assert.equal(sends, 0);
    state = 'ready';
    registry.rebindHost(bindings);
    assert.equal(sends, 1);
    assert.equal(task.notified, false);
    registry.rebindHost(bindings);
    assert.equal(sends, 1);
    now += 2000;
    throws = true;
    registry.rebindHost(bindings);
    assert.equal(sends, 2);
    assert.equal(task.notified, false);
    registry.detachHost();
    now += 4000;
    throws = false;
    registry.rebindHost(bindings);
    assert.equal(sends, 3);
    assert.equal(registry.resolveTask('receipt'), task);
    state = 'delivered';
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(task.notified, true);
    assert.equal(sends, 3);
    assert.equal(errors.length, 1);
  } finally { registry.setShuttingDown(true); registry.detachHost(); await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
