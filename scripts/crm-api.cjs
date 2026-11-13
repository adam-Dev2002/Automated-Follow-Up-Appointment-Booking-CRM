const { CrmStore, filters, dayKey } = require('./crm-store.cjs');
const { exportReport } = require('./crm-exports.cjs');
const { fail } = require('./security-store.cjs');
const { timingSafeEqual } = require('node:crypto');
const { receiptSnapshot, receiptDigest, receiptHtml } = require('./payment-receipt.cjs');
const { ReceiptStore } = require('./receipt-store.cjs');
const { ClientAvatars } = require('./client-avatars.cjs');

function createCrmApi({ security, upstream, readJson, json, serviceToken = '' }) {
    const crm = new CrmStore(security);
    const receipts = new ReceiptStore(security);
    const avatars = new ClientAvatars(security);
    async function loadBookings(actor, syncClients = true) {
        const records = []; let after = 0;
        for (let page = 0; page < 100; page++) {
            const response = await upstream({ action:'crm_list',after_id:after }, actor);
            let data;
            try { data = await response.json(); } catch { throw fail(502,'The booking list could not be read. Check the booking connection and retry.'); }
            if (!response.ok || !data.ok || !Array.isArray(data.appointments)) throw fail(502,'The complete booking list is unavailable. Check the CRM read path and retry.');
            const fields = ['id','appointment_id','customer_name','email','service','booking_start','booking_end','timezone','status','version','is_test','createdAt','updatedAt'];
            records.push(...data.appointments.map(booking => Object.fromEntries(fields.map(key => [key, booking[key] ?? null]))));
            if (data.next_after_id === null) {
                if (new Set(records.map(booking=>booking.appointment_id)).size !== records.length) throw fail(502,'The booking source returned duplicate records. Retry the report.');
                if (syncClients) crm.syncAppointments(records,actor);
                return records;
            }
            if (!Number.isSafeInteger(data.next_after_id) || data.next_after_id <= after) throw fail(502,'The booking source returned an invalid page cursor.');
            after = data.next_after_id;
        }
        throw fail(422,'There are more than 50,000 bookings. Narrow the source before exporting.');
    }
    function pageOf(rows, input) {
        const page = Number(input || 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw fail(400,'Choose a valid page.');
        return { rows:rows.slice((page-1)*25,page*25),page,page_size:25,total:rows.length };
    }
    return async function handleCrm(req,res,url,session) {
        if (url.pathname === '/api/receipt-emails') {
            const expected = Buffer.from(serviceToken), given = Buffer.from(String(req.headers['x-appoint-operator'] || ''));
            if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected,given)) throw fail(401,'Unauthorized sender.');
            if (req.method !== 'POST') throw fail(405,'Use POST.');
            json(res,200,{ok:true,...receipts.process(await readJson(req))}); return true;
        }
        if (!url.pathname.startsWith('/api/crm/')) return false;
        const ownerOnly = ['/api/crm/reports','/api/crm/export'].includes(url.pathname);
        let actor = crm.actor(security.requireUser(session),ownerOnly);
        if (['POST','PUT','PATCH'].includes(req.method)) security.requireCsrf(session,req.headers['x-csrf-token']);
        const input = Object.fromEntries(url.searchParams);
        if (url.pathname === '/api/crm/client-identities' && req.method === 'GET') {
            const clients = security.db.prepare('SELECT id,customer_name,email FROM crm_clients ORDER BY id').all().map(row=>avatars.decorate(row));
            json(res,200,{ok:true,clients}); return true;
        }
        if (url.pathname === '/api/crm/payments' && req.method === 'GET') {
            const {payments,services} = crm.transactionRows(input);
            const page = pageOf(payments,input.page);
            security.audit(actor,'transactions.viewed','workspace','',null,{count:page.total});
            json(res,200,{ok:true,payments:page.rows.map(row => avatars.decorate(row,row.client_id)),services,...Object.fromEntries(Object.entries(page).filter(([key])=>key!=='rows')),currency:'PHP',timezone:'Asia/Manila'});
            return true;
        }
        const avatarPath = url.pathname.match(/^\/api\/crm\/clients\/([a-f0-9-]{36})\/avatar$/);
        if (avatarPath) {
            if (req.method === 'GET') {
                const avatar = avatars.image(avatarPath[1]);
                res.writeHead(200,{'Content-Type':avatar.content_type,'Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; sandbox"});
                res.end(Buffer.from(avatar.image));
            } else if (req.method === 'PUT') json(res,200,{ok:true,avatar:avatars.save(avatarPath[1],await readJson(req),actor)});
            else throw fail(405,'Use GET or PUT.');
            return true;
        }
        if (url.pathname === '/api/crm/calendar' && req.method === 'GET') {
            const { from, to } = filters(input);
            const start = Date.parse(from + 'T00:00:00+08:00');
            const end = Date.parse(to + 'T00:00:00+08:00') + 86400000;
            if (!from || !to || end - start > 62 * 86400000) throw fail(400,'Choose a calendar range of up to 62 days.');
            const bookings = await loadBookings(actor,false);
            actor = crm.actor(actor);
            const appointments = bookings.filter(booking => Date.parse(booking.booking_start) < end && Date.parse(booking.booking_end) > start)
                .sort((a,b) => Date.parse(a.booking_start) - Date.parse(b.booking_start));
            security.audit(actor,'calendar.viewed','workspace','',null,{from,to,count:appointments.length});
            json(res,200,{ok:true,appointments,from,to,timezone:'Asia/Manila',checked_at:new Date().toISOString()}); return true;
        }
        const clientPath = url.pathname.match(/^\/api\/crm\/clients\/([a-f0-9-]{36})$/);
        const bookingPath = url.pathname.match(/^\/api\/crm\/appointments\/([A-Za-z0-9_-]{1,200})(?:\/(price|payments))?$/);
        const receiptPath = url.pathname.match(/^\/api\/crm\/payments\/([a-f0-9-]{36})\/receipt(?:\/(email))?$/);
        if (url.pathname === '/api/crm/clients' && req.method === 'POST') {
            const result = crm.createClient(await readJson(req),actor);
            json(res,result.idempotent?200:201,{ok:true,...result,client:avatars.decorate(result.client)}); return true;
        }
        if (clientPath && req.method === 'PATCH') {
            json(res,200,{ok:true,client:avatars.decorate(crm.updateClient(clientPath[1],await readJson(req),actor))}); return true;
        }
        const bookings = await loadBookings(actor);
        actor = crm.actor(actor,ownerOnly);
        if (receiptPath) {
            const payment = security.db.prepare('SELECT appointment_id FROM crm_payments WHERE id=?').get(receiptPath[1]);
            if (!payment) throw fail(404,'Receipt not found.');
            const booking = crm.bookingRows(bookings).find(row=>row.appointment_id===payment.appointment_id);
            if (!booking) throw fail(404,'The booking for this receipt is unavailable.');
            const receipt = receiptSnapshot(booking,crm.paymentSummary(payment.appointment_id),receiptPath[1]);
            if (req.method === 'POST' && receiptPath[2] === 'email') {
                const result = receipts.queue(receipt,await readJson(req),actor);
                json(res,result.idempotent?200:202,{ok:true,...result}); return true;
            }
            if (req.method === 'GET' && !receiptPath[2]) {
                if (input.format === 'json') {
                    json(res,200,{ok:true,receipt,receipt_digest:receiptDigest(receipt),email:receipts.forPayment(receipt.payment_id),sender:receipts.sender()}); return true;
                }
                security.audit(actor,'payment.receipt_viewed','appointment',payment.appointment_id,null,{receipt_id:receipt.payment_id});
                res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
                res.end(receiptHtml(receipt)); return true;
            }
            throw fail(405,'Unsupported receipt action.');
        }
        if (url.pathname === '/api/crm/clients' && req.method === 'GET') {
            const page = pageOf(crm.clients(bookings,input.q),input.page);
            security.audit(actor,'clients.viewed','workspace','',null,{count:page.total});
            json(res,200,{ok:true,clients:page.rows.map(row=>avatars.decorate(row)),...Object.fromEntries(Object.entries(page).filter(([key])=>key!=='rows'))}); return true;
        }
        if (clientPath && req.method === 'GET') {
            const detail = crm.clientDetail(clientPath[1],bookings);
            security.audit(actor,'client.viewed','client',clientPath[1],null,{customer_name:detail.client.customer_name});
            json(res,200,{ok:true,...detail,client:avatars.decorate(detail.client)}); return true;
        }
        if (url.pathname === '/api/crm/appointments' && req.method === 'GET') {
            const query = filters(input);
            const page = pageOf(crm.filterBookings(crm.bookingRows(bookings),query).sort((a,b)=>b.booking_start.localeCompare(a.booking_start)),input.page);
            security.audit(actor,'payments.viewed','workspace','',null,{count:page.total});
            json(res,200,{ok:true,appointments:page.rows.map(row=>avatars.decorate(row,row.client_id)),...Object.fromEntries(Object.entries(page).filter(([key])=>key!=='rows')),services:[...new Set(bookings.map(booking=>booking.service))].sort(),currency:'PHP',timezone:'Asia/Manila'}); return true;
        }
        if (bookingPath) {
            const booking = bookings.find(row=>row.appointment_id===bookingPath[1]);
            if (!booking) throw fail(404,'Appointment not found.');
            if (req.method === 'GET' && !bookingPath[2]) {
                security.audit(actor,'payments.viewed','appointment',booking.appointment_id,null,null);
                const row = crm.bookingRows([booking])[0];
                json(res,200,{ok:true,booking:avatars.decorate(row,row.client_id),summary:receipts.withDelivery(crm.paymentSummary(booking.appointment_id))}); return true;
            }
            if (req.method === 'PUT' && bookingPath[2] === 'price') { json(res,200,{ok:true,summary:receipts.withDelivery(crm.setPrice(booking,await readJson(req),actor))}); return true; }
            if (req.method === 'POST' && bookingPath[2] === 'payments') {
                const result = crm.recordPayment(booking,await readJson(req),actor);
                json(res,result.idempotent?200:201,{ok:true,...result,summary:receipts.withDelivery(result.summary)}); return true;
            }
        }
        if (url.pathname === '/api/crm/reports' && req.method === 'GET') {
            const {bookings:reportBookings,clients,payments,...report} = crm.report(bookings,input);
            security.audit(actor,'reports.viewed','workspace','',null,{from:report.filters.from,to:report.filters.to,service:report.filters.service});
            json(res,200,{ok:true,report,services:[...new Set(bookings.map(booking=>booking.service))].sort()}); return true;
        }
        if (url.pathname === '/api/crm/export' && req.method === 'GET') {
            const report = crm.report(bookings,input);
            const dataset = input.dataset || 'appointments'; const format = input.format || 'xlsx';
            const file = await exportReport(report,dataset,format);
            actor = crm.actor(actor,true);
            security.audit(actor,'data.exported','workspace','',null,{dataset,file_format:format,rows:file.rows,from:report.filters.from,to:report.filters.to});
            res.writeHead(200,{'Content-Type':file.contentType,'Content-Disposition':'attachment; filename="appoint-'+dataset+'-'+dayKey(report.generated_at)+'.'+format+'"','Cache-Control':'no-store','Content-Length':file.buffer.length});
            res.end(file.buffer); return true;
        }
        throw fail(404,'CRM endpoint not found.');
    };
}
module.exports = { createCrmApi };
