// Local account/session storage. Appointments remain in the existing n8n data table.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const derive = promisify(crypto.scrypt);
const publicActor = { id: 'public', display_name: 'Public', role: 'public' };
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const userFields = row => row ? { id: row.id, username: row.username, display_name: row.display_name, role: row.role, disabled: Boolean(row.disabled), created_at: row.created_at } : null;

function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/password|token|secret|cookie|authorization|csrf/i.test(key)).map(([key, item]) => [key, redact(item)]));
    return value ?? null;
}

class SecurityStore {
    constructor(filename) {
        if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.db = new DatabaseSync(filename);
        this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        this.db.exec(fs.readFileSync(path.join(__dirname, 'migrations/001-access-audit.sql'), 'utf8'));
        this.hashing = 0;
    }
    close() { this.db.close(); }
    transaction(work) {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = work(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    needsSetup() { return this.db.prepare('SELECT COUNT(*) AS count FROM workspace_users').get().count === 0; }
    audit(actor, action, entityType, entityId, before, after, outcome = 'succeeded') {
        const principal = actor || publicActor;
        this.db.prepare('INSERT INTO workspace_audit (operation_id, actor_id, actor_name, actor_role, action, entity_type, entity_id, old_value, new_value, outcome, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(crypto.randomUUID(), principal.id, principal.display_name, principal.role, action, entityType, entityId || '', JSON.stringify(redact(before)), JSON.stringify(redact(after)), outcome, new Date().toISOString());
    }
    readAudit(before = Number.MAX_SAFE_INTEGER, limit = 50, appointmentId = '') {
        const rows = appointmentId ? this.db.prepare("SELECT * FROM workspace_audit WHERE id < ? AND entity_type = 'appointment' AND entity_id = ? ORDER BY id DESC LIMIT ?").all(before, appointmentId, limit) : this.db.prepare('SELECT * FROM workspace_audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit);
        return rows
            .map(row => ({ ...row, id: 'local:' + row.id, source: 'accounts', old_value: JSON.parse(row.old_value), new_value: JSON.parse(row.new_value) }));
    }
    session(token) {
        if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
        const row = this.db.prepare('SELECT s.*, u.id, u.username, u.display_name, u.role, u.disabled, u.created_at FROM workspace_sessions s LEFT JOIN workspace_users u ON u.id = s.user_id WHERE token_hash = ? AND expires_at > ?').get(hash(token), Date.now());
        if (!row || row.disabled) return null;
        return { token_hash: row.token_hash, csrf_token: row.csrf_token, expires_at: row.expires_at, user: userFields(row.user_id ? row : null) };
    }
    createSession(userId = null) {
        const token = crypto.randomBytes(32).toString('hex');
        const csrf = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + (userId ? 12 * 3600000 : 20 * 60000);
        this.db.prepare('DELETE FROM workspace_sessions WHERE expires_at <= ?').run(Date.now());
        this.db.prepare('INSERT INTO workspace_sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(hash(token), userId, csrf, expires);
        return { token, csrf_token: csrf, expires_at: expires };
    }
    requireUser(session, role) {
        if (!session?.user) throw fail(401, 'Sign in to continue.');
        if (role && session.user.role !== role) throw fail(403, 'Only an owner can perform this action.');
        return session.user;
    }
    requireCsrf(session, token) {
        if (!session || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf_token))) throw fail(403, 'Your session changed. Refresh the page and try again.');
    }
    requireCurrentOwner(actor) {
        const current = this.db.prepare('SELECT role, disabled FROM workspace_users WHERE id = ?').get(actor?.id || '');
        if (!current || current.disabled || current.role !== 'owner') throw fail(403, 'Only an active owner can manage accounts.');
    }
    credentials(data, creating = true) {
        const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
        if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) throw fail(400, 'Use a username of 3–64 letters, numbers, dots, underscores, or hyphens.');
        if (typeof data.password !== 'string' || data.password.length > 128 || (creating && data.password.length < 12) || !data.password.length) throw fail(400, creating ? 'Use a password of 12–128 characters.' : 'Enter your password.');
        const name = typeof data.display_name === 'string' ? data.display_name.trim() : '';
        if (creating && (!name || name.length > 120 || /[\r\n]/.test(name))) throw fail(400, 'Enter a display name of up to 120 characters.');
        return { username, password: data.password, display_name: name };
    }
    async passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
        if (this.hashing >= 4) throw fail(429, 'Too many sign-in requests. Try again shortly.');
        this.hashing++;
        try { return salt + ':' + (await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex'); }
        finally { this.hashing--; }
    }
    async createUser(data, actor = null) {
        const fields = this.credentials(data);
        const role = actor ? data.role || 'staff' : 'owner';
        if (!['owner', 'staff'].includes(role)) throw fail(400, 'Role must be owner or staff.');
        if (actor && actor.role !== 'owner') throw fail(403, 'Only an owner can create accounts.');
        const passwordHash = await this.passwordHash(fields.password);
        return this.transaction(() => {
            if (actor) this.requireCurrentOwner(actor);
            if (!actor && !this.needsSetup()) throw fail(409, 'An owner account already exists. Sign in instead.');
            if (this.db.prepare('SELECT id FROM workspace_users WHERE username = ?').get(fields.username)) throw fail(409, 'That username is already in use.');
            const id = crypto.randomUUID();
            this.db.prepare('INSERT INTO workspace_users (id, username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, fields.username, fields.display_name, role, passwordHash, new Date().toISOString());
            const created = userFields(this.db.prepare('SELECT * FROM workspace_users WHERE id = ?').get(id));
            this.audit(actor || created, actor ? 'account.created' : 'owner.setup', 'user', id, null, created);
            return created;
        });
    }
    limits(ip, username) { return [hash('account:' + ip + ':' + username), hash('address:' + ip)]; }
    async login(data, ip, oldSession) {
        const fields = this.credentials(data, false);
        const keys = this.limits(ip, fields.username);
        const now = Date.now();
        for (const [i, key] of keys.entries()) {
            const limit = this.db.prepare('SELECT * FROM workspace_login_limits WHERE key = ? AND expires_at > ?').get(key, now);
            if (limit && limit.attempts >= (i ? 50 : 10)) throw fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
        }
        const row = this.db.prepare('SELECT * FROM workspace_users WHERE username = ?').get(fields.username);
        const expected = row?.password_hash || ('0'.repeat(32) + ':' + '0'.repeat(128));
        const actual = await this.passwordHash(fields.password, expected.split(':')[0]);
        const valid = !row?.disabled && row && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
        if (!valid) {
            this.transaction(() => {
                for (const key of keys) this.db.prepare('INSERT INTO workspace_login_limits (key, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END, expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END').run(key, now + 15 * 60000, now, now);
                this.audit(null, 'session.login', 'user', fields.username, null, { username: fields.username }, 'denied');
            });
            throw fail(401, 'Username or password is incorrect.');
        }
        return this.transaction(() => {
            // Recheck after the asynchronous password hash in case an owner disabled this account.
            const current = this.db.prepare('SELECT * FROM workspace_users WHERE id = ?').get(row.id);
            if (current.disabled || current.password_hash !== expected) throw fail(401, 'Username or password is incorrect.');
            this.db.prepare('DELETE FROM workspace_login_limits WHERE key = ?').run(keys[0]);
            if (oldSession) this.db.prepare('DELETE FROM workspace_sessions WHERE token_hash = ?').run(oldSession.token_hash);
            const session = this.createSession(row.id);
            const user = userFields(current);
            this.audit(user, 'session.login', 'user', user.id, null, { signed_in: true });
            return { ...session, user };
        });
    }
    logout(session) {
        return this.transaction(() => {
            this.db.prepare('DELETE FROM workspace_sessions WHERE token_hash = ?').run(session.token_hash);
            this.audit(session.user, 'session.logout', 'user', session.user?.id, { signed_in: true }, { signed_in: false });
        });
    }
    users() { return this.db.prepare('SELECT * FROM workspace_users ORDER BY created_at, username').all().map(userFields); }
    async updateUser(id, data, actor) {
        if (actor?.role !== 'owner') throw fail(403, 'Only an owner can manage accounts.');
        if (data.confirm !== true) throw fail(400, 'Confirm this account change first.');
        if (data.role !== undefined && !['owner', 'staff'].includes(data.role)) throw fail(400, 'Role must be owner or staff.');
        if (data.disabled !== undefined && typeof data.disabled !== 'boolean') throw fail(400, 'disabled must be a boolean.');
        if (data.password !== undefined && (typeof data.password !== 'string' || data.password.length < 12 || data.password.length > 128)) throw fail(400, 'Use a password of 12–128 characters.');
        const password = data.password === undefined ? null : await this.passwordHash(data.password);
        return this.transaction(() => {
            this.requireCurrentOwner(actor);
            const row = this.db.prepare('SELECT * FROM workspace_users WHERE id = ?').get(id);
            if (!row) throw fail(404, 'Account not found.');
            const role = data.role ?? row.role;
            const disabled = data.disabled === undefined ? row.disabled : Number(data.disabled);
            if (row.role === 'owner' && !row.disabled && (role !== 'owner' || disabled) && this.db.prepare("SELECT COUNT(*) AS count FROM workspace_users WHERE role = 'owner' AND disabled = 0").get().count <= 1) throw fail(409, 'Keep at least one active owner account.');
            this.db.prepare('UPDATE workspace_users SET role = ?, disabled = ?, password_hash = ? WHERE id = ?').run(role, disabled, password || row.password_hash, id);
            this.db.prepare('DELETE FROM workspace_sessions WHERE user_id = ?').run(id);
            const updated = userFields(this.db.prepare('SELECT * FROM workspace_users WHERE id = ?').get(id));
            this.audit(actor, 'account.updated', 'user', id, userFields(row), { ...updated, credentials_reset: Boolean(password) });
            return updated;
        });
    }
}
module.exports = { SecurityStore, publicActor, userFields, redact, hash, fail };
