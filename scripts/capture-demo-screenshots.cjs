// Render the real application with fictional data and a disposable database.
// The upstream is an in-process stub: no n8n, Gmail, or production data is used.
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {once}=require('node:events');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const {startTestServer,browserOptions}=require('./test-server.cjs');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'docs/screenshots');
const day=offset=>new Date(Date.now()+8*3600000+offset*86400000).toISOString().slice(0,10);
const clients=[['Maya Santos','maya@example.test','0917 000 0101'],['Liam Cruz','liam@example.test','0917 000 0102'],['Sofia Reyes','sofia@example.test','0917 000 0103'],['Noah Lim','noah@example.test','0917 000 0104'],['Isabella Tan','isabella@example.test','0917 000 0105']];
const specs=[[0,'Initial consultation',0,'09:00',1200],[1,'Planning session',0,'10:30',1800],[2,'Follow-up session',0,'13:00',750],[3,'Service review',0,'15:00',950],[4,'Initial consultation',1,'10:00',1200],[0,'Planning session',2,'11:00',1800],[1,'Follow-up session',3,'14:00',750],[2,'Service review',-2,'10:00',950],[3,'Initial consultation',-3,'09:00',1200],[4,'Planning session',-4,'13:00',1800]];
const bookings=specs.map(([client,service,offset,time],index)=>{
    const start=day(offset)+'T'+time+':00+08:00';
    return{id:index+1,appointment_id:'DEMO-'+String(1001+index),customer_name:clients[client][0],email:clients[client][1],service,booking_start:start,booking_end:new Date(Date.parse(start)+3600000).toISOString(),timezone:'Asia/Manila',status:index===8?'cancelled':'confirmed',version:1,is_test:false};
});
const notifications={confirmation:{status:'test_sent',sent_at:new Date().toISOString()},reminder_24h:{status:'pending'},reminder_1h:{status:'pending'}};

