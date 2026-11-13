const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const ExcelJS = require('exceljs');
const { SecurityStore } = require('../security-store.cjs');
const { CrmStore, moneyMinor, filters } = require('../crm-store.cjs');
const { exportReport, csvCell } = require('../crm-exports.cjs');
const { ClientAvatars } = require('../client-avatars.cjs');
const { removeTestDirectory } = require('../test-server.cjs');
const bookings = [
    { id:1,appointment_id:'appt_first',customer_name:'Client A',email:'client@company.com',service:'Consultation',booking_start:'2025-02-01T15:30:00.000Z',booking_end:'2025-02-01T16:00:00.000Z',status:'confirmed',is_test:false },
    { id:2,appointment_id:'appt_second',customer_name:'Client A',email:'CLIENT@company.com',service:'Follow-up',booking_start:'2025-02-02T01:00:00.000Z',booking_end:'2025-02-02T02:00:00.000Z',status:'cancelled',is_test:false },
    { id:3,appointment_id:'appt_test',customer_name:'Test Client',email:'test@example.test',service:'Test Service',booking_start:'2025-02-01T01:00:00.000Z',booking_end:'2025-02-01T02:00:00.000Z',status:'confirmed',is_test:true }
];
async function fixture(filename=':memory:') {
    const security=new SecurityStore(filename);
    const owner=await security.createUser({username:'owner',display_name:'Owner',password:'owner-test-password'});
    const staff=await security.createUser({username:'staff',display_name:'Staff',password:'staff-test-password',role:'staff'},owner);
    const crm=new CrmStore(security);crm.syncAppointments(bookings,owner);
    return{security,crm,owner,staff};
}
const payment=(overrides={})=>({kind:'deposit',amount:'300.00',method:'cash',request_id:'payment_'+crypto.randomUUID(),received_at:'2025-01-31T16:30:00.000Z',confirm:true,...overrides});

test('exact cent parsing and strict dates reject malformed financial input',()=>{
    assert.equal(moneyMinor('0.29'),29);assert.equal(moneyMinor('1000.01'),100001);assert.equal(moneyMinor('0',true),0);
    for(const value of['-1','0','1.001','1e3','NaN','Infinity','1000000000.01'])assert.throws(()=>moneyMinor(value),{status:400});
    for(const date of['2025-02-30','2025-13-01','2025-00-01','not-a-date'])assert.throws(()=>filters({from:date}),{status:400});
    assert.throws(()=>filters({from:'2025-03-01',to:'2025-02-01'}),{status:400});
});

test('transaction history lists individual receipts and refunds, including test records, without requiring current bookings',async()=>{
    const {security,crm,owner}=await fixture();
    try{
        crm.setPrice(bookings[0],{price:'1000',version:0},owner);
        const first=crm.recordPayment(bookings[0],payment({receipt_reference:'CASH-101'}),owner).payment;
        const refund=crm.recordPayment(bookings[0],payment({kind:'refund',amount:'100',refund_of:first.id,received_at:'2025-02-02T02:00:00Z'}),owner).payment;
        crm.setPrice(bookings[2],{price:'50',version:0},owner);
        crm.recordPayment(bookings[2],payment({kind:'paid',amount:'50'}),owner);
        const history=crm.transactionRows();
        assert.equal(history.payments.length,3);
        assert.equal(history.payments[0].id,refund.id);
        assert.equal(history.payments.some(row=>row.appointment_id===bookings[1].appointment_id),false,'Unpaid bookings are not transactions');
        assert.equal(crm.transactionRows({include_test:false}).payments.length,2);
        assert.equal(crm.transactionRows({q:'CASH-101'}).payments[0].id,first.id);
        assert.equal(crm.transactionRows({q:'RCPT-'+first.id.toUpperCase()}).payments[0].id,first.id);
        assert.equal(crm.transactionRows({from:'2025-02-01',to:'2025-02-01'}).payments.length,2,'Dates use the payment date in Manila');
        assert.equal(history.payments[0].client_id,crm.clientDetail(history.payments[0].client_id,[]).client.id);
        assert.equal(Object.hasOwn(history.payments[0],'request_fingerprint'),false);
        assert.equal(history.payments[0].method,'cash');
    }finally{security.close();}
});

test('client photos persist with the client, reject stale writes and active content, and audit only metadata',async()=>{
    const {security,crm,owner,staff}=await fixture();
    try{
        const avatars=new ClientAvatars(security),client=crm.clients(bookings)[0];
        const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
        const saved=avatars.save(client.id,{image,version:0},staff);
        assert.equal(saved.has_avatar,true);assert.equal(saved.avatar_version,1);
        assert.equal(new ClientAvatars(security).image(client.id).content_type,'image/png');
        assert.throws(()=>avatars.save(client.id,{image,version:0},owner),{status:409});
        assert.throws(()=>avatars.save(client.id,{image:'data:image/svg+xml;base64,PHN2Zz4=',version:1},owner),{status:400});
        assert.equal(JSON.stringify(security.readAudit()).includes('iVBOR'),false);
        const removed=avatars.save(client.id,{image:'',version:1},owner);
        assert.equal(removed.has_avatar,false);assert.equal(removed.avatar_version,2);
        assert.throws(()=>avatars.image(client.id),{status:404});
    }finally{security.close();}
});

