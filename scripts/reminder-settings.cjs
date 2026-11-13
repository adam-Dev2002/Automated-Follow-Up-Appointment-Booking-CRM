const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { fail } = require('./security-store.cjs');

class ReminderSettings {
    constructor(security) {
        this.security = security;
        this.db = security.db;
        this.db.exec(fs.readFileSync(path.join(__dirname, 'migrations/004-reminder-settings.sql'), 'utf8'));
    }
    read() { return { ...this.db.prepare('SELECT owner_email,version,updated_at FROM workspace_reminder_settings WHERE id=1').get() }; }
    save(input, actor) {
        const email = typeof input.owner_email === 'string' ? input.owner_email.trim().toLowerCase() : null;
        if (email === null || email.length > 254 || (email && !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email))) throw fail(400, 'Enter a valid Gmail or business email address.');
        if (!Number.isSafeInteger(input.version) || input.version < 0) throw fail(400, 'Refresh the reminder settings and try again.');
        return this.security.transaction(() => {
            this.security.requireCurrentOwner(actor);
            const before = this.read();
            if (before.version !== input.version) throw fail(409, 'Another owner updated reminder settings. Refresh the page before saving.');
            this.db.prepare('UPDATE workspace_reminder_settings SET owner_email=?,version=version+1,updated_at=? WHERE id=1').run(email, new Date().toISOString());
            const after = this.read();
            this.security.audit(actor, 'reminders.settings_updated', 'workspace', '', { owner_email:before.owner_email }, { owner_email:after.owner_email });
            return after;
        });
    }
}

function createReminderSettingsApi({ security, readJson, json, serviceToken }) {
    const store = new ReminderSettings(security);
    return async (req, res, url, session) => {
        if (url.pathname === '/api/reminder-config') {
            const expected = Buffer.from(serviceToken), supplied = Buffer.from(String(req.headers['x-appoint-operator'] || ''));
            if (!expected.length || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw fail(401, 'Unauthorized reminder workflow.');
            if (req.method !== 'GET') throw fail(405, 'Use GET.');
            json(res, 200, { ok:true, owner_email:store.read().owner_email });
            return true;
        }
        if (url.pathname !== '/api/settings/reminders') return false;
        const actor = security.requireUser(session, 'owner');
        if (req.method === 'GET') json(res, 200, { ok:true, settings:store.read() });
        else if (req.method === 'PUT') {
            security.requireCsrf(session, req.headers['x-csrf-token']);
            json(res, 200, { ok:true, settings:store.save(await readJson(req), actor) });
        } else throw fail(405, 'Use GET or PUT.');
        return true;
    };
}
module.exports = { ReminderSettings, createReminderSettingsApi };
