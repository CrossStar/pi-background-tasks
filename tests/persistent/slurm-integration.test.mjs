import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {watchSlurm} from '../../src/persistent/slurm-watch.mjs';

test('v2 bridge attaches, deduplicates, restores ownership and stops only the monitor', {timeout: 30000}, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-slurm-e2e-'));
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    const commands = path.join(root, 'commands');
    for (const name of ['sacct', 'scontrol', 'scancel']) {
        fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(commands)},JSON.stringify([${JSON.stringify(name)},...process.argv.slice(2)])+'\\n');\n${name === 'sacct' ? "console.log('42|RUNNING|0:0');" : name === 'scontrol' ? `console.log(${JSON.stringify('WorkDir=' + root + ' StdOut=' + path.join(root, 'train.log') + ' StdErr=' + path.join(root, 'train.log'))});` : "process.exit(99);"}`, {mode: 0o700});
    }
    const logfile = path.join(root, 'train.log'); fs.writeFileSync(logfile, 'loss: 0.5\n');
    const oldRoot = path.join(root, '.pi', 'background-tasks-remote');
    fs.mkdirSync(oldRoot, {recursive:true}); fs.writeFileSync(path.join(oldRoot,'sentinel'),'old service untouched');
    const env = {...process.env, HOME: root, PI_BG_SERVICE_DIR: '', PATH: bin + path.delimiter + process.env.PATH};
    const localRoot = spawnSync(process.execPath, ['--input-type=module', '-e', `import {serviceRoot} from ${JSON.stringify(new URL('../../src/persistent/shared.mjs', import.meta.url).href)}; console.log(serviceRoot());`], {env,encoding:'utf8'});
    assert.equal(localRoot.status,0);assert.equal(localRoot.stdout.trim(),path.join(root,'.pi','background-tasks-v2'));
    const call = (method, params = {}, serviceEnv = env) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [new URL('../../src/persistent/remote-bridge.mjs', import.meta.url).pathname], {env: serviceEnv, stdio: ['pipe', 'pipe', 'pipe']});
        let text = ''; child.stdout.on('data', data => text += data); child.stderr.resume();
        child.on('error', reject); child.on('close', () => {
            try { const response = JSON.parse(text); response.ok ? resolve(response.result) : reject(Error(response.error.message)); } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify({method, params}));
    });
    let pid, secondPid;
    const secondEnv = {...env, PI_BG_SERVICE_DIR: path.join(root, 'other-endpoint')};
    try {
        const ready = await call('ensure'); pid = ready.pid;
        assert.equal(ready.serviceRoot,path.join(root,'.pi','background-tasks-remote-v2'));
        assert.equal(fs.readFileSync(path.join(oldRoot,'sentinel'),'utf8'),'old service untouched');
        const request = {id: 'monitor-one', cwd: root, name: 'Slurm 42', command: 'slurm attach 42', ownerSession: 'owner', slurm: {jobId: '42', logs: {files: [logfile]}}};
        fs.mkdirSync(path.join(ready.serviceRoot,'tasks','corrupt'));
        fs.writeFileSync(path.join(ready.serviceRoot,'tasks','corrupt','record.json'),'{broken');
        const first = await call('start', request);
        const duplicate = await call('start', {...request, id: 'monitor-two'});
        assert.equal(duplicate.id, first.id);
        secondPid = (await call('ensure', {}, secondEnv)).pid;
        const otherEndpoint = await call('start', {...request, id:'other-endpoint'}, secondEnv);
        assert.notEqual(otherEndpoint.id, first.id);
        await call('cancel', {id:otherEndpoint.id, ownerSession:'owner'}, secondEnv);
        const otherOwner = await call('start', {...request, id: 'other-owner', ownerSession: 'other'});
        const otherIndex = await call('start', {...request, id: 'other-index', slurm: {...request.slurm, arrayTaskId: 2}});
        assert.notEqual(otherOwner.id, first.id); assert.notEqual(otherIndex.id, first.id);
        await call('cancel', {id: otherOwner.id, ownerSession: 'other'});
        await call('cancel', {id: otherIndex.id, ownerSession: 'owner'});
        assert.equal(Buffer.from((await call('logs', {id: first.id, ownerSession: 'owner', source: 'array-3-stdout'})).data,'base64').toString(),'loss: 0.5\n');
        assert.deepEqual((await call('list', {cwd: root, ownerSession: 'unrelated'})).records, []);
        await assert.rejects(call('get', {id: first.id, ownerSession: 'other'}), /ownership/);
        let record;
        for (let attempt = 0; attempt < 30; attempt++) {
            record = await call('get', {id: first.id, ownerSession: 'owner'});
            if (record.sources?.some(source => source.kind === 'file')) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        const manifest = path.join(ready.serviceRoot,'tasks',first.id,'sources.json');
        const savedManifest = fs.readFileSync(manifest);
        fs.writeFileSync(manifest,'{invalid');
        try { await assert.rejects(call('logs',{id:first.id,ownerSession:'foreign'}),/ownership/); }
        finally { fs.writeFileSync(manifest,savedManifest); }
        const source = record.sources.find(source => source.kind === 'file');
        assert.ok(source);
        assert.equal(Buffer.from((await call('logs', {id: first.id, ownerSession: 'owner', source: source.id})).data, 'base64').toString(), 'loss: 0.5\n');
        assert.equal(Buffer.from((await call('mirrorLogs', {id:first.id,ownerSession:'owner',source:source.id,maxBytes:524288})).data,'base64').toString(),'loss: 0.5\n');
        await assert.rejects(call('logs', {id:first.id,ownerSession:'owner',source:source.id,maxBytes:524288}),/integer/);
        await assert.rejects(call('logs', {id: first.id, ownerSession: 'owner', source: '/etc/passwd'}), /Unregistered/);
        assert.equal((await call('list', {cwd: root, ownerSession: 'owner'})).records.find(row => row.id === first.id).slurm.jobId, '42');
        await call('cancel', {id: first.id, ownerSession: 'owner'});
        for (let attempt = 0; attempt < 30; attempt++) {
            record = await call('get', {id: first.id, ownerSession: 'owner'});
            if (record.status !== 'running') break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(record.status, 'killed');
        const invocations = fs.readFileSync(commands, 'utf8').trim().split('\n').map(JSON.parse);
        assert.ok(invocations.length > 0);
        assert.ok(invocations.every(([command, ...args]) => command === 'sacct' || (command === 'scontrol' && args.slice(0, 3).join(' ') === 'show job -o')));
    } finally {
        try { await call('cancel', {id: 'monitor-one', ownerSession: 'owner'}); } catch {}
        for (const [id, ownerSession] of [['other-owner','other'],['other-index','owner']]) {
            try { await call('cancel', {id, ownerSession}); } catch {}
        }
        assert.deepEqual(fs.readdirSync(oldRoot),['sentinel']);
        try { await call('cancel', {id:'other-endpoint',ownerSession:'owner'}, secondEnv); } catch {}
        if (secondPid) process.kill(secondPid, 'SIGTERM');
        if (pid) process.kill(pid, 'SIGTERM');
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('watcher uses injected time to settle and performs a final log read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-watch-clock-'));
    try {
        const log = path.join(root, 'train.log'); fs.writeFileSync(log, 'step 1\n');
        let now = 0; const output = [];
        const code = await watchSlurm({record: {cwd: root, outputFile: path.join(root, 'digest'), slurm: {jobId: '42', logs: {files: [log]}}},
            call: async method => method === 'slurmStatus' ? {records: [{id: '42', state: 'COMPLETED', exitCode: '0:0'}], observedAt: now} : true,
            output: bytes => output.push(bytes.toString()), signal: new AbortController().signal,
            now: () => now, sleep: async ms => { now += ms; if (now === 8000) fs.appendFileSync(log, 'eval final\n'); }});
        assert.equal(code, 0); assert.ok(now >= 10000);
        assert.match(output.join(''), /eval final/); assert.match(output.join(''), /Final sacct/);
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
