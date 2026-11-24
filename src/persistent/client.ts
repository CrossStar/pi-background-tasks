import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rpc, endpoint, serviceRoot, privateDir, replaceLegacyDaemon } from './shared.mjs';
export interface LogSource {
    id: string; label: string; kind: 'stdout' | 'stderr' | 'file' | 'digest';
    location: 'local' | 'remote'; path: string; pattern?: string;
    readError?: string;
    cachedAt?: number; mirrorPath?: string; ranges?: Array<{start: number; end: number}>; size?: number;
}
export interface SlurmAttach {
    jobId: string; arrayTaskId?: number; keyPattern?: string;
    logs?: {files?: string[]; extra?: string[]};
}
export interface StartRequest {
    sources?: LogSource[] | undefined;
    slurm?: SlurmAttach | undefined;
    id: string;
    cwd: string;
    name: string;
    command: string;
    description?: string | undefined;
    shell: string;
    args: string[];
    windowsVerbatimArguments?: boolean;
    env: Record<string, string>;
    timeoutSeconds: number;
    maxOutputBytes: number;
    ownerSession?: string | undefined;
    notifyOnCompletion?: boolean;
    triggerOnCompletion?: boolean;
}
export interface AdmissionDiagnostic { id: string; message: string }
export interface TaskList extends Array<TaskRecord> { diagnostics: AdmissionDiagnostic[] }
export interface TaskRecord {
    sources?: LogSource[];
    slurm?: SlurmAttach;
    id: string;
    cwd: string;
    name: string;
    command: string;
    description?: string;
    ownerSession?: string;
    notifyOnCompletion?: boolean;
    triggerOnCompletion?: boolean;
    status: 'running' | 'completed' | 'failed' | 'killed';
    startedAt: number;
    finishedAt?: number;
    outputFile: string;
    outputBytes?: number;
    exitCode?: number | null;
    signal?: string | null;
    diagnostic?: string;
}
function validateRecord(value: unknown, root: string, id?: string, ownerSession?: string): TaskRecord {
    if (!value || typeof value !== 'object')
        throw Error('Invalid task record');
    const r = value as Record<string, unknown>;
    if (ownerSession !== undefined && r['ownerSession'] !== ownerSession) throw Error('Session ownership mismatch');
    if (typeof r['id'] !== 'string' || !/^[\w-]{1,100}$/.test(r['id']) || (id && r['id'] !== id)
        || typeof r['cwd'] !== 'string' || !path.isAbsolute(r['cwd'])
        || typeof r['name'] !== 'string' || typeof r['command'] !== 'string'
        || !['running', 'completed', 'failed', 'killed'].includes(String(r['status']))
        || typeof r['startedAt'] !== 'number' || !Number.isFinite(r['startedAt'])
        || r['outputFile'] !== path.join(root, 'tasks', r['id'], 'output.log'))
        throw Error('Invalid task record fields');
    for (const key of ['description', 'ownerSession', 'diagnostic'])
        if (r[key] !== undefined && typeof r[key] !== 'string')
            throw Error('Invalid string field');
    for (const key of ['finishedAt', 'outputBytes'])
        if (r[key] !== undefined && (typeof r[key] !== 'number' || !Number.isFinite(r[key])))
            throw Error('Invalid numeric field');
    for (const key of ['notifyOnCompletion', 'triggerOnCompletion'])
        if (r[key] !== undefined && typeof r[key] !== 'boolean')
            throw Error('Invalid flag');
    if (r['exitCode'] !== undefined && r['exitCode'] !== null && !Number.isInteger(r['exitCode']))
        throw Error('Invalid exit code');
    if (r['signal'] !== undefined && r['signal'] !== null && typeof r['signal'] !== 'string')
        throw Error('Invalid signal');
    return value as TaskRecord;
}
export function createClient(options: {
    root?: string;
} = {}) {
    const root = path.resolve(options.root ?? serviceRoot());
    const transport = (method: string, params: unknown) => rpc(endpoint('daemon', root), method, params, root);
    async function ensureService(): Promise<void> {
        privateDir(root);
        try {
            const identity = await transport('ping', {}) as {protocolVersion?: number};
            if (identity.protocolVersion !== 2) throw Error('Unsupported persistent protocol; v2 required');
            return;
        }
        catch (error) { if (!['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE'].includes((error as NodeJS.ErrnoException).code ?? '') && (error as Error).message !== 'RPC disconnected') await replaceLegacyDaemon(root, error); }
        const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.mjs', import.meta.url))], {
            windowsHide: true, detached: true, stdio: 'ignore', env: { ...process.env, PI_BG_SERVICE_DIR: root },
        });
        child.on('error', () => { });
        child.unref();
        for (let i = 0; i < 100; i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
            try {
                await transport('ping', {});
                return;
            }
            catch { }
        }
        throw Error('Persistent service unavailable');
    }
    async function call(method: string, params: { ownerSession?: string | undefined; [key: string]: unknown } | StartRequest): Promise<unknown> {
        if (params.ownerSession !== undefined && (typeof params.ownerSession !== 'string' || !params.ownerSession.length)) throw Error('Invalid ownerSession');
        await ensureService();
        if (params.ownerSession !== undefined) {
            const capabilities = await transport('ping', {}) as {sessionOwnership?: number};
            if (capabilities.sessionOwnership !== 1) throw Error('Daemon lacks session ownership support; restart daemon retaining supervisors; no task replay');
        }
        return transport(method, params);
    }
    return {
        ensureService,
        async logs(id: string, offset: number, maxBytes: number, ownerSession?: string, source?: string) {
            return await call('logs', {id, offset, maxBytes, ownerSession, source}) as {data: string; nextOffset: number; size: number; eof: boolean; identity: string; cachedAt: number};
        },
        async start(request: StartRequest) { return validateRecord(await call('start', request), root, request.slurm ? undefined : request.id, request.ownerSession); },
        async get(id: string, ownerSession?: string) { const value = await call('get', { id, ownerSession }); return value === null ? null : validateRecord(value, root, id, ownerSession); },
        async cancel(id: string, ownerSession?: string) { return validateRecord(await call('cancel', { id, ownerSession }), root, id, ownerSession); },
        async list(cwd?: string, ownerSession?: string) {
            const records: TaskList = Object.assign([] as TaskRecord[], {diagnostics: [] as AdmissionDiagnostic[]});
            for (let offset = 0;;) {
                const result = await call('list', { cwd, offset, ownerSession });
                if (!result || typeof result !== 'object') throw Error('Invalid list response');
                const page = result as Record<string,unknown>;
                if (!Array.isArray(page['records']) || !Array.isArray(page['diagnostics'])) throw Error('Invalid list response');
                records.push(...page['records'].map(value => validateRecord(value, root, undefined, ownerSession)));
                for (const value of page['diagnostics']) {
                    if (!value || typeof value.id !== 'string' || typeof value.message !== 'string') throw Error('Invalid admission diagnostic');
                    records.diagnostics.push({id:value.id,message:value.message});
                }
                if (page['nextOffset'] === null) return records;
                if (typeof page['nextOffset'] !== 'number' || !Number.isSafeInteger(page['nextOffset']) || page['nextOffset'] <= offset) throw Error('Invalid pagination');
                offset = page['nextOffset'];
            }
        },
    };
}
export function ensureService(): Promise<void> { return createClient().ensureService(); }
export function start(request: StartRequest): Promise<TaskRecord> { return createClient().start(request); }
export function get(id: string, ownerSession?: string): Promise<TaskRecord | null> { return createClient().get(id, ownerSession); }
export function list(cwd?: string, ownerSession?: string): Promise<TaskList> { return createClient().list(cwd, ownerSession); }
export function cancel(id: string, ownerSession?: string): Promise<TaskRecord> { return createClient().cancel(id, ownerSession); }
