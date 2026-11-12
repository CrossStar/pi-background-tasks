import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const bridge = new URL('../../src/persistent/remote-bridge.mjs', import.meta.url);
test('remote bridge survives separate transports and preserves byte offsets', { timeout: 30000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
    function call(request, raw = false) {
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [bridge.pathname], { env: { ...process.env, PI_BG_SERVICE_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
            let output = '', errors = '';
            child.stdout.on('data', chunk => output += chunk);
            child.stderr.on('data', chunk => errors += chunk);
            child.on('error', reject);
            child.stdin.on('error', () => {});
            child.on('close', code => { try { assert.equal(code, 0, errors); resolve(JSON.parse(output)); } catch (e) { reject(e); } });
            const { op, ...params } = raw ? {} : request;
            child.stdin.end(raw ? request : JSON.stringify({ method: op, params }));
        });
    }
    let pid;
    try {
        const ready = await call({ op: 'ensure' });
        assert.equal(ready.ok, true);
        assert.equal(ready.result.protocol, 'pi-background-tasks-remote');
        assert.equal(ready.result.version, 1);
        assert.equal(ready.result.daemonProtocolVersion, 1);
        assert.equal(ready.result.serviceRoot, root);
        assert.equal(ready.result.runtime.node, process.version);
        assert.equal(ready.result.runtime.platform, process.platform);
        assert.equal((await call(JSON.stringify({ op: 'ensure' }), true)).ok, false);
        pid = ready.result.pid;
        const start = { op: 'start', id: 'once', cwd: root, name: 'survivor', command: "printf '\\000\\377\\342\\202\\254'; printf x >> marker; sleep 20" };
        const admitted = await call(start);
        assert.equal(admitted.ok, true);
        assert.equal(admitted.result.capability, undefined);
        assert.equal((await call({ op: 'get', id: 'once' })).result.status, 'running');
        // Ignore the first admission response and retry the stable identity.
        assert.equal((await call(start)).result.startedAt, admitted.result.startedAt);
        assert.equal(fs.readFileSync(path.join(root, 'marker'), 'utf8'), 'x');
        assert.equal((await call({ op: 'list', cwd: root })).result.records.length, 1);
        assert.equal((await call({ op: 'list', cwd: '/elsewhere' })).result.records.length, 0);
        assert.equal((await call({ op: 'list', offset: 50 })).result.records.length, 0);
        const a = (await call({ op: 'logs', id: 'once', maxBytes: 3 })).result;
        const b = (await call({ op: 'logs', id: 'once', offset: a.nextOffset, maxBytes: 2 })).result;
        assert.deepEqual(Buffer.concat([Buffer.from(a.data, 'base64'), Buffer.from(b.data, 'base64')]), Buffer.from([0,255,226,130,172]));
        assert.equal(a.eof, false);
        assert.equal(b.eof, true);
        assert.equal(b.nextOffset, 5);
        assert.equal((await call({ op: 'logs', id: 'once', maxBytes: 49153 })).ok, false);
        assert.equal((await call({ op: 'start', id: 'bad', cwd: 'relative', name: '', command: '' })).error.taskId, 'bad');
        assert.equal((await call('{}{}', true)).ok, false);
        assert.equal((await call(' '.repeat(1048577), true)).ok, false);
        assert.equal((await call({ op: 'cancel', id: 'once' })).ok, true);
        let terminal;
        for (let attempt = 0; attempt < 100; attempt++) {
            terminal = await call({ op: 'get', id: 'once' });
            if (terminal.result.status !== 'running') break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(terminal.result.status, 'killed');
        assert.equal((await call(start)).result.status, 'killed');
        assert.equal(fs.readFileSync(path.join(root, 'marker'), 'utf8'), 'x');
    } finally {
        await call({ op: 'cancel', id: 'once' });
        if (pid) process.kill(pid, 'SIGTERM');
        fs.rmSync(root, { recursive: true, force: true });
    }
});
