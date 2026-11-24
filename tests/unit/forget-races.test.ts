import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, rename, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { BackgroundTaskRegistry, acquireProcessRegistry, releaseProcessRegistry } from '../../src/core/registry.ts';
import { captureRemote } from '../../src/core/remote-persistent.ts';
import type { TaskRecord } from '../../src/persistent/client.ts';
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const record = (id: string): TaskRecord => ({ id, ownerSession: 'owner', cwd: '/remote', name: id, command: 'cmd', status: 'running', startedAt: 1, outputFile: '/remote/out', outputBytes: 0 });

for (const fail of [false, true]) test(`forgotten in-flight poll ${fail ? 'rejection' : 'success'} stays detached and other task advances`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forget-poll-'));
  const request = deferred<TaskRecord>();
  const entered = deferred<void>();
  let polling = false;
  let healthy = 0;
  let changes = 0;
  const provider = { id: 'ssh', cwd: '/remote', spawn() { throw Error('spawn'); }, persistent: {
    async list() { return Object.assign([record('one'), record('two')], { diagnostics: [] }); },
    async get(id: string) { if (polling && id === 'one') { entered.resolve(); return request.promise; } if (polling) healthy++; return record(id); },
    async start() { throw Error('start'); }, async cancel() { throw Error('cancel'); }, async logs() { throw Error('logs'); },
  } };
  const registry = new BackgroundTaskRegistry({ resolveExecution: () => provider, onChange() { changes++; }, sendCompletionNotification() { throw Error('notify'); } });
  const ctx = { cwd, sessionId: 'owner', modelRegistry: { getAll: () => [] } };
  try {
    await registry.restoreRemoteTasks(ctx);
    const task = registry.allTasks().find(t => t.id === 'one')!;
    polling = true;
    const keepAlive = setInterval(() => {}, 100);
    try { await entered.promise; } finally { clearInterval(keepAlive); }
    await registry.forgetTask(ctx, 'one');
    const before = changes;
    if (fail) request.reject(Error('ENOENT')); else request.resolve({ ...record('one'), status: 'completed' });
    await new Promise<void>(r => setImmediate(r));
    assert.equal(registry.allTasks().length, 1);
    assert.equal(task.status, 'running');
    assert.equal(task.error, undefined);
    assert.equal(changes, before);
    assert.ok(healthy > 0);
  } finally { registry.detachHost(); await rm(cwd, { recursive: true, force: true }); }
});

test('persist failure retains monitor; reload replaces old method and forgets offline', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forget-failure-'));
  const ctx = { cwd, sessionId: 'owner', modelRegistry: { getAll: () => [] } };
  let connected = true;
  const provider = { id: 'ssh', cwd: '/remote', spawn() { throw Error('spawn'); }, persistent: {
    async list() { return Object.assign([record('one')], { diagnostics: [] }); }, async get() { return record('one'); },
    async start() { throw Error('start'); }, async cancel() { throw Error('cancel'); }, async logs() { throw Error('logs'); },
  } };
  const registry = acquireProcessRegistry(ctx, new BackgroundTaskRegistry({ resolveExecution: () => connected ? provider : undefined, sendCompletionNotification() {} }));
  try {
    await registry.restoreRemoteTasks(ctx);
    const task = registry.allTasks()[0]!;
    const root = dirname(task.outputAbsPath);
    await task.metadataWriteChain;
    await rename(root, `${root}-saved`);
    await writeFile(root, 'obstruction');
    await assert.rejects(registry.forgetTask(ctx, task.id));
    assert.equal(registry.allTasks()[0], task);
    await rm(root); await rename(`${root}-saved`, root);
    connected = false;
    const old = Object.create(Object.getPrototypeOf(registry)) as object;
    Object.defineProperty(old, 'forgetTask', { value() { throw Error('old flawed method'); } });
    Object.setPrototypeOf(registry, old);
    const migrated = acquireProcessRegistry(ctx, new BackgroundTaskRegistry({ sendCompletionNotification() {} }));
    assert.equal(migrated, registry);
    await migrated.forgetTask(ctx, task.id);
    assert.equal(migrated.allTasks().length, 0);
  } finally { registry.detachHost(); releaseProcessRegistry(ctx, registry); await rm(cwd, { recursive: true, force: true }); }
});

