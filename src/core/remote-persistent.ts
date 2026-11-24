import { ensureSafeCacheDir } from './monitor-exclusion.ts';
import { createHash } from 'node:crypto';
import { stat, open } from 'node:fs/promises';
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
    start: source.start.bind(source), get: source.get.bind(source),
    list: source.list.bind(source), cancel: source.cancel.bind(source), logs: source.logs.bind(source),
  };
  const root = join(localCwd, '.pi', 'tasks', 'remote', createHash('sha256').update(JSON.stringify([id, cwd, ownerSession])).digest('hex'));
  const pending = new Map<string, Promise<TaskRecord>>();
  async function sync(record: TaskRecord): Promise<TaskRecord> {
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
    } finally { await file.close(); }
    return { ...record, outputFile, outputBytes: offset };
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
  return { id, cwd, root, api, adapt, get: (taskId: string, _ownerSession?: string) => query(taskId), cancel: (taskId: string, _ownerSession?: string) => query(taskId, true) };
}
