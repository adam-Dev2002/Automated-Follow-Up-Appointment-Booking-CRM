/* Appoint dashboard, built on the Volt Bootstrap 5 template. */
(async () => {
    'use strict';
    const access = await window.appointAccess;
    if (!access?.user) return;
    const clientIdentities = await window.appointClients;
    const $ = id => document.getElementById(id);
    const zone = 'Asia/Manila';
    const storageKey = 'appoint.bookings.v1';
    const requestKey = 'appoint.pending-requests.v1';
    const offset = 8 * 60 * 60 * 1000;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const icon = name => `<svg class="ai" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    const manilaIso = stamp => new Date(new Date(stamp).getTime() + offset).toISOString().slice(0, 16);
    const dayKey = stamp => manilaIso(stamp).slice(0, 10);
    const fmt = (stamp, opts) => new Intl.DateTimeFormat('en-PH', { timeZone: zone, ...opts }).format(new Date(stamp));
    const dateLabel = stamp => fmt(stamp, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeLabel = stamp => fmt(stamp, { hour: 'numeric', minute: '2-digit', hour12: true });
    const fullLabel = stamp => fmt(stamp, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
    let records = [];
    let pendingRequests = {};
    let storageWarning = false;
    let deliveryBusy = false;
    let detailsRecordId = '';
    try {
        const cached = JSON.parse(localStorage.getItem(storageKey) || '[]');
        if (Array.isArray(cached)) records = cached.filter(r => r && typeof r.appointment_id === 'string' &&
            ['confirmed', 'cancelled'].includes(r.status) && Number.isFinite(Date.parse(r.booking_start)) && Number.isFinite(Date.parse(r.booking_end)));
    } catch { storageWarning = true; }
    try {
        const cached = JSON.parse(sessionStorage.getItem(requestKey) || '{}');
        if (cached && typeof cached === 'object' && !Array.isArray(cached)) pendingRequests = cached;
    } catch { /* In-memory retry tracking remains available. */ }
    let activeFilter = 'all';
    let selectedDay = '';
    let nextRecord = null;
    let bookingMode = 'book';
    let editingRecord = null;
    let connectionBusy = false;
    const today = dayKey(Date.now());
    let [calendarYear, calendarMonth] = today.split('-').slice(0, 2).map(Number);
    calendarMonth--;
    let calendarRecords = [];
    let calendarLoadedRange = '';
    let calendarLoading = false;
    let calendarError = '';
    let calendarCheckedAt = '';
    let calendarRequest = 0;
    const modals = {};
    for (const name of ['booking', 'manage', 'details', 'connection']) modals[name] = new bootstrap.Modal($(`${name}-modal`));
    const toast = new bootstrap.Toast($('app-toast'), { delay: 6500 });
    const sidebarCollapse = new bootstrap.Collapse($('app-sidebar'), { toggle: false });

    function notify(message) {
        $('toast-message').textContent = message;
        toast.show();
    }
    function saveRecord(data, metadata = {}) {
        const previous = records.find(r => r.appointment_id === data.appointment.appointment_id) || {};
        const record = { ...previous, ...metadata, ...data.appointment,
            manage_token: data.manage_token || metadata.manage_token || previous.manage_token || '',
            email_confirmation: data.email_confirmation || previous.email_confirmation || '',
            test_mode: data.test_mode ?? previous.test_mode ?? false,
            notifications: data.notifications || (previous.version === data.appointment.version ? previous.notifications : undefined),
            last_email_error: previous.version === data.appointment.version ? previous.last_email_error : '',
            last_updated: new Date().toISOString() };
        records = [record, ...records.filter(r => r.appointment_id !== record.appointment_id)];
        let persisted = true;
        try { localStorage.setItem(storageKey, JSON.stringify(records)); } catch { persisted = false; }
        render();
        if (location.hash === '#calendar') loadCalendar();
        return { record, persisted };
    }
    function upcoming(r) { return r.status === 'confirmed' && Date.parse(r.booking_start) > Date.now(); }
    function avatarMarkup(record) { return clientIdentities.avatarMarkup(record); }
    function deliveryBadge(status) {
        const labels = { sent: ['sent', 'Sent by Gmail'], test_sent: ['test', 'Test delivery'], failed: ['failed', 'Email failed'], pending: ['pending', 'Queued'], sending: ['pending', 'Sending'], skipped_late: ['', 'Skipped: booked late'], cancelled: ['', 'Cancelled'] };
        const [style, label] = labels[status] || ['', 'Not checked'];
        return `<span class="delivery-badge ${style}">${label}</span>`;
    }
    function renderDeliveryAlert() {
        const failed = records.filter(r => r.last_email_error && r.notifications && Object.values(r.notifications).some(n => n.status === 'failed'));
        $('delivery-alert').hidden = failed.length === 0;
        if (failed.length) $('delivery-alert-message').textContent = `${failed.length} saved ${failed.length === 1 ? 'booking has' : 'bookings have'} a failed email. ${failed[0].last_email_error}`;
    }
    async function refreshDelivery(manual = false) {
        if (deliveryBusy) return;
        const eligible = records.filter(r => r.manage_token);
        if (!eligible.length) { if (manual) notify('Create a booking or add its reference and token to check delivery.'); return; }
        deliveryBusy = true;
        $('refresh-delivery').disabled = true;
        let checked = 0;
        let problem = '';
        // Small batches avoid overwhelming the local workflow with status requests.
        for (let i = 0; i < eligible.length; i += 3) {
            await Promise.all(eligible.slice(i, i + 3).map(async record => {
                try {
                    const response = await fetch('/api/appointments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status', appointment_id: record.appointment_id, manage_token: record.manage_token }), signal: AbortSignal.timeout(28000) });
                    const data = await response.json();
                    if (!response.ok || !data.ok || !data.notifications) throw new Error(data.error === 'validation_error' ? 'The workflow’s delivery-status update is not active yet.' : data.message || 'Delivery status could not be checked.');
                    const current = records.find(r => r.appointment_id === record.appointment_id);
                    if (!current || data.appointment.version < current.version) return;
                    Object.assign(current, data.appointment, { notifications: data.notifications, last_email_error: data.last_email_error || '', test_mode: data.test_mode, delivery_checked_at: data.checked_at });
                    checked++;
                } catch (error) { problem = error.message; }
            }));
        }
        if (checked) {
            try { localStorage.setItem(storageKey, JSON.stringify(records)); } catch { /* Keep authoritative results in memory. */ }
            render();
            const record = records.find(r => r.appointment_id === detailsRecordId);
            if (record && $('detail-delivery')) $('detail-delivery').innerHTML = deliveryDetails(record);
        }
        $('automation-footnote').textContent = checked ? `Delivery checked for ${checked} saved ${checked === 1 ? 'booking' : 'bookings'} at ${timeLabel(Date.now())} (Asia/Manila). Sent means Gmail accepted the message; inbox delivery is not confirmed.${problem ? ' Some records could not be checked.' : ''}` : problem || 'No delivery results are available.';
        deliveryBusy = false;
        $('refresh-delivery').disabled = false;
        if (manual) notify(problem || `Delivery status refreshed for ${checked} ${checked === 1 ? 'booking' : 'bookings'}.`);
    }
    function deliveryDetails(record) {
        if (!record.notifications) return '<p class="small text-gray-500">Delivery has not been checked yet. Use Refresh delivery to load the current result from n8n.</p>';
        const names = { confirmation: 'Confirmation', reminder_24h: '24-hour reminder', reminder_1h: '1-hour reminder' };
        return `<ul class="delivery-status-list">${Object.entries(names).map(([key, name]) => {
            const item = record.notifications[key];
            return `<li><div>${name}${item?.sent_at ? '<small>Sent ' + esc(fullLabel(item.sent_at)) + '</small>' : item?.due_at ? '<small>Due ' + esc(fullLabel(item.due_at)) + '</small>' : ''}</div>${deliveryBadge(item?.status)}</li>`;
        }).join('')}</ul>${record.last_email_error ? '<div class="alert alert-danger small">' + esc(record.last_email_error) + '</div>' : ''}<p class="small text-gray-500">${record.test_mode ? 'Test address: delivery is simulated.' : 'A sent result means Gmail accepted the email. It does not confirm arrival in the inbox.'}</p>`;
    }
    function statusMarkup(r) {
        if (r.status !== 'confirmed' && r.status !== 'cancelled') return `<span class="calendar-booking-status calendar-status-${calendarStatusClass(r)}">${esc(calendarStatus(r))}</span>`;
        const past = r.status === 'confirmed' && Date.parse(r.booking_end) <= Date.now();
        return `<span class="status-badge ${r.status === 'cancelled' ? 'cancelled' : past ? 'past' : ''}">${r.status === 'cancelled' ? 'Cancelled' : past ? 'Past' : 'Confirmed'}</span>`;
    }
    function render() {
        const future = records.filter(upcoming).sort((a, b) => Date.parse(a.booking_start) - Date.parse(b.booking_start));
        $('stat-total').textContent = records.length;
        $('nav-count').textContent = records.length;
        $('table-count').textContent = records.length;
        $('stat-upcoming').textContent = future.length;
        $('stat-today').textContent = records.filter(r => r.status === 'confirmed' && dayKey(r.booking_start) === dayKey(Date.now())).length;
        $('stat-cancelled').textContent = records.filter(r => r.status === 'cancelled').length;
        nextRecord = future[0] || null;
        $('next-title').textContent = nextRecord ? `${nextRecord.customer_name || 'Appointment'} · ${nextRecord.service}` : 'A little room in your schedule';
        $('next-description').textContent = nextRecord ? `${fullLabel(nextRecord.booking_start)} – ${timeLabel(nextRecord.booking_end)} · Asia/Manila` : 'Your next confirmed appointment will appear here.';
        $('next-action').innerHTML = (nextRecord ? 'View appointment ' : 'Book an appointment ') + icon('arrow');
        renderTable();
        renderCalendar();
        renderDeliveryAlert();
    }
    function renderTable() {
        const query = $('booking-search').value.trim().toLowerCase();
        const filtered = records.filter(r => {
            if (activeFilter === 'upcoming' && !upcoming(r)) return false;
            if (activeFilter === 'cancelled' && r.status !== 'cancelled') return false;
            if (selectedDay && dayKey(r.booking_start) !== selectedDay) return false;
            return [r.customer_name, r.email, r.service, r.appointment_id].some(v => String(v || '').toLowerCase().includes(query));
        }).sort((a, b) => Date.parse(b.booking_start) - Date.parse(a.booking_start));
        $('booking-rows').innerHTML = filtered.map(r => {
            return `<tr><td>${clientIdentities.linkMarkup(r,r.service)}</td><td class="booking-date">${esc(dateLabel(r.booking_start))}<span class="appointment-time">${esc(timeLabel(r.booking_start))} – ${esc(timeLabel(r.booking_end))}</span></td><td>${statusMarkup(r)}</td><td>${deliveryBadge(r.notifications?.confirmation?.status)}</td><td><button type="button" class="btn btn-sm btn-action btn-icon action-view row-details" data-details="${esc(r.appointment_id)}" aria-label="View details for ${esc(r.customer_name || r.appointment_id)}">${icon('chevron')}</button></td></tr>`;
        }).join('');
        $('empty-state').hidden = filtered.length > 0;
        const empty = records.length === 0 && !selectedDay && !query && activeFilter === 'all';
        $('empty-title').textContent = empty ? 'Your next booking starts here' : 'No matching appointments';
        $('empty-description').textContent = empty ? 'Create your first appointment. We’ll keep the details organized while your workflow takes care of reminders.' : selectedDay ? `No saved bookings match your filters on ${dateLabel(selectedDay + 'T12:00:00+08:00')}. Clear the date or create an appointment.` : 'Try another search or choose a different status.';
        $('empty-booking').hidden = !empty && !selectedDay;
        $('results-label').textContent = `${filtered.length} ${filtered.length === 1 ? 'appointment' : 'appointments'}${selectedDay ? ' · ' + dateLabel(selectedDay + 'T12:00:00+08:00') : ''}`;
        $('clear-date').hidden = !selectedDay;
        document.querySelectorAll('[data-filter]').forEach(button => {
            const active = button.dataset.filter === activeFilter;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }
    function calendarRange() {
        const first = new Date(Date.UTC(calendarYear, calendarMonth, 1));
        const count = new Date(Date.UTC(calendarYear, calendarMonth + 1, 0)).getUTCDate();
        const cells = Math.ceil((first.getUTCDay() + count) / 7) * 7;
        const from = new Date(Date.UTC(calendarYear, calendarMonth, 1 - first.getUTCDay())).toISOString().slice(0, 10);
        const to = new Date(Date.UTC(calendarYear, calendarMonth, cells - first.getUTCDay())).toISOString().slice(0, 10);
        return { first, cells, from, to, key: from + '/' + to };
    }
    function onCalendarDay(record, key) {
        const start = Date.parse(key + 'T00:00:00+08:00');
        return Date.parse(record.booking_start) < start + 86400000 && Date.parse(record.booking_end) > start;
    }
    function calendarStatus(record) {
        const labels = { pending: 'Pending', confirmed: 'Confirmed', rescheduled: 'Rescheduled', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' };
        return labels[record.status] || 'Unknown status';
    }
    function calendarStatusClass(record) {
        return ['pending', 'confirmed', 'rescheduled', 'completed', 'cancelled', 'no_show'].includes(record.status) ? record.status : 'unknown';
    }
    function calendarTimeRange(record) {
        return `${dateLabel(record.booking_start)} · ${timeLabel(record.booking_start)} – ${dayKey(record.booking_end) !== dayKey(record.booking_start) ? dateLabel(record.booking_end) + ' · ' : ''}${timeLabel(record.booking_end)}`;
    }
    async function loadCalendar() {
        const range = calendarRange();
        const request = ++calendarRequest;
        calendarLoading = true; calendarError = '';
        renderCalendar();
        try {
            const from = new Date(Date.parse(range.from + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
            const signal = AbortSignal.timeout(60000);
            const appointments = [];
            let total = null;
            for (let page = 1; ; page++) {
                const response = await fetch('/api/crm/appointments?' + new URLSearchParams({ from, to: range.to, include_test: 'true', page }), { signal });
                const data = await response.json();
                if (!response.ok || !data.ok || !Array.isArray(data.appointments)) throw new Error(data.message || 'Your bookings could not be loaded. Please try again.');
                if (request !== calendarRequest) return;
                if (!Number.isSafeInteger(data.total) || data.total < 0 || data.total > 50000 || !Number.isSafeInteger(data.page_size) || data.page_size < 1 || data.page !== page) throw new Error('The appointment list could not be read completely. Please refresh the calendar.');
                if (total !== null && total !== data.total) throw new Error('The appointment list changed while loading. Please refresh the calendar.');
                total = data.total;
                appointments.push(...data.appointments);clientIdentities.remember(data.appointments);
                if (appointments.length >= total) break;
                if (data.appointments.length !== data.page_size) throw new Error('Some appointments could not be loaded. Please refresh the calendar.');
            }
            if (appointments.length !== total || new Set(appointments.map(record => record.appointment_id)).size !== total) throw new Error('The appointment list changed while loading. Please refresh the calendar.');
            if (request !== calendarRequest) return;
            const start = Date.parse(range.from + 'T00:00:00+08:00');
            const end = Date.parse(range.to + 'T00:00:00+08:00') + 86400000;
            calendarRecords = appointments.filter(record => Number.isFinite(Date.parse(record.booking_start)) && Number.isFinite(Date.parse(record.booking_end)) && Date.parse(record.booking_start) < end && Date.parse(record.booking_end) > start)
                .sort((a, b) => Date.parse(a.booking_start) - Date.parse(b.booking_start));
            calendarLoadedRange = range.key;
            calendarCheckedAt = new Date().toISOString();
        } catch (error) {
            if (request !== calendarRequest) return;
            calendarError = error.name === 'TimeoutError' ? 'Loading is taking longer than expected. Please refresh the calendar.' : error.message;
        } finally {
            if (request === calendarRequest) { calendarLoading = false; renderCalendar(); }
        }
    }
    function renderCalendar() {
        const range = calendarRange();
        const expanded = location.hash === '#calendar';
        const ready = expanded && calendarLoadedRange === range.key;
        const bookings = expanded ? (ready ? calendarRecords : []) : records.filter(r => r.status === 'confirmed');
        $('calendar-month').textContent = fmt(range.first, { month: 'long', year: 'numeric' });
        const currentDay = dayKey(Date.now());
        let html = '';
        for (let i = 0; i < range.cells; i++) {
            const date = new Date(Date.UTC(calendarYear, calendarMonth, i - range.first.getUTCDay() + 1));
            const key = date.toISOString().slice(0, 10);
            const outside = date.getUTCMonth() !== calendarMonth;
            const dayBookings = bookings.filter(record => onCalendarDay(record, key));
            const label = `${dateLabel(date)}${dayBookings.length ? ', ' + dayBookings.length + (dayBookings.length === 1 ? ' booking' : ' bookings') : ''}`;
            const dateButton = `<button type="button" class="calendar-date ${outside ? 'outside ' : ''}${key === currentDay ? 'today ' : ''}${key === selectedDay ? 'selected ' : ''}${dayBookings.length ? 'has-bookings' : ''}" data-date="${key}" aria-label="${esc(label)}" aria-pressed="${key === selectedDay}"${key === currentDay ? ' aria-current="date"' : ''}>${date.getUTCDate()}${expanded && dayBookings.length ? '<span class="calendar-day-count">' + dayBookings.length + '</span>' : ''}</button>`;
            html += expanded ? `<div class="calendar-cell${outside ? ' outside' : ''}${key === selectedDay ? ' selected' : ''}">${dateButton}<div class="calendar-events">${dayBookings.slice(0, 2).map(record => `<button type="button" class="calendar-event calendar-status-${calendarStatusClass(record)}" data-calendar-booking="${esc(record.appointment_id)}" title="${esc(calendarTimeRange(record) + ' · ' + (record.customer_name || record.appointment_id) + ' · ' + record.service + ' · ' + calendarStatus(record))}"><div class="calendar-event-meta"><time datetime="${esc(record.booking_start)}">${dayKey(record.booking_start) < key ? 'Continues' : esc(timeLabel(record.booking_start))}</time><span>${esc(calendarStatus(record))}</span></div><div class="calendar-event-client">${avatarMarkup(record)}<strong>${esc(record.customer_name || 'Client')}</strong></div><small class="calendar-event-service">${esc(record.service || 'Appointment')}</small></button>`).join('')}${dayBookings.length > 2 ? `<button type="button" class="calendar-more" data-date="${key}">+${dayBookings.length - 2} more</button>` : ''}</div></div>` : dateButton;
        }
        $('calendar-section').style.setProperty('--calendar-weeks', String(range.cells / 7));
        $('calendar-days').innerHTML = html;
        $('calendar-tools').hidden = !expanded;
        $('calendar-agenda').hidden = !expanded;
        $('calendar-refresh').disabled = calendarLoading;
        $('calendar-section').setAttribute('aria-busy', String(expanded && calendarLoading));
        $('calendar-loading').hidden = !expanded || !calendarLoading;
        $('calendar-error').hidden = !expanded || !calendarError;
        if (!expanded) return;
        $('calendar-error-message').textContent = calendarError;
        $('calendar-updated').textContent = ready && calendarCheckedAt ? `Updated ${timeLabel(calendarCheckedAt)}${calendarError ? ' · Showing the last loaded bookings' : ''}` : '';
        $('calendar-agenda-title').textContent = selectedDay ? fmt(selectedDay + 'T12:00:00+08:00', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'Bookings this month';
        const monthKey = range.first.toISOString().slice(0, 7);
        const monthStart = new Date(Date.UTC(calendarYear, calendarMonth, 1)).getTime() - offset;
        const monthEnd = new Date(Date.UTC(calendarYear, calendarMonth + 1, 1)).getTime() - offset;
        const agenda = bookings.filter(record => selectedDay ? onCalendarDay(record, selectedDay) : Date.parse(record.booking_start) < monthEnd && Date.parse(record.booking_end) > monthStart);
        $('calendar-agenda-count').textContent = ready ? `${agenda.length} ${agenda.length === 1 ? 'booking' : 'bookings'}` : '';
        $('calendar-agenda-list').innerHTML = agenda.map(record => `<li class="calendar-agenda-item"><div class="calendar-client">${clientIdentities.linkMarkup(record,record.service || 'Appointment')}</div><div class="calendar-agenda-time"><time datetime="${esc(record.booking_start)}">${esc(calendarTimeRange(record))}</time><small>${esc(record.appointment_id)}${record.is_test || record.test_mode ? ' · Test booking' : ''}</small></div><span class="calendar-booking-status calendar-status-${calendarStatusClass(record)}">${esc(calendarStatus(record))}</span><button type="button" class="btn btn-sm btn-action action-view" data-calendar-booking="${esc(record.appointment_id)}" aria-label="View booking for ${esc(record.customer_name || record.appointment_id)}"><svg class="ai ai-sm" aria-hidden="true"><use href="#i-info"/></svg>View details</button></li>`).join('');
        $('calendar-agenda-empty').hidden = !ready || !!agenda.length || calendarLoading || !!calendarError;
        $('calendar-agenda-empty').textContent = selectedDay ? 'No bookings on this day. Choose another date to see your schedule.' : `No bookings in ${fmt(monthKey + '-01T12:00:00+08:00', { month: 'long', year: 'numeric' })}.`;
    }
    function view() {
        const views = {
            overview: ['Overview', 'Appointment overview', 'A clear view of your bookings and what’s coming next.'],
            appointments: ['Appointments', 'Your appointments', 'Every booking, a little more organized.'],
            calendar: ['Calendar', 'Make room for what’s next', 'Your shared booking calendar. Choose a day to see the times, clients, and appointment details here.'],
            automation: ['Automated reminders', 'Keep the conversation going', 'A closer look at your workflow’s appointment notifications.'],
            clients: ['Clients', 'Your clients', 'People, contact details, and their booking history.'],
            payments: ['Transactions', 'Transaction history', 'Review recorded payments and refunds, linked to each client and booking.'],
            reports: ['Reports', 'Reports manager', 'Review your numbers and download your workspace data.']
        };
        let name = location.hash.slice(1);
        if (!Object.hasOwn(views, name)) name = 'overview';
        const [crumb, title, description] = views[name];
        $('breadcrumb-current').textContent = crumb;
        $('page-title').textContent = title;
        $('page-description').textContent = description;
        document.title = `${crumb} — Appointment Booking CRM`;
        $('stats-section').hidden = !['overview', 'appointments'].includes(name);
        $('next-section').hidden = name !== 'overview';
        $('bookings-section').hidden = !['overview', 'appointments'].includes(name);
        $('right-column').hidden = name === 'appointments';
        $('calendar-section').hidden = !['overview', 'calendar'].includes(name);
        $('automation-section').hidden = !['overview', 'automation'].includes(name);
        $('automation-detail').hidden = name !== 'automation';
        $('dashboard-grid').className = `row g-4 dashboard-grid${name === 'calendar' ? ' calendar-view' : name === 'automation' ? ' automation-view' : ''}`;
        $('bookings-section').className = name === 'appointments' ? 'col-12' : 'col-12 col-xl-8';
        $('right-column').className = ['calendar', 'automation'].includes(name) ? 'col-12 right-column' : 'col-12 col-xl-4 right-column';
        $('main').classList.toggle('single-view', name !== 'overview');
        const crmView = ['clients', 'payments', 'reports'].includes(name);
        $('crm-section').hidden = !crmView;
        $('dashboard-grid').hidden = crmView;
        document.querySelectorAll('[data-crm-view]').forEach(section => { section.hidden = section.dataset.crmView !== name; });
        document.dispatchEvent(new CustomEvent('appoint:view', { detail: { name } }));
        document.querySelectorAll('[data-view]').forEach(link => {
            const active = link.dataset.view === name;
            link.classList.toggle('active', active);
            link.closest('.nav-item')?.classList.toggle('active', active);
            if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
        });
        closeSidebar();
        renderCalendar();
        if (name === 'calendar') loadCalendar();
    }
    function closeSidebar() {
        if ($('app-sidebar').classList.contains('collapsing')) {
            if ($('menu-button').getAttribute('aria-expanded') === 'true') $('app-sidebar').addEventListener('shown.bs.collapse', () => sidebarCollapse.hide(), { once: true });
        } else sidebarCollapse.hide();
        $('sidebar-backdrop').hidden = true;
        $('menu-button').setAttribute('aria-expanded', 'false');
    }
    async function checkConnection() {
        if (connectionBusy) return;
        connectionBusy = true;
        $('check-connection').disabled = true;
        $('settings-check').disabled = true;
        $('connection-title').textContent = 'Checking your booking connection';
        try {
            const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(28000) });
            const data = await response.json();
            const connected = response.ok && data.connected === true;
            $('connection-banner').classList.toggle('alert-success', connected);
            $('connection-banner').classList.toggle('alert-warning', !connected);
            $('connection-title').textContent = connected ? 'Your booking API is connected' : 'Your booking API needs a little attention';
            $('connection-message').textContent = data.message || 'The connection could not be verified.';
            $('connection-check-result').textContent = `${connected ? 'Connected' : 'Unavailable'}${data.upstreamStatus ? ' · HTTP ' + data.upstreamStatus : ''}. ${data.message || ''}`;
            $('sidebar-status').textContent = connected ? 'Booking API connected' : 'Booking API unavailable';
            $('sidebar-status-dot').className = `status-dot${connected ? '' : ' warning'}`;
        } catch {
            $('connection-banner').classList.remove('alert-success');
            $('connection-banner').classList.add('alert-warning');
            $('connection-title').textContent = 'The local server is unavailable';
            $('connection-message').textContent = 'Start the dashboard with npm.cmd run dev, then check the connection again.';
            $('connection-check-result').textContent = 'Unable to reach the dashboard’s local server.';
            $('sidebar-status').textContent = 'Connection unavailable';
            $('sidebar-status-dot').className = 'status-dot warning';
        } finally {
            connectionBusy = false;
            $('check-connection').disabled = false;
            $('settings-check').disabled = false;
        }
    }
    function nextSlot() {
        return manilaIso(Math.ceil((Date.now() + 60 * 60 * 1000) / 1800000) * 1800000);
    }
    function validateSlot(startValue, duration) {
        const start = Date.parse(startValue + '+08:00');
        const minutes = Number(duration);
        if (!Number.isFinite(start) || start <= Date.now()) throw new Error('Choose a date and time in the future (Asia/Manila).');
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new Error('Choose a duration up to 24 hours.');
        return { booking_start: new Date(start).toISOString(), booking_end: new Date(start + minutes * 60000).toISOString() };
    }
    function previewEnd() {
        try {
            const slot = validateSlot($('booking-start').value, $('booking-duration').value);
            $('booking-end-preview').textContent = 'Ends ' + fullLabel(slot.booking_end) + ' · UTC+8';
        } catch { $('booking-end-preview').textContent = 'All appointment times use Asia/Manila (UTC+8).'; }
    }
    function openBooking(record = null) {
        bookingMode = record ? 'reschedule' : 'book';
        editingRecord = record;
        $('booking-form').reset();
        $('booking-error').hidden = true;
        $('booking-modal-title').textContent = record ? 'Reschedule appointment' : 'New appointment';
        $('booking-submit').innerHTML = (record ? 'Save new time ' : 'Create appointment ') + icon('arrow');
        $('customer-fields').hidden = Boolean(record);
        $('customer-fields').querySelectorAll('input').forEach(input => { input.disabled = Boolean(record); });
        $('booking-start').min = manilaIso(Date.now() + 60000);
        $('booking-start').value = record && upcoming(record) ? manilaIso(record.booking_start) : selectedDay && selectedDay > dayKey(Date.now()) ? selectedDay + 'T09:00' : nextSlot();
        if (record) setDuration($('booking-duration'), Math.round((Date.parse(record.booking_end) - Date.parse(record.booking_start)) / 60000));
        previewEnd();
        modals.booking.show();
    }
    function setDuration(select, minutes) {
        select.querySelectorAll('[data-custom]').forEach(option => option.remove());
        if (![...select.options].some(o => Number(o.value) === minutes)) {
            const option = new Option(`${minutes} minutes`, String(minutes));
            option.dataset.custom = 'true';
            select.add(option);
        }
        select.value = String(minutes);
    }
    function requestId(payload) {
        const fingerprint = JSON.stringify(payload);
        if (!Object.hasOwn(pendingRequests, fingerprint)) {
            pendingRequests[fingerprint] = crypto.randomUUID();
            try { sessionStorage.setItem(requestKey, JSON.stringify(pendingRequests)); } catch { /* Memory fallback. */ }
        }
        return pendingRequests[fingerprint];
    }
    function completeRequest(payload) {
        const { request_id, ...identity } = payload;
        delete pendingRequests[JSON.stringify(identity)];
        try { sessionStorage.setItem(requestKey, JSON.stringify(pendingRequests)); } catch { /* Memory fallback. */ }
    }
    async function send(payload) {
        let response;
        try {
            response = await fetch('/api/appointments', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': access.csrf_token }, body: JSON.stringify(payload), signal: AbortSignal.timeout(28000) });
        } catch { throw new Error('The connection was interrupted. Retry this unchanged form to reuse the same request ID and avoid a duplicate booking.'); }
        let data;
        try { data = await response.json(); } catch { throw new Error('The API returned an unreadable response. Check the n8n execution before trying again.'); }
        if (!response.ok || data.ok !== true) throw new Error(data.message || `The request failed (HTTP ${response.status}). Check the workflow execution.`);
        const a = data.appointment;
        if (!a || typeof a.appointment_id !== 'string' || !['confirmed', 'cancelled'].includes(a.status) || !Number.isFinite(Date.parse(a.booking_start)) || !Number.isFinite(Date.parse(a.booking_end))) {
            throw new Error('The response is missing appointment details. Check the n8n execution before submitting again.');
        }
        return data;
    }
    function busy(form, submitId, label) {
        form.dataset.busy = 'true';
        const button = $(submitId);
        const original = button.innerHTML;
        const elements = [...form.closest('.modal-content').querySelectorAll('input, select, button')];
        const states = elements.map(e => e.disabled);
        elements.forEach(e => { e.disabled = true; });
        button.textContent = label;
        return () => { delete form.dataset.busy; elements.forEach((e, i) => { e.disabled = states[i]; }); button.innerHTML = original; };
    }
    function displayError(id, error) { $(id).textContent = error.message; $(id).hidden = false; }
    function switchModal(from, to) {
        $(`${from}-modal`).addEventListener('hidden.bs.modal', to, { once: true });
        modals[from].hide();
    }
    function openManage(record = null, action = 'reschedule') {
        $('manage-form').reset();
        $('manage-error').hidden = true;
        $('manage-id').value = record?.appointment_id || '';
        $('manage-token').value = record?.manage_token || '';
        $('manage-action').value = action;
        $('manage-start').min = manilaIso(Date.now() + 60000);
        $('manage-start').value = record && upcoming(record) ? manilaIso(record.booking_start) : nextSlot();
        setDuration($('manage-duration'), record ? Math.round((Date.parse(record.booking_end) - Date.parse(record.booking_start)) / 60000) : 30);
        manageAction();
        modals.manage.show();
    }
    function manageAction() {
        const cancelling = $('manage-action').value === 'cancel';
        $('manage-date-fields').hidden = cancelling;
        $('manage-start').disabled = cancelling;
        $('manage-cancel-note').hidden = !cancelling;
        $('manage-submit').textContent = cancelling ? 'Cancel appointment' : 'Reschedule appointment';
        $('manage-submit').className = `btn ${cancelling ? 'btn-danger' : 'btn-secondary'}`;
    }
    function showDetails(record) {
        detailsRecordId = record.appointment_id;
        $('details-body').innerHTML = `<dl class="detail-list"><dt>Customer</dt><dd>${esc(record.customer_name || 'Not available from this API')}${record.email ? '<br><small class="text-muted">' + esc(record.email) + '</small>' : ''}</dd><dt>Service</dt><dd>${esc(record.service)}</dd><dt>Appointment</dt><dd>${esc(fullLabel(record.booking_start))} – ${esc(timeLabel(record.booking_end))}<br><small class="text-muted">Asia/Manila (UTC+8)</small></dd><dt>Status</dt><dd>${statusMarkup(record)}</dd><dt>Booking reference</dt><dd><code class="detail-ref">${esc(record.appointment_id)}</code></dd><dt>Confirmation</dt><dd>${record.test_mode ? 'Test address · email delivery is simulated by the workflow.' : record.email_confirmation ? 'Initial response: ' + esc(record.email_confirmation) + '. Current delivery results are shown below.' : 'See the live email follow-up results below.'}</dd><dt>Management token</dt><dd>${record.manage_token ? '<button class="token-toggle" id="token-toggle" type="button">Show management token</button><code class="token-value" id="token-value" hidden></code>' : 'Use the token in your confirmation email to manage this booking.'}</dd></dl>`;
        $('details-body').insertAdjacentHTML('afterbegin', `<div class="profile-upload">${clientIdentities.linkMarkup(record,record.email || '')}<small class="text-gray-500">Open the client profile to update their photo or logo.</small></div>`);
        $('details-body').insertAdjacentHTML('beforeend', `<div class="appointment-delivery"><h3 class="h6 d-flex align-items-center gap-2"><img src="/assets/img/brand/gmail.png" width="20" height="20" alt="Gmail">Email follow-up status</h3><div id="detail-delivery">${deliveryDetails(record)}</div><button class="btn btn-sm btn-outline-info" id="detail-refresh-delivery" type="button">Refresh delivery</button></div>`);
        $('detail-refresh-delivery').onclick = () => refreshDelivery(true);
        $('details-actions').innerHTML = '<button type="button" class="btn btn-light" data-bs-dismiss="modal">Close</button>';
        $('details-actions').insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-action action-payment" id="details-payment"><svg class="ai ai-sm" aria-hidden="true"><use href="#i-wallet"/></svg>Payment</button>');
        $('details-payment').onclick = () => switchModal('details', () => document.dispatchEvent(new CustomEvent('appoint:payment', { detail: { appointment_id: record.appointment_id } })));
        if (record.manage_token && upcoming(record)) {
            $('details-actions').insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-action action-delete" id="details-cancel"><svg class="ai ai-sm" aria-hidden="true"><use href="#i-close"/></svg>Cancel appointment</button><button type="button" class="btn btn-action action-edit" id="details-reschedule"><svg class="ai ai-sm" aria-hidden="true"><use href="#i-calendar"/></svg>Reschedule</button>');
            $('details-cancel').onclick = () => switchModal('details', () => openManage(record, 'cancel'));
            $('details-reschedule').onclick = () => switchModal('details', () => openBooking(record));
        } else if (!record.manage_token) {
            $('details-actions').insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-info" id="details-enter-token">Enter management token</button>');
            $('details-enter-token').onclick = () => switchModal('details', () => openManage(record));
        }
        if ($('token-toggle')) $('token-toggle').onclick = () => {
            const visible = $('token-value').hidden;
            $('token-value').hidden = !visible;
            $('token-value').textContent = visible ? record.manage_token : '';
            $('token-toggle').textContent = visible ? 'Hide management token' : 'Show management token';
        };
        modals.details.show();
        refreshDelivery();
    }

    $('booking-form').addEventListener('submit', async event => {
        event.preventDefault();
        if (event.target.dataset.busy) return;
        $('booking-error').hidden = true;
        let payload;
        let metadata;
        try {
            const slot = validateSlot($('booking-start').value, $('booking-duration').value);
            metadata = bookingMode === 'book' ? { customer_name: $('customer-name').value.trim(), email: $('customer-email').value.trim().toLowerCase(), service: $('booking-service').value.trim() } : editingRecord;
            if (bookingMode === 'book' && (!metadata.customer_name || !metadata.service)) throw new Error('Enter a customer name and service.');
            payload = bookingMode === 'book' ? { action: 'book', ...metadata, ...slot } : { action: 'reschedule', appointment_id: editingRecord.appointment_id, manage_token: editingRecord.manage_token, ...slot };
            if (bookingMode === 'book') payload.request_id = requestId(payload);
        } catch (error) { displayError('booking-error', error); return; }
        const done = busy(event.target, 'booking-submit', 'Saving appointment…');
        let saved;
        try {
            const data = await send(payload);
            saved = saveRecord(data, metadata);
            if (bookingMode === 'book') completeRequest(payload);
            notify(saved.persisted ? (data.idempotent ? 'Your existing booking was recovered. No duplicate was created.' : bookingMode === 'book' ? 'Appointment created. Your confirmation is queued by the workflow.' : 'Appointment rescheduled. Your confirmation is queued by the workflow.') : 'Appointment saved by n8n, but browser storage is unavailable. Keep the reference and token shown in details.');
        } catch (error) { displayError('booking-error', error); }
        finally { done(); }
        if (saved) switchModal('booking', () => showDetails(saved.record));
    });
    $('manage-form').addEventListener('submit', async event => {
        event.preventDefault();
        if (event.target.dataset.busy) return;
        $('manage-error').hidden = true;
        let payload;
        try {
            payload = { action: $('manage-action').value, appointment_id: $('manage-id').value.trim(), manage_token: $('manage-token').value.trim() };
            if (payload.action === 'reschedule') Object.assign(payload, validateSlot($('manage-start').value, $('manage-duration').value));
        } catch (error) { displayError('manage-error', error); return; }
        const done = busy(event.target, 'manage-submit', 'Saving change…');
        let saved;
        try {
            const data = await send(payload);
            saved = saveRecord(data, { manage_token: payload.manage_token });
            notify(saved.persisted ? (payload.action === 'cancel' ? 'Appointment cancelled. The workflow queues your cancellation email.' : 'Appointment rescheduled. The workflow queues your confirmation.') : 'Change saved in n8n. Browser storage is unavailable; keep your booking reference and token.');
        } catch (error) { displayError('manage-error', error); }
        finally { done(); }
        if (saved) switchModal('manage', () => showDetails(saved.record));
    });
    $('booking-modal').addEventListener('hide.bs.modal', event => { if ($('booking-form').dataset.busy) event.preventDefault(); });
    $('manage-modal').addEventListener('hide.bs.modal', event => { if ($('manage-form').dataset.busy) event.preventDefault(); });
    $('details-modal').addEventListener('hidden.bs.modal', () => { detailsRecordId = ''; $('details-body').textContent = ''; });
    $('manage-modal').addEventListener('hidden.bs.modal', () => { $('manage-token').value = ''; });
    document.querySelectorAll('.new-booking').forEach(button => button.addEventListener('click', () => {
        if (button.id === 'next-action' && nextRecord) showDetails(nextRecord); else openBooking();
    }));
    $('booking-rows').addEventListener('click', event => {
        const button = event.target.closest('[data-details]');
        const record = button && records.find(r => r.appointment_id === button.dataset.details);
        if (record) showDetails(record);
    });
    document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { activeFilter = button.dataset.filter; renderTable(); }));
    $('booking-search').addEventListener('input', renderTable);
    $('booking-start').addEventListener('input', previewEnd);
    $('booking-duration').addEventListener('change', previewEnd);
    $('manage-reference').addEventListener('click', () => openManage());
    $('manage-action').addEventListener('change', manageAction);
    function changeCalendarMonth(step) {
        const date = new Date(Date.UTC(calendarYear, calendarMonth + step, 1));
        calendarYear = date.getUTCFullYear(); calendarMonth = date.getUTCMonth();
        selectedDay = ''; renderCalendar(); renderTable();
        if (location.hash === '#calendar') loadCalendar();
    }
    $('previous-month').addEventListener('click', () => changeCalendarMonth(-1));
    $('next-month').addEventListener('click', () => changeCalendarMonth(1));
    $('calendar-today').addEventListener('click', () => {
        const parts = dayKey(Date.now()).split('-').map(Number);
        calendarYear = parts[0]; calendarMonth = parts[1] - 1;
        selectedDay = location.hash === '#calendar' ? dayKey(Date.now()) : '';
        renderCalendar(); renderTable();
        if (location.hash === '#calendar') loadCalendar();
    });
    function calendarClick(event) {
        const details = event.target.closest('[data-calendar-booking]');
        if (details) {
            const record = calendarRecords.find(r => r.appointment_id === details.dataset.calendarBooking);
            if (record) {
                const cached = records.find(r => r.appointment_id === record.appointment_id);
                showDetails({ ...cached, ...record, test_mode: record.is_test ?? cached?.test_mode });
            }
            return;
        }
        const button = event.target.closest('[data-date]');
        if (!button) return;
        const expanded = location.hash === '#calendar';
        selectedDay = !expanded && selectedDay === button.dataset.date ? '' : button.dataset.date;
        const selected = new Date(button.dataset.date + 'T12:00:00Z');
        const monthChanged = expanded && selected.getUTCMonth() !== calendarMonth;
        if (monthChanged) { calendarYear = selected.getUTCFullYear(); calendarMonth = selected.getUTCMonth(); }
        renderCalendar(); renderTable();
        if (monthChanged) loadCalendar();
        $('calendar-agenda-scroll').scrollTop = 0;
        if (button.classList.contains('calendar-more')) $('calendar-agenda-scroll').focus({ preventScroll: true });
    }
    $('calendar-days').addEventListener('click', calendarClick);
    $('calendar-agenda-list').addEventListener('click', calendarClick);
    $('calendar-refresh').addEventListener('click', loadCalendar);
    $('calendar-retry').addEventListener('click', loadCalendar);
    $('clear-date').addEventListener('click', () => { selectedDay = ''; renderCalendar(); renderTable(); });
    $('check-connection').addEventListener('click', checkConnection);
    $('settings-check').addEventListener('click', checkConnection);
    $('app-sidebar').addEventListener('show.bs.collapse', () => { $('sidebar-backdrop').hidden = false; });
    $('app-sidebar').addEventListener('hide.bs.collapse', () => { $('sidebar-backdrop').hidden = true; });
    $('sidebar-backdrop').addEventListener('click', closeSidebar);
    document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', closeSidebar));
    $('refresh-delivery').addEventListener('click', () => refreshDelivery(true));
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); });
    document.querySelector('.connection-nav').addEventListener('click', closeSidebar);
    window.addEventListener('hashchange', view);
    document.addEventListener('appoint:clients-updated', () => { render(); });
    window.addEventListener('storage', event => {
        if (event.key !== storageKey && event.key !== null) return;
        try {
            const updated = JSON.parse(localStorage.getItem(storageKey) || '[]');
            if (Array.isArray(updated)) records = updated.filter(r => r && typeof r.appointment_id === 'string' && ['confirmed', 'cancelled'].includes(r.status) && Number.isFinite(Date.parse(r.booking_start)) && Number.isFinite(Date.parse(r.booking_end)));
            render();
        } catch { notify('Browser-saved bookings could not be refreshed.'); }
    });
    $('today-label').textContent = fmt(Date.now(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    $('stat-today-caption').textContent = fmt(Date.now(), { month: 'long', day: 'numeric' }) + ' · Asia/Manila';
    render(); view(); checkConnection();
    refreshDelivery();
    fetch('/api/config').then(r => r.json()).then(data => { $('endpoint-display').value = data.endpoint; }).catch(() => {});
    if (storageWarning) notify('Browser storage is unavailable or could not be read. Keep your booking reference and management token after creating a booking.');
    // Refresh time-dependent totals and day markers without polling or changing the workflow.
    setInterval(() => { render(); if (!document.hidden) refreshDelivery(); }, 60000);
})();
