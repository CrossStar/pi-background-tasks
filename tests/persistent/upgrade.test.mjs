import {guardServiceRoot} from '../helpers/service-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {endpoint, rpc} from '../../src/persistent/shared.mjs';

const bridge = new URL('../../src/persistent/remote-bridge.mjs', import.meta.url).pathname;
function call(root, method, params = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [bridge], {env: {...process.env, HOME: root, PI_BG_SERVICE_DIR: root}, stdio: ['pipe','pipe','pipe']});
        let out = ''; child.stdout.on('data', b => out += b); child.stderr.resume();
        child.on('error', reject);
        child.on('close', () => { try { const r = JSON.parse(out); r.ok ? resolve(r.result) : reject(Error(r.error.message)); } catch(e) { reject(e); } });
        child.stdin.end(JSON.stringify({method, params}));
    });
}
async function fixture(t, name = 'daemon.mjs') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-upgrade-'));
    guardServiceRoot(t, root);
    const shared = fs.readFileSync(new URL('../../src/persistent/shared.mjs', import.meta.url), 'utf8').replace('request.version !== 2', 'request.version !== 1');
    fs.writeFileSync(path.join(root, 'shared.mjs'), shared);
    fs.writeFileSync(path.join(root, name), `import {server,endpoint} from './shared.mjs'; server(() => ({pid:process.pid,startToken:'fixture',protocolVersion:1})).listen(endpoint('daemon'),()=>console.log('ready'));`);
    const old = spawn(process.execPath, [path.join(root, name)], {env: {...process.env, PI_BG_SERVICE_DIR: root}, stdio:['ignore','pipe','inherit']});
    await once(old.stdout, 'data');
    return {root,old};
}
test('concurrent bridge takeover kills only identified v1 daemon; legacy records stay invisible', {timeout:20000}, async t => {
    const {root,old} = await fixture(t);
    const supervisorPath = path.join(root,'supervisor.mjs'); fs.writeFileSync(supervisorPath,'setInterval(()=>{},1000);');
    const supervisor = spawn(process.execPath,[supervisorPath],{env:{...process.env,PI_BG_SERVICE_DIR:root},stdio:'ignore'});
    const ready = await Promise.all(Array.from({length:4},()=>call(root,'ensure')));
    const pid = ready[0].pid;
    assert.ok(ready.every(r=>r.pid===pid)); assert.notEqual(pid,old.pid);
    process.kill(supervisor.pid,0);
    const dir = path.join(root,'tasks','legacy'); fs.mkdirSync(dir);
    const original = JSON.stringify({id:'legacy',ownerSession:'owner',status:'running',slurm:{jobId:'42'},sources:[{pattern:'**'}]});
    fs.writeFileSync(path.join(dir,'record.json'),original); fs.writeFileSync(path.join(dir,'sources.json'),'{invalid');
    for (const ownerSession of [undefined,'owner','foreign']) {
        const list = await call(root,'list',{ownerSession}); assert.deepEqual(list.records,[]); assert.deepEqual(list.diagnostics,[]);
        assert.equal(await call(root,'get',{id:'legacy',ownerSession}),null);
    }
    await assert.rejects(call(root,'start',{id:'legacy',cwd:root,name:'collision',command:'true'}),/legacy/);
    assert.equal(fs.readFileSync(path.join(dir,'record.json'),'utf8'),original);
    assert.equal((await rpc(endpoint('daemon',root),'ping',{},root)).protocolVersion,2);
});
test('unidentifiable protocol-1 responder fails with actionable error and stays alive', {timeout:15000}, async t => {
    const {root,old} = await fixture(t,'unidentified.mjs');
    await assert.rejects(call(root,'ensure'),/Cannot safely replace legacy daemon.*manually/);
    process.kill(old.pid,0);
});