(async()=>{
    fs.mkdirSync(output,{recursive:true});
    execFileSync(process.execPath,[path.join(root,'node_modules/gulp/bin/gulp.js'),'prepare'],{cwd:root,windowsHide:true,stdio:'pipe'});
    const upstream=http.createServer(async(req,res)=>{
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'),payload=body.payload||body;
        const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
        if(payload.action==='crm_list')return reply(200,{ok:true,appointments:bookings,next_after_id:null});
        if(payload.action==='audit')return reply(200,{ok:true,events:[],next_before_id:null});
        if(payload.action==='status')return reply(200,{ok:true,appointment:bookings.find(row=>row.appointment_id===payload.appointment_id),notifications,test_mode:true,checked_at:new Date().toISOString()});
        return reply(400,{ok:false,error:'validation_error',message:'This is an isolated screenshot demo.'});
    });
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    let fixture,browser;
    try{
        fixture=await startTestServer({endpoint:'http://127.0.0.1:'+upstream.address().port+'/webhook/appointments-api',owner:{username:'demo-owner',display_name:'Demo Business Owner',password:'fictional-screenshot-owner-only'}});
        browser=await chromium.launch(browserOptions());
        const context=await browser.newContext({viewport:{width:1440,height:1050},deviceScaleFactor:1,timezoneId:'Asia/Manila'});
        await context.addCookies(fixture.cookies);
        const session=await(await context.request.get(fixture.base+'/api/session')).json(),headers={'X-CSRF-Token':session.csrf_token};
        async function api(url,method='GET',data){const r=await context.request.fetch(fixture.base+url,{method,headers,...(data?{data}:{})});if(!r.ok())throw Error('Demo fixture request failed: '+url+' HTTP '+r.status());return r.json();}
        const imported=await api('/api/crm/clients');
        for(const [name,email,phone]of clients){const client=imported.clients.find(row=>row.email===email);await api('/api/crm/clients/'+client.id,'PATCH',{customer_name:name,email,phone,version:client.version});}
        for(let index=0;index<bookings.length;index++){
            const booking=bookings[index],price=specs[index][4],endpoint='/api/crm/appointments/'+booking.appointment_id;
            await api(endpoint+'/price','PUT',{price:String(price),version:0,confirm:true});
            if(index===3||index===6||index===8)continue;
            const kind=index===1||index===5?'deposit':'paid',amount=kind==='deposit'?500:price;
            const result=await api(endpoint+'/payments','POST',{kind,amount:String(amount),method:'cash',receipt_reference:'DEMO-CASH-'+String(index+1).padStart(3,'0'),request_id:'demo_cash_'+index,received_at:new Date(Date.now()-(index+1)*3600000).toISOString(),confirm:true});
            if(index===7)await api(endpoint+'/payments','POST',{kind:'refund',amount:'200',method:'cash',refund_of:result.payment.id,receipt_reference:'DEMO-REFUND-001',request_id:'demo_refund_001',received_at:new Date(Date.now()-1000).toISOString(),confirm:true});
        }
        await context.addInitScript(rows=>localStorage.setItem('appoint.bookings.v1',JSON.stringify(rows)),bookings.map(row=>({...row,manage_token:'d'.repeat(64),notifications,test_mode:true,email_confirmation:'queued'})));
        const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.goto(fixture.base+'/#overview',{waitUntil:'networkidle'});
        const logo=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=128;c.height=128;const x=c.getContext('2d');x.fillStyle='#2361ce';x.fillRect(0,0,128,128);x.fillStyle='#fff';x.font='bold 44px Arial';x.textAlign='center';x.fillText('MS',64,81);return c.toDataURL('image/png');});
        const maya=imported.clients.find(row=>row.email==='maya@example.test');await api('/api/crm/clients/'+maya.id+'/avatar','PUT',{image:logo,version:0});
        await page.reload({waitUntil:'networkidle'});
        async function capture(file){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(output,file),fullPage:true,animations:'disabled'});}
        await page.locator('#booking-rows tr').first().waitFor();await capture('overview.png');
        await page.locator('[data-view="appointments"]').click();await capture('appointments.png');
        await page.locator('[data-view="calendar"]').click();await page.locator('#calendar-agenda-list li').first().waitFor();await capture('calendar.png');
        await page.locator('[data-view="clients"]').click();await page.locator('#crm-client-rows tr').first().waitFor();await capture('clients.png');
        await page.locator('#crm-client-rows [data-client-profile="'+maya.id+'"]').click();await page.locator('#crm-client-modal').waitFor({state:'visible'});
        await page.locator('#crm-client-modal .modal-content').screenshot({path:path.join(output,'client-profile.png'),animations:'disabled'});
        await page.locator('#crm-client-modal .btn-close').click();await page.locator('#crm-client-modal').waitFor({state:'hidden'});
        await page.locator('[data-view="payments"]').click();await page.locator('#crm-transaction-rows tr').first().waitFor();await capture('transactions.png');
        await page.locator('[data-view="reports"]').click();await page.locator('#crm-report-stats .crm-report-stat').first().waitFor();await capture('reports.png');
        await page.locator('[data-view="automation"]').click();await capture('reminders.png');
        await page.setViewportSize({width:390,height:844});
        await page.locator('[data-view="reports"]').evaluate(link=>link.click());await page.locator('#crm-report-stats .crm-report-stat').first().waitFor();await capture('reports-mobile.png');
        await page.locator('[data-view="payments"]').evaluate(link=>link.click());await page.locator('#crm-transaction-rows tr').first().waitFor();await capture('transactions-mobile.png');
        if(errors.length)throw Error('Browser errors in demo: '+errors.join('; '));
        fs.writeFileSync(path.join(output,'README.md'),'# Application screenshots\n\nGenerated from the actual application with fictional clients and a disposable database. No production database, live n8n workflow, or Gmail account is contacted.\n\nRegenerate with `npm run screenshots`. Dates follow the current Asia/Manila calendar.\n');
        console.log('Created 10 demo screenshots in docs/screenshots. All clients, accounts, bookings, and transactions are fictional; no emails were sent.');
        await context.close();
    }finally{await browser?.close();await fixture?.close();await new Promise(resolve=>upstream.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
