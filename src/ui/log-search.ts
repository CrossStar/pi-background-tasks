import { open } from 'node:fs/promises';

/** Literal UTF-8 search over a size snapshot, with bounded memory and cancellable reads. */
export async function searchLog(
  path: string, query: string, from: number, direction: 1 | -1, signal: AbortSignal,
): Promise<{ offset: number; content: string; totalBytes: number } | undefined> {
  const needle = Buffer.from(query, 'utf8');
  if (!needle.length || needle.length > 4096) throw new Error('Search must contain 1–4096 UTF-8 bytes.');
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    let cursor = Math.max(0, Math.min(from, size));
    const buffer = Buffer.alloc(64 * 1024);
    while (direction === 1 ? cursor < size : cursor > 0) {
      signal.throwIfAborted();
      const start = direction === 1 ? cursor : Math.max(0, cursor - buffer.length);
      const length = Math.min(buffer.length, (direction === 1 ? size : cursor) - start);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      signal.throwIfAborted();
      if (!bytesRead) return undefined;
      const chunk = buffer.subarray(0, bytesRead);
      const found = direction === 1 ? chunk.indexOf(needle) : chunk.lastIndexOf(needle);
      if (found >= 0) {
        const offset = start + found;
        const excerpt = Buffer.alloc(16 * 1024);
        const read = await file.read(excerpt, 0, Math.min(excerpt.length, size - offset), offset);
        signal.throwIfAborted();
        return { offset, content: excerpt.subarray(0, read.bytesRead).toString('utf8'), totalBytes: size };
      }
      if (direction === 1 && start + bytesRead >= size) break;
      if (direction === -1 && start === 0) break;
      cursor = direction === 1 ? start + bytesRead - needle.length + 1 : start + needle.length - 1;
    }
    return undefined;
  } finally { await file.close(); }
}
