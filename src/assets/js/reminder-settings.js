(async () => {
    'use strict';
    const access = await window.appointAccess;
    if (access?.user?.role !== 'owner') return;
    const $ = id => document.getElementById(id);
    const form = $('reminder-settings-form');
    let settings = null;
    let busy = false;
    async function request(options = {}) {
        const response = await fetch('/api/settings/reminders', { ...options, headers:{'Content-Type':'application/json','X-CSRF-Token':access.csrf_token}, cache:'no-store' });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.message || 'Reminder settings could not be loaded.');
        return data.settings;
    }
    function showSettings(saved) {
        settings = saved;
        $('reminder-owner-email').value = saved.owner_email;
        $('reminder-settings-status').textContent = saved.owner_email ? 'Default saved. Copies of 24-hour and 1-hour client reminders go to ' + saved.owner_email + '.' : 'Add your Gmail address to receive copies of client reminders.';
    }
    async function load() {
        $('reminder-settings-error').hidden = true;
        try { showSettings(await request()); }
        catch (error) { $('reminder-settings-error').textContent = error.message; $('reminder-settings-error').hidden = false; }
        finally { $('reminder-settings-save').disabled = !settings; }
    }
    $('reminder-owner-settings').hidden = false;
    $('reminder-settings-save').disabled = true;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !settings) return;
        busy = true; $('reminder-settings-save').disabled = true; $('reminder-settings-error').hidden = true;
        try { showSettings(await request({method:'PUT',body:JSON.stringify({owner_email:$('reminder-owner-email').value.trim(),version:settings.version})})); }
        catch (error) { $('reminder-settings-error').textContent = error.message; $('reminder-settings-error').hidden = false; }
        finally { busy = false; $('reminder-settings-save').disabled = false; }
    });
    $('reminder-settings-reload').addEventListener('click', () => { if (!busy) load(); });
    document.addEventListener('appoint:view', event => { if (event.detail.name === 'automation' && !busy) load(); });
    await load();
})();
