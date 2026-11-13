const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SecurityStore}=require('../security-store.cjs');
const {CrmStore}=require('../crm-store.cjs');
const {ReceiptStore}=require('../receipt-store.cjs');
const {receiptSnapshot,receiptDigest,receiptHtml}=require('../payment-receipt.cjs');
const {buildReceiptWorkflow}=require('../build-receipt-workflow.cjs');
async function fixture(){
    const security=new SecurityStore(':memory:');
    const actor=await security.createUser({username:'receipt-owner',display_name:'Receipt Owner',password:'isolated-receipt-owner'});
    const crm=new CrmStore(security),receipts=new ReceiptStore(security);
    const booking={appointment_id:'appt_receipt_1',customer_name:'Client <img src=x onerror=alert(1)>',email:'client@company.com',service:'Consultation',booking_start:'2026-01-01T01:00:00Z',booking_end:'2026-01-01T02:00:00Z',status:'confirmed',is_test:false,manage_token:'PRIVATE_MANAGEMENT_CODE'};
    crm.syncAppointments([booking],actor);crm.setPrice(booking,{price:'200',version:0},actor);
    const payment=crm.recordPayment(booking,{request_id:'payment_receipt_1',kind:'paid',amount:'200',method:'cash',note:'PRIVATE_STAFF_NOTE',confirm:true},actor).payment;
    const receipt=receiptSnapshot(booking,crm.paymentSummary(booking.appointment_id),payment.id);
    const input={request_id:'receipt_send_1',to:receipt.email,sender_email:'sender@company.test',receipt_digest:receiptDigest(receipt),confirm:true};
    return{security,actor,crm,receipts,booking,payment,receipt,input};
}
test('receipt reflects persisted cents, dates, type and balance; excludes internal notes and management tokens',async()=>{
    const f=await fixture();try{
        const html=receiptHtml(f.receipt);
        assert.equal(f.receipt.amount_minor,20000);assert.equal(f.receipt.balance_minor,0);
        assert.ok(html.includes('₱200.00'));assert.ok(html.includes('&lt;img'));assert.equal(html.includes('<img src=x'),false);
        assert.equal(html.includes('PRIVATE_STAFF_NOTE'),false);assert.equal(html.includes('PRIVATE_MANAGEMENT_CODE'),false);
        assert.equal(receiptDigest(f.receipt),receiptDigest({...f.receipt}));
        assert.equal(receiptHtml(f.receipt,true).includes('<script'),false);
        assert.throws(()=>receiptSnapshot(f.booking,f.crm.paymentSummary(f.booking.appointment_id),'missing'),{status:404});
    }finally{f.security.close();}
});
test('receipt emailing requires exact owner confirmation, matching current snapshot, recipient and sender readiness',async()=>{
    const f=await fixture();try{
        assert.throws(()=>f.receipts.queue(f.receipt,{...f.input,confirm:false},f.actor),{status:400});
        assert.throws(()=>f.receipts.queue(f.receipt,{...f.input,to:'other@company.com'},f.actor),{status:409});
        assert.throws(()=>f.receipts.queue(f.receipt,{...f.input,receipt_digest:'old'},f.actor),{status:409});
        assert.throws(()=>f.receipts.queue(f.receipt,f.input,f.actor),{status:503});
        assert.deepEqual(f.receipts.process({action:'claim',execution_id:'empty',sender_email:'sender@company.test'}),{job:null});
        assert.throws(()=>f.receipts.queue(f.receipt,{...f.input,sender_email:'unexpected@company.test'},f.actor),{status:409});
        const job=f.receipts.queue(f.receipt,f.input,f.actor).job;
        assert.equal(job.status,'Queued');assert.equal(f.receipts.queue(f.receipt,f.input,f.actor).idempotent,true);
        assert.throws(()=>f.receipts.queue(f.receipt,{...f.input,request_id:'second_receipt_send'},f.actor),{status:409});
    }finally{f.security.close();}
});
test('test bookings and reserved recipient domains cannot send, but printable copies remain available',async()=>{
    const f=await fixture();try{
        for(const receipt of[{...f.receipt,is_test:true},{...f.receipt,email:'test@example.test'},{...f.receipt,email:'test@example.com'}]){
            assert.throws(()=>f.receipts.queue(receipt,{...f.input,to:receipt.email,receipt_digest:receiptDigest(receipt)},f.actor),{status:400});
        }
        assert.ok(receiptHtml({...f.receipt,is_test:true}).includes('TEST BOOKING'));
        assert.equal(f.security.db.prepare('SELECT count(*) total FROM crm_receipt_emails').get().total,0);
    }finally{f.security.close();}
});
test('durable claim is exclusive and never reclaimed; uncertain sends do not retry; only matching Gmail confirmation marks sent',async()=>{
    const f=await fixture();try{
        f.receipts.process({action:'claim',execution_id:'register',sender_email:'sender@company.test'});
        const queued=f.receipts.queue(f.receipt,f.input,f.actor).job;
        const claim=f.receipts.process({action:'claim',execution_id:'send_1',sender_email:'sender@company.test'});
        assert.equal(claim.job.id,queued.id);
        assert.deepEqual(f.receipts.process({action:'claim',execution_id:'send_1',sender_email:'sender@company.test'}),{job:null});
        assert.throws(()=>f.receipts.process({action:'result',execution_id:'other',job_id:queued.id,outcome:'sent',gmail_message_id:'abcdef1234'}),{status:409});
        assert.throws(()=>f.receipts.process({action:'result',execution_id:'send_1',job_id:queued.id,outcome:'sent'}),{status:400});
        f.receipts.process({action:'result',execution_id:'send_1',job_id:queued.id,outcome:'uncertain'});
        assert.equal(f.receipts.forPayment(f.payment.id).status,'Needs review');
        assert.deepEqual(f.receipts.process({action:'claim',execution_id:'send_2',sender_email:'sender@company.test'}),{job:null});
        assert.equal(f.receipts.process({action:'result',execution_id:'send_1',job_id:queued.id,outcome:'uncertain'}).duplicate,true);
        const finish={action:'result',execution_id:'send_1',job_id:queued.id,outcome:'sent',gmail_message_id:'abcdef1234'};
        f.receipts.process(finish);assert.equal(f.receipts.forPayment(f.payment.id).status,'Sent');assert.equal(f.receipts.process(finish).duplicate,true);
    }finally{f.security.close();}
});
test('email contents are frozen at confirmation; payment/refund balances are not changed by queue or delivery',async()=>{
    const f=await fixture();try{
        const before=JSON.stringify(f.crm.paymentSummary(f.booking.appointment_id));
        f.receipts.process({action:'claim',execution_id:'register',sender_email:'sender@company.test'});
        const job=f.receipts.queue(f.receipt,f.input,f.actor).job;
        f.booking.customer_name='Changed after confirmation';
        const claimed=f.receipts.process({action:'claim',execution_id:'send_1',sender_email:'sender@company.test'}).job;
        assert.equal(claimed.to,'client@company.com');assert.equal(claimed.html.includes('Changed after confirmation'),false);
        f.receipts.process({action:'result',execution_id:'send_1',job_id:job.id,outcome:'sent',gmail_message_id:'abcdef1234'});
        assert.equal(JSON.stringify(f.crm.paymentSummary(f.booking.appointment_id)),before);
    }finally{f.security.close();}
});
test('changed sender identity holds queued email; revoked staff cannot queue',async()=>{
    const f=await fixture();try{
        f.receipts.process({action:'claim',execution_id:'register',sender_email:'sender@company.test'});
        f.receipts.queue(f.receipt,f.input,f.actor);
        assert.equal(f.receipts.process({action:'claim',execution_id:'changed',sender_email:'different@company.test'}).job,null);
        assert.equal(f.receipts.forPayment(f.payment.id).status,'Needs review');
        f.security.db.prepare('UPDATE workspace_users SET disabled=1 WHERE id=?').run(f.actor.id);
        assert.throws(()=>f.receipts.queue(f.receipt,{...f.input,request_id:'revoked_request'},f.actor),{status:401});
    }finally{f.security.close();}
});
test('a stale sending claim remains held and exposes uncertainty without automatic resend',async()=>{
    const f=await fixture();try{
        f.receipts.process({action:'claim',execution_id:'register',sender_email:'sender@company.test'});
        const queued=f.receipts.queue(f.receipt,f.input,f.actor).job;
        f.receipts.process({action:'claim',execution_id:'claimed',sender_email:'sender@company.test'});
        f.security.db.prepare('UPDATE crm_receipt_emails SET updated_at=? WHERE id=?').run('2020-01-01T00:00:00Z',queued.id);
        assert.equal(f.receipts.forPayment(f.payment.id).overdue,true);
        assert.equal(f.receipts.forPayment(f.payment.id).status,'Sending');
        assert.equal(f.receipts.process({action:'claim',execution_id:'another',sender_email:'sender@company.test'}).job,null);
        f.receipts.process({action:'result',execution_id:'claimed',job_id:queued.id,outcome:'sent',gmail_message_id:'abcdef1234'});
        assert.equal(f.receipts.forPayment(f.payment.id).status,'Sent');
    }finally{f.security.close();}
});
test('receipt workflow is independent, checks Gmail before claim, has no automatic Gmail retry and reports uncertain outputs',()=>{
    const workflow=buildReceiptWorkflow({id:'gmail'},{id:'callback'});
    const names=workflow.nodes.map(node=>node.name);
    assert.equal(workflow.nodes.length,7);assert.equal(workflow.nodes[0].type,'n8n-nodes-base.scheduleTrigger');
    assert.ok(names.indexOf('Read Gmail sending account')<names.indexOf('Claim one receipt'));
    assert.equal(workflow.nodes.find(node=>node.type==='n8n-nodes-base.gmail').retryOnFail,false);
    assert.deepEqual(workflow.connections['Receipt waiting?'].main[1],[]);
    const code=workflow.nodes.find(node=>node.name==='Record receipt result').parameters.jsCode;
    const run=result=>new Function('$input','$','$execution',code)({first:()=>({json:result})},()=>({first:()=>({json:{job:{id:'job'}}})}),{id:'exec'})[0].json;
    assert.equal(run({id:'abcdef1234'}).outcome,'sent');
    assert.equal(run({error:'Timeout'}).outcome,'uncertain');
    assert.equal(run({}).outcome,'uncertain');
    assert.equal(JSON.stringify(buildReceiptWorkflow()).includes('PRIVATE'),false);
});