test('client import is idempotent; history spans browsers; contact edits use versions',async()=>{
    const {security,crm,owner}=await fixture();
    try{
        const count=security.readAudit().length;crm.syncAppointments(bookings,owner);assert.equal(security.readAudit().length,count);
        const client=crm.clients(bookings,'client@company.com')[0];assert.equal(client.bookings,2);
        assert.equal(crm.clientDetail(client.id,bookings).bookings.length,2);
        const updated=crm.updateClient(client.id,{customer_name:'Updated Client',email:client.email,phone:'+63 912 345 6789',version:client.version},owner);
        assert.equal(crm.clients(bookings,'912 345')[0].id,client.id);assert.equal(updated.version,2);
        assert.equal(crm.clients(bookings,'9123456789')[0].id,client.id);
        assert.equal(crm.filterBookings(crm.bookingRows(bookings),filters({q:'9123456789'})).length,2);
        assert.throws(()=>crm.updateClient(client.id,{...updated,version:1},owner),{status:409});
        const data={customer_name:'Phone Client',phone:'+65 8123 4567',email:'',request_id:'new_client_request'};
        const created=crm.createClient(data,owner);assert.equal(crm.createClient(data,owner).idempotent,true);
        assert.equal(crm.clientDetail(created.client.id,bookings).bookings.length,0);
        assert.throws(()=>crm.createClient({...data,email:client.email,request_id:'different_client_request'},owner),{status:409});
    }finally{security.close();}
});

test('deposit, partial, full payment, refunds, idempotency, and overpayment protection',async()=>{
    const{security,crm,owner,staff}=await fixture();const booking=bookings[0];
    try{
        assert.throws(()=>crm.recordPayment(booking,payment(),owner),{status:409});
        crm.setPrice(booking,{price:'1000',version:0},staff);
        const depositRequest=payment();const first=crm.recordPayment(booking,depositRequest,staff);
        assert.equal(first.summary.payment_status,'deposit');assert.equal(first.summary.balance_minor,70000);
        assert.equal(crm.recordPayment(booking,depositRequest,staff).idempotent,true);assert.equal(crm.paymentSummary(booking.appointment_id).payments.length,1);
        assert.throws(()=>crm.recordPayment(booking,{...depositRequest,amount:'301'},owner),{status:409});
        assert.throws(()=>crm.recordPayment(booking,payment({kind:'paid',amount:'100'}),owner),{status:400});
        crm.recordPayment(booking,payment({kind:'partial',amount:'200',received_at:'2025-02-01T16:30:00Z'}),staff);
        const paid=crm.recordPayment(booking,payment({kind:'paid',amount:'500',received_at:'2025-02-02T16:30:00Z'}),staff);
        assert.equal(paid.summary.payment_status,'paid');assert.equal(paid.summary.balance_minor,0);
        assert.throws(()=>crm.recordPayment(booking,payment({amount:'0.01'}),owner),{status:409});
        const refund=payment({kind:'refund',amount:'300',refund_of:first.payment.id,received_at:'2025-02-28T16:30:00Z'});
        assert.throws(()=>crm.recordPayment(booking,refund,staff),{status:403});
        const result=crm.recordPayment(booking,refund,owner);assert.equal(result.summary.net_minor,70000);assert.equal(result.summary.balance_minor,30000);assert.equal(result.summary.payment_status,'partial');
        assert.throws(()=>crm.recordPayment(booking,payment({kind:'refund',amount:'0.01',refund_of:first.payment.id}),owner),{status:409});
        assert.throws(()=>crm.setPrice(booking,{price:'600',version:1,confirm:true},owner),{status:409});
        assert.throws(()=>crm.setPrice(booking,{price:'900',version:1},owner),{status:400});
        crm.setPrice(booking,{price:'900',version:1,confirm:true},owner);
        assert.throws(()=>crm.setPrice(booking,{price:'1000',version:1,confirm:true},owner),{status:409});
        assert.equal(security.readAudit(Number.MAX_SAFE_INTEGER,100,'appt_first').some(row=>row.action==='payment.refund_recorded'),true);
    }finally{security.close();}
});

test('audit failure rolls back a receipt, and revoked owners cannot record refunds',async()=>{
    const{security,crm,owner,staff}=await fixture();const booking=bookings[0];
    try{
        crm.setPrice(booking,{price:'1000',version:0},owner);
        const original=security.audit.bind(security);security.audit=()=>{throw new Error('Simulated audit failure');};
        assert.throws(()=>crm.recordPayment(booking,payment(),owner),/audit failure/);security.audit=original;
        assert.equal(crm.paymentSummary(booking.appointment_id).payments.length,0);
        const receipt=crm.recordPayment(booking,payment(),owner).payment;
        security.db.prepare("UPDATE workspace_users SET role='staff' WHERE id=?").run(owner.id);
        assert.throws(()=>crm.recordPayment(booking,payment({kind:'refund',refund_of:receipt.id}),owner),{status:403});
        assert.throws(()=>crm.recordPayment(booking,payment({card_number:'4111111111111111'}),staff),{status:400});
    }finally{security.close();}
});

