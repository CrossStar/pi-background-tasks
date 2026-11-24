import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateSources, expandSources, createSourceExpander, readSourceRange, SourceCursor, mirrorRanges} from '../../src/persistent/log-sources.mjs';
import {slurmCommand, parseAccounting, accountingOutcome, discoverSources, digestLines, keyRegex, digestWriter, watchSlurm} from '../../src/persistent/slurm-watch.mjs';

test('expansion is cached, capped and tolerates files disappearing during discovery', t => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'expansion-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 for(let i=0;i<140;i++)fs.writeFileSync(path.join(cwd,`log-${i}`),'');
 const sources=[{id:'glob',label:'glob',kind:'file',location:'local',path:cwd,pattern:'log-*'}];
 const original=fs.statSync;let removed=false;
 fs.statSync=(file,...args)=>{if(!removed){removed=true;fs.unlinkSync(file);}return original(file,...args);};
 let expanded;try{expanded=expandSources(sources,cwd);}finally{fs.statSync=original;}
 assert.equal(expanded.length,128);assert.match(expanded.diagnostic,/capped/);
 let clock=0,calls=0;const cached=createSourceExpander({now:()=>clock,expand:(...args)=>{calls++;return expandSources(...args);}});
 cached('id',sources,cwd);cached('id',sources,cwd);assert.equal(calls,1);
 clock=30000;cached('id',sources,cwd);assert.equal(calls,2);
});

test('empty accounting warns without failure and scalar discovery stops after success', async () => {
 let clock=0,discovery=0,registrations=0;const output=[];const controller=new AbortController();
 await watchSlurm({record:{cwd:os.tmpdir(),outputFile:path.join(os.tmpdir(),'unused'),slurm:{jobId:'42'}},now:()=>clock,sleep:async ms=>{clock+=ms;if(clock>240000)controller.abort();},signal:controller.signal,output:b=>output.push(b.toString()),execute:async()=>{discovery++;return 'WorkDir=/tmp StdOut=(null) StdErr=(null)';},call:async method=>{
 if(method==='registerSources'){registrations++;return true;}
 return {observedAt:clock,records:clock<160000?[]:[{id:'42',state:'RUNNING',exitCode:'0:0'}]};
 }});
 assert.match(output.join(''),/No accounting record after two minutes/);assert.equal(discovery,1);assert.equal(registrations,1);
});

test('source registration, legacy primary and restricted byte ranges', t => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-sources-'));
    t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
    const outputFile = path.join(cwd, 'primary');
    fs.writeFileSync(outputFile, 'primary');
    fs.writeFileSync(path.join(cwd, 'metrics'), 'loss: 1');
    const sources = validateSources([{id: 'metrics', label: 'Metrics', kind: 'file', location: 'local', path: 'metrics'}], cwd);
    const record = {cwd, outputFile, sources: JSON.parse(JSON.stringify(sources))};
    assert.equal(Buffer.from(readSourceRange({cwd, outputFile}).data, 'base64').toString(), 'primary');
    assert.equal(Buffer.from(readSourceRange(record, 'metrics', 2, 3).data, 'base64').toString(), 'ss:');
    assert.throws(() => readSourceRange(record, '/etc/passwd'), /Unregistered/);
    assert.throws(() => readSourceRange(record, 'metrics', -1), /range/);
    assert.throws(() => validateSources([...sources, ...sources], cwd), /Invalid/);
    assert.throws(() => validateSources([{...sources[0], pattern: '../*'}], cwd), /relative/);
    fs.symlinkSync(outputFile, path.join(cwd, 'symlink'));
    assert.throws(() => readSourceRange({...record, sources: [{...sources[0], path: path.join(cwd, 'symlink')}]}, 'metrics'));
});

test('cursor bounds initial tail, avoids duplicates and recovers replacement and truncate/regrow', t => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-cursor-'));
    t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
    const file = path.join(cwd, 'log');
    fs.writeFileSync(file, 'abcdef');
    const cursor = new SourceCursor(3);
    assert.equal(cursor.read(file).bytes.toString(), 'def');
    assert.equal(cursor.read(file).bytes.length, 0);
    fs.appendFileSync(file, 'ghi');
    assert.equal(cursor.read(file).bytes.toString(), 'ghi');
    fs.writeFileSync(file, 'replacement-longer');
    assert.equal(cursor.read(file).bytes.toString(), 'replacement-longer');
    fs.renameSync(file, file + '.old'); fs.writeFileSync(file, 'rotated');
    assert.equal(cursor.read(file).bytes.toString(), 'rotated');
    fs.truncateSync(file, 0); assert.equal(cursor.read(file).reset, true);
    fs.appendFileSync(file, 'new'); assert.equal(cursor.read(file).bytes.toString(), 'new');
});

test('mirror intervals retain running tail and terminal head+tail with explicit gap', () => {
    assert.deepEqual(mirrorRanges(100, false, 20, 10), [{start: 80, end: 100}]);
    assert.deepEqual(mirrorRanges(100, true, 20, 10), [{start: 0, end: 10}, {start: 80, end: 100}]);
    assert.deepEqual(mirrorRanges(25, true, 20, 10), [{start: 0, end: 25}]);
});

