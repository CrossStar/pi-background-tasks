import '../helpers/isolated-service.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('two Node processes reconnect without replaying the command', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bg-two-process-'));
  const registryUrl = pathToFileURL(resolve('src/core/registry.ts')).href;
  const script = join(cwd, 'client.mjs');
  await writeFile(script, `
import { BackgroundTaskRegistry } from ${JSON.stringify(registryUrl)};
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const registry = new BackgroundTaskRegistry({ sendCompletionNotification() { throw Error('Unexpected notification'); } });
const ctx = { cwd: process.cwd(), sessionId: process.argv[2] === 'foreign' ? 'other-owner' : 'stable-owner', modelRegistry: { getAll: () => [] } };
if (process.argv[2] === 'A') {
  const source = "require('fs').appendFileSync('counter', 'launch\\n'); console.log('ready'); setInterval(() => {}, 1000)";
  const task = await registry.startTask(ctx, 'node -e ' + JSON.stringify(source), { name: 'Across processes', notifyOnCompletion: false });
  writeFileSync('id', task.id);
  writeFileSync('pidA', String(process.pid));
} else if (process.argv[2] === 'foreign') {
  await registry.restoreDurableTasks(ctx);
  if (registry.allTasks().length) throw Error('Imported foreign task');
  let rejected = false;
  try { registry.resolveTask(readFileSync('id', 'utf8')); } catch { rejected = true; }
  if (!rejected) throw Error('Resolved foreign task');
} else {
  await registry.restoreDurableTasks(ctx);
  const task = registry.resolveTask(readFileSync('id', 'utf8'));
  if (task.status !== 'running') throw Error('Task did not survive');
  if (String(process.pid) === readFileSync('pidA', 'utf8')) throw Error('Expected distinct processes');
  await registry.stopTask(task, 'user');
  if (task.status !== 'killed') throw Error('Cancellation not verified');
  if (!readFileSync(task.outputAbsPath, 'utf8').includes('ready')) throw Error('Output missing');
}
registry.setShuttingDown(true);
registry.detachHost();
`);
  const env = { ...process.env };
  for (const phase of ['A', 'foreign', 'B']) {
    if (phase === 'B') await new Promise(resolve => setTimeout(resolve, 300));
    const result = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), script, phase], {
      cwd, env, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(await readFile(join(cwd, 'counter'), 'utf8'), 'launch\n');
});
