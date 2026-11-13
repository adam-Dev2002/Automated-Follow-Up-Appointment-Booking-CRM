// Isolated dashboard process and disposable account database for integration/browser tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { operatorEndpoint } = require('./operator-client.cjs');

function removeTestDirectory(directory) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(resolved).startsWith('appoint-access-test-')) throw new Error('Refusing to remove a non-test directory.');
    fs.rmSync(resolved, { recursive: true, force: true });
}

async function startTestServer(options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appoint-access-test-'));
    const endpoint = options.endpoint || 'http://localhost:5678/webhook/appointments-api';
    const child = spawn(process.execPath, [path.join(__dirname, 'dev-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), windowsHide: true,
        env: { ...process.env, PORT: '0', APPOINTMENTS_DATA_DIR: directory, APPOINTMENTS_API_URL: endpoint, APPOINTMENTS_OPERATOR_API_URL: operatorEndpoint(endpoint) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let base;
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Test server startup timed out. ' + output)), 15000);
        const append = chunk => {
            output += chunk;
            const match = output.match(/Appointment dashboard: http:\/\/localhost:(\d+)/);
            if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
        };
        child.stdout.on('data', append); child.stderr.on('data', append);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error('Test server exited: ' + code + '\n' + output)); });
    });
    async function close() {
        if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
        removeTestDirectory(directory);
    }
    try {
        base = await ready;
        let ownerCookie;
        if (options.setup !== false) {
            const response = await fetch(base + '/api/session');
            const preauth = response.headers.get('set-cookie').split(';')[0];
            const session = await response.json();
            const created = await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: preauth, 'X-CSRF-Token': session.csrf_token }, body: JSON.stringify(options.owner || { username: 'test-owner', display_name: 'Test Owner', password: 'isolated-test-owner-password' }) });
            if (!created.ok) throw new Error('Could not set up the isolated owner account.');
            ownerCookie = created.headers.get('set-cookie').split(';')[0].split('=')[1];
        }
        return { base, directory, close, cookies: ownerCookie ? [{ name: 'appoint_session', value: ownerCookie, url: base, httpOnly: true, sameSite: 'Strict' }] : [] };
    } catch (error) { await close(); throw error; }
}

function browserOptions() {
    const installed = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(filename => fs.existsSync(filename));
    return { headless: true, ...(installed ? { executablePath: installed } : {}) };
}

module.exports = { startTestServer, browserOptions, removeTestDirectory };
