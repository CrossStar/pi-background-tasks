import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rpc, endpoint, serviceRoot, privateDir } from './shared.mjs';
export interface StartRequest {
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
    ownerSession?: string;
    notifyOnCompletion?: boolean;
    triggerOnCompletion?: boolean;
}
export interface AdmissionDiagnostic { id: string; message: string }
export interface TaskList extends Array<TaskRecord> { diagnostics: AdmissionDiagnostic[] }
export interface TaskRecord {
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
function validateRecord(value: unknown, root: string, id?: string): TaskRecord {
    if (!value || typeof value !== 'object')
        throw Error('Invalid task record');
    const r = value as Record<string, unknown>;
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
            await transport('ping', {});
            return;
        }
        catch { }
        const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.mjs', import.meta.url))], {
            detached: true, stdio: 'ignore', env: { ...process.env, PI_BG_SERVICE_DIR: root },
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
    async function call(method: string, params: unknown): Promise<unknown> {
        await ensureService();
        return transport(method, params);
    }
    return {
        ensureService,
        async start(request: StartRequest) { return validateRecord(await call('start', request), root, request.id); },
        async get(id: string) { return validateRecord(await call('get', { id }), root, id); },
        async cancel(id: string) { return validateRecord(await call('cancel', { id }), root, id); },
        async list(cwd?: string) {
            const records: TaskList = Object.assign([] as TaskRecord[], {diagnostics: [] as AdmissionDiagnostic[]});
            for (let offset = 0;;) {
                const result = await call('list', { cwd, offset });
                if (!result || typeof result !== 'object') throw Error('Invalid list response');
                const page = result as Record<string,unknown>;
                if (!Array.isArray(page['records']) || !Array.isArray(page['diagnostics'])) throw Error('Invalid list response');
                records.push(...page['records'].map(value => validateRecord(value, root)));
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
export function get(id: string): Promise<TaskRecord> { return createClient().get(id); }
export function list(cwd?: string): Promise<TaskList> { return createClient().list(cwd); }
export function cancel(id: string): Promise<TaskRecord> { return createClient().cancel(id); }
