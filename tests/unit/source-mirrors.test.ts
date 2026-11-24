import {mkdtempSync, rmSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureRemote} from '../../src/core/remote-persistent.ts';
import {BackgroundTaskRegistry, acquireProcessRegistry, releaseProcessRegistry} from '../../src/core/registry.ts';
import type {TaskRecord} from '../../src/persistent/client.ts';

test('v2 reload ignores the old process registry without mutating it', () => {
 const key=Symbol.for('pi-background-tasks.process-registry.v1');
 const old=Reflect.get(process,key);
 const marker={registries:new Map([['old', {sentinel:true}]])};
 Reflect.set(process,key,marker);
 const ctx={cwd:tmpdir(),sessionId:'v2-namespace-test'};
 const isolated = mkdtempSync(join(tmpdir(),'registry-guard-'));
 const registry=new BackgroundTaskRegistry({env:{PI_BG_SERVICE_DIR:join(isolated,'service')},sendCompletionNotification(){}});
 try {assert.equal(acquireProcessRegistry(ctx,registry),registry);assert.equal(Reflect.get(process,key),marker);assert.equal(marker.registries.size,1);}
 finally {releaseProcessRegistry(ctx,registry);registry.detachHost();rmSync(isolated,{recursive:true,force:true});if(old===undefined)Reflect.deleteProperty(process,key);else Reflect.set(process,key,old);}
});

test('registry accepts a deduplicated Slurm ID and retains its original cwd and metadata', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'dedupe-registry-'));
 const record: TaskRecord={id:'existing',ownerSession:'owner',cwd:'/original',name:'original monitor',command:'slurm attach 42',slurm:{jobId:'42'},status:'running',startedAt:1,outputFile:'/original/digest',outputBytes:0,notifyOnCompletion:false,triggerOnCompletion:false};
 const provider={id:'endpoint',cwd:'/new',spawn(){throw Error('forbidden');},persistent:{async start(){return record;},async get(){return record;},async cancel(){return {...record,status:'killed' as const};},async list(){return Object.assign([record],{diagnostics:[]});},async logs(){throw Error('empty output should not be read');}}};
 const registry=new BackgroundTaskRegistry({env:{PI_BG_SERVICE_DIR:join(cwd,'service')},resolveExecution:()=>provider,sendCompletionNotification(){throw Error('unexpected wake');}});
 try {const ctx={cwd,sessionId:'owner',modelRegistry:{getAll:()=>[]}};
 const first=await registry.startTask(ctx,'slurm attach 42',{slurm:{jobId:'42'}});
 const duplicate=await registry.startTask(ctx,'slurm attach 42',{slurm:{jobId:'42'}});
 assert.equal(first,duplicate);assert.equal(first.id,'existing');assert.equal(first.execution?.cwd,'/original');assert.equal(first.name,'original monitor');assert.equal(first.notifyOnCompletion,false);
 await first.metadataWriteChain;
 } finally {registry.detachHost();await rm(cwd,{recursive:true,force:true});}
});

test('local dedupe removes the polling placeholder without launching a daemon', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'local-dedupe-'));
 const registry=new BackgroundTaskRegistry({env:{PI_BG_SERVICE_DIR:join(cwd,'service')},sendCompletionNotification(){}});
 const record:TaskRecord={id:'existing',ownerSession:'owner',cwd,name:'monitor',command:'attach',slurm:{jobId:'42'},status:'running',startedAt:1,outputFile:join(cwd,'digest'),outputBytes:0};
 Reflect.set(registry,'durableTasks',new Set());
 Reflect.set(registry,'durableClient',{async start(){return record;},async get(){return record;},async list(){throw Error('unexpected discovery');},async cancel(){throw Error('unexpected control');}});
 try {const ctx={cwd,sessionId:'owner',modelRegistry:{getAll:()=>[]}};
 const first=await registry.startTask(ctx,'attach',{slurm:{jobId:'42'},localSlurm:true});
 assert.equal(await registry.startTask(ctx,'attach',{slurm:{jobId:'42'},localSlurm:true}),first);
 const tracked:unknown=Reflect.get(registry,'durableTasks');assert.ok(tracked instanceof Set);assert.equal(tracked.size,1);
 } finally {registry.detachHost();await rm(cwd,{recursive:true,force:true});}
});

