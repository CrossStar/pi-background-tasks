import { spawn } from 'node:child_process';
import path from 'node:path';
/** No PATH lookup; launch environment is the supervisor's, never the command's. */
export function killWindowsTree(pid) {
    return new Promise((resolve) => {
        let helper, timer, settled = false;
        let stdout = '', stderr = '';
        function finish(exitCode, error) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ exitCode, error, stdout, stderr });
        }
        try {
            if (!Number.isSafeInteger(pid) || pid <= 0)
                throw Error('Invalid pid');
            const entries = Object.entries(process.env);
            const root = entries.find(([key]) => key.toLowerCase() === 'systemroot')?.[1]
                ?? entries.find(([key]) => key.toLowerCase() === 'windir')?.[1];
            if (!root || root.includes('\0') || !path.win32.isAbsolute(root))
                throw Error('Invalid Windows system root');
            helper = spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
                windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
            });
            helper.stdout.on('data', data => { stdout += data.toString().slice(0, 8192 - stdout.length); });
            helper.stderr.on('data', data => { stderr += data.toString().slice(0, 8192 - stderr.length); });
            helper.once('error', error => finish(null, error.message));
            helper.once('close', code => finish(code, code === 0 ? undefined : 'taskkill failed'));
            timer = setTimeout(() => { helper.kill(); finish(null, 'taskkill timeout'); }, 2000);
        }
        catch (error) {
            finish(null, error.message);
        }
    });
}
