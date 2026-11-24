import { ensureSafeCacheDir } from './monitor-exclusion.ts';
import { createHash } from 'node:crypto';
import { stat, open, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { BackgroundExecutionProvider, PersistentRemoteExecution } from './execution-backend.ts';
import type { TaskRecord } from '../persistent/client.ts';

/** Capture every method before the first asynchronous admission operation. */
export function captureRemote(provider: BackgroundExecutionProvider, localCwd: string, cap: number, ownerSession: string, detached: (record: TaskRecord) => boolean = () => false) {
  if (!provider.persistent) return undefined;
  const id = provider.id;
  const cwd = provider.cwd;
  if (!id || !cwd || !isAbsolute(cwd)) throw new Error('Persistent provider requires id and absolute cwd');
  const source = provider.persistent;
  for (const method of ['start', 'get', 'list', 'cancel', 'logs'] as const) {
    if (typeof source[method] !== 'function') throw new Error(`Invalid persistent method: ${method}`);
  }
  const api: PersistentRemoteExecution = {
    ...(source.mirrorLogs ? {mirrorLogs: source.mirrorLogs.bind(source)} : {}),
    start: source.start.bind(source), get: source.get.bind(source),
    list: source.list.bind(source), cancel: source.cancel.bind(source), logs: source.logs.bind(source),
  };
  const root = join(localCwd, '.pi', 'tasks', 'remote', createHash('sha256').update(JSON.stringify([id, cwd, ownerSession])).digest('hex'));
  const pending = new Map<string, Promise<TaskRecord>>();
  const windows = new Map<string, {identity: unknown; size: number; blocks: Array<{start: number; bytes: Buffer}>}>();
  let generation = 0;
  const release = (taskId?: string) => { generation++; for (const key of windows.keys()) if (!taskId || key.startsWith(taskId + ':')) windows.delete(key); };
  async function sync(record: TaskRecord): Promise<TaskRecord> {
    const activeGeneration = generation;
    if (detached(record)) throw new Error('Remote monitor detached');
    if (record.ownerSession !== ownerSession) throw new Error('Remote task owner mismatch');
    const outputBytes = record.outputBytes;
    if (!/^[\w-]{1,100}$/.test(record.id) || record.cwd !== cwd ||
        !['running', 'completed', 'failed', 'killed'].includes(record.status) ||
        typeof outputBytes !== 'number' || !Number.isSafeInteger(outputBytes) || outputBytes < 0 ||
        typeof record.name !== 'string' || typeof record.command !== 'string' ||
        typeof record.outputFile !== 'string' || !isAbsolute(record.outputFile) ||
        !Number.isFinite(record.startedAt)) throw new Error('Invalid remote task record');
    for (const value of [record.description, record.ownerSession, record.diagnostic, record.signal ?? undefined]) {
      if (value !== undefined && typeof value !== 'string') throw new Error('Invalid remote string field');
    }
    for (const value of [record.notifyOnCompletion, record.triggerOnCompletion]) {
      if (value !== undefined && typeof value !== 'boolean') throw new Error('Invalid remote flag');
    }
    if ((record.finishedAt !== undefined && !Number.isFinite(record.finishedAt)) ||
        (record.exitCode != null && !Number.isInteger(record.exitCode))) throw new Error('Invalid remote numeric field');
    await ensureSafeCacheDir(localCwd, root);
    const outputFile = join(root, `${record.id}.output`);
    let offset = await stat(outputFile).then(s => s.size, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return 0; throw e; });
    const target = Math.min(cap, outputBytes);
    if (offset > target) throw new Error('Remote output shrank');
    const file = await open(outputFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
    await file.chmod(0o600);
    while (offset < target) {
      if (detached(record)) throw new Error('Remote monitor detached');
      const count = Math.min(49152, target - offset);
      const chunk = await api.logs(record.id, offset, count, ownerSession);
      if (detached(record)) throw new Error('Remote monitor detached');
      const bytes = Buffer.from(chunk.data, 'base64');
      if (bytes.toString('base64') !== chunk.data || !bytes.length || bytes.length > count ||
          chunk.nextOffset !== offset + bytes.length || !Number.isSafeInteger(chunk.size) ||
          chunk.size < chunk.nextOffset || chunk.size < target || chunk.eof !== (chunk.nextOffset === chunk.size)) throw new Error('Invalid remote log response');
      await file.writeFile(bytes);
      offset += bytes.length;
    }
    await file.sync();
    } catch (error) { throw error; } finally { await file.close(); }
    const sources = record.sources ? await Promise.all(record.sources.map(async source => {
      if (!/^[\w.-]{1,100}$/.test(source.id)) throw new Error('Invalid source id');
      if (source.kind === 'digest') return {...source, location: 'remote' as const, mirrorPath: outputFile, cachedAt: Date.now()};
      if (source.pattern) return source;
      try {
      const first = await api.logs(record.id, 0, 1, ownerSession, source.id);
      const size = first.size;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid source size');
      const tailBytes = Number(process.env['PI_BG_SOURCE_TAIL_BYTES'] ?? 4194304);
      const headBytes = Number(process.env['PI_BG_SOURCE_HEAD_BYTES'] ?? 1048576);
      if (![tailBytes, headBytes].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 16777216)) throw new Error('Invalid source mirror limits');
      const tailStart = Math.max(0, size - tailBytes);
      const headEnd = record.status === 'running' ? 0 : Math.min(size, headBytes);
      const ranges = headEnd >= tailStart ? [{start: 0, end: size}] : [...(headEnd ? [{start: 0, end: headEnd}] : []), {start: tailStart, end: size}];
      const key = `${record.id}:${source.id}`;
      let previous = windows.get(key);
      const identity = 'identity' in first ? first.identity : undefined;
      if (identity === undefined || previous?.identity !== identity || previous.size > size) previous = undefined;
      // An anchor detects same-inode truncate/regrow between polls.
      const last = previous?.blocks.at(-1);
      if (last?.bytes.length) {
        const count = Math.min(64, last.bytes.length);
        const at = last.start + last.bytes.length - count;
        const anchor = await api.logs(record.id, at, count, ownerSession, source.id);
        if (!Buffer.from(anchor.data, 'base64').equals(last.bytes.subarray(-count))) previous = undefined;
      }
      const blocks: Array<{start: number; bytes: Buffer}> = [];
      const chunks: Buffer[] = [];
      for (const range of ranges) {
        chunks.push(Buffer.from(`\n[Cached byte range ${range.start}..${range.end} of ${size}]\n`));
        for (let at = range.start; at < range.end;) {
          const cached = previous?.blocks.find(block => block.start <= at && block.start + block.bytes.length > at);
          if (cached) {
            const bytes = cached.bytes.subarray(at - cached.start, Math.min(cached.bytes.length, range.end - cached.start));
            chunks.push(bytes); blocks.push({start: at, bytes}); at += bytes.length;
            continue;
          }
          const chunk = await (api.mirrorLogs ?? api.logs)(record.id, at, Math.min(api.mirrorLogs ? 524288 : 49152, range.end - at), ownerSession, source.id);
          const bytes = Buffer.from(chunk.data, 'base64');
          if (!bytes.length || bytes.toString('base64') !== chunk.data || chunk.nextOffset !== at + bytes.length || chunk.nextOffset > range.end || chunk.size < size || ('identity' in first && 'identity' in chunk && first.identity !== chunk.identity)) throw new Error('Source changed during mirror sync; retry required');
          chunks.push(bytes); blocks.push({start: at, bytes}); at = chunk.nextOffset;
        }
      }
      if (detached(record)) throw new Error('Remote monitor detached');
      const mirrorPath = join(root, `${record.id}.${source.id}.source`);
      const temporary = mirrorPath + '.tmp';
      await writeFile(temporary, Buffer.concat(chunks), {mode: 0o600});
      await rename(temporary, mirrorPath);
      if (generation === activeGeneration && record.status === 'running' && !detached(record)) windows.set(key, {identity, size, blocks});
      return {...source, location: 'remote' as const, mirrorPath, cachedAt: Date.now(), size, ranges};
      } catch (error) {
        const mirrorPath = join(root, `${record.id}.${source.id}.source`);
        const cached = await stat(mirrorPath).catch((error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT') return undefined; throw error;});
        return {...source, location: 'remote' as const, readError: String(error), ...(cached ? {mirrorPath, cachedAt: cached.mtimeMs} : {})};
      }
    })) : undefined;
    if (record.status !== 'running' || detached(record)) release(record.id);
    return { ...record, ...(sources ? {sources} : {}), outputFile, outputBytes: offset };
  }
  function adapt(record: TaskRecord): Promise<TaskRecord> {
    const previous = pending.get(record.id) ?? Promise.resolve(record);
    const next = previous.catch(() => record).then(() => sync(record));
    pending.set(record.id, next);
    void next.finally(() => { if (pending.get(record.id) === next) pending.delete(record.id); }).catch(() => {});
    return next;
  }
  async function query(taskId: string, cancel = false) {
    const record = await (cancel ? api.cancel(taskId, ownerSession) : api.get(taskId, ownerSession));
    if (record.id !== taskId) throw new Error('Remote task ID mismatch');
    return adapt(record);
  }
  return { release, cachedWindowCount: () => windows.size, id, cwd, root, api, adapt, get: (taskId: string, _ownerSession?: string) => query(taskId), cancel: (taskId: string, _ownerSession?: string) => query(taskId, true) };
}
