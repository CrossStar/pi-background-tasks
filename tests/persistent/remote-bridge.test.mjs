import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { endpoint } from '../../src/persistent/shared.mjs';
import { spawn } from 'node:child_process';
const bridge = new URL('../../src/persistent/remote-bridge.mjs', import.meta.url);
test('remote bridge rejects a daemon without ownership capability before scoped operations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-old-'));
    const methods = [];
    const service = net.createServer(socket => {
        let text = '';
        socket.on('data', chunk => {
            text += chunk;
            if (!text.includes('\n')) return;
            methods.push(JSON.parse(text).method);
            socket.end(JSON.stringify({result:{pid:process.pid,startToken:'old',protocolVersion:1}})+'\n');
        });
    });
    await new Promise(resolve=>service.listen(endpoint('daemon',root),resolve));
    try {
        for (const method of ['start','get','list','cancel','logs']) {
            const response = await new Promise((resolve,reject)=>{
                const child = spawn(process.execPath,[bridge.pathname],{env:{...process.env,PI_BG_SERVICE_DIR:root},stdio:['pipe','pipe','inherit']});
                let text = '';
                child.stdout.on('data',chunk=>text+=chunk);
                child.on('error',reject);
                child.on('close',()=>resolve(JSON.parse(text)));
                child.stdin.end(JSON.stringify({method,params:{id:'a',cwd:root,name:'a',command:'true',ownerSession:'A'}}));
            });
            assert.equal(response.ok,false);
            assert.match(response.error.message,/Incompatible daemon protocol/);
        }
        assert.ok(methods.every(method=>method==='ping'));
        assert.ok(service.listening);
    } finally {
        await new Promise(resolve=>service.close(resolve));
        fs.rmSync(root,{recursive:true,force:true});
    }
});
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
        assert.equal(ready.result.version, 2);
        assert.equal(ready.result.daemonProtocolVersion, 2);
        assert.equal(ready.result.serviceRoot, root);
        assert.equal(ready.result.runtime.node, process.version);
        assert.equal(ready.result.runtime.platform, process.platform);
        assert.equal((await call(JSON.stringify({ op: 'ensure' }), true)).ok, false);
        assert.equal(ready.result.sessionOwnership, 1);
        pid = ready.result.pid;
        const start = { op: 'start', id: 'once', cwd: root, name: 'survivor', ownerSession: 'A', command: "printf '\\000\\377\\342\\202\\254'; printf x >> marker; sleep 20" };
        const admitted = await call(start);
        assert.equal(admitted.ok, true);
        assert.equal(admitted.result.capability, undefined);
        assert.equal((await call({ op: 'get', id: 'once' })).result.status, 'running');
        // Ignore the first admission response and retry the stable identity.
        assert.equal((await call(start)).result.startedAt, admitted.result.startedAt);
        assert.equal(fs.readFileSync(path.join(root, 'marker'), 'utf8'), 'x');
        assert.equal((await call({...start, ownerSession:'B'})).ok, false);
        for (const ownerSession of ['B', 'unknown']) {
            for (const op of ['get','cancel','logs']) {
                const denied = await call({op,id:'once',ownerSession});
                assert.equal(denied.ok,false);
                assert.match(denied.error.message,/ownership mismatch/);
            }
        }
        assert.equal((await call({op:'list',cwd:root,ownerSession:'A'})).result.records.length,1);
        assert.equal((await call({op:'list',cwd:root,ownerSession:'B'})).result.records.length,0);
        assert.equal((await call({...start,id:'owned-b',ownerSession:'B',command:'true'})).ok,true);
        assert.deepEqual((await call({op:'list',cwd:root,ownerSession:'B'})).result.records.map(r=>r.id),['owned-b']);
        assert.equal((await call({op:'logs',id:'once',ownerSession:''})).ok,false);
        const legacy = await call({...start,id:'legacy',ownerSession:undefined,command:'true'});
        assert.equal(legacy.ok,true);
        for (const op of ['get','cancel','logs']) assert.equal((await call({op,id:'legacy',ownerSession:'A'})).ok,false);
        assert.equal((await call({ op: 'list', cwd: root })).result.records.length, 3);
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
