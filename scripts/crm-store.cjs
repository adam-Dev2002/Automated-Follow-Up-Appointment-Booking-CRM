const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail, userFields } = require('./security-store.cjs');
const CURRENCY = 'PHP';
const MAX_MINOR = 100000000000;
const systemActor = { id: 'system', display_name: 'System', role: 'system' };
const dayKey = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10);
const safeAdd = (a, b) => { const total = a + b; if (!Number.isSafeInteger(total)) throw fail(422, 'This report exceeds the supported amount. Use a smaller date range.'); return total; };
function moneyMinor(value, zero = false) {
    const text = String(value ?? '').trim();
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw fail(400, 'Enter an amount with no more than two decimal places.');
    const [whole, fraction = ''] = text.split('.');
    const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(amount) || amount > MAX_MINOR || amount < (zero ? 0 : 1)) throw fail(400, zero ? 'Enter a price from 0 to 1,000,000,000 PHP.' : 'Enter a positive amount up to 1,000,000,000 PHP.');
    return amount;
}
function dateOnly(value) {
    if (!value) return '';
    const stamp = Date.parse(value + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2100-12-31' || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) throw fail(400, 'Choose a valid date between 2000 and 2100.');
    return value;
}
function filters(input = {}) {
    const result = { from: dateOnly(String(input.from || '')), to: dateOnly(String(input.to || '')), service: String(input.service || '').trim(), status: String(input.status || '').trim(), q: String(input.q || '').trim(), include_test: input.include_test !== false && input.include_test !== 'false' };
    if (result.from && result.to && result.from > result.to) throw fail(400, 'The start date must be on or before the end date.');
    if (result.service.length > 120 || result.q.length > 200 || !['', 'pending', 'confirmed', 'rescheduled', 'completed', 'cancelled', 'no_show'].includes(result.status)) throw fail(400, 'Invalid search or report filter.');
    return result;
}
function oneLine(value, max, label) {
    if (value !== undefined && typeof value !== 'string') throw fail(400, label + ' must be text.');
    const text = (value || '').trim();
    if (text.length > max || /[\r\n\x00-\x1f]/.test(text)) throw fail(400, label + ' must be one line, up to ' + max + ' characters.');
    return text;
}
function clientFields(input) {
    const customer_name = oneLine(input.customer_name, 120, 'Client name');
    const email = oneLine(input.email, 254, 'Email').toLowerCase();
    const phone = oneLine(input.phone, 32, 'Phone');
    if (!customer_name || (!email && !phone)) throw fail(400, 'Enter a name and at least one contact method: phone or email.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email address.');
    if (phone && (!/^[+\d\s().-]+$/.test(phone) || phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15)) throw fail(400, 'Enter a phone number with 7–15 digits.');
    return { customer_name, email, phone };
}
const cleanClient = row => row ? Object.fromEntries(['id', 'customer_name', 'email', 'phone', 'source', 'version', 'created_at', 'updated_at'].map(key => [key, row[key]])) : null;
const cleanPayment = row => row ? Object.fromEntries(['id', 'appointment_id', 'client_id', 'service', 'kind', 'amount_minor', 'currency', 'method', 'receipt_reference', 'note', 'refund_of', 'received_at', 'is_test', 'created_by', 'created_at'].map(key => [key, row[key]])) : null;
const matchesPhone = (phone, query) => /^[+\d\s().-]+$/.test(query) && query.replace(/\D/g,'').length >= 3 && String(phone || '').replace(/\D/g,'').includes(query.replace(/\D/g,''));

class CrmStore {
    constructor(security) {
        this.security = security;
        this.db = security.db;
        this.db.exec(fs.readFileSync(path.join(__dirname, 'migrations/002-clients-payments.sql'), 'utf8'));
    }
    actor(principal, owner = false) {
        const row = this.db.prepare('SELECT * FROM workspace_users WHERE id = ?').get(principal?.id || '');
        if (!row || row.disabled) throw fail(401, 'Sign in to continue.');
        if (owner && row.role !== 'owner') throw fail(403, 'Only an owner can perform this action.');
        return userFields(row);
    }
    syncAppointments(appointments, principal) {
        if (!Array.isArray(appointments) || appointments.length > 50000) throw fail(502, 'The booking list could not be loaded completely.');
        this.security.transaction(() => {
            this.actor(principal);
            const linked = this.db.prepare('SELECT client_id FROM crm_appointment_clients WHERE appointment_id = ?');
            const byEmail = this.db.prepare('SELECT * FROM crm_clients WHERE email = ?');
            const insert = this.db.prepare('INSERT INTO crm_clients (id,customer_name,email,phone,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
            const link = this.db.prepare('INSERT INTO crm_appointment_clients (appointment_id,client_id,linked_at) VALUES (?,?,?)');
            for (const booking of appointments) {
                if (!booking?.appointment_id || !Number.isFinite(Date.parse(booking.booking_start)) || !Number.isFinite(Date.parse(booking.booking_end))) throw fail(502, 'The booking source returned incomplete records.');
                if (linked.get(booking.appointment_id)) continue;
                const email = String(booking.email || '').trim().toLowerCase();
                let client = email ? byEmail.get(email) : null;
                if (!client) {
                    const id = crypto.randomUUID(); const now = new Date().toISOString();
                    insert.run(id, String(booking.customer_name || 'Unnamed client'), email, '', 'booking', now, now);
                    client = this.db.prepare('SELECT * FROM crm_clients WHERE id = ?').get(id);
                    this.security.audit(systemActor, 'client.imported', 'client', id, null, cleanClient(client));
                }
                link.run(booking.appointment_id, client.id, new Date().toISOString());
                this.security.audit(systemActor, 'client.booking_linked', 'appointment', booking.appointment_id, null, { customer_name: client.customer_name, client_id: client.id });
            }
        });
    }
    createClient(input, principal) {
        const values = clientFields(input);
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.request_id || '')) throw fail(400, 'A client request ID is required. Retry the unchanged form.');
        return this.security.transaction(() => {
            const actor = this.actor(principal);
            const old = this.db.prepare('SELECT * FROM crm_clients WHERE request_id = ?').get(input.request_id);
            if (old) {
                if (Object.keys(values).some(key => old[key] !== values[key])) throw fail(409, 'This request ID belongs to different client details. Reopen the form.');
                return { client: cleanClient(old), idempotent: true };
            }
            if (values.email && this.db.prepare('SELECT id FROM crm_clients WHERE email = ?').get(values.email)) throw fail(409, 'A client with this email already exists. Open their existing profile.');
            const id = crypto.randomUUID(); const now = new Date().toISOString();
            this.db.prepare('INSERT INTO crm_clients (id,customer_name,email,phone,source,request_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, values.customer_name, values.email, values.phone, 'manual', input.request_id, now, now);
            const client = cleanClient(this.db.prepare('SELECT * FROM crm_clients WHERE id = ?').get(id));
            this.security.audit(actor, 'client.created', 'client', id, null, client);
            return { client, idempotent: false };
        });
    }
    updateClient(id, input, principal) {
        const values = clientFields(input);
        return this.security.transaction(() => {
            const actor = this.actor(principal);
            const old = this.db.prepare('SELECT * FROM crm_clients WHERE id = ?').get(id);
            if (!old) throw fail(404, 'Client not found.');
            if (input.version !== old.version) throw fail(409, 'This client was changed elsewhere. Refresh their profile before editing.');
            if (values.email && this.db.prepare('SELECT id FROM crm_clients WHERE email = ? AND id <> ?').get(values.email, id)) throw fail(409, 'Another client already uses this email.');
            this.db.prepare('UPDATE crm_clients SET customer_name=?,email=?,phone=?,version=version+1,updated_at=? WHERE id=?').run(values.customer_name, values.email, values.phone, new Date().toISOString(), id);
            const client = cleanClient(this.db.prepare('SELECT * FROM crm_clients WHERE id = ?').get(id));
            this.security.audit(actor, 'client.updated', 'client', id, cleanClient(old), client);
            return client;
        });
    }
    paymentSummary(id) {
        const charge = this.db.prepare('SELECT * FROM crm_booking_charges WHERE appointment_id=?').get(id);
        const rows = this.db.prepare('SELECT * FROM crm_payments WHERE appointment_id=? ORDER BY received_at DESC,created_at DESC,id').all(id);
        let gross_minor = 0, refunded_minor = 0;
        for (const row of rows) { if (row.kind === 'refund') refunded_minor = safeAdd(refunded_minor, row.amount_minor); else gross_minor = safeAdd(gross_minor, row.amount_minor); }
        const net_minor = gross_minor - refunded_minor;
        const price_minor = charge?.price_minor ?? null;
        const status = price_minor === null ? 'unpriced' : refunded_minor && net_minor === 0 ? 'refunded' : net_minor === price_minor ? 'paid' : net_minor === 0 ? 'unpaid' : !refunded_minor && rows.filter(row => row.kind !== 'refund').every(row => row.kind === 'deposit') ? 'deposit' : 'partial';
        return { appointment_id: id, currency: CURRENCY, price_minor, price_version: charge?.version || 0, gross_minor, refunded_minor, net_minor, balance_minor: price_minor === null ? null : price_minor - net_minor, payment_status: status, payments: rows.map(row => ({ ...cleanPayment(row), refundable_minor: row.kind === 'refund' ? 0 : row.amount_minor - rows.filter(refund => refund.refund_of === row.id).reduce((sum, refund) => safeAdd(sum, refund.amount_minor), 0) })) };
    }
    setPrice(booking, input, principal) {
        const amount = moneyMinor(input.price, true);
        return this.security.transaction(() => {
            const actor = this.actor(principal);
            const before = this.paymentSummary(booking.appointment_id);
            if (input.version !== before.price_version) throw fail(409, 'This price changed elsewhere. Reload the booking before saving.');
            if (amount < before.net_minor) throw fail(409, 'The price cannot be less than the amount retained. Record the refund first.');
            if (before.price_minor !== null && amount < before.price_minor && input.confirm !== true) throw fail(400, 'Confirm the price reduction first.');
            this.db.prepare('INSERT INTO crm_booking_charges (appointment_id,price_minor,currency,version,updated_at) VALUES (?,?,?,1,?) ON CONFLICT(appointment_id) DO UPDATE SET price_minor=excluded.price_minor,version=crm_booking_charges.version+1,updated_at=excluded.updated_at').run(booking.appointment_id, amount, CURRENCY, new Date().toISOString());
            const after = this.paymentSummary(booking.appointment_id);
            this.security.audit(actor, before.price_minor === null ? 'appointment.price_set' : 'appointment.price_updated', 'appointment', booking.appointment_id, { price_minor: before.price_minor, currency: CURRENCY }, { price_minor: after.price_minor, currency: CURRENCY });
            return after;
        });
    }
    recordPayment(booking, input, principal) {
        if (Object.keys(input).some(key => /^(?:card_number|pan|cvv|cvc|expiry)$/i.test(key))) throw fail(400, 'This form records payments only. Do not enter card details.');
        const amount = moneyMinor(input.amount);
        if (!['paid', 'partial', 'deposit', 'refund'].includes(input.kind) || !['cash', 'card', 'bank_transfer', 'other'].includes(input.method)) throw fail(400, 'Choose a payment type and method.');
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.request_id || '')) throw fail(400, 'A payment request ID is required. Retry the unchanged form.');
        if (input.confirm !== true) throw fail(400, 'Review and confirm the payment record first.');
        const receipt_reference = oneLine(input.receipt_reference, 120, 'Receipt reference');
        const note = oneLine(input.note, 500, 'Payment note');
        let received_at = null;
        if (input.received_at) {
            const value = String(input.received_at);
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw fail(400, 'Enter a valid payment date and time.');
            dateOnly(value.slice(0, 10));
            const stamp = Date.parse(value);
            if (!Number.isFinite(stamp) || stamp > Date.now() + 5 * 60000) throw fail(400, 'A payment record cannot be dated in the future.');
            received_at = new Date(stamp).toISOString();
        }
        const normalized = { appointment_id: booking.appointment_id, kind: input.kind, amount_minor: amount, method: input.method, receipt_reference, note, received_at, refund_of: input.kind === 'refund' ? String(input.refund_of || '') : null };
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
        return this.security.transaction(() => {
            const actor = this.actor(principal, input.kind === 'refund');
            const previous = this.db.prepare('SELECT * FROM crm_payments WHERE request_id=?').get(input.request_id);
            if (previous) {
                if (previous.request_fingerprint !== fingerprint) throw fail(409, 'This request ID belongs to a different payment. Reopen the payment form.');
                return { payment: cleanPayment(previous), summary: this.paymentSummary(booking.appointment_id), idempotent: true };
            }
            const before = this.paymentSummary(booking.appointment_id);
            if (before.price_minor === null) throw fail(409, 'Set the appointment price before recording a payment.');
            if (input.kind === 'refund') {
                const original = before.payments.find(payment => payment.id === normalized.refund_of && payment.kind !== 'refund');
                if (!original || amount > original.refundable_minor) throw fail(409, 'The refund exceeds the remaining amount on the selected receipt.');
                if (received_at && received_at < original.received_at) throw fail(400, 'A refund cannot be dated before its original receipt.');
            } else {
                if (amount > before.balance_minor) throw fail(409, 'The payment exceeds the remaining balance. Reload the booking.');
                if (input.kind === 'paid' && amount !== before.balance_minor) throw fail(400, 'For a full payment, enter the entire remaining balance. Otherwise choose Partial payment or Deposit.');
            }
            const linked = this.db.prepare('SELECT client_id FROM crm_appointment_clients WHERE appointment_id=?').get(booking.appointment_id);
            if (!linked) throw fail(409, 'Refresh the booking to link its client before recording a payment.');
            const id = crypto.randomUUID(); const now = new Date().toISOString();
            this.db.prepare('INSERT INTO crm_payments (id,request_id,request_fingerprint,appointment_id,client_id,service,kind,amount_minor,currency,method,receipt_reference,note,refund_of,received_at,is_test,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.request_id, fingerprint, booking.appointment_id, linked.client_id, booking.service || '', input.kind, amount, CURRENCY, input.method, receipt_reference, note, normalized.refund_of, received_at || now, Number(Boolean(booking.is_test)), actor.id, now);
            const payment = cleanPayment(this.db.prepare('SELECT * FROM crm_payments WHERE id=?').get(id));
            const after = this.paymentSummary(booking.appointment_id);
            this.security.audit(actor, input.kind === 'refund' ? 'payment.refund_recorded' : 'payment.recorded', 'appointment', booking.appointment_id, { net_minor: before.net_minor, balance_minor: before.balance_minor, payment_status: before.payment_status }, { net_minor: after.net_minor, balance_minor: after.balance_minor, payment_status: after.payment_status, amount_minor: amount, currency: CURRENCY, payment_kind: input.kind, payment_method: input.method, receipt_reference });
            return { payment, summary: after, idempotent: false };
        });
    }
    transactionRows(input = {}) {
        const query = filters(input), q = query.q.toLowerCase();
        const rows = this.db.prepare('SELECT p.*,c.customer_name,c.email,c.phone FROM crm_payments p JOIN crm_clients c ON c.id=p.client_id ORDER BY p.received_at DESC,p.created_at DESC,p.id DESC').all();
        const payments = rows.filter(row => (query.include_test || !row.is_test) && (!query.from || dayKey(row.received_at) >= query.from) && (!query.to || dayKey(row.received_at) <= query.to) && (!query.service || row.service === query.service) && (!q || [row.customer_name,row.email,row.phone,row.appointment_id,row.id,'RCPT-'+row.id,row.receipt_reference].some(value => String(value || '').toLowerCase().includes(q)) || matchesPhone(row.phone,q)))
            .map(row => ({...cleanPayment(row),customer_name:row.customer_name,email:row.email,phone:row.phone,receipt_number:'RCPT-'+row.id.toUpperCase()}));
        return {payments,services:[...new Set(rows.map(row => row.service))].sort()};
    }
    bookingRows(appointments) {
        const clients = new Map(this.db.prepare('SELECT a.appointment_id,c.id,c.customer_name,c.email,c.phone FROM crm_appointment_clients a JOIN crm_clients c ON c.id=a.client_id').all().map(row => [row.appointment_id, row]));
        return appointments.map(booking => {
            const client = clients.get(booking.appointment_id);
            const summary = this.paymentSummary(booking.appointment_id);
            const { payments, ...payment } = summary;
            return { ...booking, customer_name: client?.customer_name || booking.customer_name, email: client?.email || booking.email, phone: client?.phone || '', client_id: client?.id || null, is_test: Boolean(booking.is_test), ...payment };
        });
    }
    filterBookings(bookings, query) {
        const q = query.q.toLowerCase();
        return bookings.filter(booking => (query.include_test || !booking.is_test) && (!query.from || dayKey(booking.booking_start) >= query.from) && (!query.to || dayKey(booking.booking_start) <= query.to) && (!query.service || booking.service === query.service) && (!query.status || booking.status === query.status) && (!q || [booking.customer_name, booking.email, booking.phone, booking.appointment_id].some(value => String(value || '').toLowerCase().includes(q)) || matchesPhone(booking.phone,q)));
    }
    clients(appointments, search = '') {
        const bookings = this.bookingRows(appointments);
        const byClient = new Map();
        for (const booking of bookings) { if (!byClient.has(booking.client_id)) byClient.set(booking.client_id, []); byClient.get(booking.client_id).push(booking); }
        const q = String(search).trim().toLowerCase();
        if (q.length > 200) throw fail(400, 'Use a shorter client search.');
        return this.db.prepare('SELECT * FROM crm_clients ORDER BY customer_name COLLATE NOCASE,id').all().map(row => {
            const history = byClient.get(row.id) || [];
            return { ...cleanClient(row), bookings: history.length, visits: history.filter(booking => booking.status === 'completed').length, no_shows: history.filter(booking => booking.status === 'no_show').length, last_booking: history.map(booking => booking.booking_start).sort().at(-1) || null };
        }).filter(client => !q || [client.customer_name, client.email, client.phone].some(value => value.toLowerCase().includes(q)) || matchesPhone(client.phone,q));
    }
    clientDetail(id, appointments) {
        const client = cleanClient(this.db.prepare('SELECT * FROM crm_clients WHERE id=?').get(id));
        if (!client) throw fail(404, 'Client not found.');
        const bookings = this.bookingRows(appointments).filter(booking => booking.client_id === id).sort((a,b) => b.booking_start.localeCompare(a.booking_start));
        const payments = this.db.prepare('SELECT * FROM crm_payments WHERE client_id=? ORDER BY received_at DESC,created_at DESC').all(id).map(cleanPayment);
        return { client, bookings, payments };
    }
    report(appointments, input) {
        const query = filters(input);
        const allBookings = this.bookingRows(appointments);
        const bookings = this.filterBookings(allBookings, query);
        const nonTestClients = new Set(allBookings.filter(booking => !booking.is_test).map(booking => booking.client_id));
        const clients = this.clients(appointments, query.q).filter(client => query.include_test || !client.bookings || nonTestClients.has(client.id));
        const selectedIds = new Set(this.filterBookings(allBookings, { ...query, from: '', to: '' }).map(booking => booking.appointment_id));
        const payments = this.db.prepare('SELECT p.*,c.customer_name,c.email,c.phone FROM crm_payments p JOIN crm_clients c ON c.id=p.client_id ORDER BY received_at DESC,created_at DESC,id').all().filter(payment => (query.include_test || !payment.is_test) && (!query.from || dayKey(payment.received_at) >= query.from) && (!query.to || dayKey(payment.received_at) <= query.to) && (!query.service || payment.service === query.service) && ((!query.q && !query.status) || selectedIds.has(payment.appointment_id))).map(row => ({ ...cleanPayment(row), customer_name: row.customer_name, email: row.email, phone: row.phone }));
        const aggregate = key => {
            const groups = new Map();
            for (const payment of payments) {
                const label = key(payment);
                const group = groups.get(label) || { label, received_minor: 0, refunded_minor: 0, net_minor: 0, currency: CURRENCY };
                if (payment.kind === 'refund') group.refunded_minor = safeAdd(group.refunded_minor, payment.amount_minor); else group.received_minor = safeAdd(group.received_minor, payment.amount_minor);
                group.net_minor = group.received_minor - group.refunded_minor; groups.set(label, group);
            }
            return [...groups.values()].sort((a,b) => a.label.localeCompare(b.label));
        };
        const revenue_day = aggregate(payment => dayKey(payment.received_at));
        const revenue_month = aggregate(payment => dayKey(payment.received_at).slice(0, 7));
        const revenue_service = aggregate(payment => payment.service || 'Unspecified service');
        const top = new Map(); const busy = new Map();
        for (const booking of bookings.filter(booking => booking.status !== 'cancelled')) {
            top.set(booking.service, (top.get(booking.service) || 0) + 1);
            const local = new Date(Date.parse(booking.booking_start) + 8 * 3600000);
            const weekday = local.getUTCDay(); const hour = local.getUTCHours(); const label = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][weekday] + ' ' + String(hour).padStart(2, '0') + ':00';
            const key = weekday + ':' + hour; const group = busy.get(key) || { label, weekday, hour, bookings: 0 }; group.bookings++; busy.set(key, group);
        }
        const received_minor = payments.filter(payment => payment.kind !== 'refund').reduce((sum,payment) => safeAdd(sum,payment.amount_minor),0);
        const refunded_minor = payments.filter(payment => payment.kind === 'refund').reduce((sum,payment) => safeAdd(sum,payment.amount_minor),0);
        return { filters: query, currency: CURRENCY, timezone: 'Asia/Manila', generated_at: new Date().toISOString(), summary: { bookings: bookings.length, cancelled: bookings.filter(booking=>booking.status==='cancelled').length, clients: clients.length, received_minor, refunded_minor, net_minor: received_minor-refunded_minor }, bookings, clients, payments, revenue_day, revenue_month, revenue_service, top_services: [...top].map(([service,bookings])=>({service,bookings})).sort((a,b)=>b.bookings-a.bookings||a.service.localeCompare(b.service)), busiest_times: [...busy.values()].sort((a,b)=>b.bookings-a.bookings||a.weekday-b.weekday||a.hour-b.hour) };
    }
}
module.exports = { CrmStore, moneyMinor, filters, dateOnly, dayKey, CURRENCY, MAX_MINOR };
