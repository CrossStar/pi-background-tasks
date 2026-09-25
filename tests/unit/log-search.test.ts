import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchLog } from '../../src/ui/log-search.js';

void describe('bounded full-log search', () => {
  void it('finds UTF-8 matches across chunk boundaries in both directions beyond the tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bg-search-'));
    try {
      const path = join(root, 'log');
      const needle = '出错 marker';
      const prefix = 'x'.repeat(65534);
      const content = prefix + needle + '\n' + 'y'.repeat(200000) + needle;
      await writeFile(path, content);
      const signal = new AbortController().signal;
      const first = await searchLog(path, needle, 0, 1, signal);
      assert.equal(first?.offset, 65534);
      assert.ok(first?.content.startsWith(needle));
      const second = await searchLog(path, needle, 65535, 1, signal);
      assert.equal(second?.offset, Buffer.byteLength(prefix + needle + '\n' + 'y'.repeat(200000)));
      const previous = await searchLog(path, needle, second?.offset ?? 0, -1, signal);
      assert.equal(previous?.offset, first?.offset);
      assert.equal(await searchLog(path, 'absent', 0, 1, signal), undefined);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(searchLog(path, needle, 0, 1, controller.signal), /abort/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
