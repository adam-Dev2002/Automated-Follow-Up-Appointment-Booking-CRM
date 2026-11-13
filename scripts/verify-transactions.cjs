// Isolated ledger/profile checks: no live bookings, payments, uploads, or emails.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {once}=require('node:events');
const {chromium}=require('playwright');
const {startTestServer,browserOptions}=require('./test-server.cjs');

(async()=>{
    let fixture,browser,unavailable=false;
    const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    const bookings=[
        {id:1,appointment_id:'appt_history_paid',customer_name:'Ada Client',email:'ada@client.company',service:'Consultation',booking_start:day+'T10:00:00+08:00',booking_end:day+'T11:00:00+08:00',status:'confirmed',is_test:false},
        {id:2,appointment_id:'appt_history_unpaid',customer_name:'Unpaid Client',email:'unpaid@client.company',service:'Follow-up',booking_start:day+'T14:00:00+08:00',booking_end:day+'T15:00:00+08:00',status:'confirmed',is_test:false}
    ];
    const stub=http.createServer(async(req,res)=>{
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
        res.setHeader('Content-Type','application/json');
        if(body.payload?.action==='crm_list'){
            res.statusCode=unavailable?503:200;res.end(JSON.stringify(unavailable?{ok:false}:{ok:true,appointments:bookings,next_after_id:null}));
        }else{res.statusCode=400;res.end(JSON.stringify({ok:false,error:'validation_error'}));}
    });
    stub.listen(0,'127.0.0.1');await once(stub,'listening');
    try{
        fixture=await startTestServer({endpoint:'http://127.0.0.1:'+stub.address().port+'/webhook/appointments-api'});
        browser=await chromium.launch(browserOptions());
        const context=await browser.newContext({viewport:{width:1440,height:1050}});await context.addCookies(fixture.cookies);
        await context.addInitScript(booking=>localStorage.setItem('appoint.bookings.v1',JSON.stringify([booking])),bookings[0]);
        const session=await(await context.request.get(fixture.base+'/api/session')).json(),headers={'X-CSRF-Token':session.csrf_token};
        const bookingPath=fixture.base+'/api/crm/appointments/'+bookings[0].appointment_id;
        assert.equal((await context.request.put(bookingPath+'/price',{headers,data:{price:'1000',version:0,confirm:true}})).status(),200);
        async function record(kind,amount,index,refundOf){
            const response=await context.request.post(bookingPath+'/payments',{headers,data:{kind,amount,method:'cash',receipt_reference:'CASH-'+index,request_id:'history_payment_'+index,received_at:new Date(Date.now()-(4-index)*3600000).toISOString(),confirm:true,refund_of:refundOf}});
            assert.equal(response.status(),201);return(await response.json()).payment;
        }
        const deposit=await record('deposit','300',1);await record('partial','200',2);await record('refund','100',3,deposit.id);
        assert.equal((await fetch(fixture.base+'/api/crm/payments')).status,401);
        unavailable=true;
        const ledger=await context.request.get(fixture.base+'/api/crm/payments');assert.equal(ledger.status(),200,'History remains readable when n8n is unavailable');
        const history=await ledger.json();assert.equal(history.total,3);assert.equal(history.payments[0].kind,'refund');
        assert.equal(history.payments.some(row=>row.appointment_id===bookings[1].appointment_id),false);
        assert.equal((await(await context.request.get(fixture.base+'/api/crm/payments?q=CASH-1')).json()).total,1);
        assert.equal((await context.request.get(fixture.base+'/api/crm/payments?page=0')).status(),400);
        unavailable=false;
        const clientId=history.payments[0].client_id,avatarPath=fixture.base+'/api/crm/clients/'+clientId+'/avatar';
        assert.equal((await fetch(avatarPath)).status,401);
        assert.equal((await context.request.put(avatarPath,{data:{image:'',version:0}})).status(),403);
        const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.goto(fixture.base+'/#payments',{waitUntil:'networkidle'});
        await page.waitForFunction(()=>document.querySelectorAll('#crm-transaction-rows tr').length===3);
        assert.equal(await page.locator('[data-payment-view="history"]').getAttribute('aria-pressed'),'true');
        assert.equal(await page.locator('#crm-booking-balances').isVisible(),false);
        assert.ok((await page.locator('#crm-transaction-rows tr').first().innerText()).includes('−₱100.00'));
        await page.locator('#crm-transaction-rows [data-client-profile]').first().click();
        await page.locator('#crm-client-modal').waitFor({state:'visible'});assert.equal(await page.locator('#crm-client-email').inputValue(),bookings[0].email);
        const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=96;const c=canvas.getContext('2d');c.fillStyle='#374151';c.fillRect(0,0,96,96);c.fillStyle='#fff';c.font='bold 36px sans-serif';c.fillText('AC',20,60);return canvas.toDataURL('image/png').split(',')[1];});
        const uploaded=page.waitForResponse(r=>r.url()===avatarPath&&r.request().method()==='PUT');
        await page.locator('#crm-client-avatar').setInputFiles({name:'client-logo.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
        assert.equal((await uploaded).status(),200);
        await page.locator('#crm-client-identity img.client-avatar').waitFor();
        const sharedSrc=await page.locator('#crm-client-identity img.client-avatar').getAttribute('src');
        assert.equal((await context.request.get(avatarPath)).headers()['content-type'],'image/jpeg');
        await page.locator('#crm-client-modal .btn-close').click();await page.locator('#crm-client-modal').waitFor({state:'hidden'});
        await page.waitForFunction(()=>document.querySelectorAll('#crm-transaction-rows img.client-avatar').length===3);
        const output=path.resolve(__dirname,'../.local/verification');fs.mkdirSync(output,{recursive:true});
        await page.screenshot({path:path.join(output,'transaction-history-desktop.png'),fullPage:true,animations:'disabled'});
        await page.reload({waitUntil:'networkidle'});await page.locator('#crm-transaction-rows img.client-avatar').first().waitFor();
        assert.equal(await page.locator('#crm-transaction-rows img.client-avatar').first().getAttribute('src'),sharedSrc);
        await page.locator('[data-view="clients"]').click();await page.locator('#crm-client-rows img.client-avatar').waitFor();
        assert.equal(await page.locator('#crm-client-rows img.client-avatar').getAttribute('src'),sharedSrc);
        for(const name of ['overview','appointments']){
            await page.locator('[data-view="'+name+'"]').click();await page.locator('#booking-rows img.client-avatar').waitFor();
            assert.equal(await page.locator('#booking-rows img.client-avatar').getAttribute('src'),sharedSrc);
        }
        await page.locator('[data-view="calendar"]').click();await page.locator('#calendar-agenda-list img.client-avatar').waitFor();
        assert.equal(await page.locator('#calendar-agenda-list img.client-avatar').getAttribute('src'),sharedSrc);
        await page.locator('#calendar-agenda-list [data-calendar-booking="'+bookings[0].appointment_id+'"]').click();
        await page.locator('#details-modal').waitFor({state:'visible'});assert.equal(await page.locator('#details-body img.client-avatar').getAttribute('src'),sharedSrc);
        await page.locator('#details-body [data-client-profile]').click();await page.locator('#crm-client-modal').waitFor({state:'visible'});
        await page.locator('#crm-client-modal .btn-close').click();await page.locator('#crm-client-modal').waitFor({state:'hidden'});
        await page.locator('[data-view="payments"]').click();await page.locator('#crm-transaction-rows tr').first().waitFor();
        await page.locator('[data-payment-view="balances"]').click();await page.locator('#crm-payment-rows img.client-avatar').waitFor();
        assert.equal(await page.locator('#crm-payment-rows img.client-avatar').getAttribute('src'),sharedSrc);
        await page.locator('#crm-payment-rows [data-payment="'+bookings[0].appointment_id+'"]').click();await page.locator('#crm-payment-modal').waitFor({state:'visible'});
        assert.equal(await page.locator('#crm-payment-identity img.client-avatar').getAttribute('src'),sharedSrc);
        await page.locator('#crm-payment-modal .btn-close').click();await page.locator('#crm-payment-modal').waitFor({state:'hidden'});
        await page.locator('[data-payment-view="history"]').click();await page.locator('#crm-transaction-rows tr').first().waitFor();
        await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.getElementById('main').getBoundingClientRect().left<32);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await page.screenshot({path:path.join(output,'transaction-history-mobile.png'),fullPage:true,animations:'disabled'});
        const other=await browser.newContext();await other.addCookies(fixture.cookies);const otherPage=await other.newPage();
        await otherPage.goto(fixture.base+'/#clients',{waitUntil:'networkidle'});await otherPage.locator('#crm-client-rows img.client-avatar').waitFor();
        assert.equal(await otherPage.locator('#crm-client-rows img.client-avatar').getAttribute('src'),sharedSrc,'Photo is shared across browsers');
        const removed=await context.request.put(avatarPath,{headers,data:{image:'',version:1}});assert.equal(removed.status(),200);
        await page.reload({waitUntil:'networkidle'});await page.locator('#crm-transaction-rows tr').first().waitFor();
        assert.equal(await page.locator('#crm-transaction-rows img.client-avatar').count(),0);
        assert.equal(await page.locator('#crm-transaction-rows .user-avatar').count(),3);
        assert.deepEqual(errors,[]);await other.close();await context.close();
        console.log('PASS: real transaction rows, refunds, filters, offline history, protected uploads, linked profiles, avatar persistence across all views/browsers, removal, and desktop/mobile layout. Only disposable records were used.');
    }finally{await browser?.close();await fixture?.close();await new Promise(resolve=>stub.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
