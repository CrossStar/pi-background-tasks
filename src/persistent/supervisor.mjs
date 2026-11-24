import { killWindowsTree } from './windows-tree.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { endpoint, server, load, record, atomic, rpc } from './shared.mjs';
import { watchSlurm } from './slurm-watch.mjs';
const id = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
    input += data;
    if (Buffer.byteLength(input) > 1048576)
        process.exit(1);
});
process.stdin.on('end', launch);
function launch() {
    const request = JSON.parse(input);
    input = '';
    const original = load(id);
    // Never remove this claim, even after a crash before spawn.
    const claim = fs.openSync(path.join(path.dirname(record(id)), 'launch.claim'), 'wx', 0o600);
    fs.writeFileSync(claim, JSON.stringify({ capability: original.capability, pid: process.pid }));
    fs.fsyncSync(claim);
    fs.closeSync(claim);
    atomic(record(id), original); // flush the claim's parent directory as well
    const address = endpoint(original.capability);
    const monitorAbort = new AbortController();
    let child, fd, reason, outputError, timeout, escalation, deadline;
    let windowsKill;
    let groupOwned = false;
    let cancellationDeadline = 0;
    let finishRetry;
    let active = false, finished = false, bytes = 0;
    const snapshot = () => ({ ...load(id), outputBytes: bytes });
    const control = server(async (method, params) => {
        if (params?.capability !== original.capability)
            throw Error('Unauthorized');
        if (method === 'cancel')
            stop('cancelled');
        else if (method !== 'get')
            throw Error('Unknown method');
        return snapshot();
    });
    function signalGroup(signal) {
        if (!groupOwned || finished || !reason || !child?.pid || process.platform === 'win32')
            return;
        try {
            process.kill(-child.pid, signal);
        }
        catch (error) {
            if (error.code === 'ESRCH') groupOwned = false;
            else outputError = error;
        }
    }
    function stop(cause) {
        if (finished)
            return;
        reason ??= cause;
        if (original.slurm) {
            monitorAbort.abort();
            void finish(0, null);
            return;
        }
        cancellationDeadline ||= Date.now() + 3000;
        if (process.platform === 'win32') {
            if (!windowsKill) {
                windowsKill = active && child?.pid ? killWindowsTree(child.pid) : Promise.resolve({ error: 'leader no longer active' });
                windowsKill.then(outcome => { if (outcome.error)
                    finish(null, null, Error('unknown: ' + outcome.error)); });
            }
            deadline ??= setTimeout(() => finish(null, null, Error('unknown: termination not verified')), 3000);
            return;
        }
        signalGroup('SIGTERM');
        escalation ??= setTimeout(() => signalGroup('SIGKILL'), 1000);
        deadline ??= setTimeout(() => finish(null, null, Error('unknown: termination not verified')), 3000);
    }
    async function finish(code, signal, error) {
        if (windowsKill) {
            const outcome = await windowsKill;
            if (outcome.error) error = Error('unknown: '+outcome.error);
        }
        if (finished)
            return;
        if (reason && groupOwned && child?.pid && process.platform !== 'win32') {
            try {
                process.kill(-child.pid, 0);
                // The original group remains owned across leader exit. Do not
                // cancel escalation just because all inherited pipes closed.
                if (Date.now() < cancellationDeadline) {
                    clearTimeout(finishRetry);
                    finishRetry = setTimeout(() => finish(code, signal, error), 50);
                    return;
                }
                error = Error('unknown: process group still exists after escalation');
            } catch (probe) {
                if (probe.code === 'ESRCH') groupOwned = false;
                else error = Error('unknown: process group verification failed');
            }
        }
        finished = true;
        clearTimeout(timeout);
        clearTimeout(escalation);
        clearTimeout(deadline);
        clearTimeout(finishRetry);
        try {
            if (fd !== undefined)
                fs.fsyncSync(fd);
        }
        catch (failure) {
            outputError = failure;
        }
        try {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
        catch (failure) {
            outputError ??= failure;
        }
        const diagnostic = error?.message || outputError?.message || reason ||
            (code !== 0 || signal ? `Exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}` : undefined);
        const status = error || outputError ? 'failed' : reason === 'cancelled' ? 'killed' : code === 0 && !reason ? 'completed' : 'failed';
        try {
            atomic(record(id), { ...original, status, outputBytes: bytes, exitCode: code, signal, diagnostic, finishedAt: Date.now() });
        }
        catch {
            process.exitCode = 1;
        }
        control.close(() => process.exit(process.exitCode || 0));
        setTimeout(() => process.exit(process.exitCode || 0), 100).unref();
    }
    function output(data) {
        if (finished)
            return;
        const slice = data.subarray(0, Math.max(0, request.outputCapBytes - bytes));
        try {
            let offset = 0;
            while (offset < slice.length) {
                const written = fs.writeSync(fd, slice, offset);
                offset += written;
                bytes += written;
            }
        }
        catch (error) {
            outputError = error;
            stop('output-error');
            return;
        }
        if (slice.length < data.length && !original.slurm)
            stop('output-cap');
    }
    control.on('error', error => finish(null, null, error));
    control.listen(address, () => {
        try {
            if (!address.startsWith('\0') && process.platform !== 'win32')
                fs.chmodSync(address, 0o600);
            fd = fs.openSync(original.outputFile, 'a', 0o600);
            if (original.slurm) {
                const call = (method, params) => rpc(endpoint('daemon'), method, {...params, id, capability: original.capability});
                void watchSlurm({record: original, call, output, signal: monitorAbort.signal, budget: request.outputCapBytes})
                    .then(code => finish(code, null), error => finish(null, null, error));
                if (request.timeoutMs) timeout = setTimeout(() => stop('timeout'), request.timeoutMs);
                return;
            }
            child = spawn(request.shellExecutable, request.shellArgs, {
                windowsHide: true, cwd: request.cwd, env: request.environment, detached: process.platform !== 'win32', windowsVerbatimArguments: request.windowsVerbatimArguments === true, stdio: ['ignore', 'pipe', 'pipe'],
            });
            active = true;
            groupOwned = Boolean(child.pid) && process.platform !== 'win32';
            child.stdout.on('data', output);
            child.stderr.on('data', output);
            child.once('exit', () => { active = false; });
            child.once('error', error => { active = false; finish(null, null, error); });
            child.once('close', (code, signal) => finish(code, signal));
            if (request.timeoutMs)
                timeout = setTimeout(() => stop('timeout'), request.timeoutMs);
        }
        catch (error) {
            finish(null, null, error);
        }
    });
}
