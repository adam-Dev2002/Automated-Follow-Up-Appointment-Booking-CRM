// Shared calendar checks use a disposable account database and a read-only booking stub.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { startTestServer, browserOptions } = require('./test-server.cjs');

(async () => {
    let fixture, browser, failed = false, pageReads = 0;
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10);
    const month = day.slice(0,7);
    const monthStamp = new Date(month + '-01T00:00:00Z');
    const nextMonth = new Date(Date.UTC(monthStamp.getUTCFullYear(),monthStamp.getUTCMonth()+1,1)).toISOString().slice(0,7);
    const previousDay = new Date(Date.UTC(monthStamp.getUTCFullYear(),monthStamp.getUTCMonth(),0)).toISOString().slice(0,10);
    const row = (id, name, start, end, status = 'confirmed') => ({ id, appointment_id:'appt_calendar_'+id, customer_name:name, email:'calendar'+id+'@example.test', service:'Consultation', booking_start:start, booking_end:end, status, is_test:true, version:1, manage_token:'PRIVATE_MANAGE_TOKEN' });
    const bookings = [
        row(1,'Shared Client <img src=x onerror=alert(1)>',month+'-15T09:30:00+08:00',month+'-15T10:30:00+08:00'),
        row(2,'Cancelled Client',month+'-15T11:00:00+08:00',month+'-15T12:00:00+08:00','cancelled'),
        row(3,'Late Client',month+'-15T16:00:00Z',month+'-15T17:00:00Z'),
        row(4,'Overnight Client',month+'-14T23:30:00+08:00',month+'-15T00:30:00+08:00'),
        row(5,'Next Month Client',nextMonth+'-10T14:00:00+08:00',nextMonth+'-10T15:00:00+08:00'),
        row(6,'Midnight End Client',month+'-14T23:00:00+08:00',month+'-15T00:00:00+08:00'),
        row(7,'Starts Before Month',previousDay+'T23:00:00+08:00',month+'-01T01:00:00+08:00')
    ];
    const stub = http.createServer(async (req,res) => {
        const chunks=[]; for await (const chunk of req) chunks.push(chunk);
        const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
        const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
        if (!req.url.endsWith('appointments-operator-api')) return reply(400,{ok:false,error:'validation_error'});
        assert.equal(req.headers['x-appoint-operator'],fs.readFileSync(path.join(fixture.directory,'operator-token'),'utf8'));
        if (body.payload.action === 'audit') return reply(200,{ok:true,events:[],next_before_id:null});
        assert.equal(body.payload.action,'crm_list','Calendar only reads bookings');
        pageReads++;
        if (failed) return reply(503,{ok:false,message:'Unavailable'});
        const second = body.payload.after_id === 4;
        return reply(200,{ok:true,appointments:second ? bookings.slice(4) : bookings.slice(0,4),next_after_id:second ? null : 4});
    });
    stub.listen(0,'127.0.0.1'); await once(stub,'listening');
    try {
        fixture = await startTestServer({endpoint:'http://127.0.0.1:'+stub.address().port+'/webhook/appointments-api'});
        const range = '?from='+month+'-01&to='+month+'-28';
        assert.equal((await fetch(fixture.base+'/api/crm/calendar'+range)).status,401,'Public cannot read customer bookings');
        browser=await chromium.launch(browserOptions());
        const context=await browser.newContext({viewport:{width:1440,height:1100},timezoneId:'America/New_York'});
        await context.addCookies(fixture.cookies);
        const calendar=await context.request.get(fixture.base+'/api/crm/calendar'+range);
        assert.equal(calendar.status(),200);
        const data=await calendar.json();
        assert.equal(data.appointments.length,6,'All source pages, including overnight arrivals, are read');
        assert.equal(JSON.stringify(data).includes('PRIVATE_MANAGE_TOKEN'),false,'Management secrets are excluded');
        assert.equal(data.timezone,'Asia/Manila');
        assert.ok(pageReads>=2,'Booking list pagination is followed');
        assert.equal((await context.request.get(fixture.base+'/api/crm/calendar?from=2026-02-30&to=2026-03-01')).status(),400);
        assert.equal((await context.request.get(fixture.base+'/api/crm/calendar?from=2026-03-01&to=2026-02-01')).status(),400);
        assert.equal((await context.request.get(fixture.base+'/api/crm/calendar?from=2026-01-01&to=2026-12-31')).status(),400);
        const page=await context.newPage(), errors=[], appointmentReads=[];
        let missingCalendarReads=0;
        await page.route('**/api/crm/calendar?**',route=>{missingCalendarReads++;return route.fulfill({status:404,json:{ok:false,message:'CRM endpoint not found.'}});});
        page.on('request',request=>{if(new URL(request.url()).pathname==='/api/crm/appointments')appointmentReads.push(request.url());});
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(fixture.base+'/#calendar',{waitUntil:'networkidle'});
        assert.equal(await page.evaluate(()=>localStorage.getItem('appoint.bookings.v1')),null,'Fresh browser has no cached bookings');
        assert.equal(await page.locator('#calendar-agenda-list > li').count(),6,'Shared bookings appear without browser storage');
        assert.ok(appointmentReads.length>0,'Calendar reads the existing appointment table API');
        assert.equal(missingCalendarReads,0,'Calendar works without a calendar-specific endpoint');
        assert.equal(await page.locator('#calendar-tools').innerText().then(text=>text.includes('Asia/Manila (UTC+8)')),true);
        assert.ok((await page.locator('#calendar-days [data-calendar-booking="appt_calendar_1"] time').innerText()).includes('9:30 AM'),'Times use the business timezone in a New York browser');
        assert.ok((await page.locator('#calendar-days [data-calendar-booking="appt_calendar_1"]').getAttribute('title')).includes('Consultation'),'Tooltip includes the service');
        assert.equal(await page.locator('#calendar-days [data-calendar-booking="appt_calendar_1"] .user-avatar').count(),1,'Month cells include a client avatar');
        assert.equal(await page.locator('#calendar-days [data-calendar-booking="appt_calendar_1"] .calendar-event-service').innerText(),'Consultation');
        assert.equal(await page.locator('#calendar-section img[src="x"]').count(),0,'Client names are escaped');
        assert.equal(await page.locator('#calendar-agenda-list .user-avatar').count(),6,'Client initials avatars are shown');
        const layout=await page.evaluate(()=>{
            const month=document.querySelector('.calendar-month-panel').getBoundingClientRect(),agenda=document.getElementById('calendar-agenda').getBoundingClientRect(),list=document.getElementById('calendar-agenda-scroll');
            const before=window.scrollY;list.scrollTop=100;
            return{sideBySide:agenda.left>=month.right,scrollable:list.scrollHeight>list.clientHeight&&list.scrollTop>0,pageStill:window.scrollY===before,brandBackground:getComputedStyle(document.querySelector('#app-sidebar .brand-link')).backgroundColor,primary:getComputedStyle(document.querySelector('.new-booking')).backgroundColor};
        });
        assert.equal(layout.sideBySide,true,'Bookings sit beside the month on desktop');
        assert.equal(layout.scrollable,true,'The side list has independent scrolling');
        assert.equal(layout.pageStill,true,'Scrolling bookings does not move the calendar');
        assert.equal(layout.brandBackground,'rgba(0, 0, 0, 0)','Brand has no white tile');
        assert.equal(layout.primary,'rgb(35, 97, 206)','Main actions use the supplied Bootstrap blue button variant');
        const selectDay=async key=>{await page.locator('.calendar-date[data-date="'+key+'"]').click();assert.equal(new URL(page.url()).hash,'#calendar');};
        await selectDay(month+'-15');
        assert.equal(await page.locator('#calendar-agenda-list > li').count(),3,'Selected day includes overnight, confirmed, and cancelled bookings');
        assert.ok((await page.locator('#calendar-agenda-list').innerText()).includes('Cancelled Client'),'Cancelled bookings remain visible');
        assert.equal(await page.locator('#calendar-agenda-list [data-calendar-booking="appt_calendar_6"]').count(),0,'An appointment ending at midnight is not in the following day');
        assert.ok((await page.locator('#calendar-agenda-list').innerText()).includes('11:30 PM'),'Overnight booking shows original start time');
        assert.ok((await page.locator('#calendar-agenda-list').innerText()).includes('12:30 AM'),'Overnight booking shows end time and date');
        await page.locator('#calendar-agenda-list [data-calendar-booking="appt_calendar_1"]').click();
        await page.locator('#details-modal').waitFor({state:'visible'});
        assert.ok((await page.locator('#details-body').innerText()).includes('appt_calendar_1'));
        assert.equal(new URL(page.url()).hash,'#calendar');
        await page.locator('#details-modal .btn-close').click(); await page.locator('#details-modal').waitFor({state:'hidden'});
        await page.locator('#calendar-days [data-calendar-booking="appt_calendar_1"]').click();
        await page.locator('#details-modal').waitFor({state:'visible'});
        await page.locator('#details-modal .btn-close').click(); await page.locator('#details-modal').waitFor({state:'hidden'});
        await selectDay(month+'-16');
        assert.equal(await page.locator('#calendar-agenda-list > li').count(),1,'UTC midnight boundary belongs to the correct local day');
        await selectDay(month+'-20'); assert.equal(await page.locator('#calendar-agenda-empty').isVisible(),true);
        await page.locator('#next-month').click(); await page.waitForFunction(()=>!document.getElementById('calendar-refresh').disabled);
        assert.equal(await page.locator('#calendar-agenda-list > li').count(),1);
        assert.ok((await page.locator('#calendar-agenda-list').innerText()).includes('Next Month Client'));
        await page.locator('#previous-month').click(); await page.waitForFunction(()=>!document.getElementById('calendar-refresh').disabled);
        failed=true; await page.locator('#calendar-refresh').click(); await page.locator('#calendar-error').waitFor({state:'visible'});
        assert.equal(await page.locator('#calendar-agenda-empty').isVisible(),false,'A read failure must not claim there are no bookings');
        assert.ok((await page.locator('#calendar-updated').innerText()).includes('last loaded bookings'),'Failed refresh labels stale results');
        failed=false; await page.locator('#calendar-retry').click(); await page.waitForFunction(()=>!document.getElementById('calendar-refresh').disabled);
        assert.equal(await page.locator('#calendar-error').isVisible(),false);
        await page.locator('#calendar-today').click(); await page.waitForFunction(()=>!document.getElementById('calendar-refresh').disabled);
        assert.equal(await page.locator('.calendar-date[aria-pressed="true"]').getAttribute('data-date'),day);
        await page.locator('#clear-date').click();
        const outputs=path.resolve(__dirname,'../.local/verification');fs.mkdirSync(outputs,{recursive:true});
        await page.evaluate(()=>{scrollTo(0,0);document.getElementById('calendar-agenda-scroll').scrollTop=0;});
        await page.screenshot({path:path.join(outputs,'calendar-desktop.png'),fullPage:true,animations:'disabled'});
        await page.setViewportSize({width:390,height:844});await selectDay(month+'-15');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Mobile calendar fits without horizontal page scrolling');
        assert.equal(await page.locator('#calendar-agenda-list > li').count(),3);
        await page.screenshot({path:path.join(outputs,'calendar-mobile.png'),fullPage:true,animations:'disabled'});
        let tablePages=0;
        await page.route('**/api/crm/appointments?**',route=>{
            const input=new URL(route.request().url()).searchParams;
            const page=Number(input.get('page'));
            assert.equal(input.get('include_test'),'true');
            tablePages++;
            return route.fulfill({json:{ok:true,appointments:data.appointments.slice((page-1)*2,page*2),page,page_size:2,total:data.appointments.length}});
        });
        await page.reload({waitUntil:'networkidle'});assert.equal(await page.locator('#calendar-agenda-list > li').count(),6,'Shared records survive reload without browser data');
        assert.equal(tablePages,3,'Calendar follows every appointment table page');
        assert.equal(missingCalendarReads,0);
        const db=new DatabaseSync(path.join(fixture.directory,'access.sqlite'));
        try {
            assert.ok(db.prepare("SELECT count(*) AS count FROM workspace_audit WHERE action='calendar.viewed'").get().count>0,'Calendar reads have an audit trail');
            assert.equal(db.prepare('SELECT count(*) AS count FROM crm_clients').get().count,bookings.length,'The existing appointment table API links clients once');
            assert.equal(db.prepare('SELECT count(*) AS count FROM crm_payments').get().count,0,'Calendar never creates payment records');
        } finally { db.close(); }
        assert.deepEqual(errors,[],'No browser errors');
        await context.close();
        console.log('PASS: shared calendar API, existing table API compatibility, frontend/source pagination, date bounds, secret exclusion, local dates/times, overnight bookings, retained cancellations, same-page details, month/day navigation, retry, cell details/avatars, reload, mobile layout, and no payment writes.');
    } finally { await browser?.close(); await fixture?.close(); await new Promise(resolve=>stub.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
