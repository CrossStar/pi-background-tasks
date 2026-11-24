#!/usr/bin/env node
// One request per SSH exec; execution belongs exclusively to the shared daemon.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.env.PI_BG_SERVICE_DIR ||= path.join(os.homedir(), '.pi/background-tasks-remote');
const { root, endpoint, rpc, MAX_FRAME, replaceLegacyDaemon } = await import('./shared.mjs');
let request;
const finish = value => process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(0));
const deadline = setTimeout(() => finish({ ok: false, error: { message: 'Bridge timeout; task admission may have succeeded', ...(request?.method === 'start' ? { taskId: request.params?.id } : {}) } }), 20000);
function integer(value, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Invalid integer');
    return value;
}
function id(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw Error('Invalid task id');
    return value;
}
function publicRecord(value) {
    if (!value || typeof value !== 'object') return value;
    const { capability, ...safe } = value;
    return safe;
}
async function ensure(ownerSession) {
    const address = endpoint('daemon');
    const ping = async () => {
        const result = await rpc(address, 'ping', {});
        if (!Number.isInteger(result?.pid) || typeof result?.startToken !== 'string' || result.protocolVersion !== 2) throw Error('Incompatible daemon protocol');
        if (ownerSession !== undefined && result.sessionOwnership !== 1) throw Error('Daemon lacks session ownership support; restart daemon retaining supervisors; no task replay');
        return { ...result, protocol: 'pi-background-tasks-remote', version: 2,
            daemonProtocolVersion: 2, runtime: { node: process.version, platform: process.platform, arch: process.arch }, serviceRoot: root };
    };
    try { return await ping(); } catch (error) {
        if (!['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE'].includes(error.code) && error.message !== 'RPC disconnected') await replaceLegacyDaemon(root, error);
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.mjs', import.meta.url))], {
        windowsHide: true, detached: true, stdio: 'ignore', env: process.env,
    });
    let failure;
    child.on('error', error => { failure = error; });
    child.unref();
    for (let attempt = 0; attempt < 50; attempt++) {
        if (failure) throw failure;
        try { return await ping(); } catch (error) {
            if (!['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE'].includes(error.code) && error.message !== 'RPC disconnected') await replaceLegacyDaemon(root, error);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Daemon did not become available');
}
async function run(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw Error('Expected {method,params} request');
    const p = { ...request.params, op: request.method };
    if (!['ensure', 'start', 'get', 'list', 'cancel', 'logs', 'mirrorLogs'].includes(p.op)) throw Error('Unknown operation');
    if (p.ownerSession !== undefined && (typeof p.ownerSession !== 'string' || !p.ownerSession.length)) throw Error('Invalid ownerSession');
    if (p.op === 'ensure') return ensure(p.ownerSession);
    if (p.op !== 'list') id(p.id);
    if (p.cwd !== undefined && (typeof p.cwd !== 'string' || !path.isAbsolute(p.cwd))) throw Error('cwd must be absolute');
    if (p.op !== 'start') await ensure(p.ownerSession);
    const call = (method, params) => rpc(endpoint('daemon'), method, params);
    if (p.op === 'start') {
        if (typeof p.cwd !== 'string' || typeof p.command !== 'string' || typeof p.name !== 'string') throw Error('Invalid start request');
        for (const key of ['description', 'ownerSession']) if (p[key] !== undefined && typeof p[key] !== 'string') throw Error('Invalid ' + key);
        for (const key of ['notifyOnCompletion', 'triggerOnCompletion']) if (p[key] !== undefined && typeof p[key] !== 'boolean') throw Error('Invalid ' + key);
        const timeoutSeconds = p.timeoutSeconds ?? 0;
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw Error('Invalid timeout');
        const maxOutputBytes = integer(p.maxOutputBytes ?? 20971520, 1, Number.MAX_SAFE_INTEGER);
        await ensure(p.ownerSession);
        return publicRecord(await call('start', {
            id: p.id, cwd: p.cwd, name: p.name, command: p.command, sources: p.sources, slurm: p.slurm,
            description: p.description, ownerSession: p.ownerSession,
            notifyOnCompletion: p.notifyOnCompletion, triggerOnCompletion: p.triggerOnCompletion,
            timeoutSeconds, maxOutputBytes, shell: '/bin/bash', args: ['-c', p.command], env: { ...process.env },
        }));
    }
    if (p.op === 'list') {
        const result = await call('list', { cwd: p.cwd, ownerSession: p.ownerSession, offset: integer(p.offset ?? 0, 0, Number.MAX_SAFE_INTEGER) });
        return { ...result, records: result.records.map(publicRecord) };
    }
    if (p.op !== 'logs' && p.op !== 'mirrorLogs') return publicRecord(await call(p.op, { id: p.id, ownerSession: p.ownerSession }));
    const offset = integer(p.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = integer(p.maxBytes ?? 49152, 1, p.op === 'mirrorLogs' ? 524288 : 49152);
    return call(p.op, {id: p.id, ownerSession: p.ownerSession, offset, maxBytes, source: p.source});
}
try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > MAX_FRAME) throw Error('Request exceeds 1 MiB');
        chunks.push(chunk);
    }
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = await run(request);
    clearTimeout(deadline);
    finish({ ok: true, result });
} catch (error) {
    clearTimeout(deadline);
    finish({ ok: false, error: { message: String(error.message), ...(request?.method === 'start' ? { taskId: request.params?.id } : {}) } });
}
