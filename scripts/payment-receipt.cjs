const crypto = require('node:crypto');
const { fail } = require('./security-store.cjs');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => value === null ? 'Not set' : new Intl.NumberFormat('en-PH', { style:'currency', currency:'PHP' }).format(value / 100);
const date = value => new Intl.DateTimeFormat('en-PH', { timeZone:'Asia/Manila', dateStyle:'medium', timeStyle:'short' }).format(new Date(value));
const labels = { paid:'Full payment', partial:'Partial payment', deposit:'Deposit', refund:'Refund', cash:'Cash', card:'Card', bank_transfer:'Bank transfer', other:'Other' };
function receiptSnapshot(booking, summary, paymentId) {
    const payment = summary.payments.find(row => row.id === paymentId);
    if (!payment) throw fail(404, 'Receipt not found.');
    return {
        version:1, receipt_number:'RCPT-' + payment.id.toUpperCase(),
        payment_id:payment.id, appointment_id:payment.appointment_id,
        customer_name:booking.customer_name, email:String(booking.email || '').trim().toLowerCase(),
        service:payment.service, booking_start:booking.booking_start, booking_end:booking.booking_end,
        kind:payment.kind, method:payment.method, amount_minor:payment.amount_minor, currency:payment.currency,
        received_at:payment.received_at, recorded_at:payment.created_at, receipt_reference:payment.receipt_reference,
        refund_of:payment.refund_of, price_minor:summary.price_minor, gross_minor:summary.gross_minor,
        refunded_minor:summary.refunded_minor, net_minor:summary.net_minor, balance_minor:summary.balance_minor,
        is_test:Boolean(booking.is_test || payment.is_test)
    };
}
const receiptDigest = receipt => crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
function receiptHtml(receipt, email = false) {
    const heading = receipt.kind === 'refund' ? 'Refund receipt' : 'Payment receipt';
    const logo = email ? 'https://dynamic.heygen.ai/image/bf67dac0475144f19b4374d86c212bd6/original.png' : '/assets/img/brand/appointment-booking-crm.png';
    const field = (name, value) => '<tr><td style="padding:10px 0;color:#6b7280;vertical-align:top;width:38%">' + esc(name) + '</td><td style="padding:10px 0;color:#1f2937;overflow-wrap:anywhere">' + esc(value) + '</td></tr>';
    const paymentFields = [
        ['Receipt number', receipt.receipt_number], ['Client', receipt.customer_name], ['Email', receipt.email || 'Not recorded'],
        ['Booking reference', receipt.appointment_id], ['Service', receipt.service],
        ['Appointment', date(receipt.booking_start) + ' – ' + date(receipt.booking_end)],
        [receipt.kind === 'refund' ? 'Refunded at' : 'Received at', date(receipt.received_at) + ' · Asia/Manila (UTC+8)'],
        ['Payment type', labels[receipt.kind]], ['Method', labels[receipt.method]]
    ];
    if (receipt.receipt_reference) paymentFields.push(['Transfer / external reference', receipt.receipt_reference]);
    if (receipt.refund_of) paymentFields.push(['Original receipt', 'RCPT-' + receipt.refund_of.toUpperCase()]);
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(heading + ' · ' + receipt.receipt_number) + '</title>' +
        (email ? '' : '<style>body{margin:0;background:#f2f4f6}a,button{font:inherit}.receipt-actions{max-width:720px;margin:20px auto;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:0 20px}.receipt-actions button{display:inline-flex;align-items:center;gap:8px;background:rgba(var(--bs-info-rgb,35,97,206),.08);color:var(--bs-info,#2361ce);border:1px solid rgba(var(--bs-info-rgb,35,97,206),.25);border-radius:6px;padding:12px 18px;cursor:pointer}.receipt-actions a{color:#374151}.receipt-sheet{box-shadow:0 4px 16px #1118270c}@page{size:A4;margin:14mm}@media print{body{background:white}.receipt-actions{display:none!important}.receipt-sheet{box-shadow:none!important;border:0!important;margin:0!important;max-width:none!important;padding:0!important}tr{break-inside:avoid}}@media(max-width:600px){.receipt-sheet{padding:24px 18px!important}}</style>') +
        '</head><body style="font-family:Arial,Helvetica,sans-serif;color:#374151">' +
        (email ? '' : '<nav class="receipt-actions" aria-label="Receipt actions"><a href="/#payments">Back to payments</a><button id="print-receipt" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6M6 17H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M6 14h12v7H6z"/></svg>Print receipt / Save PDF</button></nav>') +
        '<main class="receipt-sheet" style="max-width:680px;margin:20px auto;padding:36px;background:white;border:1px solid #e5e7eb;border-radius:8px">' +
        '<table role="presentation" style="width:100%;border-collapse:collapse"><tr><td><img src="' + logo + '" width="100" height="100" alt="Appointment Booking CRM" style="object-fit:contain;display:block"></td><td style="text-align:right"><h1 style="font-size:26px;margin:0 0 8px;color:#1f2937">' + heading + '</h1><span style="font-size:13px;color:#6b7280">Appointment Booking CRM</span></td></tr></table>' +
        (receipt.is_test ? '<p style="padding:10px;background:#ffeed6;color:#805206">TEST BOOKING · Not a real customer receipt</p>' : '') +
        '<div style="padding:22px 0;border-top:2px solid #1f2937;border-bottom:1px solid #e5e7eb;margin:24px 0"><span style="font-size:13px;color:#6b7280">' + (receipt.kind === 'refund' ? 'Amount refunded' : 'Amount received') + '</span><p style="font-size:32px;font-weight:bold;color:#1f2937;margin:8px 0 0">' + esc(money(receipt.amount_minor)) + '</p></div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.5;table-layout:fixed">' + paymentFields.map(row => field(...row)).join('') + '</table>' +
        '<h2 style="font-size:16px;border-top:1px solid #e5e7eb;padding-top:24px;margin-top:20px">Booking balance when this receipt was prepared</h2>' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed">' + [['Appointment price',receipt.price_minor],['Total received',receipt.gross_minor],['Total refunded',receipt.refunded_minor],['Retained after refunds',receipt.net_minor],['Balance due',receipt.balance_minor]].map(([key,value]) => field(key,money(value))).join('') + '</table>' +
        '<p style="font-size:12px;line-height:1.7;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:20px;margin-top:20px">This receipt records a payment or refund already recorded for your booking. It does not charge a card or transfer money. Please contact the business with your booking reference if you have a question.</p></main>' +
        (email ? '' : '<script src="/assets/js/receipt.js"></script>') + '</body></html>';
}
module.exports = { receiptSnapshot, receiptDigest, receiptHtml };