test('legacy monitor forgets offline after remote record and local metadata disappear', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forget-missing-legacy-'));
  const ctx = { cwd, sessionId: 'owner', modelRegistry: { getAll: () => [] } };
  let connected = true;
  let missing = false;
  let calls = 0;
  let current = record('legacy-one');
  const provider = { id: 'ssh', cwd: '/remote', spawn() { throw Error('spawn'); }, persistent: {
    async list() { calls++; return Object.assign([current], { diagnostics: [] }); },
    async get() { calls++; if (missing) throw Object.assign(Error('remote record missing'), { code: 'ENOENT' }); return current; },
    async start() { calls++; throw Error('start'); },
    async cancel() { calls++; throw Error('cancel'); },
    async logs() { calls++; throw Error('logs'); },
  } };
  const make = () => new BackgroundTaskRegistry({ resolveExecution: () => connected ? provider : undefined, sendCompletionNotification() { throw Error('notify'); } });
  const registry = make();
  const fresh = make();
  try {
    await registry.restoreRemoteTasks(ctx);
    const task = registry.allTasks()[0]!;
    await task.metadataWriteChain;
    // Older module instances retained captured clients but had no global confirmation membership.
    const state: unknown = Reflect.get(process, Symbol.for('pi-background-tasks.monitor-state.v2'));
    if (typeof state === 'object' && state !== null) {
      const confirmed: unknown = Reflect.get(state, 'confirmed');
      if (confirmed instanceof WeakSet) confirmed.delete(task);
    }
    await rm(task.metadataAbsPath);
    await writeFile(task.outputAbsPath, 'cached legacy output\n');
    const clients: unknown = Reflect.get(registry, 'taskClients');
    assert.ok(clients instanceof WeakMap);
    missing = true;
    await assert.rejects(clients.get(task).get(task.id), { code: 'ENOENT' });
    assert.equal(registry.allTasks()[0], task);
    connected = false;
    const before = calls;
    await registry.forgetTask(ctx, task.id);
    assert.equal(calls, before, 'offline forget must use only the captured identity');
    assert.equal(registry.allTasks().length, 0);
    assert.equal(task.status, 'running');
    assert.equal(await readFile(task.outputAbsPath, 'utf8'), 'cached legacy output\n');
    connected = true;
    missing = false;
    await fresh.restoreRemoteTasks(ctx);
    assert.equal(fresh.allTasks().length, 0, 'same identity and timestamp remain excluded');
    current = { ...current, startedAt: current.startedAt + 1 };
    await fresh.restoreRemoteTasks(ctx);
    assert.equal(fresh.allTasks().length, 1, 'same ID with another timestamp must restore');
    await fresh.allTasks()[0]!.metadataWriteChain;
  } finally { registry.detachHost(); fresh.detachHost(); await rm(cwd, { recursive: true, force: true }); }
});

test('forget rejects unconfirmed admission without backend calls', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forget-admission-'));
  const response = deferred<TaskRecord>();
  const entered = deferred<void>();
  let gets = 0;
  const provider = { id: 'ssh', cwd: '/remote', spawn() { throw Error('spawn'); }, persistent: {
    async list() { return Object.assign([], { diagnostics: [] }); }, async get() { gets++; return record('one'); },
    async start() { entered.resolve(); return response.promise; }, async cancel() { throw Error('cancel'); }, async logs() { throw Error('logs'); },
  } };
  const registry = new BackgroundTaskRegistry({ makeTaskId: () => 'one', resolveExecution: () => provider, sendCompletionNotification() {} });
  const ctx = { cwd, sessionId: 'owner', modelRegistry: { getAll: () => [] } };
  try {
    const starting = registry.startTask(ctx, 'cmd');
    await entered.promise;
    acquireProcessRegistry(ctx, registry);
    const migrated = acquireProcessRegistry(ctx, new BackgroundTaskRegistry({ sendCompletionNotification() {} }));
    assert.equal(migrated, registry);
    await assert.rejects(migrated.forgetTask(ctx, 'one'), /identity is not confirmed/);
    assert.equal(gets, 0);
    assert.equal(registry.allTasks().length, 1);
    response.resolve(record('one'));
    const task = await starting;
    await task.metadataWriteChain;
    await registry.forgetTask(ctx, 'one');
    assert.equal(gets, 0);
    releaseProcessRegistry(ctx, registry);
  } finally { registry.detachHost(); await rm(cwd, { recursive: true, force: true }); }
});

test('reload rewraps a legacy captured adapter and ignores its delayed response', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forget-legacy-'));
  const response = deferred<TaskRecord>();
  let delay = false;
  let logs = 0;
  const provider = { id: 'ssh', cwd: '/remote', spawn() { throw Error('spawn'); }, persistent: {
    async list() { return Object.assign([record('one')], { diagnostics: [] }); }, async get() { return delay ? response.promise : record('one'); },
    async start() { throw Error('start'); }, async cancel() { throw Error('cancel'); }, async logs() { logs++; throw Error('unexpected logs'); },
  } };
  const ctx = { cwd, sessionId: 'owner', modelRegistry: { getAll: () => [] } };
  const registry = acquireProcessRegistry(ctx, new BackgroundTaskRegistry({ resolveExecution: () => provider, sendCompletionNotification() {} }));
  try {
    await registry.restoreRemoteTasks(ctx);
    const task = registry.allTasks()[0]!;
    await task.metadataWriteChain;
    const legacy = captureRemote(provider, cwd, 100000, 'owner')!;
    const clients: unknown = Reflect.get(registry, 'taskClients');
    assert.ok(clients instanceof WeakMap);
    clients.set(task, legacy);
    delay = true;
    const oldRequest = legacy.get(task.id);
    acquireProcessRegistry(ctx, new BackgroundTaskRegistry({ sendCompletionNotification() {} }));
    const upgraded: unknown = clients.get(task);
    assert.notEqual(upgraded, legacy);
    assert.ok(typeof upgraded === 'object' && upgraded !== null && 'get' in upgraded && typeof upgraded.get === 'function');
    const newRequest: Promise<unknown> = upgraded.get(task.id);
    await registry.forgetTask(ctx, task.id);
    const rejected = assert.rejects(newRequest, /detached/);
    response.resolve(record('one'));
    await oldRequest;
    await rejected;
    assert.equal(registry.allTasks().length, 0);
    assert.equal(logs, 0);
  } finally { registry.detachHost(); releaseProcessRegistry(ctx, registry); await rm(cwd, { recursive: true, force: true }); }
});

