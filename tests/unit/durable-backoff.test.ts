import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundTaskRegistry } from '../../src/core/registry.ts';
import * as durable from '../../src/persistent/client.ts';

test('persistent polling backs off independently, deduplicates, recovers, and ignores stale failures', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const logs: unknown[][] = [];
  let changes = 0;
  const registry = new BackgroundTaskRegistry({ sendCompletionNotification: () => {}, now: () => now, logger: { error: (...args: unknown[]) => { logs.push(args); } }, onChange: () => { changes++; } });
  const client: ReturnType<typeof durable.createClient> = Reflect.get(registry, 'durableClient');
  const record = (id: string): durable.TaskRecord => ({ ownerSession: 'first', id, name: id, command: 'true', cwd: '/tmp', status: 'running', startedAt: 0, outputFile: '/tmp/output' });
  client.list = async () => Object.assign([record('bad'), record('healthy')], { diagnostics: [] });
  let badCalls = 0;
  let healthyCalls = 0;
  let error = new Error('offline\n    at secret stack');
  let recover = false;
  client.get = async id => {
    if (id === 'healthy') { healthyCalls++; return record(id); }
    badCalls++;
    if (!recover) throw error;
    return record(id);
  };
  const tick = async (time: number) => {
    now = time;
    t.mock.timers.tick(1000);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    await registry.restoreDurableTasks({ cwd: '/tmp', sessionId: 'first', modelRegistry: { getAll: () => [] } });
    const task = registry.resolveTask('bad');
    for (const time of [1000, 3000, 7000, 15000, 31000, 61000]) await tick(time);
    assert.equal(badCalls, 6);
    assert.equal(logs.length, 1);
    assert.equal(task.error, 'Persistent task unavailable: offline\n    at secret stack');
    assert.equal(logs[0]?.length, 1);
    assert.doesNotMatch(String(logs[0]?.[0]), /stack|\n/);
    await tick(62000);
    assert.equal(badCalls, 6);
    assert.equal(healthyCalls, 7);
    error = new Error('changed ' + 'x'.repeat(1000));
    await tick(91000);
    assert.equal(logs.length, 2);
    assert.ok(String(logs[1]?.[0]).length < 420);
    await tick(93000);
    assert.equal(badCalls, 7);
    recover = true;
    await tick(121000);
    assert.equal(task.error, undefined);
    recover = false;
    await tick(122000);
    assert.equal(logs.length, 3);
    await tick(123000);
    assert.equal(badCalls, 9);
    await tick(124000);
    assert.equal(badCalls, 10);
    assert.equal(task.status, 'running');
    let rejectPending: (error: Error) => void = () => { throw new Error('No pending request'); };
    client.get = id => id === 'healthy' ? Promise.resolve(record(id)) : new Promise((_resolve, reject) => { rejectPending = reject; });
    await tick(128000);
    registry.setShuttingDown(true);
    const before = changes;
    const previousError = task.error;
    rejectPending(new Error('late failure'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(changes, before);
    assert.equal(task.error, previousError);
    assert.equal(logs.length, 3);
  } finally { registry.setShuttingDown(true); registry.detachHost(); }
});
