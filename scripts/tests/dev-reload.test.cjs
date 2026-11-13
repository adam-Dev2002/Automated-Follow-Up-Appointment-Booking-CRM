const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { removeTestDirectory } = require('../test-server.cjs');

test('backend edits reload calendar routes without losing signed-in sessions', { timeout: 45000 }, async () => {
    const root = path.resolve(__dirname, '../..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appoint-access-test-'));
    let child;
    let output = '';
    const booking = { id: 1, appointment_id: 'appt_reload', customer_name: 'Reload Client', email: 'reload@example.test', service: 'Consultation', booking_start: '2026-11-15T09:00:00+08:00', booking_end: '2026-11-15T10:00:00+08:00', status: 'confirmed', is_test: true };
    const stub = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const ok = body.payload?.action === 'crm_list';
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ok ? { ok: true, appointments: [booking], next_after_id: null } : { ok: false, error: 'validation_error' }));
    });
    async function until(check, label) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const value = check();
            if (value) return value;
            if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('Server exited: ' + output);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Timed out waiting for ' + label + ': ' + output);
    }
    try {
        // Edit only a disposable copy: the user's running server and source are untouched.
        fs.cpSync(path.join(root, 'scripts'), path.join(directory, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(directory, 'src'));
        const apiPath = path.join(directory, 'scripts/crm-api.cjs');
        const currentApi = fs.readFileSync(apiPath, 'utf8');
        const oldApi = currentApi.replace("url.pathname === '/api/crm/calendar'", "url.pathname === '/api/crm/calendar-before-reload'");
        assert.notEqual(oldApi, currentApi);
        fs.writeFileSync(apiPath, oldApi);

        stub.listen(0, '127.0.0.1');
        await once(stub, 'listening');
        const dev = require('../../package.json').scripts.dev;
        const match = dev.match(/&& node (.+) scripts\/dev-server\.cjs$/);
        assert.ok(match, 'The dev command launches the backend with Node');
        const flags = match[1].split(/\s+/);
        assert.ok(flags.includes('--watch'), 'Backend changes must restart the dev server');
        child = spawn(process.execPath, [...flags, 'scripts/dev-server.cjs'], {
            cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PORT: '0', APPOINTMENTS_DATA_DIR: path.join(directory, 'data'), APPOINTMENTS_API_URL: 'http://127.0.0.1:' + stub.address().port + '/webhook/appointments-api', APPOINTMENTS_OPERATOR_API_URL: 'http://127.0.0.1:' + stub.address().port + '/webhook/appointments-operator-api', NODE_PATH: path.join(root, 'node_modules') }
        });
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        const starts = () => [...output.matchAll(/Appointment dashboard: http:\/\/localhost:(\d+)/g)];
        await until(() => starts().length === 1, 'initial server startup');
        const base = 'http://127.0.0.1:' + starts()[0][1];
        const anonymousResponse = await fetch(base + '/api/session');
        const anonymous = await anonymousResponse.json();
        const created = await fetch(base + '/api/setup', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: anonymousResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': anonymous.csrf_token },
            body: JSON.stringify({ username: 'reload-owner', display_name: 'Reload Owner', password: 'isolated-reload-owner-password' })
        });
        assert.equal(created.status, 200);
        const headers = { Cookie: created.headers.get('set-cookie').split(';')[0] };
        const range = '/api/crm/calendar?from=2026-11-01&to=2026-11-30';
        const missing = await fetch(base + range, { headers });
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).message, 'CRM endpoint not found.');

        // Reproduce installing a calendar route while the old backend is already running.
        fs.writeFileSync(apiPath, currentApi);
        await until(() => starts().length >= 2, 'automatic backend restart');
        const reloadedBase = 'http://127.0.0.1:' + starts().at(-1)[1];
        const calendar = await fetch(reloadedBase + range, { headers });
        assert.equal(calendar.status, 200, 'The existing session works with the new route');
        const data = await calendar.json();
        assert.equal(data.appointments.length, 1);
        assert.equal(data.appointments[0].appointment_id, booking.appointment_id);
        assert.equal((await fetch(reloadedBase + range)).status, 401, 'Reload does not bypass authentication');
    } finally {
        if (child?.exitCode === null) {
            const stopped = once(child, 'exit');
            if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            else child.kill('SIGTERM');
            await stopped;
        }
        stub.closeAllConnections();
        await new Promise(resolve => stub.close(resolve));
        removeTestDirectory(directory);
    }
});
