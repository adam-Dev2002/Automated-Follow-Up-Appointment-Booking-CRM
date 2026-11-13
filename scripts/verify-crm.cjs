const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const ExcelJS=require('exceljs');
const {chromium}=require('playwright');
const {startTestServer,browserOptions}=require('./test-server.cjs');
const {once}=require('node:events');

(async()=>{
    let fixture,browser;
    const tomorrow=new Date(Date.now()+86400000).toISOString();
    const bookings=[
        {id:1,appointment_id:'appt_crm_1',customer_name:'Ada Client',email:'ada@client.company',service:'Consultation',booking_start:tomorrow,booking_end:new Date(Date.parse(tomorrow)+3600000).toISOString(),status:'confirmed',is_test:false,manage_token:'PRIVATE_BOOKING_TOKEN'},
        {id:2,appointment_id:'appt_crm_2',customer_name:'Ada Client',email:'ada@client.company',service:'Cancelled service',booking_start:new Date(Date.now()+2*86400000).toISOString(),booking_end:new Date(Date.now()+2*86400000+3600000).toISOString(),status:'cancelled',is_test:false},
        {id:3,appointment_id:'appt_crm_test',customer_name:'Test Customer',email:'test@example.test',service:'Test service',booking_start:tomorrow,booking_end:new Date(Date.parse(tomorrow)+3600000).toISOString(),status:'confirmed',is_test:true}
    ];
    const stub=http.createServer(async(req,res)=>{
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
        const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
        if(req.url.endsWith('appointments-operator-api')){
            if(req.headers['x-appoint-operator']!==fs.readFileSync(path.join(fixture.directory,'operator-token'),'utf8'))return reply(403,{ok:false});
            if(body.payload.action==='crm_list')return reply(200,{ok:true,appointments:bookings,next_after_id:null});
            if(body.payload.action==='audit')return reply(200,{ok:true,events:[],next_before_id:null});
            return reply(400,{ok:false,error:'validation_error'});
        }
        return reply(400,{ok:false,error:'validation_error'});
    });
    stub.listen(0,'127.0.0.1');await once(stub,'listening');
    try{
        fixture=await startTestServer({endpoint:'http://127.0.0.1:'+stub.address().port+'/webhook/appointments-api'});
        browser=await chromium.launch(browserOptions());const context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});await context.addCookies(fixture.cookies);
        const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.goto(fixture.base+'/#clients',{waitUntil:'networkidle'});
        await page.waitForFunction(()=>document.querySelectorAll('#crm-client-rows tr').length===2);
        assert.equal(await page.locator('#crm-client-rows .user-avatar').count(),2);
        await page.locator('#crm-client-rows tr').filter({hasText:'Ada Client'}).getByRole('button',{name:'Profile & history'}).click();
        await page.locator('#crm-client-modal').waitFor({state:'visible'});assert.equal(await page.locator('#crm-client-bookings tr').count(),2);
        await page.locator('#crm-client-phone').fill('+63 912 345 6789');const edited=page.waitForResponse(response=>response.url().includes('/api/crm/clients/')&&response.request().method()==='PATCH');await page.locator('#crm-client-save').click();await edited;await page.waitForFunction(()=>!document.getElementById('crm-client-save').disabled);
        await page.locator('#crm-client-modal .btn-close').click();await page.locator('#crm-client-modal').waitFor({state:'hidden'});
        await page.locator('#crm-add-client').click();await page.locator('#crm-client-name').fill('Walk-in Client');await page.locator('#crm-client-phone').fill('+65 8123 4567');
        const created=page.waitForResponse(response=>response.url().endsWith('/api/crm/clients')&&response.request().method()==='POST');await page.locator('#crm-client-save').click();assert.equal((await created).status(),201);await page.waitForFunction(()=>!document.getElementById('crm-client-save').disabled);
        await page.locator('#crm-client-modal .btn-close').click();await page.locator('#crm-client-modal').waitFor({state:'hidden'});
        await page.locator('[data-view="payments"]').click();await page.locator('[data-payment-view="balances"]').click();await page.locator('[data-payment="appt_crm_1"]').waitFor();assert.equal(await page.locator('#crm-payment-rows tr').count(),3);assert.equal(await page.locator('#crm-payments-test').count(),0);assert.equal(await page.locator('[data-payment="appt_crm_test"]').count(),1);
        await page.locator('[data-payment="appt_crm_1"]').click();await page.locator('#crm-payment-modal').waitFor({state:'visible'});
        const session=await(await context.request.get(fixture.base+'/api/session')).json();const csrf={'X-CSRF-Token':session.csrf_token};
        assert.equal(Object.hasOwn((await(await context.request.get(fixture.base+'/api/crm/appointments/appt_crm_1')).json()).booking,'manage_token'),false);
        await page.locator('#crm-booking-price').fill('1000');await page.locator('#crm-price-save').click();await page.locator('#crm-confirm-modal').waitFor({state:'visible'});
        await page.locator('#crm-confirm-modal').getByRole('button',{name:'Go back'}).click();await page.locator('#crm-payment-modal').waitFor({state:'visible'});
        assert.equal((await(await context.request.get(fixture.base+'/api/crm/appointments/appt_crm_1')).json()).summary.price_minor,null);
        await page.locator('#crm-price-save').click();await page.locator('#crm-confirm-modal').waitFor({state:'visible'});await page.locator('#crm-confirm-submit').click();await page.locator('#crm-confirm-modal').waitFor({state:'hidden'});await page.locator('#crm-payment-modal').waitFor({state:'visible'});
        async function record(kind,amount,reference){
            await page.locator('#crm-payment-kind').selectOption(kind);await page.locator('#crm-payment-amount').fill(amount);await page.locator('#crm-receipt-reference').fill(reference);
            const response=page.waitForResponse(result=>result.url().endsWith('/appt_crm_1/payments')&&result.request().method()==='POST');
            await page.locator('#crm-payment-review').click();await page.locator('#crm-confirm-modal').waitFor({state:'visible'});await page.locator('#crm-confirm-submit').click();assert.equal((await response).status(),201);
            await page.locator('#crm-confirm-modal').waitFor({state:'hidden'});await page.locator('#crm-payment-modal').waitFor({state:'visible'});
        }
        await record('deposit','300','DEP-001');await record('partial','200','PART-001');await record('paid','500','FULL-001');await record('refund','100','REFUND-001');
        const state=await(await context.request.get(fixture.base+'/api/crm/appointments/appt_crm_1')).json();assert.equal(state.summary.net_minor,90000);assert.equal(state.summary.balance_minor,10000);assert.equal(state.summary.payments.length,4);
        assert.equal(await page.locator('#crm-payment-history tr').count(),4);
        fs.mkdirSync(path.resolve(__dirname,'../.local/verification'),{recursive:true});await page.locator('#crm-payment-modal .modal-content').screenshot({path:path.resolve(__dirname,'../.local/verification/crm-payment.png'),animations:'disabled'});
        await page.locator('#crm-payment-modal .btn-close').click();await page.locator('#crm-payment-modal').waitFor({state:'hidden'});
        await page.locator('[data-view="reports"]').click();await page.waitForFunction(()=>document.getElementById('crm-report-stats').innerText.includes('900.00'));
        await page.locator('#crm-report-from').fill('');await page.locator('#crm-report-to').fill('');await page.locator('#crm-report-apply').click();await page.waitForFunction(()=>document.querySelectorAll('#crm-top-service-rows tr').length===2&&document.getElementById('crm-top-service-rows').innerText.includes('Consultation'));
        await page.locator('#crm-revenue-group').selectOption('revenue_service');assert.ok((await page.locator('#crm-revenue-rows').innerText()).includes('900.00'));
        const downloadEvent=page.waitForEvent('download');await page.locator('[data-dataset="full_report"]').click();const download=await downloadEvent;assert.ok(download.suggestedFilename().endsWith('.xlsx'));
        const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await fs.promises.readFile(await download.path()));assert.equal(workbook.worksheets.length,9);assert.equal(workbook.getWorksheet('Revenue by service').getCell('D2').value,900);assert.equal(workbook.getWorksheet('Payments').rowCount,5);
        await page.locator('#crm-export-dataset').selectOption('clients');const csvEvent=page.waitForEvent('download');await page.locator('.crm-export[data-format="csv"]').click();const csv=await fs.promises.readFile(await(await csvEvent).path(),'utf8');assert.ok(csv.includes('Walk-in Client'));assert.ok(csv.includes('+63 912'));assert.equal(csv.includes('PRIVATE_BOOKING_TOKEN'),false);
        await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.resolve(__dirname,'../.local/verification/crm-reports.png'),fullPage:true,animations:'disabled'});
        const staff=await context.request.post(fixture.base+'/api/users',{headers:csrf,data:{username:'crm-staff',display_name:'CRM Staff',password:'crm-staff-test-password',role:'staff'}});assert.equal(staff.status(),201);
        const staffContext=await browser.newContext();const anonResponse=await staffContext.request.get(fixture.base+'/api/session');const anonymous=await anonResponse.json();const signed=await staffContext.request.post(fixture.base+'/api/login',{headers:{'X-CSRF-Token':anonymous.csrf_token},data:{username:'crm-staff',password:'crm-staff-test-password'}});assert.equal(signed.status(),200);const staffSession=await signed.json();
        assert.equal((await staffContext.request.get(fixture.base+'/api/crm/reports')).status(),403);assert.equal((await staffContext.request.get(fixture.base+'/api/crm/export?dataset=clients&format=xlsx')).status(),403);
        const receipt=state.summary.payments.find(payment=>payment.kind==='deposit');const denied=await staffContext.request.post(fixture.base+'/api/crm/appointments/appt_crm_1/payments',{headers:{'X-CSRF-Token':staffSession.csrf_token},data:{request_id:'staff_refund_denied',kind:'refund',amount:'1',method:'cash',refund_of:receipt.id,confirm:true}});assert.equal(denied.status(),403);
        const audit=await(await context.request.get(fixture.base+'/api/audit?appointment_id=appt_crm_1')).json();assert.ok(audit.events.some(event=>event.action==='payment.refund_recorded'));assert.ok(audit.events.some(event=>event.action==='appointment.price_set'));
        await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.getElementById('main').getBoundingClientRect().left<32);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await page.screenshot({path:path.resolve(__dirname,'../.local/verification/crm-reports-mobile.png'),fullPage:true,animations:'disabled'});
        assert.deepEqual(errors,[]);await staffContext.close();await context.close();
        console.log('PASS: client contact/history UI, price confirmation, all four payment types, balances/refunds, owner report permissions, native Excel/CSV downloads, per-booking audit, and mobile layout.');
        console.log('All bookings were read from a disposable stub; financial records and users used a temporary database. No production payments or bookings changed.');
    }finally{await browser?.close();await fixture?.close();await new Promise(resolve=>stub.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
