window.appointAccess = (async () => {
    'use strict';
    const $ = id => document.getElementById(id);
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const title = value => String(value || '').replace(/[._]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
    const roleLabel = role => ({ owner: 'Owner', staff: 'Staff', public: 'Public access', system: 'System' }[role] || 'Workspace user');
    function avatar(id, name, large = false) {
        const words = String(name || '').match(/[\p{L}\p{N}]+/gu) || [];
        const initials = words.length ? Array.from(words[0])[0] + (words.length > 1 ? Array.from(words.at(-1))[0] : '') : '?';
        let tone = 0;
        for (const char of String(id || name || '')) tone = (tone * 31 + char.codePointAt(0)) % 5;
        return `<span class="user-avatar user-avatar-tone-${tone}${large ? ' user-avatar-large' : ''}" aria-hidden="true">${escape(initials.toUpperCase())}</span>`;
    }
    function person(id, name, subtitle, large = false) {
        return `<span class="workspace-person">${avatar(id, name, large)}<span class="workspace-person-text"><strong>${escape(name)}</strong><small>${escape(subtitle)}</small></span></span>`;
    }
    function dateLabel(value) {
        if (!value || !Number.isFinite(Date.parse(value))) return 'Not set';
        return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    }
    function actionLabel(item) {
        const receipts={'transactions.viewed':'Viewed transaction history','client.avatar_updated':'Updated a client photo or logo','payment.receipt_viewed':'Viewed a payment receipt','payment.receipt_queued':'Requested a receipt email','payment.receipt_sent':'Receipt accepted by Gmail','payment.receipt_needs_review':'Receipt delivery needs review'};
        if(receipts[item.action])return receipts[item.action];
        if (item.action === 'account.updated') {
            const before = item.old_value || {};
            const after = item.new_value || {};
            const changes = [before.role !== after.role && after.role ? 'Changed an account role' : '', before.disabled !== after.disabled && typeof after.disabled === 'boolean' ? (after.disabled ? 'Disabled an account' : 'Enabled an account') : '', after.credentials_reset ? 'Reset an account password' : ''].filter(Boolean);
            return changes.length === 1 ? changes[0] : 'Updated an account';
        }
        return ({ 'owner.setup': 'Created the owner account', 'account.created': 'Added an account', 'session.login': item.outcome === 'denied' ? 'Tried to sign in' : 'Signed in', 'session.logout': 'Signed out', 'audit.viewed': 'Viewed activity history', 'accounts.viewed': 'Viewed accounts', 'access.denied': 'Tried a restricted action', 'appointment.book': 'Created a booking', 'appointment.reschedule': 'Rescheduled a booking', 'appointment.cancel': 'Cancelled a booking', 'client.created': 'Added a client', 'client.updated': 'Updated client details', 'client.imported': 'Added a client from a booking', 'client.booking_linked': 'Linked a booking to its client', 'clients.viewed': 'Viewed clients', 'client.viewed': 'Viewed a client profile', 'payments.viewed': 'Viewed booking payments', 'calendar.viewed': 'Viewed the booking calendar', 'appointment.price_set': 'Set an appointment price', 'appointment.price_updated': 'Changed an appointment price', 'payment.recorded': 'Recorded a payment', 'payment.refund_recorded': 'Recorded a refund', 'reports.viewed': 'Viewed reports', 'data.exported': 'Downloaded workspace data' })[item.action] || title(item.action);
    }
    const fieldLabels = { display_name: 'Name', username: 'Username', role: 'Role', disabled: 'Account access', credentials_reset: 'Password', signed_in: 'Sign-in status', appointment_id: 'Booking reference', customer_name: 'Customer', email: 'Email', service: 'Service', booking_start: 'Start time', booking_end: 'End time', timezone: 'Time zone', status: 'Booking status', cancelled_at: 'Cancelled at' };
    Object.assign(fieldLabels,{price_minor:'Price',net_minor:'Retained after refunds',balance_minor:'Balance due',amount_minor:'Amount',payment_status:'Payment status',payment_kind:'Payment type',payment_method:'Payment method',receipt_reference:'Receipt reference'});
    Object.assign(fieldLabels,{receipt_id:'Receipt',recipient:'Recipient'});
    function valueLabel(key, value) {
        if (value === null || value === undefined || value === '') return 'Not set';
        if (key === 'disabled') return value ? 'Disabled' : 'Active';
        if (key === 'credentials_reset') return value ? 'Password reset' : 'Unchanged';
        if (key === 'signed_in') return value ? 'Signed in' : 'Signed out';
        if (['booking_start', 'booking_end', 'cancelled_at'].includes(key)) return dateLabel(value);
        if (key === 'role') return roleLabel(value);
        if (key === 'status') return title(value);
        if (['payment_status','payment_kind','payment_method','dataset','file_format'].includes(key)) return title(value);
        if (key.endsWith('_minor')) return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(value / 100);
        if (Array.isArray(value)) return value.join(', ') || 'None';
        if (typeof value === 'object') return 'Updated details';
        if (typeof value === 'boolean') return value ? 'Yes' : 'No';
        return String(value);
    }
    function changeDetails(item) {
        const before = item.old_value && typeof item.old_value === 'object' ? item.old_value : {};
        const after = item.new_value && typeof item.new_value === 'object' ? item.new_value : {};
        const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !['id', 'client_id', 'version', 'created_at', 'updated_at', 'operation_id'].includes(key) && !/password|token|secret|cookie|authorization|csrf/i.test(key) && JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
        if (!fields.length) return '<span class="audit-no-change">No changes made</span>';
        return `<details class="audit-changes"><summary>${fields.length === 1 ? 'See what changed' : 'See ' + fields.length + ' changes'}</summary><dl class="audit-change-list">${fields.map(key => `<div><dt>${escape(fieldLabels[key] || title(key))}</dt><dd>${before[key] === null || before[key] === undefined ? '' : '<span>Previous: ' + escape(valueLabel(key, before[key])) + '</span>'}<strong>${before[key] === null || before[key] === undefined ? 'Set to: ' : 'Now: '}${escape(valueLabel(key, after[key]))}</strong></dd></div>`).join('')}</dl></details>`;
    }
    let session;
    try {
        const response = await fetch('/api/session', { cache: 'no-store' });
        session = await response.json();
        if (!response.ok || !session.user) { location.replace('/pages/access.html'); return null; }
    } catch { location.replace('/pages/access.html'); return null; }
    const accountModal = new bootstrap.Modal($('workspace-account-modal'));
    const confirmModal = new bootstrap.Modal($('account-confirm-modal'));
    const owner = session.user.role === 'owner';
    let users = [];
    let pendingChange = null;
    let accountBusy = false;
    let auditBusy = false;
    let events = [];
    let cursor = {};
    async function api(url, options = {}) {
        const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, ...options.headers } });
        const result = await response.json();
        if (response.status === 401) { location.replace('/pages/access.html'); throw new Error('Sign in to continue.'); }
        if (!response.ok || !result.ok) throw new Error(result.message || 'The request could not be completed.');
        return result;
    }
    function showError(id, problem) { $(id).textContent = problem.message; $(id).hidden = false; }
    function renderUsers() {
        $('account-rows').innerHTML = users.map(user => `<tr><td>${person(user.id, user.display_name, user.username)}</td><td data-label="Role"><span class="workspace-role">${roleLabel(user.role)}</span></td><td data-label="Access"><span class="audit-result ${user.disabled ? 'audit-result-neutral' : 'audit-result-success'}">${user.disabled ? 'Disabled' : 'Active'}</span></td><td data-label="Account actions"><div class="d-flex gap-2 flex-wrap"><button type="button" class="btn btn-sm btn-outline-gray-300" data-account="${escape(user.id)}" data-change="role">Make ${user.role === 'owner' ? 'staff' : 'owner'}</button><button type="button" class="btn btn-sm btn-outline-gray-300" data-account="${escape(user.id)}" data-change="disabled">${user.disabled ? 'Enable' : 'Disable'}</button><button type="button" class="btn btn-sm btn-outline-gray-300" data-account="${escape(user.id)}" data-change="password">Reset password</button></div></td></tr>`).join('');
    }
    async function loadUsers() { users = (await api('/api/users')).users; renderUsers(); }
    function renderAudit() {
        const grouped = new Map();
        for (const item of events) {
            const key = item.source + ':' + item.operation_id;
            if (!grouped.has(key) || item.outcome === 'succeeded') grouped.set(key, item);
        }
        const rows = [...grouped.values()].sort((a,b) => b.occurred_at.localeCompare(a.occurred_at));
        $('audit-rows').innerHTML = rows.map(item => {
            const targetUser = users.find(user => user.id === item.entity_id);
            const target = item.entity_type === 'appointment' ? 'Booking ' + item.entity_id : item.entity_type === 'client' ? item.new_value?.customer_name || item.old_value?.customer_name || 'Client profile' : item.entity_type === 'user' ? targetUser?.display_name || item.new_value?.display_name || item.old_value?.display_name || (item.actor_id === item.entity_id ? item.actor_name : 'Workspace account') : item.entity_type === 'route' ? 'Workspace access' : 'Workspace';
            const read = ['audit.viewed', 'accounts.viewed', 'calendar.viewed', 'transactions.viewed'].includes(item.action);
            const result = item.outcome === 'succeeded' ? (read ? 'Viewed' : 'Successful') : item.outcome === 'requested' ? 'Needs review' : item.outcome === 'denied' ? (item.action === 'session.login' ? 'Unsuccessful' : 'Blocked') : title(item.outcome);
            const resultStyle = item.outcome === 'requested' ? 'review' : item.outcome === 'denied' ? 'blocked' : read ? 'neutral' : 'success';
            const name = item.actor_name === 'Public' ? 'Public visitor' : item.actor_name || 'Unknown user';
            return `<tr><td class="audit-time" data-label="When (Asia/Manila)">${escape(dateLabel(item.occurred_at))}</td><td>${person(item.actor_id, name, roleLabel(item.actor_role))}</td><td><strong class="audit-action">${escape(actionLabel(item))}</strong><small class="audit-record">${escape(target)}</small></td><td><span class="audit-result audit-result-${resultStyle}">${escape(result)}</span></td><td>${changeDetails(item)}</td></tr>`;
        }).join('');
        $('audit-empty').hidden = rows.length !== 0;
    }
    async function loadAudit(more = false) {
        if (auditBusy) return;
        auditBusy = true; $('audit-refresh').disabled = true; $('audit-more').disabled = true;
        if (!more) { events = []; cursor = {}; }
        try {
            const params = new URLSearchParams({ appointment_id: $('audit-reference').value.trim(), ...cursor });
            const result = await api('/api/audit?' + params);
            events.push(...result.events);
            cursor = { local_before: String(result.local_before), booking_before: String(result.booking_before) };
            $('audit-warning').textContent = result.warning || '';
            $('audit-warning').hidden = !result.warning;
            $('audit-more').hidden = !result.local_before && !result.booking_before;
            renderAudit();
        } catch (problem) { showError('account-error', problem); }
        finally { auditBusy = false; $('audit-refresh').disabled = false; $('audit-more').disabled = false; }
    }
    $('workspace-account').innerHTML = `${avatar(session.user.id, session.user.display_name)}<span class="account-button-text"><strong id="workspace-account-name">${escape(session.user.display_name)}</strong><small>${roleLabel(session.user.role)}</small></span>`;
    $('workspace-account').setAttribute('aria-label', 'Account: ' + session.user.display_name + ', ' + roleLabel(session.user.role));
    $('account-identity').innerHTML = person(session.user.id, session.user.display_name, roleLabel(session.user.role) + ' account', true);
    $('owner-controls').hidden = !owner;
    $('workspace-account').addEventListener('click', () => {
        $('account-error').hidden = true; accountModal.show();
        if (owner) loadUsers().catch(problem => showError('account-error', problem));
    });
    $('account-logout').addEventListener('click', async () => {
        if (accountBusy) return;
        accountBusy = true;
        try { await api('/api/logout', { method: 'POST', body: '{}' }); location.replace('/pages/access.html'); }
        catch (problem) { showError('account-error', problem); }
        finally { accountBusy = false; }
    });
    $('account-create-form').addEventListener('submit', async event => {
        event.preventDefault(); if (accountBusy) return;
        accountBusy = true; $('account-create-submit').disabled = true; $('account-error').hidden = true;
        try {
            await api('/api/users', { method: 'POST', body: JSON.stringify({ username: $('account-username').value.trim(), display_name: $('account-name').value.trim(), password: $('account-password').value, role: $('account-role').value }) });
            event.target.reset(); await loadUsers();
        } catch (problem) { showError('account-error', problem); }
        finally { accountBusy = false; $('account-create-submit').disabled = false; }
    });
    $('account-rows').addEventListener('click', event => {
        const button = event.target.closest('[data-account]');
        const user = button && users.find(u => u.id === button.dataset.account);
        if (!user || accountBusy) return;
        const change = button.dataset.change;
        pendingChange = { user, change };
        $('account-confirm-error').hidden = true;
        $('account-reset-password').value = '';
        $('account-reset-field').hidden = change !== 'password';
        $('account-reset-password').disabled = change !== 'password';
        $('account-reset-password').required = change === 'password';
        const description = change === 'role' ? 'Change ' + user.display_name + ' to ' + (user.role === 'owner' ? 'staff' : 'owner') + '?' : change === 'disabled' ? (user.disabled ? 'Enable ' : 'Disable ') + user.display_name + '?' : 'Reset the password for ' + user.display_name + '?';
        $('account-confirm-description').textContent = description;
        $('workspace-account-modal').addEventListener('hidden.bs.modal', () => confirmModal.show(), { once: true });
        accountModal.hide();
    });
    $('account-confirm-form').addEventListener('submit', async event => {
        event.preventDefault(); if (!pendingChange || accountBusy) return;
        accountBusy = true; $('account-confirm-submit').disabled = true;
        try {
            const { user, change } = pendingChange;
            const data = { confirm: true };
            if (change === 'role') data.role = user.role === 'owner' ? 'staff' : 'owner';
            else if (change === 'disabled') data.disabled = !user.disabled;
            else data.password = $('account-reset-password').value;
            await api('/api/users/' + user.id, { method: 'PATCH', body: JSON.stringify(data) });
            if (user.id === session.user.id) { location.replace('/pages/access.html'); return; }
            await loadUsers(); accountBusy = false; confirmModal.hide();
        } catch (problem) { showError('account-confirm-error', problem); }
        finally { accountBusy = false; $('account-confirm-submit').disabled = false; }
    });
    $('account-confirm-modal').addEventListener('hide.bs.modal', event => { if (accountBusy) event.preventDefault(); });
    $('workspace-account-modal').addEventListener('hide.bs.modal', event => { if (accountBusy) event.preventDefault(); });
    $('account-confirm-modal').addEventListener('hidden.bs.modal', () => { pendingChange = null; $('account-reset-password').value = ''; accountModal.show(); });
    $('workspace-account-modal').addEventListener('hidden.bs.modal', () => { $('account-password').value = ''; });
    $('audit-tab').addEventListener('shown.bs.tab', () => loadAudit());
    $('audit-filter-form').addEventListener('submit', event => { event.preventDefault(); loadAudit(); });
    $('audit-more').addEventListener('click', () => loadAudit(true));
    return { ...session, avatarMarkup: avatar };
})();
