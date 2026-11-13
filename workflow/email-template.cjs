// This standalone function is embedded in the n8n Code node by scripts/prepare-workflow-email.cjs.
// Use email-safe tables and inline styles so the brand and key details remain readable in Gmail.
module.exports = function renderAppointmentEmail(row, kind, title) {
    const logoUrl = 'https://dynamic.heygen.ai/image/bf67dac0475144f19b4374d86c212bd6/original.png';
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const format = (stamp, options) => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', ...options }).format(new Date(stamp));
    const date = format(row.booking_start, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const time = format(row.booking_start, { hour: 'numeric', minute: '2-digit', hour12: true }) + ' – ' + format(row.booking_end, { hour: 'numeric', minute: '2-digit', hour12: true });
    const cancelled = row.status === 'cancelled';
    const reminder = kind !== 'confirmation';
    const heading = cancelled ? 'Your appointment is cancelled' : kind === 'reminder_1h' ? 'Your appointment is coming up soon' : kind === 'reminder_24h' ? 'A reminder for your upcoming appointment' : row.version > 1 ? 'Your appointment has a new time' : 'Your appointment is confirmed';
    const intro = cancelled ? 'We’ve recorded your cancellation. Keep this email for your records.' : reminder ? 'Here’s a quick reminder of your appointment details. Please check the date and time below.' : row.version > 1 ? 'Your booking has been updated. Please use the new details below.' : 'Thank you for booking with us. Your appointment details are below.';
    const accent = cancelled ? '#b6555f' : '#0066cc';
    const pale = cancelled ? '#fff0f1' : '#edf6ff';
    const badge = cancelled ? 'CANCELLED' : kind === 'reminder_1h' ? '1-HOUR REMINDER' : kind === 'reminder_24h' ? '24-HOUR REMINDER' : row.version > 1 ? 'RESCHEDULED' : 'CONFIRMED';
    const instructions = cancelled
        ? '<strong>Would you like to book again?</strong><br>Reply to this email with your requested service and preferred date and time. The business will help arrange a new appointment.'
        : '<strong>Need to reschedule or cancel?</strong><br>Reply to this email with your <strong>booking reference</strong>. For a new time, include your preferred date and time. For cancellation, say that you would like to cancel.<br><br>The business will review your request and update the booking. Please request changes <strong>before your appointment starts</strong>.';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>@media only screen and (max-width:620px){.email-container{width:100%!important}.email-pad{padding:24px!important}.email-title{font-size:25px!important}.outer-pad{padding:12px 6px!important}}</style></head>
<body style="margin:0;padding:0;background:#f3f5fa;font-family:Arial,Helvetica,sans-serif;color:#374151;-webkit-text-size-adjust:100%">
<div style="display:none;font-size:1px;color:#f3f5fa;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${esc(heading)} · ${esc(row.service)} · ${esc(date)} · ${esc(time)} · Asia/Manila</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fa"><tr><td class="outer-pad" align="center" style="padding:32px 12px">
<table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #dce9f3;border-radius:16px;overflow:hidden">
<tr><td class="email-pad" align="center" style="padding:20px 36px;border-bottom:3px solid #00b3a4;background:#ffffff">
<table role="presentation" cellpadding="0" cellspacing="0" aria-label="Appointment Booking CRM logo"><tr><td align="center"><img src="${logoUrl}" width="160" height="160" alt="Appointment Booking CRM" style="display:block;width:160px;max-width:100%;height:auto;border:0"></td></tr></table>
</td></tr>
<tr><td class="email-pad" style="padding:32px 36px">
<span style="display:inline-block;background:${pale};color:${accent};border-radius:6px;font-size:11px;font-weight:bold;letter-spacing:1px;padding:8px 11px">${badge}</span>
<h1 class="email-title" style="font-size:29px;line-height:1.25;font-weight:bold;letter-spacing:-.5px;color:#0b2748;margin:20px 0 18px">${esc(heading)}</h1>
<p style="font-size:15px;line-height:1.8;margin:0 0 12px">Hello <strong>${esc(row.customer_name)}</strong>,</p>
<p style="font-size:15px;line-height:1.8;margin:0 0 24px">${intro}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${pale};border:1px solid ${cancelled ? '#f4dadd' : '#cfe4f8'};border-radius:12px">
<tr><td style="padding:22px 24px"><p style="font-size:11px;letter-spacing:1px;color:${accent};font-weight:bold;margin:0 0 9px">${cancelled ? 'CANCELLED APPOINTMENT' : 'YOUR APPOINTMENT'}</p><p style="font-size:20px;line-height:1.4;font-weight:bold;color:#34304a;margin:0 0 18px">${esc(row.service)}</p><p style="font-size:16px;line-height:1.6;margin:0 0 6px;color:#34304a"><strong>${esc(date)}</strong></p><p style="font-size:19px;line-height:1.5;margin:0 0 7px;font-weight:bold;color:${accent}">${esc(time)}</p><p style="font-size:12px;color:#7d728f;margin:0">Asia/Manila · UTC+08:00</p></td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr><td style="font-size:12px;line-height:1.8;padding:10px 0;color:#8b8199">BOOKING REFERENCE<br><strong style="font-family:Consolas,monospace;font-size:14px;color:#534267">${esc(row.appointment_id)}</strong></td><td align="right" style="font-size:12px;line-height:1.8;padding:10px 0;color:#8b8199">STATUS<br><strong style="color:${accent}">${cancelled ? 'Cancelled' : 'Confirmed'}</strong></td></tr></table>
<div style="height:1px;background:#e1eaf2;margin:20px 0 24px"></div>
<h2 style="font-size:17px;color:#34304a;margin:0 0 12px">${cancelled ? 'What happens next' : 'Before your appointment'}</h2>
${cancelled ? '<p style="font-size:14px;line-height:1.8;margin:0 0 18px">Remaining reminders for this booking have been stopped.</p>' : '<ul style="font-size:14px;line-height:1.8;margin:0 0 22px;padding-left:20px"><li>Check the <strong>service, date, and time</strong> above.</li><li>Keep your booking reference handy when contacting the business.</li><li>All appointment times shown here are in <strong>Asia/Manila</strong>.</li></ul>'}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#f8f9fc;border-left:4px solid ${accent};padding:18px 20px;font-size:14px;line-height:1.8;border-radius:5px">${instructions}</td></tr></table>
<p style="font-size:14px;line-height:1.8;margin:24px 0 0">Thank you,<br><strong>The Appointment Booking CRM team</strong></p>
${row.manage_token ? `<p style="font-size:11px;line-height:1.7;margin:24px 0 0;color:#9a91a5"><strong style="color:#7f738f">Private management code</strong><br><span style="font-family:Consolas,monospace;word-break:break-all;overflow-wrap:anywhere">${esc(row.manage_token)}</span><br>Keep this code private. Share it only with the business if requested to manage your booking.</p>` : ''}
</td></tr><tr><td class="email-pad" style="padding:20px 36px;background:#f0faf8;border-top:1px solid #d7eee9"><p style="font-size:11px;line-height:1.8;color:#61788c;margin:0"><strong style="color:#0066cc">Appointment Booking CRM</strong> · Appointment booking &amp; reminders<br>This is an appointment update. Reply to the business if you need help.</p></td></tr>
</table></td></tr></table></body></html>`;
};
