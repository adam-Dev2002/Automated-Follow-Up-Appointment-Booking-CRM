// Browser checks use intercepted API responses. They never create real n8n bookings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startTestServer, browserOptions } = require('./test-server.cjs');
let base = process.env.DASHBOARD_URL;
const outputs = path.resolve(__dirname, '../.local/verification');
const isoInput = stamp => new Date(stamp + 8 * 3600000).toISOString().slice(0, 16);

async function until(fn, description) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
        if (await fn()) return;
        await new Promise(resolve => setTimeout(resolve, 70));
    }
    throw new Error('Timed out: ' + description);
}
async function text(page, id, value) {
    await until(async () => (await page.locator('#' + id).innerText()) === value, id + ' = ' + value);
}
async function closeModal(page, id) {
    await page.locator('#' + id + ' .btn-close').click();
    await page.locator('#' + id).waitFor({ state: 'hidden' });
}

(async () => {
    fs.mkdirSync(outputs, { recursive: true });
    const fixture = base ? null : await startTestServer();
    base ||= fixture.base;
    let browser;
    const errors = [];
    try {
        browser = await chromium.launch(browserOptions());
        // Check the actual local server, assets, and real webhook availability first.
        const health = await (await fetch(base + '/api/health')).json();
        console.log('Live webhook:', health.connected ? 'connected' : 'unavailable', 'HTTP', health.upstreamStatus || 'connection error');
        const live = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
        if (fixture) await live.addCookies(fixture.cookies);
        const livePage = await live.newPage();
        livePage.on('pageerror', error => errors.push(error.message));
        await livePage.goto(base, { waitUntil: 'networkidle' });
        await livePage.locator('#calendar-days button').first().waitFor();
        await text(livePage, 'stat-total', '0');
        assert.equal(await livePage.locator('h1').innerText(), 'Appointment overview');
        assert.equal(await livePage.locator('#stats-section').evaluate(el => el.classList.contains('row')), true, 'Uses Bootstrap grid');
        assert.equal(await livePage.locator('#app-sidebar').evaluate(el => el.classList.contains('sidebar')), true, 'Uses Volt sidebar');
        assert.deepEqual(await livePage.locator('.stat-card').first().evaluate(el => ({background:getComputedStyle(el).backgroundColor,image:getComputedStyle(el).backgroundImage})),{background:'rgb(255, 255, 255)',image:'none'},'Cards use the supplied Volt white-card presentation');
        const cardShadow=await livePage.locator('.stat-card').first().evaluate(el=>getComputedStyle(el).boxShadow);
        await livePage.locator('.stat-card').first().hover();
        await until(async () => await livePage.locator('.stat-card').first().evaluate((el,before) => getComputedStyle(el).boxShadow !== before,cardShadow), 'Subtle template card hover');
        assert.equal(await livePage.locator('.stat-card').first().evaluate(el=>getComputedStyle(el).transform),'none','Template cards do not jump on hover');
        assert.equal(await livePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Desktop has no horizontal page overflow');
        await livePage.screenshot({ path: path.join(outputs, 'dashboard-desktop.png'), fullPage: true });
        await livePage.setViewportSize({ width: 390, height: 844 });
        assert.equal(await livePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile has no horizontal page overflow');
        await livePage.locator('#menu-button').click();
        await until(async () => await livePage.locator('#app-sidebar').evaluate(el => el.classList.contains('show') && !el.classList.contains('collapsing')), 'Native Bootstrap sidebar opened first time');
        await livePage.locator('[data-view="calendar"]').click();
        await text(livePage, 'page-title', 'Make room for what’s next');
        assert.equal(await livePage.locator('#sidebar-backdrop').isVisible(), false);
        await livePage.locator('#app-sidebar').waitFor({ state: 'hidden' });
        await until(async () => await livePage.locator('#app-sidebar').evaluate(el => !el.classList.contains('collapsing')), 'Native Bootstrap sidebar finished closing');
        await livePage.locator('#menu-button').click();
        await until(async () => await livePage.locator('#app-sidebar').evaluate(el => el.classList.contains('show')), 'Native Bootstrap sidebar opened');
        await livePage.locator('[data-view="overview"]').click();
        await until(async () => await livePage.locator('#app-sidebar').evaluate(el => el.getBoundingClientRect().right <= 0), 'Mobile menu fully closed');
        await livePage.screenshot({ path: path.join(outputs, 'dashboard-mobile.png'), fullPage: true, animations: 'disabled' });
        await livePage.goto(base + '/pages/dashboard/dashboard.html', { waitUntil: 'networkidle' });
        assert.equal(await livePage.locator('h1').innerText(), 'Appointment overview');
        const pdf = await fetch(base + '/assets/docs/appointment-guide.pdf');
        assert.equal(pdf.status, 200);
        assert.equal(pdf.headers.get('content-type'), 'application/pdf');
        assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
        await livePage.setViewportSize({ width: 680, height: 1000 });
        await livePage.goto(base + '/assets/docs/email-reminder-preview.html', { waitUntil: 'networkidle' });
        await livePage.locator('table[aria-label="Appointment Booking CRM logo"]').waitFor();
        assert.ok(await livePage.locator('strong').count() > 5, 'Email has highlighted bold details');
        await livePage.screenshot({ path: path.join(outputs, 'branded-email-preview.png'), fullPage: true });
        await live.close();
        console.log('PASS: live page, legacy dashboard URL, desktop/mobile layout, mobile navigation');

        // An isolated browser context ensures test bookings never appear in the user's dashboard.
        const context = await browser.newContext({ viewport: { width: 1440, height: 1040 }, timezoneId: 'America/New_York' });
        if (fixture) await context.addCookies(fixture.cookies);
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        const calls = [];
        let record;
        let failFirstBooking = true;
        let conflictNextReschedule = false;
        let emailFails = true;
        await page.route('**/api/health', route => route.fulfill({ json: { connected: true, upstreamStatus: 400, message: 'Isolated UI test connection.' } }));
        await page.route('**/api/appointments', async route => {
            const payload = route.request().postDataJSON();
            if (payload.action === 'status') {
                return route.fulfill({ json: { ok: true, appointment: record, notifications: { confirmation: { status: emailFails ? 'failed' : 'test_sent', sent_at: null }, reminder_24h: { status: record.status === 'cancelled' ? 'cancelled' : 'pending', due_at: record.booking_start, sent_at: null }, reminder_1h: { status: record.status === 'cancelled' ? 'cancelled' : 'pending', due_at: record.booking_start, sent_at: null } }, last_email_error: emailFails ? 'Simulated Gmail authentication failure' : '', test_mode: true, checked_at: new Date().toISOString() } });
            }
            calls.push(payload);
            if (payload.action === 'book') {
                assert.match(payload.request_id, /^[A-Za-z0-9_-]{8,128}$/);
                assert.ok(Date.parse(payload.booking_end) > Date.parse(payload.booking_start));
                if (failFirstBooking) {
                    failFirstBooking = false;
                    return route.fulfill({ status: 503, json: { ok: false, message: 'Simulated temporary failure. Please retry.' } });
                }
                record = { appointment_id: 'appt_ui_test', service: payload.service, booking_start: payload.booking_start, booking_end: payload.booking_end, status: 'confirmed', version: 1 };
                return route.fulfill({ status: 201, json: { ok: true, appointment: record, manage_token: 'a'.repeat(64), email_confirmation: 'queued', test_mode: true } });
            }
            assert.equal(payload.appointment_id, 'appt_ui_test');
            assert.equal(payload.manage_token, 'a'.repeat(64));
            if (conflictNextReschedule) {
                conflictNextReschedule = false;
                return route.fulfill({ status: 409, json: { ok: false, error: 'time_unavailable', message: 'This time overlaps an existing confirmed appointment. Choose another time.' } });
            }
            if (payload.action === 'reschedule') record = { ...record, booking_start: payload.booking_start, booking_end: payload.booking_end, version: record.version + 1 };
            else if (payload.action === 'cancel') record = { ...record, status: 'cancelled', version: record.version + 1 };
            else throw new Error('Unexpected action');
            return route.fulfill({ json: { ok: true, appointment: record, email_confirmation: 'queued' } });
        });
        await page.goto(base, { waitUntil: 'networkidle' });
        await text(page, 'connection-title', 'Your booking API is connected');
        await page.getByRole('button', { name: 'New appointment', exact: true }).click();
        const customer = 'QA Customer <img src=x onerror=alert(1)>';
        await page.locator('#customer-name').fill(customer);
        await page.locator('#customer-email').fill('qa@gmail.com');
        await page.locator('#booking-service').fill('Automation QA');
        const start = isoInput(Date.now() + 3 * 86400000);
        await page.locator('#booking-start').fill(start);
        await page.locator('#booking-duration').selectOption('60');
        await page.locator('#booking-submit').click();
        await page.locator('#booking-error').waitFor({ state: 'visible' });
        await text(page, 'stat-total', '0');
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('appoint.bookings.v1') || '[]').length), 0, 'Failure must not create a local record');
        await page.locator('#booking-submit').click();
        await page.locator('#details-modal').waitFor({ state: 'visible' });
        assert.equal(calls[0].request_id, calls[1].request_id, 'Retry must reuse request ID');
        assert.equal(calls[1].booking_start, new Date(start + '+08:00').toISOString(), 'Input uses Manila even in a New York browser');
        await text(page, 'stat-total', '1');
        await text(page, 'stat-upcoming', '1');
        assert.equal(await page.locator('#details-body img[src="x"]').count(), 0, 'Customer HTML is escaped');
        await page.locator('#delivery-alert').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#booking-rows .user-avatar').count(), 1, 'Client identity uses the shared avatar renderer');
        await page.evaluate(() => localStorage.setItem('appoint.customer-profiles.v1',JSON.stringify({'qa@gmail.com':{photo_data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='}})));
        assert.equal(await page.locator('#token-value').isVisible(), false);
        await page.locator('#token-toggle').click();
        await text(page, 'token-value', 'a'.repeat(64));
        await closeModal(page, 'details-modal');
        await page.reload({ waitUntil: 'networkidle' });
        await text(page, 'stat-total', '1');
        assert.equal(await page.locator('#booking-rows img.client-avatar').count(), 1, 'Existing browser-saved photos remain available through the shared renderer');
        emailFails = false;
        await page.locator('#refresh-delivery').click();
        await page.locator('#delivery-alert').waitFor({ state: 'hidden' });
        await page.locator('#booking-search').fill('no-match');
        await page.locator('#empty-state').waitFor({ state: 'visible' });
        await page.locator('#booking-search').fill('Automation QA');
        await until(async () => await page.locator('#booking-rows tr').count() === 1, 'Search result');
        await page.locator('#booking-search').fill('');
        console.log('PASS: booking, retry ID, no phantom records, Manila timezone, persistence, search, escaped content, token display, shared client avatars, preserved customer photos, live delivery failure display');

        await page.locator('.row-details').click();
        await page.locator('#details-reschedule').click();
        await page.locator('#booking-modal').waitFor({ state: 'visible' });
        const later = isoInput(Date.now() + 4 * 86400000);
        await page.locator('#booking-start').fill(later);
        conflictNextReschedule = true;
        await page.locator('#booking-submit').click();
        await page.locator('#booking-error').waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('appoint.bookings.v1'))[0].booking_start), calls[1].booking_start, 'Conflict preserves previous booking');
        await page.locator('#booking-submit').click();
        await page.locator('#details-modal').waitFor({ state: 'visible' });
        assert.equal(record.booking_start, new Date(later + '+08:00').toISOString());
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('appoint.bookings.v1'))[0].customer_name), customer);
        await page.locator('#details-cancel').click();
        await page.locator('#manage-modal').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#manage-start').isDisabled(), true, 'Cancellation needs no new date');
        await page.locator('#manage-submit').click();
        await page.locator('#details-modal').waitFor({ state: 'visible' });
        await text(page, 'stat-upcoming', '0');
        await text(page, 'stat-cancelled', '1');
        await closeModal(page, 'details-modal');
        await page.locator('[data-filter="cancelled"]').click();
        await until(async () => await page.locator('#booking-rows tr').count() === 1, 'Cancelled filter');
        await page.locator('[data-filter="upcoming"]').click();
        await page.locator('#empty-state').waitFor({ state: 'visible' });
        await page.locator('[data-filter="all"]').click();
        await page.locator('[data-view="calendar"]').click();
        await text(page, 'page-title', 'Make room for what’s next');
        await page.locator('#calendar-days .calendar-date:not(.outside)').first().click();
        await text(page, 'page-title', 'Make room for what’s next');
        assert.equal(new URL(page.url()).hash, '#calendar', 'Selecting a date keeps the calendar open');
        assert.equal(await page.locator('#calendar-agenda').isVisible(), true);
        await page.locator('#clear-date').click();
        await page.locator('[data-view="automation"]').click();
        await page.locator('#automation-detail').waitFor({ state: 'visible' });
        await page.locator('#customer-instructions-tab').click();
        await page.locator('#customer-instructions').waitFor({ state: 'visible' });
        assert.ok((await page.locator('#customer-instructions').innerText()).includes('Request a change by replying'));
        await page.locator('#owner-instructions-tab').click();
        await page.locator('#owner-instructions').waitFor({ state: 'visible' });
        console.log('PASS: conflict handling, rescheduling, cancellation, status filters, date navigation, reminder view');
        assert.deepEqual(errors, [], 'No browser JavaScript errors');
        await context.close();
        console.log('PASS: no browser JavaScript errors. Screenshots:', outputs);
    } finally { await browser?.close(); await fixture?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
