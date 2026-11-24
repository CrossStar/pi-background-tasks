import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, privateDir, endpoint, server, rpc, atomic, record, load } from './shared.mjs';
import { validateSources, readSourceRange, createSourceExpander, MIRROR_RANGE_LIMIT } from './log-sources.mjs';
import { executeSlurm, parseAccounting, jobSelector, discoverSources, keyRegex } from './slurm-watch.mjs';
let accountingCache;
let accountingAt = 0;
const expand = createSourceExpander();
function enriched(value) {
    if (!value) return null;
    const manifest = path.join(path.dirname(record(value.id)), 'sources.json');
    const sources = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : value.sources;
    if (!sources) return value;
    const expanded = expand(value.id, sources, value.cwd);
    return {...value, sources: expanded, ...(expanded.diagnostic ? {diagnostic: [value.diagnostic, expanded.diagnostic].filter(Boolean).join('; ')} : {})};
}
privateDir(root);
privateDir(path.join(root, 'tasks'));
async function get(id) {
    const r = load(id);
    if (!r) return null;
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
function checkOwner(record, owner) {
    if (!record) throw Error('Task not found (legacy admission is invisible)');
    if (owner !== undefined && record.ownerSession !== owner) throw Error('Session ownership mismatch');
}
const daemonIdentity = crypto.randomUUID();
const service = server(async (method, p) => {
    if (p.ownerSession !== undefined && (typeof p.ownerSession !== 'string' || !p.ownerSession.length)) throw Error('Invalid ownerSession');
    if (method === 'ping')
        return { pid: process.pid, startToken: daemonIdentity, protocolVersion: 2, sessionOwnership: 1 };
    if (method === 'logs' || method === 'mirrorLogs') {
        let r = load(p.id);
        if (!r) return null;
        checkOwner(r, p.ownerSession);
        r = enriched(r);
        const indexSource = typeof p.source === 'string' && /^array-(\d+)-(stdout|stderr)$/.exec(p.source);
        if (indexSource && r.slurm && !r.sources?.some(source => source.id === p.source)) {
            const [, index, kind] = indexSource;
            if (r.slurm.arrayTaskId !== undefined && String(r.slurm.arrayTaskId) !== index) throw Error('Array index outside attached monitor');
            const attach = {...r.slurm, arrayTaskId: Number(index)};
            const discovered = discoverSources(await executeSlurm('discovery', [jobSelector(attach.jobId, attach.arrayTaskId)]), attach);
            const source = discovered.sources.find(source => source.kind === kind);
            if (!source) throw Error('Requested array log is unavailable');
            r = {...r, sources: [...(r.sources ?? []), {...source, id: p.source, label: p.source}]};
            // Resolve only the requested index. Do not subscribe it to automatic tailing.
        }
        if (r.outputFile !== path.join(root, 'tasks', p.id, 'output.log')) throw Error('Unsafe stored output path');
        return readSourceRange(r, p.source, p.offset, p.maxBytes, method === 'mirrorLogs' ? MIRROR_RANGE_LIMIT : undefined);
    }
    if (method === 'registerSources') {
        const r = load(p.id);
        if (p.capability !== r.capability) throw Error('Unauthorized');
        atomic(path.join(path.dirname(record(p.id)), 'sources.json'), validateSources(p.sources, r.cwd));
        return true;
    }
    if (method === 'slurmStatus') {
        const r = load(p.id);
        if (p.capability !== r.capability || !r.slurm) throw Error('Unauthorized');
        if (!accountingCache || Date.now() - accountingAt >= 25000 || (Number.isFinite(p.notBefore) && p.notBefore <= Date.now() && accountingAt < p.notBefore)) {
            const selectors = fs.readdirSync(path.join(root, 'tasks')).flatMap(id => {
                try { const task = load(id); return task?.status === 'running' && task.slurm ? [jobSelector(task.slurm.jobId, task.slurm.arrayTaskId)] : []; } catch { return []; }
            });
            accountingAt = Date.now();
            const observedAt = accountingAt;
            accountingCache = executeSlurm('accounting', selectors).then(text => {
                const diagnostics = [];
                return {records: parseAccounting(text, message => { if (diagnostics.length < 32) diagnostics.push(message); }), observedAt, diagnostics};
            });
            accountingCache.catch(() => { accountingCache = undefined; });
        }
        const selector = jobSelector(r.slurm.jobId, r.slurm.arrayTaskId);
        const result = await accountingCache;
        return {...result, records: result.records.filter(row => row.id === selector || row.id.startsWith(selector + '_') || row.id.startsWith(selector + '+'))};
    }
    if (method === 'get') {
        const stored = load(p.id);
        if (!stored) return null;
        checkOwner(stored, p.ownerSession);
        return enriched(await get(p.id));
    }
    if (method === 'list') {
        const ids = fs.readdirSync(path.join(root, 'tasks')).sort();
        const offset = Number.isSafeInteger(p.offset) && p.offset >= 0 ? p.offset : 0;
        const records = [], diagnostics = [];
        for (const id of ids.slice(offset, offset + 50)) {
            try {
                const stored = load(id);
                if (!stored) continue;
                if (p.ownerSession !== undefined && stored?.ownerSession !== p.ownerSession) continue;
                const value = enriched(stored);
                if (p.ownerSession !== undefined && value?.ownerSession !== p.ownerSession) continue;
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
                diagnostics.push(p.ownerSession !== undefined ? {id:'unknown',message:'unreadable admission'} : {id,message:'unreadable admission: '+String(error.message).slice(0,512)});
            }
        }
        return {records,diagnostics,nextOffset:offset+50<ids.length?offset+50:null};
    }
    if (method === 'cancel') {
        checkOwner(load(p.id), p.ownerSession);
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
        if (p.sources !== undefined) p.sources = validateSources(p.sources, p.cwd);
        if (p.slurm !== undefined) {
            jobSelector(p.slurm.jobId, p.slurm.arrayTaskId);
            keyRegex(p.slurm.keyPattern);
            if (!p.ownerSession) throw Error('Slurm attach requires ownerSession');
            for (const id of fs.readdirSync(path.join(root, 'tasks'))) {
                let existing;
                try { existing = load(id); } catch { continue; }
                if (existing?.status === 'running' && existing.ownerSession === p.ownerSession && existing.slurm &&
                    jobSelector(existing.slurm.jobId, existing.slurm.arrayTaskId) === jobSelector(p.slurm.jobId, p.slurm.arrayTaskId)) return enriched(await get(id));
            }
        }
        const { env: ignoredEnvironment, ...metadata } = p;
        if (Buffer.byteLength(JSON.stringify(metadata)) > 12000)
            throw Error('Task metadata exceeds 12000 byte limit');
        if (fs.existsSync(target)) {
            if (!load(p.id)) throw Error('Task admission exists (legacy); choose a new task ID; never replay');
            if (load(p.id).ownerSession !== p.ownerSession) throw Error('Session ownership mismatch');
            return get(p.id);
        }
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
        const r = { recordVersion: 2, sources: p.sources, slurm: p.slurm, id: p.id, cwd: p.cwd, name: p.name, command: p.command, description: p.description, ownerSession: p.ownerSession, notifyOnCompletion: p.notifyOnCompletion, triggerOnCompletion: p.triggerOnCompletion, status: 'running', startedAt: Date.now(), outputFile: path.join(dir, 'output.log'), capability: crypto.randomBytes(32).toString('hex') };
        fs.closeSync(fs.openSync(r.outputFile, 'wx', 0o600));
        atomic(target, r);
        const c = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), p.id], { windowsHide: true, env: { ...process.env, PI_BG_SERVICE_DIR: root }, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
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
