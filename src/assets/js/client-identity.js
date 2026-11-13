// One client identity and avatar renderer shared by every dashboard view.
window.appointClients = (async () => {
    'use strict';
    const access = await window.appointAccess;
    if (!access?.user) return null;
    const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const byId = new Map(), byEmail = new Map();
    function remember(records) {
        for (const record of records) {
            const id = record.client_id || record.id;
            if (!id || !record.customer_name) continue;
            const previous = byId.get(id);
            if (previous && (previous.avatar_version || 0) > (record.avatar_version || 0)) continue;
            const client = {...previous,...record,id};
            byId.set(id,client);
            if (client.email) byEmail.set(client.email.trim().toLowerCase(),client);
        }
    }
    function identity(record) {
        return byId.get(record.client_id || record.id) || byEmail.get((record.email || '').trim().toLowerCase()) || {...record,id:record.client_id || record.id || ''};
    }
    function avatarMarkup(record) {
        const client = identity(record), name = client.customer_name || record.customer_name || 'Client';
        if (client.has_avatar && client.id) return `<img class="user-avatar client-avatar" src="/api/crm/clients/${encodeURIComponent(client.id)}/avatar?v=${client.avatar_version}" width="36" height="36" alt="">`;
        // Preserve existing browser-saved photos until a shared photo is saved or removed.
        let legacy = '';
        if (!client.avatar_version) try {
            const profiles = JSON.parse(localStorage.getItem('appoint.customer-profiles.v1') || '{}');
            legacy = profiles[(client.email || record.email || '').trim().toLowerCase()]?.photo_data || profiles[record.appointment_id]?.photo_data || record.photo_data || '';
        } catch { /* Initials remain available when browser storage is inaccessible. */ }
        if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(legacy)) return `<img class="user-avatar client-avatar" src="${escape(legacy)}" width="36" height="36" alt="">`;
        return access.avatarMarkup(client.id || (record.email || '').toLowerCase() || record.appointment_id,name);
    }
    function personMarkup(record, subtitle = '') {
        const client = identity(record), name = client.customer_name || record.customer_name || 'Client';
        return `<span class="workspace-person">${avatarMarkup(record)}<span class="workspace-person-text"><strong>${escape(name)}</strong><small>${escape(subtitle)}</small></span></span>`;
    }
    function linkMarkup(record, subtitle = '') {
        const client = identity(record), name = client.customer_name || record.customer_name || 'Client';
        if (!client.id) return personMarkup(record,subtitle);
        return `<a href="#clients" class="crm-client-link" data-client-profile="${escape(client.id)}" aria-label="View client profile: ${escape(name)}">${personMarkup(record,subtitle)}</a>`;
    }
    try {
        const response = await fetch('/api/crm/client-identities',{cache:'no-store'});
        if (response.ok) remember((await response.json()).clients || []);
    } catch { /* A later list response supplies identities when the connection returns. */ }
    return {remember,identity,avatarMarkup,personMarkup,linkMarkup};
})();
