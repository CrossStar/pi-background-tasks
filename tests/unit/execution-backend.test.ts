import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTaskRegistry, type BackgroundTaskContext } from '../../src/core/registry.js';
import type { BackgroundExecutionProvider } from '../../src/core/execution-backend.js';

class RemoteChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 987654;
  kills: (NodeJS.Signals | undefined)[] = [];
  disposals = 0;
  kill(signal?: NodeJS.Signals) { this.kills.push(signal); return true; }
  dispose() { this.disposals++; }
}

async function harness(resolveExecution: () => BackgroundExecutionProvider | undefined) {
  const cwd = await mkdtemp(join(tmpdir(), 'bg-native-test-'));
  let localSpawns = 0;
  let localKills = 0;
  let terminals = 0;
  const localChild = new RemoteChild();
  const registry = new BackgroundTaskRegistry({
    resolveExecution,
    sendCompletionNotification: () => {},
    spawn: () => { localSpawns++; return localChild; },
    killProcess: () => { localKills++; return true; },
    killGraceMs: 5,
    stopWaitMs: 500,
    publishTerminal: () => { terminals++; },
  });
  const ctx: BackgroundTaskContext = { cwd, sessionId: 'native-test', modelRegistry: { getAll: () => [] }, model: undefined };
  return { registry, ctx, localChild, publishTerminal: () => { terminals++; }, counts: () => ({ localSpawns, localKills, terminals }), cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

async function settled() {
  // Finalization includes output stream flush and durable metadata writes.
  await new Promise(resolve => setTimeout(resolve, 80));
}

it('native backend snapshots provider before async admission and pins tasks across host rebinding', async () => {
  const first = new RemoteChild();
  const second = new RemoteChild();
  const calls: string[] = [];
  let provider: BackgroundExecutionProvider = { id: 'remote-one', cwd: '/remote/one', spawn: command => { calls.push(command); return first; } };
  const h = await harness(() => provider);
  try {
    const pending = h.registry.startTask(h.ctx, 'remote-command');
    provider = { id: 'remote-two', cwd: '/remote/two', spawn: () => second };
    const task = await pending;
    assert.deepEqual(calls, ['remote-command']);
    assert.equal(task.execution?.cwd, '/remote/one');
    h.registry.rebindHost({ resolveExecution: () => provider, sendCompletionNotification: () => {}, onChange: () => {}, publishTerminal: h.publishTerminal });
    const next = await h.registry.startTask(h.ctx, 'next-command');
    assert.equal(next.execution?.cwd, '/remote/two');
    const stop = h.registry.stopTask(task, 'user');
    first.emit('close', null, 'SIGTERM');
    await stop;
    assert.equal(first.kills.length, 1);
    assert.equal(second.kills.length, 0);
    second.emit('close', 0, null);
    await settled();
    assert.deepEqual(h.counts(), { localSpawns: 0, localKills: 0, terminals: 2 });
    assert.equal(first.disposals, 1);
    assert.equal(second.disposals, 1);
  } finally { await h.cleanup(); }
});

it('native transport error followed by close publishes unknown exactly once, including after cancellation', async () => {
  for (const cancel of [false, true]) {
    const child = new RemoteChild();
    const h = await harness(() => ({ spawn: () => child }));
    try {
      const task = await h.registry.startTask(h.ctx, 'remote-command');
      const stop = cancel ? h.registry.stopTask(task, 'user') : undefined;
      child.emit('error', new Error('SSH transport lost'));
      child.emit('close', 255, null);
      if (stop) await assert.rejects(stop, /unknown/i);
      await settled();
      assert.equal(task.status, 'failed');
      assert.match(task.error ?? '', /remote outcome unknown/i);
      assert.deepEqual(h.counts(), { localSpawns: 0, localKills: 0, terminals: 1 });
      assert.equal(child.disposals, 1);
    } finally { await h.cleanup(); }
  }
});

it('native discovery failure cannot silently fall back to local spawn', async () => {
  const h = await harness(() => { throw new Error('discovery failed'); });
  try {
    await assert.rejects(h.registry.startTask(h.ctx, 'must-not-run'), /discovery failed/);
    assert.equal(h.counts().localSpawns, 0);
  } finally { await h.cleanup(); }
});

it('native spawn failure cannot silently fall back to local spawn', async () => {
  const h = await harness(() => ({ spawn: () => { throw new Error('remote spawn failed'); } }));
  try {
    await assert.rejects(h.registry.startTask(h.ctx, 'must-not-run'), /remote spawn failed/);
    await settled();
    assert.equal(h.counts().localSpawns, 0);
  } finally { await h.cleanup(); }
});

it('native provider rejects agent launches before spawning', async () => {
  let remoteSpawns = 0;
  const h = await harness(() => ({ spawn: () => { remoteSpawns++; return new RemoteChild(); } }));
  try {
    await assert.rejects(h.registry.startTask(h.ctx, 'pi -p test', { isAgent: true }), /agent|remote|external/i);
    await assert.rejects(h.registry.startAttestedPiTask(h.ctx, {
      name: 'rejected remote attestation', provider: 'openai-codex', model: 'test',
      prompt: 'test', reportPath: 'report.md',
    }), /local|remote|external/i);
    assert.equal(remoteSpawns, 0);
    assert.equal(h.counts().localSpawns, 0);
  } finally { await h.cleanup(); }
});

it('unclaimed discovery retains local execution and captures cwd before admission', async () => {
  const h = await harness(() => undefined);
  const cwd = h.ctx.cwd;
  try {
    const pending = h.registry.startTask(h.ctx, 'local-command');
    h.ctx.cwd = '/changed-after-admission';
    const task = await pending;
    assert.equal(task.execution?.kind, 'local');
    assert.equal(task.execution?.cwd, cwd);
    assert.equal(h.counts().localSpawns, 1);
    h.localChild.emit('close', 0, null);
    await settled();
  } finally { h.ctx.cwd = cwd; await h.cleanup(); }
});

it('native malformed provider is rejected without local fallback', async () => {
  const provider: BackgroundExecutionProvider = { spawn: () => new RemoteChild() };
  Object.defineProperty(provider, 'spawn', { value: undefined });
  const h = await harness(() => provider);
  try {
    await assert.rejects(h.registry.startTask(h.ctx, 'must-not-run'), /provider|spawn/i);
    assert.equal(h.counts().localSpawns, 0);
  } finally { await h.cleanup(); }
});

it('native timeout during connecting uses only provider cancellation and disposes once', async () => {
  const child = new RemoteChild();
  const h = await harness(() => ({ spawn: () => child }));
  try {
    const task = await h.registry.startTask(h.ctx, 'connecting-command', { timeoutSeconds: 1 });
    // No spawn/ready event: the provider is still connecting when timeout fires.
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.ok(child.kills.length > 0);
    child.emit('close', null, 'SIGTERM');
    await settled();
    assert.equal(task.status, 'failed');
    assert.match(task.error ?? '', /timed out/i);
    assert.equal(child.disposals, 1);
    assert.equal(h.counts().localKills, 0);
    assert.equal(h.counts().localSpawns, 0);
  } finally { await h.cleanup(); }
});

it('unknown transport outcome bounds a hanging optional dispose and calls it once', async () => {
  const child = new RemoteChild();
  child.dispose = () => { child.disposals++; return new Promise<void>(() => {}); };
  const h = await harness(() => ({ spawn: () => child }));
  try {
    const task = await h.registry.startTask(h.ctx, 'remote-command');
    child.emit('error', new Error('transport disconnected'));
    child.emit('close', 255, null);
    await new Promise(resolve => setTimeout(resolve, 1250));
    assert.equal(task.status, 'failed');
    assert.match(task.error ?? '', /remote outcome unknown/i);
    assert.equal(h.counts().terminals, 1);
    assert.equal(child.disposals, 1);
  } finally { await h.cleanup(); }
});

it('external signal exit without cancellation is failure, not success', async () => {
  const child = new RemoteChild();
  const h = await harness(() => ({ spawn: () => child }));
  try {
    const task = await h.registry.startTask(h.ctx, 'remote-command');
    child.emit('close', null, 'SIGKILL');
    await settled();
    assert.equal(task.status, 'failed');
    assert.match(task.error ?? '', /SIGKILL/);
    assert.equal(child.disposals, 1);
  } finally { await h.cleanup(); }
});

it('legacy provider child without dispose completes normally', async () => {
  const child = new EventEmitter();
  const legacy = Object.assign(child, {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true,
  });
  const h = await harness(() => ({ spawn: () => legacy }));
  try {
    const task = await h.registry.startTask(h.ctx, 'legacy-command');
    child.emit('close', 0, null);
    await settled();
    assert.equal(task.status, 'completed');
    assert.equal(h.counts().terminals, 1);
    assert.equal(h.counts().localSpawns, 0);
  } finally { await h.cleanup(); }
});
