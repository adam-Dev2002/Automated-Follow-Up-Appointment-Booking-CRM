const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail } = require('./security-store.cjs');
const { receiptDigest, receiptHtml } = require('./payment-receipt.cjs');
const publicJob = row => {
    if(!row)return null;
    const job=Object.fromEntries(['id','payment_id','recipient','status','gmail_message_id','detail','created_at','updated_at'].map(key => [key,row[key]]));
    job.overdue=row.status==='Sending' && Date.now()-Date.parse(row.updated_at)>180000;
    if(job.overdue)job.detail='Delivery has not been confirmed. Check the sending account before sending another copy. This receipt will not retry automatically.';
    return job;
};
class ReceiptStore {
    constructor(security) {
        this.security = security;
        this.db = security.db;
        this.db.exec(fs.readFileSync(path.join(__dirname,'migrations/003-receipt-emails.sql'),'utf8'));
        if (!this.db.prepare('PRAGMA table_info(crm_receipt_emails)').all().some(column=>column.name==='sender_email')) this.db.exec("ALTER TABLE crm_receipt_emails ADD COLUMN sender_email TEXT NOT NULL DEFAULT ''");
    }
    sender() {
        const row = this.db.prepare('SELECT email,checked_at FROM crm_receipt_sender WHERE id=1').get();
        return { ready:!!row && Date.now()-Date.parse(row.checked_at)<180000, email:row?.email || '', checked_at:row?.checked_at || '' };
    }
    forPayment(id) { return publicJob(this.db.prepare('SELECT * FROM crm_receipt_emails WHERE payment_id=?').get(id)); }
    withDelivery(summary) { return { ...summary, payments:summary.payments.map(payment => ({...payment, receipt_email:this.forPayment(payment.id)})), receipt_sender:this.sender() }; }
    queue(receipt,input,actor) {
        if (input.confirm !== true) throw fail(400,'Confirm the recipient and receipt before sending.');
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.request_id || '')) throw fail(400,'A receipt request ID is required. Reopen the confirmation.');
        if (receipt.is_test || /@(?:example\.(?:com|org|net)|[^@]*\.(?:test|invalid))$/i.test(receipt.email)) throw fail(400,'Test bookings cannot email receipts. You can print a test copy.');
        if (!/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(receipt.email)) throw fail(400,'This booking needs a valid customer email before a receipt can be sent.');
        if (input.to !== receipt.email || input.receipt_digest !== receiptDigest(receipt)) throw fail(409,'The receipt or recipient changed. Review the current receipt again.');
        return this.security.transaction(() => {
            const user = this.db.prepare('SELECT disabled FROM workspace_users WHERE id=?').get(actor.id);
            if (!user || user.disabled) throw fail(401,'Sign in to continue.');
            const old = this.db.prepare('SELECT * FROM crm_receipt_emails WHERE payment_id=? OR request_id=?').get(receipt.payment_id,input.request_id);
            if (old) {
                if (old.request_id !== input.request_id || old.payment_id !== receipt.payment_id || old.receipt_digest !== input.receipt_digest) throw fail(409,'A receipt email has already been requested. Check its delivery status.');
                return { job:publicJob(old), idempotent:true };
            }
            const sender=this.sender();
            if (!sender.ready) throw fail(503,'The sending account is not ready. Refresh its status before sending.');
            if (input.sender_email!==sender.email) throw fail(409,'The sending account changed. Review the receipt and sender again.');
            const id=crypto.randomUUID(),now=new Date().toISOString();
            const subject=(receipt.kind==='refund'?'Refund receipt':'Payment receipt')+' · '+receipt.appointment_id;
            this.db.prepare("INSERT INTO crm_receipt_emails(id,payment_id,request_id,receipt_digest,recipient,sender_email,subject,html,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'Queued',?,?,?)")
                .run(id,receipt.payment_id,input.request_id,input.receipt_digest,receipt.email,sender.email,subject,receiptHtml(receipt,true),actor.id,now,now);
            this.security.audit(actor,'payment.receipt_queued','appointment',receipt.appointment_id,null,{receipt_id:receipt.payment_id,recipient:receipt.email,status:'Queued'});
            return {job:this.forPayment(receipt.payment_id),idempotent:false};
        });
    }
    process(input) {
        const execution=String(input.execution_id || '');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(execution)) throw fail(400,'A sender execution ID is required.');
        if (input.action==='claim') {
            const email=String(input.sender_email || '').trim().toLowerCase();
            if (!/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(email)) throw fail(400,'A verified sender profile is required.');
            return this.security.transaction(() => {
                const now=new Date().toISOString();
                this.db.prepare('INSERT INTO crm_receipt_sender(id,email,checked_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,checked_at=excluded.checked_at').run(email,now);
                this.db.prepare("UPDATE crm_receipt_emails SET status='Needs review',detail='The connected sending account changed. Review this receipt before sending.',updated_at=? WHERE status='Queued' AND sender_email<>?").run(now,email);
                const row=this.db.prepare("SELECT * FROM crm_receipt_emails WHERE status='Queued' ORDER BY created_at,id LIMIT 1").get();
                if(!row)return {job:null};
                this.db.prepare("UPDATE crm_receipt_emails SET status='Sending',execution_id=?,updated_at=? WHERE id=? AND status='Queued'").run(execution,now,row.id);
                return {job:{id:row.id,to:row.recipient,subject:row.subject,html:row.html}};
            });
        }
        if (input.action==='result') {
            return this.security.transaction(() => {
                const row=this.db.prepare('SELECT * FROM crm_receipt_emails WHERE id=?').get(String(input.job_id || ''));
                if(!row)throw fail(404,'Receipt delivery not found.');
                if(row.execution_id!==execution)throw fail(409,'This delivery belongs to another sender execution.');
                if(row.status==='Sent') {
                    if(input.outcome==='sent' && input.gmail_message_id===row.gmail_message_id)return {accepted:true,duplicate:true};
                    throw fail(409,'Receipt delivery is already confirmed.');
                }
                if(row.status==='Needs review' && input.outcome==='uncertain')return {accepted:true,duplicate:true};
                if(row.status!=='Sending' && row.status!=='Needs review')throw fail(409,'This receipt was not claimed.');
                const sent=input.outcome==='sent' && /^[a-f0-9]{6,100}$/i.test(input.gmail_message_id || '');
                if(input.outcome==='sent'&&!sent)throw fail(400,'A Gmail message ID is required to confirm delivery.');
                if(!['sent','uncertain'].includes(input.outcome))throw fail(400,'Provide a confirmed or uncertain result.');
                const status=sent?'Sent':'Needs review';
                const detail=sent?'Gmail accepted the receipt email. Inbox delivery is not confirmed.':'Delivery could not be confirmed. Check the sending account before sending another copy.';
                this.db.prepare('UPDATE crm_receipt_emails SET status=?,gmail_message_id=?,detail=?,updated_at=? WHERE id=?').run(status,sent?input.gmail_message_id:null,detail,new Date().toISOString(),row.id);
                const payment=this.db.prepare('SELECT appointment_id FROM crm_payments WHERE id=?').get(row.payment_id);
                this.security.audit({id:'receipt-sender',display_name:'Receipt sender',role:'system'},sent?'payment.receipt_sent':'payment.receipt_needs_review','appointment',payment.appointment_id,null,{receipt_id:row.payment_id,status});
                return {accepted:true};
            });
        }
        throw fail(400,'Unsupported receipt delivery action.');
    }
}
module.exports = { ReceiptStore };
