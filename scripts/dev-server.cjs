// Local-only dashboard server. Proxying through this origin avoids webhook CORS issues.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SecurityStore, fail } = require('./security-store.cjs');
const { operatorToken, operatorEndpoint, actorEnvelope } = require('./operator-client.cjs');
const { createCrmApi } = require('./crm-api.cjs');
const { createReminderSettingsApi } = require('./reminder-settings.cjs');

const root = path.resolve(__dirname, '..', '.temp');
const port = Number(process.env.PORT || 3002);
const endpoint = new URL(process.env.APPOINTMENTS_API_URL || 'http://localhost:5678/webhook/appointments-api');
const operatorUrl = new URL(process.env.APPOINTMENTS_OPERATOR_API_URL || operatorEndpoint(endpoint));
const dataDir = path.resolve(process.env.APPOINTMENTS_DATA_DIR || path.join(__dirname, '../.local'));
const security = new SecurityStore(path.join(dataDir, 'access.sqlite'));
const serviceToken = operatorToken(dataDir);
if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || !['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('APPOINTMENTS_API_URL must be a local HTTP(S) endpoint.');
}
if (!['localhost', '127.0.0.1', '[::1]'].includes(operatorUrl.hostname) || !['http:', 'https:'].includes(operatorUrl.protocol)) throw new Error('APPOINTMENTS_OPERATOR_API_URL must be a local HTTP(S) endpoint.');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };

function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
}

async function upstream(payload, user = null) {
    return fetch(user ? operatorUrl : endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(user ? { 'X-Appoint-Operator': serviceToken } : {}) },
        body: JSON.stringify(user ? { payload, actor: actorEnvelope(user) } : payload), signal: AbortSignal.timeout(25000), redirect: 'error'
    });
}

function cookieSession(req) {
    const value = String(req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('appoint_session='));
    return security.session(value ? value.slice('appoint_session='.length) : '');
}
function setSessionCookie(res, session) {
    const maxAge = session ? Math.max(0, Math.floor((session.expires_at - Date.now()) / 1000)) : 0;
    res.setHeader('Set-Cookie', 'appoint_session=' + (session?.token || '') + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + maxAge);
}

async function readJson(req) {
    if (!String(req.headers['content-type']).toLowerCase().startsWith('application/json')) {
        throw Object.assign(new Error('Send application/json.'), { status: 415 });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) throw Object.assign(new Error('Request is too large.'), { status: 413 });
        chunks.push(chunk);
    }
    try {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        return data;
    } catch { throw Object.assign(new Error('Send a JSON object.'), { status: 400 }); }
}

