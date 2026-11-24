import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SourceCursor, validateSources } from './log-sources.mjs';

const terminal = /^(COMPLETED|FAILED|CANCELLED|TIMEOUT|OUT_OF_ME(?:MORY)?|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE)$/;
export function jobSelector(jobId, arrayTaskId) {
    const job = String(jobId);
    if (!/^\d+$/.test(job) || (arrayTaskId !== undefined && !/^\d+$/.test(String(arrayTaskId)))) throw Error('Invalid Slurm job selector');
    return arrayTaskId === undefined ? job : `${job}_${arrayTaskId}`;
}
export function slurmCommand(operation, selectors) {
    if (!Array.isArray(selectors) || !selectors.length || selectors.some(id => !/^\d+(?:_\d+)?$/.test(id))) throw Error('Invalid Slurm selectors');
    if (operation === 'accounting') return ['sacct', ['-n', '-X', '-P', '-j', [...new Set(selectors)].join(','), '-o', 'JobID,State,ExitCode']];
    if (operation === 'discovery' && selectors.length === 1) return ['scontrol', ['show', 'job', '-o', selectors[0]]];
    throw Error('Slurm operation is not read-only or supported');
}
export function executeSlurm(operation, selectors) {
    const [file, args] = slurmCommand(operation, selectors);
    return new Promise((resolve, reject) => execFile(file, args, {encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true},
        (error, stdout) => error ? reject(error) : resolve(stdout)));
}
export function parseAccounting(text, diagnose = () => {}) {
    const records = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [id, rawState, exitCode] = line.trim().split('|');
        if (!/^\d+(?:_\d+|_\[[^\]]+\]|\+\d+)?$/.test(id ?? '') || !rawState || !/^\d+:\d+$/.test(exitCode ?? '')) {
            diagnose(`Skipped malformed sacct row: ${line.slice(0, 300)}`);
            // Keep a recognizable owner's outcome unknown without poisoning other jobs.
            const owner = /^(\d+)/.exec(id ?? '')?.[1];
            if (owner) records.push({id: owner, state: 'UNKNOWN', exitCode: '0:0'});
            continue;
        }
        records.push({id, state: id.includes('[') ? 'PENDING' : rawState.trim().split(/\s/)[0].replace(/\+$/, ''), exitCode});
    }
    return records;
}
export function accountingOutcome(records) {
    const done = records.length > 0 && records.every(record => !record.id.includes('[') && terminal.test(record.state));
    return {terminal: done, success: done && records.every(record => record.state === 'COMPLETED'),
        failedIndices: records.filter(record => terminal.test(record.state) && record.state !== 'COMPLETED' && record.id.includes('_')).map(record => record.id)};
}
export function discoverSources(text, attach) {
    const fields = Object.fromEntries([...text.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9]*)=(.*?)(?=\s[A-Za-z][A-Za-z0-9]*=|$)/g)].map(m => [m[1], m[2]]));
    const values = {j: jobSelector(attach.jobId, attach.arrayTaskId), A: String(attach.jobId), a: attach.arrayTaskId === undefined ? undefined : String(attach.arrayTaskId), x: fields.JobName, u: fields.UserId?.replace(/\(.*$/, '')};
    const expand = value => {
        const result = value.replace(/%([jxuaA%])/g, (_, key) => key === '%' ? '%' : values[key] ?? `%${key}`);
        if (/%[A-Za-z]/.test(result)) throw Error(`Unresolved Slurm path placeholder: ${result}`);
        return result;
    };
    return {cwd: fields.WorkDir, sources: ['StdOut', 'StdErr'].flatMap((key, index) => {
        const file = fields[key];
        if (!file || file === '(null)') return [];
        return [{id: index ? 'stderr' : 'stdout', label: index ? 'stderr' : 'stdout', kind: index ? 'stderr' : 'stdout', location: 'local', path: path.resolve(fields.WorkDir || '/', expand(file))}];
    })};
}
// Deliberately restricted regex vocabulary: literal alternatives, character classes,
// anchors and single characters. No repetition, groups or backreferences.
export function keyRegex(pattern = 'loss|eval|step|error|Traceback|Warning|exception') {
    if (typeof pattern !== 'string' || pattern.length > 256 || /[()*+?{}]|\\[1-9]/.test(pattern)) throw Error('Unsafe keyPattern: use literal alternatives or character classes; no repetition/groups/backreferences');
    return new RegExp(pattern, 'i');
}
export function digestLines(text, key = keyRegex()) {
    return text.split(/[\r\n]+/).map(line => line.slice(0, 300)).filter(line => line.trim() && !/(?:it\/s|s\/it)\]/.test(line) && (key.lastIndex = 0, key.test(line)))
        .map(line => line.replace(/[\x00-\x1f\x7f-\x9f]/g, ''));
}
export function digestWriter(output, budget = 20 * 1024 * 1024) {
    const reserve = Math.min(65536, Math.floor(budget / 2));
    let used = 0, suppressed = 0, repeated = 0;
    const seen = new Map();
    return {
        emit(text) {
            text = text.slice(0, 4096);
            if (seen.has(text)) { repeated++; seen.set(text, seen.get(text) + 1); return; }
            if (seen.size >= 256) seen.delete(seen.keys().next().value);
            seen.set(text, 0);
            const bytes = Buffer.from(text + '\n');
            if (used + bytes.length > budget - reserve) {
                if (suppressed === 0) {
                    const notice = Buffer.from('[Digest budget reached; further lines are counted; final summary is reserved.]\n').subarray(0, Math.floor(reserve / 4));
                    output(notice); used += notice.length;
                }
                suppressed++; return;
            }
            output(bytes); used += bytes.length;
        },
        final(records, failedIndices) {
            const repeats = [...seen].filter(([, count]) => count).map(([line, count]) => `[repeated ${count} times] ${line.slice(0, 120)}`).join('\n');
            const counts = Object.fromEntries([...new Set(records.map(row => row.state))].map(state => [state, records.filter(row => row.state === state).length]));
            const text = `Final sacct: ${records.length} records ${JSON.stringify(counts)}\nFailed indices: ${failedIndices.join(',') || 'none'}\nSuppressed digest lines: ${suppressed}; repeated lines: ${repeated}\n${repeats}\n`;
            const bytes = Buffer.from(text);
            const available = budget - used;
            if (bytes.length <= available) output(bytes);
            else {
                const notice = Buffer.from('\n[Final summary truncated; query sacct for complete records]\n');
                output(Buffer.concat([bytes.subarray(0, Math.max(0, available - notice.length)), notice]).subarray(0, available));
            }
        },
    };
}
export async function watchSlurm({record, call, output, signal, budget, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, execute = executeSlurm}) {
    const attach = record.slurm, cursors = new Map(), fragments = new Map();
    let sources = [{id: 'digest', label: 'digest', kind: 'digest', location: 'local', path: record.outputFile}];
    let state = '', terminalAt, retryAt = 0, failures = 0, discoveryAt = 0, refreshAt = 0, registered = '', discovered = false, array = false;
    const started = now(), key = keyRegex(attach.keyPattern), digest = digestWriter(output, budget);
    const emit = text => digest.emit(text);
    const refreshSources = async () => {
        if (now() < refreshAt) return;
        refreshAt = now() + 30000;
        const files = [...(attach.logs?.files ?? [])];
        for (const pattern of attach.logs?.extra ?? []) {
            if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) throw Error('Log globs must be relative to cwd');
            for (const file of fs.globSync(pattern, {cwd: record.cwd})) { if (files.length >= 127) {emit('Source limit reached (128)');break;} files.push(file); }
        }
        let candidates = files.map(file => ({path: path.resolve(record.cwd, file), kind: 'file', label: path.basename(file), location: 'local'}));
        if (!files.length && !attach.logs?.extra?.length && !discovered && !array && state && state !== 'pending/unknown' && now() >= discoveryAt) {
            discoveryAt = now() + 30000;
            candidates = discoverSources(await execute('discovery', [jobSelector(attach.jobId, attach.arrayTaskId)]), attach).sources;
            discovered = true;
        }
        for (const source of candidates) if (!sources.some(existing => existing.path === source.path)) {
            if (sources.length === 128) {emit('Source limit reached (128)');break;}
            sources.push({...source, id: `file-${sources.length}`});
        }
        sources = validateSources(sources, record.cwd);
        const signature = JSON.stringify(sources);
        if (signature !== registered) {await call('registerSources', {sources});registered = signature;}
    };
    const tail = () => {
        for (const source of sources) {
            if (source.kind === 'digest' || (attach.arrayTaskId === undefined && (array || !state || state === 'pending/unknown'))) continue;
            let cursor = cursors.get(source.id);
            if (!cursor) {cursor = new SourceCursor();cursors.set(source.id, cursor);}
            try {
                const chunk = cursor.read(source.path);
                if (chunk.reset) {fragments.delete(source.id);emit(`[${source.label}] source replaced or truncated`);}
                const text = (fragments.get(source.id) ?? '') + chunk.bytes.toString('utf8');
                const end = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
                fragments.set(source.id, text.slice(end + 1).slice(-4096));
                for (const line of digestLines(text.slice(0, end + 1), key)) emit(`[${source.label}] ${line}`);
            } catch (error) {if (error.code !== 'ENOENT') emit(`[${source.label}] monitor read error: ${error.message}`);}
        }
    };
    while (!signal.aborted) {
        if (now() >= retryAt) {
            try {
                const response = await call('slurmStatus', {notBefore: terminalAt === undefined ? 0 : terminalAt + 10000});
                const {records, observedAt, diagnostics = []} = response;
                for (const diagnostic of diagnostics) emit(diagnostic);
                array = attach.arrayTaskId === undefined && records.some(row => row.id.includes('_'));
                failures = 0;retryAt = now() + 25000;
                const next = records.map(row => `${row.id}:${row.state}`).join(',') || 'pending/unknown';
                if (next !== state) {state = next;emit(`Slurm ${state}`);}
                if (!records.length && now() - started >= 120000) emit('No accounting record after two minutes; job remains pending/unknown. Check job ID and accounting availability.');
                const outcome = accountingOutcome(records);
                if (outcome.terminal) {
                    terminalAt ??= observedAt;
                    if (observedAt >= terminalAt + 10000) {
                        await refreshSources();tail();
                        for (const source of sources) for (const line of digestLines(fragments.get(source.id) ?? '', key)) emit(`[${source.label}] ${line}`);
                        digest.final(records, outcome.failedIndices);
                        return outcome.success ? 0 : 1;
                    }
                    retryAt = Math.min(retryAt, terminalAt + 10000);
                } else terminalAt = undefined;
            } catch (error) {retryAt = now() + Math.min(120000, 2000 * 2 ** Math.min(failures++, 6));emit(`Slurm monitor error (retrying): ${error.message}`);}
        }
        try {await refreshSources();} catch (error) {emit(`Source discovery monitor error: ${error.message}`);}
        tail();await sleep(4000);
    }
    return 0;
}