test('reports use Manila payment dates, subtract refunds, and include all bookings by default',async()=>{
    const{security,crm,owner}=await fixture();
    try{
        crm.setPrice(bookings[0],{price:'1000',version:0},owner);const receipt=crm.recordPayment(bookings[0],payment(),owner).payment;
        crm.recordPayment(bookings[0],payment({kind:'refund',amount:'100',refund_of:receipt.id,received_at:'2025-02-28T16:30:00Z'}),owner);
        crm.setPrice(bookings[2],{price:'500',version:0},owner);crm.recordPayment(bookings[2],payment({kind:'paid',amount:'500'}),owner);
        const feb=crm.report(bookings,{from:'2025-02-01',to:'2025-02-28'});
        assert.equal(feb.summary.received_minor,80000);assert.equal(feb.revenue_day[0].label,'2025-02-01');assert.equal(feb.summary.bookings,3);assert.equal(feb.top_services.length,2);
        const march=crm.report(bookings,{from:'2025-03-01',to:'2025-03-31'});assert.equal(march.summary.net_minor,-10000);assert.equal(march.revenue_month[0].label,'2025-03');
        assert.equal(crm.report(bookings,{}).summary.received_minor,80000);assert.equal(crm.report(bookings,{include_test:false}).summary.received_minor,30000);assert.equal(crm.report(bookings,{include_test:'false'}).summary.bookings,2);
    }finally{security.close();}
});

test('native Excel round trip preserves numeric amounts and exports no management tokens; CSV resists formulas',async()=>{
    const{security,crm,owner}=await fixture();
    try{
        const client=crm.clients(bookings,'client@company.com')[0];crm.updateClient(client.id,{...client,customer_name:'=HYPERLINK("untrusted")',version:client.version},owner);
        crm.setPrice(bookings[0],{price:'1000',version:0},owner);crm.recordPayment(bookings[0],payment(),owner);
        const report=crm.report(bookings,{});const file=await exportReport(report,'full_report','xlsx');
        const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(file.buffer);
        assert.equal(workbook.getWorksheet('Appointments').getCell('I2').value,1000);
        assert.equal(workbook.getWorksheet('Appointments').getCell('B2').value,'=HYPERLINK("untrusted")');
        assert.notEqual(workbook.getWorksheet('Appointments').getCell('B2').type,ExcelJS.ValueType.Formula);
        assert.equal(workbook.worksheets.length,9);
        const csv=(await exportReport(report,'clients','csv')).buffer.toString('utf8');assert.ok(csv.includes("'=HYPERLINK"));assert.equal(csv.includes('manage_token'),false);
        assert.equal(csvCell(-1),'"-1"');assert.equal(csvCell('=1+1'),'"\'=1+1"');
    }finally{security.close();}
});

test('concurrent payment writers cannot exceed the booking balance',async()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'appoint-access-test-'));const filename=path.join(directory,'access.sqlite');
    const {security,crm,owner}=await fixture(filename);const workers=[];
    try{
        crm.setPrice(bookings[0],{price:'1000',version:0},owner);
        const gate=new SharedArrayBuffer(4);const signals=new Int32Array(gate);
        const ready=[];const finished=[];
        for(let index=0;index<2;index++){
            const script=`const {parentPort,workerData}=require('node:worker_threads');const {SecurityStore}=require(${JSON.stringify(path.resolve(__dirname,'../security-store.cjs'))});const {CrmStore}=require(${JSON.stringify(path.resolve(__dirname,'../crm-store.cjs'))});const security=new SecurityStore(workerData.filename);const crm=new CrmStore(security);parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.gate),0,0);try{crm.recordPayment(workerData.booking,workerData.payment,workerData.actor);parentPort.postMessage({status:201});}catch(error){parentPort.postMessage({status:error.status||500});}finally{security.close();}`;
            const worker=new Worker(script,{eval:true,workerData:{filename,gate,booking:bookings[0],actor:owner,payment:payment({amount:'700',request_id:'concurrent_payment_'+index})}});workers.push(worker);
            let markReady,markDone,rejectReady,rejectDone;ready.push(new Promise((resolve,reject)=>{markReady=resolve;rejectReady=reject;}));finished.push(new Promise((resolve,reject)=>{markDone=resolve;rejectDone=reject;}));
            worker.on('message',message=>{if(message.ready)markReady();else markDone(message.status);});worker.on('error',error=>{rejectReady(error);rejectDone(error);});
        }
        await Promise.all(ready);Atomics.store(signals,0,1);Atomics.notify(signals,0,2);
        assert.deepEqual((await Promise.all(finished)).sort(),[201,409]);assert.equal(crm.paymentSummary(bookings[0].appointment_id).net_minor,70000);
    }finally{await Promise.all(workers.map(worker=>worker.terminate()));security.close();removeTestDirectory(directory);}
});
