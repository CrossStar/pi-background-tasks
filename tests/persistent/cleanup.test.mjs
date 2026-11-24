import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {cleanupServiceRoot, guardServiceRoot} from '../helpers/service-cleanup.mjs';

test('cleanup after fixture failure reaps TERM-resistant descendants and preserves other roots', {timeout:15000}, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'bg-cleanup-test-'));
    guardServiceRoot(t,root);
    const other = fs.mkdtempSync(path.join(os.tmpdir(),'bg-cleanup-other-'));
    guardServiceRoot(t,other);
    fs.writeFileSync(path.join(other,'daemon.mjs'), "setInterval(()=>{},1000);console.log('ready');");
    const unrelated = spawn(process.execPath,[path.join(other,'daemon.mjs')],{env:{...process.env,PI_BG_SERVICE_DIR:other},stdio:['ignore','pipe','inherit']});
    await once(unrelated.stdout,'data');
    fs.writeFileSync(path.join(root,'supervisor.mjs'), "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready');");
    fs.writeFileSync(path.join(root,'daemon.mjs'), `import {spawn} from 'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(path.join(root,'supervisor.mjs'))}],{env:{},stdio:['ignore','pipe','inherit']});child.stdout.once('data',()=>console.log('ready'));setInterval(()=>{},1000);`);
    const child = spawn(process.execPath,[path.join(root,'daemon.mjs')],{env:{...process.env,PI_BG_SERVICE_DIR:root},stdio:['ignore','pipe','inherit']});
    await assert.rejects(async () => {
        try { await once(child.stdout,'data'); throw Error('injected fixture failure'); }
        finally { await cleanupServiceRoot(root); }
    }, /injected fixture failure/);
    assert.equal(fs.existsSync(root),false);
    assert.notEqual(child.signalCode,null);
    process.kill(unrelated.pid,0);
    assert.equal(fs.existsSync(other),true);
});
