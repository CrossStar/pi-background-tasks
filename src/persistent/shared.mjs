import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
export const MAX_FRAME = 1048576;
export function serviceRoot() {
    return path.resolve(process.env.PI_BG_SERVICE_DIR || path.join(os.homedir(), '.pi/background-tasks'));
}
export const root = serviceRoot();
export const DAEMON_KEY = 'daemon';
export function privateDir(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
        throw Error('Unsafe service directory');
    fs.chmodSync(directory, 0o700);
}
function token(directory) {
    privateDir(directory);
    const target = path.join(directory, 'auth');
    if (!fs.existsSync(target)) {
        const temporary = target + '.' + crypto.randomUUID();
        fs.writeFileSync(temporary, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
        try {
            fs.linkSync(temporary, target);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        finally {
            fs.unlinkSync(temporary);
        }
    }
    return fs.readFileSync(target, 'utf8');
}
export function endpoint(key, directory = root) {
    const hash = crypto.createHash('sha256').update(directory + token(directory) + key).digest('hex').slice(0, 32);
    if (process.platform === 'win32')
        return `\\\\.\\pipe\\pi-bg-${hash}`;
    return process.platform === 'linux' ? '\0pi-bg-' + hash : path.join(directory, hash + '.sock');
}
export function atomic(target, value) {
    const temporary = target + '.' + crypto.randomUUID();
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(value));
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    if (process.platform !== 'win32') {
        const parent = fs.openSync(path.dirname(target), 'r');
        try {
            fs.fsyncSync(parent);
        }
        finally {
            fs.closeSync(parent);
        }
    }
}
function frame(value) {
    const data = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(data) > MAX_FRAME)
        throw Error('RPC frame exceeds limit');
    return data;
}
export function rpc(address, method, params, directory = root, version = 2) {
    return new Promise((resolve, reject) => {
        let outgoing;
        try {
            outgoing = frame({ version, token: token(directory), method, params });
        }
        catch (error) {
            reject(error);
            return;
        }
        const socket = net.connect(address);
        let text = '';
        socket.setTimeout(5000, () => socket.destroy(Error('RPC timeout')));
        socket.on('error', reject);
        socket.on('close', () => reject(Error('RPC disconnected')));
        socket.on('connect', () => socket.write(outgoing));
        socket.on('data', data => {
            text += data;
            if (Buffer.byteLength(text) > MAX_FRAME)
                return socket.destroy(Error('RPC too large'));
            if (!text.includes('\n'))
                return;
            try {
                const response = JSON.parse(text.split('\n')[0]);
                if (response.error)
                    reject(Error(response.error));
                else
                    resolve(response.result);
            }
            catch (error) {
                reject(error);
            }
            socket.destroy();
        });
    });
}
export function server(handler) {
    return net.createServer(socket => {
        let text = '';
        socket.setTimeout(5000, () => socket.destroy());
        socket.on('error', () => { });
        socket.on('data', async (data) => {
            text += data;
            if (Buffer.byteLength(text) > MAX_FRAME)
                return socket.destroy();
            if (!text.includes('\n'))
                return;
            socket.removeAllListeners('data');
            try {
                const request = JSON.parse(text.split('\n')[0]);
                if (request.token !== token(root) || request.version !== 2)
                    throw Error('Unauthorized or unsupported protocol');
                socket.end(frame({ result: await handler(request.method, request.params) }));
            }
            catch (error) {
                socket.end(frame({ error: String(error.message) }));
            }
        });
    });
}
export function record(id) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
        throw Error('Invalid task id');
    return path.join(root, 'tasks', id, 'record.json');
}
export function load(id) {
    const value = JSON.parse(fs.readFileSync(record(id), 'utf8'));
    if (value && typeof value === 'object' && !Object.hasOwn(value, 'recordVersion')) return null;
    if (value?.recordVersion !== 2) throw Error('Unsupported task record version');
    return value;
}

// Only an authenticated v1 handshake authorizes considering daemon replacement.
export async function replaceLegacyDaemon(directory, originalError) {
    if (originalError?.message !== 'Unauthorized or unsupported protocol') throw originalError;
    const fail = detail => Error(`Cannot safely replace legacy daemon: ${detail}. Stop only the daemon for ${directory} manually, retaining supervisors, then retry.`);
    if (process.platform !== 'linux') throw fail('automatic identification requires Linux /proc');
    const lock = path.join(directory, 'daemon-upgrade.lock');
    let acquired = false;
    for (let i = 0; i < 100; i++) {
        try { fs.mkdirSync(lock, {mode: 0o700}); acquired = true; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!acquired) throw fail('upgrade lock is busy; inspect/remove a stale daemon-upgrade.lock');
    try {
        const address = endpoint('daemon', directory);
        try { await rpc(address, 'ping', {}, directory); return; }
        catch (error) {
            if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return;
            if (error.message !== 'Unauthorized or unsupported protocol') throw error;
        }
        let identity;
        try { identity = await rpc(address, 'ping', {}, directory, 1); }
        catch { throw fail('authenticated protocol-1 ping failed'); }
        if (identity?.protocolVersion !== 1 || !Number.isSafeInteger(identity.pid) || identity.pid <= 1 || typeof identity.startToken !== 'string') throw fail('invalid protocol-1 identity');
        const proc = `/proc/${identity.pid}`;
        function identify() {
            try {
                if (fs.statSync(proc).uid !== process.getuid()) throw Error('foreign user');
                const argv = fs.readFileSync(proc + '/cmdline', 'utf8').split('\0');
                if (!argv[1] || path.basename(argv[1]) !== 'daemon.mjs') throw Error('not a daemon entrypoint');
                const env = Object.fromEntries(fs.readFileSync(proc + '/environ', 'utf8').split('\0').filter(Boolean).map(item => { const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)]; }));
                const cwd = fs.readlinkSync(proc + '/cwd');
                const serving = env.PI_BG_SERVICE_DIR ? path.resolve(cwd, env.PI_BG_SERVICE_DIR) : path.join(env.HOME || os.homedir(), '.pi/background-tasks');
                if (path.resolve(serving) !== path.resolve(directory)) throw Error('different service root');
                return fs.readFileSync(proc + '/stat', 'utf8').split(') ').slice(1).join(') ').split(' ')[19];
            } catch (error) { throw fail(`PID ${identity.pid} cannot be identified (${error.message})`); }
        }
        const birth = identify();
        const again = await rpc(address, 'ping', {}, directory, 1);
        if (again.pid !== identity.pid || again.startToken !== identity.startToken || identify() !== birth) throw fail('daemon identity changed');
        process.kill(identity.pid, 'SIGTERM');
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            try { await rpc(address, 'ping', {}, directory); return; }
            catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return; }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw fail('daemon did not release its endpoint after SIGTERM');
    } finally { fs.rmdirSync(lock); }
}