const handleCrm = createCrmApi({ security, upstream, readJson, json, serviceToken });
const handleReminders = createReminderSettingsApi({ security, readJson, json, serviceToken });
const server = http.createServer(async (req, res) => {
    let session;
    try {
        const url = new URL(req.url, 'http://localhost');
        const host = String(req.headers.host || '');
        const senderCallback = ['/api/receipt-emails', '/api/reminder-config'].includes(url.pathname) && host === 'host.docker.internal:' + server.address().port;
        if (!senderCallback && !['localhost', '127.0.0.1', '[::1]'].some(name => host === name + ':' + server.address().port)) return json(res, 403, { ok: false, message: 'Use the local dashboard address.' });
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('X-Frame-Options', 'DENY');
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
            return json(res, 403, { ok: false, message: 'Use the dashboard on its local origin.' });
        }
        session = cookieSession(req);
        if (await handleReminders(req,res,url,session)) return;
        if (url.pathname === '/api/session' && req.method === 'GET') {
            if (!session) {
                const issued = security.createSession();
                setSessionCookie(res, issued);
                session = security.session(issued.token);
            }
            return json(res, 200, { ok: true, user: session.user, csrf_token: session.csrf_token, needs_setup: security.needsSetup() });
        }
        if (['/api/setup', '/api/login', '/api/logout'].includes(url.pathname) && req.method === 'POST') {
            security.requireCsrf(session, req.headers['x-csrf-token']);
            if (url.pathname === '/api/logout') {
                security.requireUser(session);
                security.logout(session);
                setSessionCookie(res, null);
                return json(res, 200, { ok: true });
            }
            const data = await readJson(req);
            let signedIn;
            if (url.pathname === '/api/setup') {
                const user = await security.createUser(data);
                signedIn = await security.login({ username: user.username, password: data.password }, req.socket.remoteAddress, session);
            } else signedIn = await security.login(data, req.socket.remoteAddress, session);
            setSessionCookie(res, signedIn);
            return json(res, 200, { ok: true, user: signedIn.user, csrf_token: signedIn.csrf_token });
        }
        if (url.pathname === '/api/users') {
            const actor = security.requireUser(session, 'owner');
            if (req.method === 'GET') {
                security.audit(actor, 'accounts.viewed', 'workspace', '', null, null);
                return json(res, 200, { ok: true, users: security.users() });
            }
            if (req.method === 'POST') {
                security.requireCsrf(session, req.headers['x-csrf-token']);
                return json(res, 201, { ok: true, user: await security.createUser(await readJson(req), actor) });
            }
        }
        if (/^\/api\/users\/[a-f0-9-]{36}$/.test(url.pathname) && req.method === 'PATCH') {
            const actor = security.requireUser(session, 'owner');
            security.requireCsrf(session, req.headers['x-csrf-token']);
            return json(res, 200, { ok: true, user: await security.updateUser(url.pathname.split('/').pop(), await readJson(req), actor) });
        }
        if (url.pathname === '/api/audit' && req.method === 'GET') {
            const actor = security.requireUser(session, 'owner');
            const before = url.searchParams.get('local_before') || String(Number.MAX_SAFE_INTEGER);
            const bookingBefore = url.searchParams.get('booking_before') || String(Number.MAX_SAFE_INTEGER);
            const ref = (url.searchParams.get('appointment_id') || '').trim();
            if (![before, bookingBefore].every(v => /^\d{1,16}$/.test(v) && Number.isSafeInteger(Number(v))) || (ref && !/^[A-Za-z0-9_-]{1,200}$/.test(ref))) throw fail(400, 'Invalid audit cursor or booking reference.');
            security.audit(actor, 'audit.viewed', ref ? 'appointment' : 'workspace', ref, null, null);
            const localRows = before === '0' ? [] : security.readAudit(Number(before), 51, ref);
            const localEvents = localRows.slice(0, 50);
            let booking = { events: [], next_before_id: null };
            let warning = '';
            if (bookingBefore !== '0') {
                try {
                    const result = await upstream({ action: 'audit', before_id: Number(bookingBefore), appointment_id: ref }, actor);
                    booking = await result.json();
                    if (!result.ok || !booking.ok || !Array.isArray(booking.events)) throw new Error();
                } catch { booking = { events: [], next_before_id: Number(bookingBefore) }; warning = 'Booking history could not be loaded from n8n. Account history is shown; retry to load booking events.'; }
            }
            return json(res, 200, { ok: true, events: [...localEvents, ...booking.events].sort((a,b) => b.occurred_at.localeCompare(a.occurred_at)), local_before: localRows.length > 50 ? Number(localEvents.at(-1).id.slice(6)) : 0, booking_before: booking.next_before_id || 0, warning });
        }
        if (await handleCrm(req,res,url,session)) return;
        if (url.pathname === '/api/config' && req.method === 'GET') {
            return json(res, 200, { endpoint: endpoint.href, timezone: 'Asia/Manila', scope: 'browser' });
        }
        if (url.pathname === '/api/health' && req.method === 'GET') {
            // Deliberately fails validation before any calendar write or email dispatch.
            const result = await upstream({ action: '__dashboard_connection_check__' });
            let data;
            try { data = await result.json(); } catch { data = {}; }
            const connected = result.status === 400 && data.error === 'validation_error' && data.ok === false;
            return json(res, 200, {
                connected, upstreamStatus: result.status, checkedAt: new Date().toISOString(),
                message: connected ? 'Booking API is reachable and request validation is working.' :
                    result.status === 404 ? 'The POST appointments-api webhook is not registered. Publish or activate the workflow in n8n.' :
                    'The webhook did not return the expected booking validation response. Check the workflow and its latest execution.'
            });
        }
        if (url.pathname === '/api/appointments' && req.method === 'POST') {
            const input = await readJson(req);
            const payload = Object.fromEntries(['action', 'customer_name', 'email', 'service', 'booking_start', 'booking_end', 'appointment_id', 'manage_token', 'request_id'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
            if (session?.user && payload.action !== 'status') security.requireCsrf(session, req.headers['x-csrf-token']);
            const result = await upstream(payload, session?.user);
            let data;
            try { data = await result.json(); } catch {
                return json(res, 502, { ok: false, error: 'invalid_response', message: 'n8n returned an empty or non-JSON response. Check the workflow execution.' });
            }
            if (result.status === 404 && data.code === 404) {
                data = { ok: false, error: 'webhook_not_registered', message: 'The booking webhook is not registered. Publish or activate the workflow in n8n, then try again.' };
            }
            return json(res, result.status, data);
        }
        if (url.pathname.startsWith('/api/')) return json(res, 404, { ok: false, message: 'API route not found.' });
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { message: 'Method not allowed.' });
        let pathname;
        try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { message: 'Invalid path.' }); }
        const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(root + path.sep)) return json(res, 403, { message: 'Forbidden.' });
        if ([path.join(root, 'index.html'), path.join(root, 'pages/dashboard/dashboard.html')].includes(file) && !session?.user) {
            res.writeHead(302, { Location: '/pages/access.html', 'Cache-Control': 'no-store' });
            return res.end();
        }
        let stat;
        try { stat = await fs.promises.stat(file); } catch { return json(res, 404, { message: 'File not found.' }); }
        if (!stat.isFile()) return json(res, 404, { message: 'File not found.' });
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(file);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
    } catch (error) {
        if ([401, 403].includes(error.status)) security.audit(session?.user, 'access.denied', 'route', req.url.split('?')[0], null, null, 'denied');
        json(res, error.status || 502, { ok: false, error: 'connection_error', message: error.status ? error.message : 'Cannot reach n8n. Make sure it is running on ' + endpoint.origin + '. If a booking timed out, retry the unchanged form to reuse its request ID.' });
    }
});

server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Appointment dashboard: http://localhost:${server.address().port}\nBooking API: ${endpoint.href}\nWatching src/ for changes. Press Ctrl+C to stop.`));

let timer;
let building = false;
let queued = false;
function rebuild() {
    if (building) { queued = true; return; }
    building = true;
    const child = spawn(process.execPath, [path.resolve(__dirname, '../node_modules/gulp/bin/gulp.js'), 'prepare'], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true });
    child.on('exit', code => {
        building = false;
        if (code === 0) console.log('Dashboard updated. Refresh your browser.');
        if (queued) { queued = false; rebuild(); }
    });
}
const watcher = fs.watch(path.resolve(__dirname, '../src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 350);
});
function shutdown() { watcher.close(); server.close(() => { security.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
