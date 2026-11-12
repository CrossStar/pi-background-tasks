import '../helpers/isolated-service.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTaskRegistry } from '../../src/core/registry.ts';

test('local command survives registry shutdown and restores without delivery', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bg-registry-reconnect-'));
  const ctx = { cwd, sessionId: 'first', modelRegistry: { getAll: () => [] } };
  let notifications = 0;
  let publications = 0;
  const options = { sendCompletionNotification: () => { notifications++; },
    publishTerminal: () => { publications++; } };
  const first = new BackgroundTaskRegistry(options);
  const task = await first.startTask(ctx, 'sleep 1; printf survived', { name: 'Reconnect test' });
  first.setShuttingDown(true);
  await first.stopTask(task, 'shutdown');
  first.detachHost();
  const second = new BackgroundTaskRegistry(options);
  try {
    await second.restoreDurableTasks({ ...ctx, sessionId: 'second' });
    const restored = second.resolveTask(task.id);
    assert.equal(restored.outputAbsPath, task.outputAbsPath);
    const deadline = Date.now() + 10000;
    while (restored.status === 'running' && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(restored.status, 'completed');
    assert.equal(await readFile(restored.outputAbsPath, 'utf8'), 'survived');
    second.rebindHost(options);
    assert.equal(restored.notified, false);
    assert.equal(notifications, 0);
    assert.equal(publications, 0);
  } finally { second.setShuttingDown(true); second.detachHost(); }
});
