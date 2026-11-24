import {guardServiceRoot} from '../helpers/service-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
test('local concurrent ensures replace a verified protocol-1 daemon', {timeout:20000}, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-local-upgrade-'));
    guardServiceRoot(t, root);
    fs.writeFileSync(path.join(root,'shared.mjs'),fs.readFileSync(new URL('../../src/persistent/shared.mjs',import.meta.url),'utf8').replace('request.version !== 2','request.version !== 1'));
    fs.writeFileSync(path.join(root,'daemon.mjs'),"import {server,endpoint} from './shared.mjs'; server(()=>({pid:process.pid,startToken:'old',protocolVersion:1})).listen(endpoint('daemon'),()=>console.log('ready'));");
    const old = spawn(process.execPath,[path.join(root,'daemon.mjs')],{env:{...process.env,PI_BG_SERVICE_DIR:root},stdio:['ignore','pipe','ignore']});
    await new Promise<void>(resolve=>old.stdout.once('data',()=>resolve()));
    const {createClient} = await import('../../src/persistent/client.js');
    const {rpc,endpoint} = await import('../../src/persistent/shared.mjs');
    try {
        const attempts = await Promise.allSettled(Array.from({length:4},()=>createClient({root}).ensureService()));
        for (const result of attempts) if (result.status === 'rejected') throw result.reason;
        const identity = await rpc(endpoint('daemon',root),'ping',{},root) as {pid:number;protocolVersion:number};
        assert.notEqual(identity.pid,old.pid); assert.equal(identity.protocolVersion,2);
    } finally {
        // The root guard catches detached concurrent starters as well as the answering daemon.
    }
});
test('scoped client rejects old daemon without sending operations or replacing it', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-old-'));
    guardServiceRoot(t, root);
    const {endpoint} = await import('../../src/persistent/shared.mjs');
    const {createClient} = await import('../../src/persistent/client.js');
    const methods: string[] = [];
    const service = net.createServer(socket => {
        let text = '';
        socket.on('data', chunk => {
            text += chunk;
            if (!text.includes('\n')) return;
            methods.push(JSON.parse(text).method);
            socket.end(JSON.stringify({result:{pid:process.pid,startToken:'old',protocolVersion:1}})+'\n');
        });
    });
    await new Promise<void>(resolve=>service.listen(endpoint('daemon',root),resolve));
    try {
        const client = createClient({root});
        await assert.rejects(client.get('a','A'),/Unsupported persistent protocol/);
        await assert.rejects(client.cancel('a','A'),/Unsupported persistent protocol/);
        await assert.rejects(client.list(root,'A'),/Unsupported persistent protocol/);
        assert.ok(methods.every(method=>method==='ping'));
        assert.ok(service.listening);
    } finally {
        await new Promise<void>(resolve=>service.close(()=>resolve()));
    }
});
test('durable supervisors survive daemon restart and deduplicate admission', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-persist-'));
    guardServiceRoot(t, root);
    const client = (await import('../../src/persistent/client.js')).createClient({ root });
    const { rpc, endpoint } = await import('../../src/persistent/shared.mjs');
    await client.ensureService();
    async function daemonPid() { const identity = await rpc(endpoint('daemon', root), 'ping', {}, root) as {
        pid: number;
    }; return identity.pid; }
    let daemon = await daemonPid();
    const wait = async (id: string) => { for (let i = 0; i < 200; i++) {
        const r = await client.get(id);
        assert.ok(r);
        if (r.diagnostic?.startsWith('unknown'))
            throw Error(r.diagnostic);
        if (r.status !== 'running')
            return r;
        await new Promise(r => setTimeout(r, 25));
    } throw Error('deadline'); };
    try {
        await client.ensureService();
        const request = { ownerSession: 'A', id: 'once', cwd: root, name: 'once', command: 'node', shell: process.execPath, args: ['-e', 'require("fs").appendFileSync("counter","1");setTimeout(()=>{console.log("done");process.exit(7)},700)'], env: {}, timeoutSeconds: 5, maxOutputBytes: 1000 };
        await Promise.all([client.start(request), client.start(request)]);
        process.kill(daemon, 'SIGKILL');
        await new Promise(r => setTimeout(r, 100));
        await client.ensureService();
        daemon = await daemonPid();
        const result = await wait('once');
        assert.equal(result.exitCode, 7);
        assert.equal(fs.readFileSync(result.outputFile, 'utf8'), 'done\n');
        await assert.rejects(client.start({...request,ownerSession:'B'}),/ownership mismatch/);
        await assert.rejects(client.start({...request,ownerSession:undefined}),/ownership mismatch/);
        await assert.rejects(client.get('once','B'),/ownership mismatch/);
        await assert.rejects(client.cancel('once','B'),/ownership mismatch/);
        await assert.rejects(client.list(root,''),/Invalid ownerSession/);
        assert.equal((await client.get('once','A'))?.id,'once');
        assert.equal((await client.list(root,'A')).length,1);
        assert.equal((await client.list(root,'B')).length,0);
        assert.equal((await client.start(request)).exitCode, 7);
        assert.equal((await client.cancel('once')).status,'failed');
        assert.equal((await client.cancel('once')).exitCode,7);
        const legacyDir = path.join(root,'tasks','legacy-owned');
        fs.mkdirSync(legacyDir);
        const legacy = JSON.stringify({id:'legacy-owned',ownerSession:'A',status:'running',sources:[{pattern:'**'}]});
        fs.writeFileSync(path.join(legacyDir,'record.json'),legacy);
        fs.writeFileSync(path.join(legacyDir,'sources.json'),'{invalid');
        assert.equal(await client.get('legacy-owned','A'),null);
        assert.equal(await client.get('legacy-owned','B'),null);
        assert.ok(!(await client.list(root,'A')).some(row=>row.id==='legacy-owned'));
        assert.equal(fs.readFileSync(path.join(legacyDir,'record.json'),'utf8'),legacy);
        fs.mkdirSync(path.join(root,'tasks','interrupted'));
        fs.mkdirSync(path.join(root,'tasks','corrupt'));
        fs.writeFileSync(path.join(root,'tasks','corrupt','record.json'),'{bad json');
        const restored=await client.list(root);
        assert.ok(restored.some(task=>task.id==='once'&&task.exitCode===7));
        assert.deepEqual(restored.diagnostics.map(item=>item.id).sort(),['corrupt','interrupted']);
        for (let i=0;i<51;i++) {
            const id = `aaa-${i}`;
            const dir = path.join(root,'tasks',id);
            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(dir,'record.json'),JSON.stringify({...result,id,ownerSession:'B',outputFile:path.join(dir,'output.log')}));
        }
        const scoped = await client.list(root,'A');
        assert.deepEqual(scoped.map(item=>item.id),['once']);
        assert.ok(scoped.diagnostics.every(item=>item.id==='unknown'&&item.message==='unreadable admission'));
        assert.equal((await client.list(root,'B')).length,51);
        assert.equal(fs.readFileSync(path.join(root, 'counter'), 'utf8'), '1');
        const duplicate = spawn(process.execPath, ['src/persistent/supervisor.mjs', 'once'], { env: { ...process.env, PI_BG_SERVICE_DIR: root }, stdio: ['pipe', 'ignore', 'ignore'] });
        duplicate.stdin.end(JSON.stringify({ cwd: root, shellExecutable: request.shell, shellArgs: request.args, environment: {}, outputCapBytes: 1000 }));
        const duplicateCode = await new Promise(resolve => duplicate.once('exit', resolve));
        assert.notEqual(duplicateCode, 0);
        assert.equal(fs.readFileSync(path.join(root, 'counter'), 'utf8'), '1');
        if (process.platform === 'linux') for (const pipeMode of ['inherit','ignore']) {
            const treeId='tree-'+pipeMode;
            const heartbeat = path.join(root, 'heartbeat-'+pipeMode);
            const pidFile = path.join(root, 'descendant-'+pipeMode+'.pid');
            const descendant = `const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20)`;
            const leader = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:${JSON.stringify(pipeMode)}});setInterval(()=>{},1000)`;
            await client.start({...request,id:treeId,args:['-e',leader],timeoutSeconds:10});
            for(let i=0;i<100&&!fs.existsSync(heartbeat);i++) await new Promise(resolve=>setTimeout(resolve,20));
            assert.ok(fs.existsSync(heartbeat),'descendant ready before cancellation');
            const descendantPid=Number(fs.readFileSync(pidFile,'utf8'));
            function descendantRunning() {
                try { return fs.readFileSync(`/proc/${descendantPid}/stat`,'utf8').split(') ')[1]?.[0] !== 'Z'; }
                catch {return false;}
            }
            try {
                await client.cancel(treeId);
                let terminal=await client.get(treeId);
                assert.ok(terminal);
                for(let i=0;i<160&&terminal.status==='running';i++) {
                    await new Promise(resolve=>setTimeout(resolve,25));
                    terminal=await client.get(treeId);
                    assert.ok(terminal);
                }
                assert.notEqual(terminal.status,'running');
                assert.ok(terminal.status==='killed'||(terminal.status==='failed'&&terminal.diagnostic?.startsWith('unknown:')));
                assert.equal(descendantRunning(),false,'TERM-ignoring descendant must receive escalation');
                const size=fs.statSync(heartbeat).size;
                await new Promise(resolve=>setTimeout(resolve,100));
                assert.equal(fs.statSync(heartbeat).size,size);
            } finally {
                if(descendantRunning())process.kill(descendantPid,'SIGKILL');
            }
        }
        for (const [id, args, timeout] of [['timeout', ['-e', 'setInterval(()=>{},1000)'], 0.1], ['cap', ['-e', 'setTimeout(()=>console.log("x".repeat(5000)),200)'], 5], ['cancel', ['-e', 'setInterval(()=>{},1000)'], 5]] as const) {
            await client.start({ ...request, id, args: [...args], timeoutSeconds: timeout });
            if (id !== 'cancel') {
                process.kill(daemon, 'SIGKILL');
                await new Promise(r => setTimeout(r, 350));
                await client.ensureService();
                daemon = await daemonPid();
            }
            if (id === 'cancel') {
                await new Promise(r => setTimeout(r, 150));
                await client.cancel(id);
            }
            const r = await wait(id);
            assert.equal(r.status, id === 'cancel' ? 'killed' : 'failed');
            assert.ok(fs.statSync(r.outputFile).size <= 1000);
        }
    }
    finally {
        // Cleanup uses /proc identity, never an ensure call that could start another daemon.
    }
});
