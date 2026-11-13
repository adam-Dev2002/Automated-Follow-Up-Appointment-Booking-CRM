const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SecurityStore, redact, hash } = require('../security-store.cjs');
const { removeTestDirectory } = require('../test-server.cjs');
const ownerData = { username: 'owner', display_name: 'Owner <script>', password: 'a-long-owner-password' };

test('setup is exclusive; persisted credentials are hashed; audit never includes credentials', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appoint-access-test-'));
    const filename = path.join(directory, 'access.sqlite');
    const store = new SecurityStore(filename);
    try {
        const results = await Promise.allSettled([store.createUser(ownerData), store.createUser({ ...ownerData, username: 'other-owner' })]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
        assert.equal(store.users().length, 1);
        const raw = store.db.prepare('SELECT password_hash FROM workspace_users').get();
        assert.notEqual(raw.password_hash, ownerData.password);
        assert.match(raw.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
        assert.equal(JSON.stringify(store.readAudit()).includes(ownerData.password), false);
        store.close();
        const reopened = new SecurityStore(filename);
        assert.equal(reopened.needsSetup(), false);
        assert.equal(reopened.readAudit()[0].action, 'owner.setup');
        reopened.close();
    } finally { try { store.close(); } catch {} removeTestDirectory(directory); }
});

test('owner/staff/public permissions, confirmation, last-owner protection, and session revocation', async () => {
    const store = new SecurityStore(':memory:');
    try {
        const owner = await store.createUser(ownerData);
        const staff = await store.createUser({ username: 'staff', display_name: 'Staff', password: 'a-long-staff-password', role: 'staff' }, owner);
        const issued = await store.login({ username: 'staff', password: 'a-long-staff-password' }, 'local');
        const session = store.session(issued.token);
        assert.equal(store.requireUser(session).id, staff.id);
        assert.throws(() => store.requireUser(session, 'owner'), { status: 403 });
        assert.throws(() => store.requireUser(null), { status: 401 });
        await assert.rejects(store.createUser({ ...ownerData, username: 'intruder' }, staff), { status: 403 });
        await assert.rejects(store.updateUser(staff.id, { role: 'owner' }, owner), { status: 400 });
        await assert.rejects(store.updateUser(owner.id, { disabled: true, confirm: true }, owner), { status: 409 });
        await assert.rejects(store.updateUser(owner.id, { role: 'staff', confirm: true }, owner), { status: 409 });
        await store.updateUser(staff.id, { disabled: true, confirm: true }, owner);
        assert.equal(store.session(issued.token), null);
        await assert.rejects(store.login({ username: 'staff', password: 'a-long-staff-password' }, 'local'), { status: 401 });
        const log = store.readAudit().find(e => e.action === 'account.updated');
        assert.equal(log.actor_id, owner.id);
        assert.equal(log.old_value.disabled, false);
        assert.equal(log.new_value.disabled, true);
        assert.equal(log.outcome, 'succeeded');
    } finally { store.close(); }
});

test('session rotation, expiry, CSRF, password reset, and persisted login throttling', async () => {
    const store = new SecurityStore(':memory:');
    try {
        const owner = await store.createUser(ownerData);
        const anonymous = store.createSession();
        const before = store.session(anonymous.token);
        store.requireCsrf(before, anonymous.csrf_token);
        for (const token of [undefined, 'x'.repeat(64), 'é'.repeat(64), 'a'.repeat(64)]) assert.throws(() => store.requireCsrf(before, token), { status: 403 });
        const signed = await store.login(ownerData, 'ip-one', before);
        assert.equal(store.session(anonymous.token), null);
        assert.equal(store.session(signed.token).user.id, owner.id);
        assert.equal(store.db.prepare('SELECT token_hash FROM workspace_sessions WHERE token_hash = ?').get(signed.token), undefined);
        store.db.prepare('UPDATE workspace_sessions SET expires_at = 0 WHERE token_hash = ?').run(hash(signed.token));
        assert.equal(store.session(signed.token), null);
        const next = await store.login(ownerData, 'ip-two');
        await store.updateUser(owner.id, { password: 'replacement-owner-password', confirm: true }, owner);
        assert.equal(store.session(next.token), null);
        await assert.rejects(store.login(ownerData, 'ip-three'), { status: 401 });
        const after = await store.login({ username: ownerData.username, password: 'replacement-owner-password' }, 'ip-three');
        store.logout(store.session(after.token));
        assert.equal(store.session(after.token), null);
        for (let i = 0; i < 10; i++) await assert.rejects(store.login({ username: 'missing', password: 'incorrect' }, 'throttled'), { status: 401 });
        await assert.rejects(store.login({ username: 'missing', password: 'incorrect' }, 'throttled'), { status: 429 });
        assert.deepEqual(redact({ token: 'private', fields: { manage_token: 'private', name: 'Keep' }, array: [{ password: 'private', role: 'staff' }] }), { fields: { name: 'Keep' }, array: [{ role: 'staff' }] });
    } finally { store.close(); }
});

test('an owner demoted during password hashing cannot create accounts with stale authority', async () => {
    const store = new SecurityStore(':memory:');
    try {
        const owner = await store.createUser(ownerData);
        const second = await store.createUser({ ...ownerData, username: 'second', role: 'owner' }, owner);
        const originalHash = store.passwordHash.bind(store);
        let release;
        const waiting = new Promise(resolve => { release = resolve; });
        store.passwordHash = async password => { await waiting; return originalHash(password); };
        const pending = store.createUser({ ...ownerData, username: 'stale-request', role: 'owner' }, owner);
        await store.updateUser(owner.id, { role: 'staff', confirm: true }, second);
        release();
        await assert.rejects(pending, { status: 403 });
        assert.equal(store.users().some(u => u.username === 'stale-request'), false);
    } finally { store.close(); }
});
