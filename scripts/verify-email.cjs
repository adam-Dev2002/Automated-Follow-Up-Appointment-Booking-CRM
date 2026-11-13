const assert = require('node:assert/strict');
const render = require('../workflow/email-template.cjs');
const row = { customer_name: 'Jamie <img src=x onerror=alert(1)>', service: 'Consultation & planning', appointment_id: 'TEST-REFERENCE', booking_start: '2026-11-16T02:00:00.000Z', booking_end: '2026-11-16T02:30:00.000Z', status: 'confirmed', version: 1, manage_token: 'a'.repeat(64) };
for (const kind of ['confirmation', 'reminder_24h', 'reminder_1h']) {
    const html = render(row, kind, 'Appointment update');
    assert.ok(html.includes('aria-label="Appointment Booking CRM logo"'));
    assert.ok(html.includes('alt="Appointment Booking CRM"'));
    assert.ok(html.includes('https://dynamic.heygen.ai/image/bf67dac0475144f19b4374d86c212bd6/original.png'));
    assert.ok(html.includes('#0066cc') && html.includes('#00b3a4'));
    assert.ok(!html.includes('appoint<span'));
    assert.ok(html.includes('<strong>'));
    assert.ok(html.includes('November 16, 2026'));
    assert.ok(html.includes('10:00 AM – 10:30 AM'));
    assert.ok(html.includes('Asia/Manila'));
    assert.ok(html.includes('Jamie &lt;img'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('Reply to this email'));
    assert.ok(!html.includes('POST request'));
    assert.ok(!html.includes('localhost'));
}
const cancelled = render({ ...row, status: 'cancelled' }, 'confirmation', 'Cancelled');
assert.ok(cancelled.includes('Remaining reminders for this booking have been stopped.'));
assert.ok(cancelled.includes('Would you like to book again?'));
const rescheduled = render({ ...row, version: 2 }, 'confirmation', 'Rescheduled');
assert.ok(rescheduled.includes('Your appointment has a new time'));
assert.ok(!render({ ...row, manage_token: '' }, 'confirmation', 'Preview').includes('Private management code'));
console.log('PASS: branded HTML emails, bold details, Manila times, safe customer content, cancellation/reschedule instructions, and private token handling.');
