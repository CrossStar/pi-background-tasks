import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { monitorExclusion } from '../../src/core/monitor-exclusion.ts';

test('exclusion validates content and every identity component', async () => {
  const local = await mkdtemp(join(tmpdir(), 'exclusion-'));
  const root = join(local, '.pi/tasks/remote/cache');
  try {
    const marker = monitorExclusion(root, local, 'owner', 'ssh', '/remote', 'task', 1);
    await marker.persist();
    assert.equal(await marker.has(), true);
    for (const args of [
      [local, 'other', 'ssh', '/remote', 'task', 1],
      [local, 'owner', 'other', '/remote', 'task', 1],
      [local, 'owner', 'ssh', '/other', 'task', 1],
      [local, 'owner', 'ssh', '/remote', 'other', 1],
      [local, 'owner', 'ssh', '/remote', 'task', 2],
    ] as const) assert.equal(await monitorExclusion(root, args[0], args[1], args[2], args[3], args[4], args[5]).has(), false);
    // Simulate a fresh process so disk-validation cases do not use the
    // successful forget remembered by this process.
    const remembered: unknown = Reflect.get(process, Symbol.for('pi-background-tasks.monitor-exclusions.v1'));
    assert.ok(remembered instanceof Set);
    remembered.delete(JSON.stringify([1, local, 'owner', 'ssh', '/remote', 'task', 1]));
    const path = join(root, (await readdir(root))[0]!);
    await writeFile(path, JSON.stringify([1, local, 'other-owner', 'ssh', '/remote', 'task', 1]));
    assert.equal(await marker.has(), false);
    await writeFile(path, '{broken');
    assert.equal(await marker.has(), false);
    await writeFile(path, '{}');
    assert.equal(await marker.has(), false);
    await rm(path);
    assert.equal(await marker.has(), false);
  } finally { await rm(local, { recursive: true, force: true }); }
});

test('exclusion refuses symlink cache ancestors', async () => {
  const local = await mkdtemp(join(tmpdir(), 'exclusion-link-'));
  try {
    const target = join(local, 'target');
    await mkdir(target);
    await symlink(target, join(local, '.pi'));
    const marker = monitorExclusion(join(local, '.pi/tasks/remote/cache'), local, 'owner', 'ssh', '/remote', 'task', 1);
    await assert.rejects(marker.persist(), /Unsafe remote cache directory/);
    assert.equal(marker.isRemembered(), false);
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(local, { recursive: true, force: true }); }
});