test('delayed negative exclusion read cannot restore a concurrently forgotten identity', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forget-read-race-'));
  const entered = deferred<void>();
  const release = deferred<void>();
  let cancelled = 0;
  const provider = { id: 'ssh', cwd: '/remote', spawn() { throw Error('spawn'); }, persistent: {
    async list() { return Object.assign([record('one')], { diagnostics: [] }); }, async get() { return record('one'); },
    async start() { throw Error('start'); }, async cancel() { cancelled++; return record('one'); }, async logs() { throw Error('logs'); },
  } };
  const ctx = { cwd, sessionId: 'owner', modelRegistry: { getAll: () => [] } };
  const registry = new BackgroundTaskRegistry({ resolveExecution: () => provider, sendCompletionNotification() {} });
  try {
    await registry.restoreRemoteTasks(ctx);
    await registry.allTasks()[0]?.metadataWriteChain;
    const original = fs.lstat;
    let intercepted = false;
    const mocked = mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
      if (!intercepted && String(args[0]).startsWith(cwd) && String(args[0]).includes('forgotten-')) {
        intercepted = true;
        // The negative read happened before the forget; delay its delivery.
        let negative: unknown;
        try { await original(...args); } catch (error) { negative = error; }
        entered.resolve();
        await release.promise;
        throw negative;
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const restoring = registry.restoreRemoteTasks(ctx);
      await entered.promise;
      await registry.forgetTask(ctx, 'one');
      release.resolve();
      await restoring;
      assert.equal(registry.allTasks().length, 0);
      assert.equal(cancelled, 0);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  } finally { registry.detachHost(); await rm(cwd, { recursive: true, force: true }); }
});

test('terminal gate cannot publish or notify after forget', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forget-gate-'));
  const gate = deferred<void>();
  let notifications = 0;
  let publications = 0;
  const terminal = { ...record('one'), status: 'completed' as const };
  const provider = { id: 'ssh', cwd: '/remote', spawn() { throw Error('spawn'); }, persistent: {
    async list() { return Object.assign([], { diagnostics: [] }); }, async get() { return terminal; }, async start() { return terminal; }, async cancel() { throw Error('cancel'); }, async logs() { throw Error('logs'); },
  } };
  const registry = new BackgroundTaskRegistry({ makeTaskId: () => 'one', resolveExecution: () => provider, sendCompletionNotification() { notifications++; }, publishTerminal() { publications++; } });
  const ctx = { cwd, sessionId: 'owner', modelRegistry: { getAll: () => [] } };
  try {
    const task = await registry.startTask(ctx, 'cmd', { terminalPublicationGate: gate.promise });
    await task.metadataWriteChain;
    await registry.forgetTask(ctx, task.id);
    gate.resolve();
    await new Promise<void>(r => setImmediate(r));
    assert.equal(notifications, 0); assert.equal(publications, 0);
    assert.equal(task.status, 'completed');
  } finally { registry.detachHost(); await rm(cwd, { recursive: true, force: true }); }
});

test('detaching during a log request discards chunk and stops subsequent remote calls', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forget-chunks-'));
  const response = deferred<{ data: string; nextOffset: number; size: number; eof: boolean }>();
  const entered = deferred<void>();
  let detached = false;
  let calls = 0;
  const remoteRecord = { ...record('one'), outputBytes: 100000 };
  const provider = { id: 'ssh', cwd: '/remote', spawn() { throw Error('spawn'); }, persistent: {
    async list() { return Object.assign([], { diagnostics: [] }); }, async get() { return remoteRecord; }, async start() { return remoteRecord; }, async cancel() { throw Error('cancel'); },
    async logs() { calls++; entered.resolve(); return response.promise; },
  } };
  try {
    const remote = captureRemote(provider, cwd, 200000, 'owner', () => detached)!;
    const pending = remote.get('one');
    await entered.promise;
    detached = true;
    response.resolve({ data: Buffer.alloc(49152).toString('base64'), nextOffset: 49152, size: 100000, eof: false });
    await assert.rejects(pending, /detached/);
    assert.equal(calls, 1);
    assert.equal((await readFile(join(remote.root, 'one.output'))).length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
