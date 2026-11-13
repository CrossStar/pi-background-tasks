import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTaskRegistry } from '../../src/core/registry.ts';

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'bg-review-'));
  let delivered = 0;
  const registry = new BackgroundTaskRegistry({ sendCompletionNotification: () => { delivered++; } });
  const client = Reflect.get(registry, 'durableClient');
  const record = { ownerSession: 'first', id: '', name: 'test', command: 'true', cwd, status: 'running', startedAt: Date.now(), outputFile: join(cwd, 'output.log') };
  client.start = async (request: { id: string }) => { record.id = request.id; return { ...record }; };
  client.get = async () => ({ ...record });
  const ctx = { cwd, sessionId: 'first', modelRegistry: { getAll: () => [] } };
  return { registry, client, record, ctx, delivered: () => delivered };
}

test('restore skips foreign and unknown owners without claiming records', async () => {
  const f = await fixture();
  const records = [
    { ...f.record, id: 'owned' },
    { ...f.record, id: 'foreign', ownerSession: 'second' },
    { ...f.record, id: 'legacy', ownerSession: undefined },
  ];
  f.client.list = async (_cwd: string, owner: string) => {
    assert.equal(owner, 'first');
    return records;
  };
  try {
    await f.registry.restoreDurableTasks(f.ctx);
    assert.deepEqual(f.registry.allTasks().map(task => task.id), ['owned']);
    assert.equal(records.length, 3);
    assert.equal(records[2]?.ownerSession, undefined);
  } finally { f.registry.setShuttingDown(true); }
});

test('lost admission response reconciles the original ID without resubmitting', async () => {
  const f = await fixture();
  let calls = 0;
  f.client.start = async (request: { id: string }) => { calls++; f.record.id = request.id; throw Error('connection closed'); };
  try {
    const task = await f.registry.startTask(f.ctx, 'true');
    assert.equal(task.id, f.record.id);
    assert.equal(f.registry.allTasks().length, 1);
    assert.equal(calls, 1);
  } finally { f.registry.setShuttingDown(true); }
});

test('uncertain admission retains ID and known rejection removes pending view', async () => {
  const f = await fixture();
  f.client.start = async () => { throw Error('connection closed'); };
  f.client.get = async () => { throw Error('unavailable'); };
  try {
    await assert.rejects(f.registry.startTask(f.ctx, 'true'), /Admission uncertain for task/);
    assert.equal(f.registry.allTasks().length, 1);
    f.client.start = async () => { throw Error('Invalid start request'); };
    await assert.rejects(f.registry.startTask(f.ctx, 'true'), /^Error: Invalid start request$/);
    assert.equal(f.registry.allTasks().length, 1);
  } finally { f.registry.setShuttingDown(true); }
});

test('shutdown suppresses a completion already waiting on publication gate', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.record.status = 'completed';
  await f.registry.startTask(f.ctx, 'true', { terminalPublicationGate: gate });
  f.registry.setShuttingDown(true);
  f.registry.setShuttingDown(false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.delivered(), 0);
  f.registry.setShuttingDown(true);
});

test('poll timer is stable across admissions and independent refreshes overlap', async () => {
  const f = await fixture();
  try {
    const first = await f.registry.startTask(f.ctx, 'true');
    const timer = Reflect.get(f.registry, 'durablePoll');
    const second = await f.registry.startTask(f.ctx, 'true');
    assert.equal(Reflect.get(f.registry, 'durablePoll'), timer);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.client.get = async (id: string) => {
      if (id === first.id) await held;
      return { ...f.record, id, status: 'completed' };
    };
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(first.status, 'running');
    assert.equal(second.status, 'completed');
    release();
    await new Promise(resolve => setImmediate(resolve));
  } finally { f.registry.setShuttingDown(true); }
});

test('failed delivery is not retried into a replacement conversation', async () => {
  const f = await fixture();
  let deliveries = 0;
  f.registry.rebindHost({ sendCompletionNotification: () => { throw Error('old host unavailable'); }, publishTerminal: () => { throw Error('old bus unavailable'); } });
  f.record.status = 'completed';
  await f.registry.startTask(f.ctx, 'true');
  await new Promise(resolve => setImmediate(resolve));
  f.registry.setShuttingDown(true);
  f.registry.detachHost();
  f.registry.setShuttingDown(false);
  f.registry.rebindHost({ sendCompletionNotification: () => { deliveries++; }, publishTerminal: () => { deliveries++; } });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(deliveries, 0);
  f.registry.setShuttingDown(true);
  f.registry.detachHost();
});

test('completed cancellation race is not reported as killed', async () => {
  const f = await fixture();
  try {
    const task = await f.registry.startTask(f.ctx, 'true');
    f.client.cancel = async () => ({ ...f.record, status: 'completed' });
    await assert.rejects(f.registry.stopTask(task, 'user'), /Cancellation did not produce/);
    assert.equal(task.status, 'completed');
  } finally { f.registry.setShuttingDown(true); }
});
