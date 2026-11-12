import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, privateDir, endpoint, server, rpc, atomic, record, load } from './shared.mjs';
privateDir(root);
privateDir(path.join(root, 'tasks'));
async function get(id) {
    const r = load(id);
    if (r.status !== 'running')
        return r;
    for (let i = 0; i < 10; i++) {
        try {
            return await rpc(endpoint(r.capability), 'get', { capability: r.capability });
        }
        catch {
            const latest = load(id);
            if (latest.status !== 'running')
                return latest;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    throw Error('SUPERVISOR_UNREACHABLE: preserve last running snapshot');
}
const daemonIdentity = crypto.randomUUID();
const service = server(async (method, p) => {
    if (method === 'ping')
        return { pid: process.pid, startToken: daemonIdentity, protocolVersion: 1 };
    if (method === 'get')
        return get(p.id);
    if (method === 'list') {
        const ids = fs.readdirSync(path.join(root, 'tasks')).sort();
        const offset = Number.isSafeInteger(p.offset) && p.offset >= 0 ? p.offset : 0;
        const records = [], diagnostics = [];
        for (const id of ids.slice(offset, offset + 50)) {
            try {
                const value = load(id);
                if (!value || value.id !== id || typeof value.cwd !== 'string' ||
                    typeof value.name !== 'string' || typeof value.command !== 'string' ||
                    !['running','completed','failed','killed'].includes(value.status) ||
                    !Number.isFinite(value.startedAt) ||
                    value.outputFile !== path.join(root,'tasks',id,'output.log') || !path.isAbsolute(value.cwd) ||
                    ['description','ownerSession','diagnostic'].some(key=>value[key]!==undefined&&typeof value[key]!=='string') ||
                    ['notifyOnCompletion','triggerOnCompletion'].some(key=>value[key]!==undefined&&typeof value[key]!=='boolean') ||
                    ['finishedAt','outputBytes'].some(key=>value[key]!==undefined&&!Number.isFinite(value[key])) ||
                    (value.exitCode!==undefined&&value.exitCode!==null&&!Number.isInteger(value.exitCode)) ||
                    (value.signal!==undefined&&value.signal!==null&&typeof value.signal!=='string')) throw Error('Malformed task record');
                if (!p.cwd || value.cwd === p.cwd) records.push(value.status === 'running'
                    ? {...value,diagnostic:'unverified: stored running admission; supervisor reachability has not been verified'} : value);
            } catch (error) {
                diagnostics.push({id,message:'unreadable admission: '+String(error.message).slice(0,512)});
            }
        }
        return {records,diagnostics,nextOffset:offset+50<ids.length?offset+50:null};
    }
    if (method === 'cancel') {
        const r = await get(p.id);
        if (r.status !== 'running')
            return r;
        try {
            return await rpc(endpoint(r.capability), 'cancel', { capability: r.capability });
        } catch {
            // Terminal publication precedes endpoint shutdown. A raced cancel
            // must return that durable outcome rather than a transport error.
            const latest = load(p.id);
            if (latest.status !== 'running') return latest;
            throw Error('SUPERVISOR_UNREACHABLE: cancellation not verified; preserve last running snapshot');
        }
    }
    if (method === 'start') {
        const target = record(p.id);
        const { env: ignoredEnvironment, ...metadata } = p;
        if (Buffer.byteLength(JSON.stringify(metadata)) > 12000)
            throw Error('Task metadata exceeds 12000 byte limit');
        if (fs.existsSync(target))
            return get(p.id);
        if ((p.windowsVerbatimArguments !== undefined && typeof p.windowsVerbatimArguments !== 'boolean') || typeof p.command !== 'string' || typeof p.name !== 'string' || !path.isAbsolute(p.cwd) || typeof p.shell !== 'string' || !Array.isArray(p.args) || !p.args.every(x => typeof x === 'string') || !p.env || typeof p.env !== 'object' || !Object.values(p.env).every(x => typeof x === 'string') || !Number.isSafeInteger(p.maxOutputBytes) || p.maxOutputBytes < 1 || !Number.isFinite(p.timeoutSeconds) || p.timeoutSeconds < 0)
            throw Error('Invalid start request');
        const dir = path.dirname(target);
        try {
            fs.mkdirSync(dir, { mode: 0o700 });
        }
        catch (e) {
            if (e.code === 'EEXIST')
                throw Error('Task admission exists; never replay');
            throw e;
        }
        const r = { id: p.id, cwd: p.cwd, name: p.name, command: p.command, description: p.description, ownerSession: p.ownerSession, notifyOnCompletion: p.notifyOnCompletion, triggerOnCompletion: p.triggerOnCompletion, status: 'running', startedAt: Date.now(), outputFile: path.join(dir, 'output.log'), capability: crypto.randomBytes(32).toString('hex') };
        fs.closeSync(fs.openSync(r.outputFile, 'wx', 0o600));
        atomic(target, r);
        const c = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), p.id], { env: { ...process.env, PI_BG_SERVICE_DIR: root }, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
        c.on('error', () => { });
        c.stdin.on('error', () => { });
        c.stdin.end(JSON.stringify({ cwd: p.cwd, shellExecutable: p.shell, shellArgs: p.args, windowsVerbatimArguments: p.windowsVerbatimArguments, environment: p.env, timeoutMs: p.timeoutSeconds * 1000, outputCapBytes: p.maxOutputBytes }));
        c.unref();
        return get(p.id);
    }
    throw Error('Unknown method');
});
// The OS socket bind arbitrates concurrent starters. Never unlink an endpoint
// based on failed health checks: another daemon may be starting.
const address = endpoint('daemon');
service.on('error', async (e) => {
    if (e.code !== 'EADDRINUSE')
        process.exit(1);
    for (let i = 0; i < 20; i++) {
        try {
            await rpc(address, 'ping', {});
            process.exit(0);
        }
        catch { }
        await new Promise(r => setTimeout(r, 100));
    }
    process.exit(1);
});
service.listen(address, () => {
    if (!address.startsWith('\0') && process.platform !== 'win32')
        fs.chmodSync(address, 0o600);
});
