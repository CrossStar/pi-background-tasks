import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function inside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function processes(root) {
    const all = new Map();
    for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
        const base = '/proc/' + entry;
        try {
            if (fs.statSync(base).uid !== process.getuid()) continue;
            const stat = fs.readFileSync(base + '/stat', 'utf8').split(') ').slice(1).join(') ').split(' ');
            if (stat[0] === 'Z') continue;
            const environment = fs.readFileSync(base + '/environ', 'utf8').split('\0');
            const service = environment.find(value => value.startsWith('PI_BG_SERVICE_DIR='))?.slice(18);
            const home = environment.find(value => value.startsWith('HOME='))?.slice(5);
            const command = fs.readFileSync(base + '/cmdline', 'utf8').split('\0');
            // The bridge sets its default after exec; /proc/environ may still show an empty override.
            const owned = service ? inside(root, path.resolve(service)) : Boolean(home && inside(root, home) && /(?:daemon|supervisor|remote-bridge)\.mjs$/.test(command[1] ?? ''));
            all.set(Number(entry), {pid: Number(entry), parent: Number(stat[1]), birth: stat[19], owned, command: command.join(' ')});
        } catch (error) {
            if (!['ENOENT','ESRCH','EACCES'].includes(error.code)) throw error;
        }
    }
    // Children may intentionally receive an empty environment. Capture them before their parent exits.
    let changed;
    do {
        changed = false;
        for (const item of all.values()) if (!item.owned && all.get(item.parent)?.owned) { item.owned = true; changed = true; }
    } while (changed);
    return [...all.values()].filter(item => item.owned);
}
function alive(item) {
    try {
        const fields = fs.readFileSync(`/proc/${item.pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ');
        return fields[0] !== 'Z' && fields[19] === item.birth;
    } catch (error) { if (['ENOENT','ESRCH'].includes(error.code)) return false; throw error; }
}
/** Test-only: register immediately after mkdtemp, before setup or spawning. Never uses RPC (which may start another daemon). */
export function guardServiceRoot(t, root) {
    t.after(() => cleanupServiceRoot(root));
}
export async function cleanupServiceRoot(root) {
    root = path.resolve(root);
    assert.ok(root !== path.resolve(os.tmpdir()) && inside(path.resolve(os.tmpdir()), root), 'cleanup requires a unique temporary root');
    if (process.platform !== 'linux') throw Error('Persistent process leak guard requires Linux /proc');
    const known = new Map();
    const started = Date.now();
    let quietSince;
    try {
        while (Date.now() - started < 7000) {
            for (const item of processes(root)) known.set(item.pid, item);
            const live = [...known.values()].filter(alive);
            if (!live.length) {
                quietSince ??= Date.now();
                if (Date.now() - quietSince >= 300) break;
            } else {
                quietSince = undefined;
                for (const item of live) {
                    if (!alive(item)) continue;
                    try { process.kill(item.pid, Date.now() - started < 2000 ? 'SIGTERM' : 'SIGKILL'); }
                    catch (error) { if (error.code !== 'ESRCH') throw error; }
                }
            }
            await delay(50);
        }
        const leaks = [...known.values(), ...processes(root)].filter(alive);
        assert.deepEqual(leaks.map(item => ({pid:item.pid,command:item.command})), [], `Persistent process leak under ${root}`);
    } finally {
        fs.rmSync(root, {recursive:true,force:true});
    }
}
