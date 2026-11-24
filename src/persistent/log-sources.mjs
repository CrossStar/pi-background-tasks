import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export const SOURCE_VERSION = 1;
export const MIRROR_RANGE_LIMIT = 524288;
export const RANGE_LIMIT = 49152;
export function validateSources(sources, cwd) {
    if (!path.isAbsolute(cwd) || !Array.isArray(sources) || sources.length > 128) throw Error('Invalid log sources');
    const ids = new Set();
    return sources.map(source => {
        if (!source || typeof source.id !== 'string' || !/^[\w.-]{1,100}$/.test(source.id) || ids.has(source.id) ||
            typeof source.label !== 'string' || !source.label.length || source.label.length > 200 ||
            !['stdout', 'stderr', 'file', 'digest'].includes(source.kind) || !['local', 'remote'].includes(source.location) ||
            typeof source.path !== 'string' || !source.path.length || source.path.includes('\0')) throw Error('Invalid log source');
        ids.add(source.id);
        if (source.pattern !== undefined && (typeof source.pattern !== 'string' || !source.pattern.length ||
            path.isAbsolute(source.pattern) || source.pattern.split(/[\\/]/).includes('..'))) throw Error('Pattern must be relative to its declared root');
        return { id: source.id, label: source.label, kind: source.kind, location: source.location,
            path: path.resolve(cwd, source.path), ...(source.pattern === undefined ? {} : {pattern: source.pattern}) };
    });
}

export function expandSources(sources, cwd) {
    const validated = validateSources(sources, cwd);
    const expanded = [...validated];
    for (const source of validated) if (source.pattern) {
        for (const file of fs.globSync(source.pattern, {cwd: source.path})) {
            const absolute = path.resolve(source.path, file);
            try { if (!fs.statSync(absolute).isFile()) continue; } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (expanded.length >= 128) { expanded.diagnostic = 'Source expansion capped at 128'; return expanded; }
            const {pattern, ...fields} = source;
            expanded.push({...fields, id: crypto.createHash('sha256').update(source.id + absolute).digest('hex').slice(0, 32), label: path.basename(file), path: absolute});

        }
    }
    return expanded;
}

export function createSourceExpander({now = Date.now, expand = expandSources} = {}) {
    const cache = new Map();
    return (id, sources, cwd) => {
        const signature = JSON.stringify([cwd, sources]), previous = cache.get(id);
        if (previous?.signature === signature && now() - previous.at < 30000) return previous.sources;
        const expanded = expand(sources, cwd);
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(id, {signature, at: now(), sources: expanded});
        return expanded;
    };
}

/** A source id, never a caller-supplied path, selects a range. */
export function readSourceRange(record, sourceId, offset = 0, maxBytes = RANGE_LIMIT, limit = RANGE_LIMIT) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > limit) throw Error('Invalid log range');
    const sources = record.sources === undefined ? [] : validateSources(record.sources, record.cwd);
    const source = sourceId === undefined ? sources.find(s => s.kind === 'digest') : sources.find(s => s.id === sourceId);
    if (sourceId !== undefined && !source) throw Error('Unregistered log source');
    if (source?.pattern) throw Error('Select a discovered file source, not a pattern');
    const fd = fs.openSync(source?.path ?? record.outputFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw Error('Log source is not a regular file');
        const bytes = Buffer.alloc(Math.min(maxBytes, Math.max(0, stat.size - offset)));
        const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
        return { data: bytes.subarray(0, count).toString('base64'), nextOffset: offset + count,
            size: stat.size, eof: offset + count >= stat.size, identity: `${stat.dev}:${stat.ino}`, cachedAt: Date.now() };
    } finally { fs.closeSync(fd); }
}

/** Tracks bounded increments, resetting on replacement or observable truncation. */
export class SourceCursor {
    constructor(initialWindow = RANGE_LIMIT) { this.initialWindow = initialWindow; this.offset = 0; this.identity = undefined; this.anchor = Buffer.alloc(0); }
    read(file, maxBytes = RANGE_LIMIT) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > RANGE_LIMIT) throw Error('Invalid cursor range');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) throw Error('Log source is not a regular file');
            const identity = `${stat.dev}:${stat.ino}`;
            let reset = this.identity !== undefined && (identity !== this.identity || stat.size < this.offset);
            if (!reset && this.anchor.length && this.offset <= stat.size) {
                const anchor = Buffer.alloc(this.anchor.length);
                fs.readSync(fd, anchor, 0, anchor.length, this.offset - anchor.length);
                reset = !anchor.equals(this.anchor);
            }
            if (this.identity === undefined) this.offset = Math.max(0, stat.size - this.initialWindow);
            else if (reset) this.offset = 0;
            this.identity = identity;
            const start = this.offset;
            const bytes = Buffer.alloc(Math.min(maxBytes, Math.max(0, stat.size - start)));
            const count = fs.readSync(fd, bytes, 0, bytes.length, start);
            this.offset += count;
            this.anchor = Buffer.alloc(Math.min(64, this.offset));
            fs.readSync(fd, this.anchor, 0, this.anchor.length, this.offset - this.anchor.length);
            return { bytes: bytes.subarray(0, count), start, nextOffset: this.offset, size: stat.size, identity, reset };
        } finally { fs.closeSync(fd); }
    }
}

/** Explicit byte intervals for a sparse mirror: callers must never concatenate across gaps silently. */
export function mirrorRanges(size, terminal, tailBytes = 4 * 1024 * 1024, headBytes = 1024 * 1024) {
    for (const value of [size, tailBytes, headBytes]) if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid mirror size');
    const tail = Math.max(0, size - tailBytes);
    const head = terminal ? Math.min(size, headBytes) : 0;
    if (head >= tail) return size ? [{start: 0, end: size}] : [];
    return [...(head ? [{start: 0, end: head}] : []), ...(tail < size ? [{start: tail, end: size}] : [])];
}