test('mirror-only reads fill four MiB in eight bounded transfers', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'mirror-batch-'));const bytes=Buffer.alloc(4*1024*1024,97);let calls=0;
 const record:TaskRecord={id:'batch',ownerSession:'owner',cwd:'/work',name:'batch',command:'test',status:'running',startedAt:1,outputFile:'/work/digest',outputBytes:0,sources:[{id:'log',label:'log',kind:'file',location:'remote',path:'/work/log'}]};
 const read=async (_id:string,offset:number,count:number)=>{const data=bytes.subarray(offset,offset+count);return {data:data.toString('base64'),nextOffset:offset+data.length,size:bytes.length,eof:offset+data.length===bytes.length,identity:'inode'};};
 const client=captureRemote({id:'endpoint',cwd:'/work',spawn(){throw Error('forbidden');},persistent:{async start(){return record;},async get(){return record;},async cancel(){return record;},async list(){return Object.assign([record],{diagnostics:[]});},logs:read,async mirrorLogs(id,offset,count){calls++;assert.ok(count<=524288);return read(id,offset,count);}}},cwd,1000,'owner');assert.ok(client);
 try {await client.get('batch');assert.equal(calls,8);assert.equal(client.cachedWindowCount(),1);client.release();assert.equal(client.cachedWindowCount(),0);}
 finally {client.release();await rm(cwd,{recursive:true,force:true});}
});

test('source mirrors reuse unchanged ranges, recover replacement and retain terminal head plus tail', async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'source-window-'));
 const oldTail = process.env['PI_BG_SOURCE_TAIL_BYTES'];
 const oldHead = process.env['PI_BG_SOURCE_HEAD_BYTES'];
 process.env['PI_BG_SOURCE_TAIL_BYTES']='100'; process.env['PI_BG_SOURCE_HEAD_BYTES']='20';
 let bytes=Buffer.alloc(200, 97), identity='inode1', transferred=0;
 const record: TaskRecord={id:'one',ownerSession:'owner',cwd:'/work',name:'test',command:'test',status:'running',startedAt:1,outputFile:'/work/digest',outputBytes:0,sources:[{id:'log',label:'train',kind:'file',location:'remote',path:'/work/train'}]};
 const provider={id:'endpoint',cwd:'/work',spawn(){throw Error('forbidden');},persistent:{
 async start(){return record;},async get(){return record;},async cancel(){return record;},async list(){return Object.assign([record],{diagnostics:[]});},
 async logs(_id:string,offset:number,count:number){const chunk=bytes.subarray(offset,offset+count);transferred+=chunk.length;return {data:chunk.toString('base64'),nextOffset:offset+chunk.length,size:bytes.length,eof:offset+chunk.length===bytes.length,identity};}
 }};
 try {
 const client=captureRemote(provider,cwd,1000,'owner'); assert.ok(client);
 let result=await client.get('one'); assert.deepEqual(result.sources?.[0]?.ranges,[{start:100,end:200}]);
 transferred=0; await client.get('one'); assert.ok(transferred<=65,'only metadata and anchor read');
 bytes=Buffer.concat([bytes,Buffer.from('new\n')]); transferred=0;
 result=await client.get('one'); assert.ok(transferred<=69); assert.ok(result.sources?.[0]?.cachedAt);
 identity='inode2'; bytes=Buffer.from('replacement\n');
 result=await client.get('one'); const file=result.sources?.[0]?.mirrorPath; assert.ok(file);
 assert.match(await readFile(file,'utf8'),/replacement/); assert.doesNotMatch(await readFile(file,'utf8'),/aaaa/);
 assert.equal(client.cachedWindowCount(),1);client.release('one');assert.equal(client.cachedWindowCount(),0);
 await client.get('one');
 bytes=Buffer.alloc(400,98);record.status='completed';
 result=await client.get('one');assert.deepEqual(result.sources?.[0]?.ranges,[{start:0,end:20},{start:300,end:400}]);assert.equal(client.cachedWindowCount(),0);
 } finally {if(oldTail===undefined)delete process.env['PI_BG_SOURCE_TAIL_BYTES'];else process.env['PI_BG_SOURCE_TAIL_BYTES']=oldTail;if(oldHead===undefined)delete process.env['PI_BG_SOURCE_HEAD_BYTES'];else process.env['PI_BG_SOURCE_HEAD_BYTES']=oldHead;await rm(cwd,{recursive:true,force:true});}
});
