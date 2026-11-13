const fs = require('node:fs');
const path = require('node:path');
const render = require('../workflow/email-template.cjs');
const folder = path.resolve(__dirname, '../src/assets/docs');
fs.mkdirSync(folder, { recursive: true });
const example = { customer_name: 'Jamie Santos', service: 'Consultation — email preview', appointment_id: 'PREVIEW-ONLY', booking_start: '2026-11-16T02:00:00.000Z', booking_end: '2026-11-16T02:30:00.000Z', status: 'confirmed', version: 1, manage_token: '' };
for (const [file, kind, title, row] of [
    ['email-confirmation-preview.html', 'confirmation', 'Appointment confirmed', example],
    ['email-reminder-preview.html', 'reminder_1h', '1-hour appointment reminder', example],
    ['email-cancellation-preview.html', 'confirmation', 'Appointment cancelled', { ...example, status: 'cancelled' }]
]) fs.writeFileSync(path.join(folder, file), render(row, kind, title));
// A pure function string can be embedded in n8n's network-free Code node.
fs.mkdirSync(path.resolve(__dirname, '../.local'), { recursive: true });
fs.writeFileSync(path.resolve(__dirname, '../.local/email-renderer.json'), JSON.stringify(render.toString()));
const workflowPath = path.resolve(__dirname, '../workflow/appointments.updated.json');
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const planner = workflow.nodes.find(node => node.name === 'Choose next notification');
const boundary = planner.parameters.jsCode.indexOf('\nconst row = $input.first().json;');
if (boundary < 0) throw new Error('The existing notification renderer boundary could not be found.');
planner.parameters.jsCode = 'const renderAppointmentEmail = ' + render.toString() + ';' + planner.parameters.jsCode.slice(boundary);
const gmail = workflow.nodes.find(node => node.name === 'Gmail appointment email');
gmail.parameters.options.senderName = 'Appointment Booking CRM';
fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2) + '\n');
fs.writeFileSync(path.resolve(__dirname, '../.local/email-branding.operations.json'), JSON.stringify([
    { type: 'updateNodeParameters', nodeName: planner.name, parameters: planner.parameters, replace: true },
    { type: 'updateNodeParameters', nodeName: gmail.name, parameters: gmail.parameters, replace: true }
], null, 2));
console.log('Branded HTML email previews and workflow renderer are ready. Only the email presentation and sender name changed.');