test('Slurm command vocabulary rejects every mutating operation and unsafe selector', () => {
    assert.deepEqual(slurmCommand('discovery', ['42']), ['scontrol', ['show', 'job', '-o', '42']]);
    assert.deepEqual(slurmCommand('accounting', ['42', '43_2', '42'])[1], ['-n', '-X', '-P', '-j', '42,43_2', '-o', 'JobID,State,ExitCode']);
    for (const op of ['scancel', 'cancel', 'requeue', 'hold', 'update', 'stop-task', 'shutdown']) assert.throws(() => slurmCommand(op, ['42']), /not read-only/);
    assert.throws(() => slurmCommand('accounting', ['42; touch bad']), /selectors/);
});

test('accounting handles empty, terminal states, multiple records and failed arrays', () => {
    assert.equal(accountingOutcome(parseAccounting('')).terminal, false);
    assert.equal(accountingOutcome(parseAccounting('42|COMPLETED|0:0\n42_1|RUNNING|0:0')).terminal, false);
    assert.equal(accountingOutcome(parseAccounting('42|COMPLETED|0:0')).success, true);
    for (const state of ['FAILED', 'CANCELLED by 1', 'TIMEOUT', 'OUT_OF_ME+', 'OUT_OF_MEMORY', 'NODE_FAIL', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE']) {
        assert.deepEqual(accountingOutcome(parseAccounting(`42_3|${state}|1:0`)), {terminal: true, success: false, failedIndices: ['42_3']});
    }
    const diagnostics=[]; assert.deepEqual(parseAccounting('garbage', message=>diagnostics.push(message)), []); assert.equal(diagnostics.length,1);
});

test('discovery expands known placeholders and refuses unresolved array paths', () => {
    const line = 'JobId=42 JobName=train UserId=alice(1000) WorkDir=/work StdOut=/work/%x-%A-%a-%u.out StdErr=/work/%j.err';
    const result = discoverSources(line, {jobId: '42', arrayTaskId: 3});
    assert.equal(result.cwd, '/work');
    assert.equal(result.sources[0].path, '/work/train-42-3-alice.out');
    assert.throws(() => discoverSources(line, {jobId: '42'}), /Unresolved/);
    assert.deepEqual(digestLines('loss: 1\rstep 2\n  4it/s]\nignored\nError: bad'), ['loss: 1', 'step 2', 'Error: bad']);
});

test('array ranges and heterogeneous jobs do not poison other accounting records', () => {
 const diagnostics=[];
 const rows=parseAccounting('123_[2-10]|PENDING|0:0\n123_[2-10%4]|COMPLETED|0:0\n123+0|RUNNING|0:0\n124|COMPLETED|0:0\n125_weird|broken|oops\ngarbage', m=>diagnostics.push(m));
 assert.equal(accountingOutcome(rows.filter(r=>r.id.startsWith('123'))).terminal,false);
 assert.equal(accountingOutcome(rows.filter(r=>r.id==='124')).success,true);
 assert.equal(accountingOutcome(rows.filter(r=>r.id==='125')).terminal,false);
 assert.equal(diagnostics.length,2);
});

test('watcher requires fresh post-settle accounting, suppresses whole-array discovery and registers once', async () => {
 let clock=0, reads=0, registered=0;
 const states=['PREEMPTED','RUNNING','COMPLETED','COMPLETED'];
 const result=await watchSlurm({record:{cwd:os.tmpdir(),outputFile:path.join(os.tmpdir(),'unused'),slurm:{jobId:'123'}},now:()=>clock,sleep:async ms=>{clock+=ms;},signal:new AbortController().signal,output(){},execute(){throw Error('whole arrays must not discover');},call:async (method,p)=>{
 if(method==='registerSources'){registered++;return true;}
 const state=states[Math.min(reads++,3)];
 if(reads===2) assert.ok(p.notBefore>=10000);
 return {observedAt:clock,records:[{id:'123_2',state,exitCode:'0:0'}]};
 }});
 assert.equal(result,0);assert.equal(reads,4);assert.equal(registered,1);
});

test('safe key filters and digest budget preserve final summary with repeat counts', () => {
 for(const pattern of ['(a+)+$','a{100000}','a'.repeat(257),'(a|aa)*'])assert.throws(()=>keyRegex(pattern),/Unsafe/);
 assert.deepEqual(digestLines('loss '+ 'x'.repeat(10000),keyRegex('loss|eval')).map(s=>s.length),[300]);
 const chunks=[]; const writer=digestWriter(b=>chunks.push(b),2048);
 for(let i=0;i<1000;i++)writer.emit('error repeated');
 for(let i=0;i<1000;i++)writer.emit('warning '+i);
 writer.emit('final repeated');writer.emit('final repeated');
 writer.final([{id:'42_2',state:'FAILED',exitCode:'1:0'}],['42_2']);
 const text=Buffer.concat(chunks);assert.ok(text.length<=2048);assert.match(text.toString(),/Final sacct/);assert.match(text.toString(),/Failed indices: 42_2/);assert.match(text.toString(),/Suppressed digest lines/);assert.match(text.toString(),/repeated lines: 1000/);assert.match(text.toString(),/Digest budget reached/);
});
