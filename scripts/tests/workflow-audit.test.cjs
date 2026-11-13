const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const candidate = JSON.parse(fs.readFileSync(path.join(__dirname, '../../workflow/appointments.updated.json'), 'utf8'));
const original = require('./fixtures/workflow-before-access.json');
const emailBrandingBefore = require('./fixtures/email-branding-before.json');
const renderEmail = require('../../workflow/email-template.cjs');
const canonical = value => Array.isArray(value) ? value.map(canonical) : (value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value);
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const find = name => candidate.nodes.find(n => n.name === name);
const execute = (name, inputs, fixtures, executionId = 'audit_test') => new Function('$input', '$', '$execution', find(name).parameters.jsCode)(
    { first: () => ({ json: inputs[0] }), all: () => inputs.map(json => ({ json })) },
    nodeName => ({ first: () => ({ json: fixtures[nodeName][0] }), all: () => fixtures[nodeName].map(json => ({ json })) }), { id: executionId })[0].json;
const targets = name => (candidate.connections[name]?.main || []).flat().filter(Boolean).map(e => e.node);

test('booking decisions, locks, and notification delivery logic survive email branding changes', () => {
    for (const [name, expected] of Object.entries(original.nodes)) {
        if (['Normalize request body', 'Validate booking request'].includes(name)) continue;
        const node = structuredClone(find(name));
        if (name === 'Choose next notification') {
            const renderer = 'const renderAppointmentEmail = ' + renderEmail.toString() + ';';
            assert.ok(node.parameters.jsCode.startsWith(renderer), 'The workflow uses the verified email template');
            node.parameters.jsCode = emailBrandingBefore.renderer + node.parameters.jsCode.slice(renderer.length);
        }
        if (name === 'Gmail appointment email') {
            assert.equal(node.parameters.options.senderName, 'Appointment Booking CRM');
            node.parameters.options.senderName = emailBrandingBefore.senderName;
        }
        assert.equal(fingerprint({ type: node.type, typeVersion: node.typeVersion, parameters: node.parameters, credentials: node.credentials || {}, disabled: node.disabled || false }), expected, name + ' must stay unchanged');
    }
    for (const [name, expected] of Object.entries(original.automationConnections)) assert.equal(fingerprint(candidate.connections[name] || null), expected, name + ' connections');
});

test('public input cannot impersonate a verified account; empty reads reach their response branch', () => {
    const expression = find('Normalize request body').parameters.jsonOutput;
    const inner = expression.slice(3, -2).trim();
    assert.equal(inner.includes('}}'), false, 'Nested object braces must not close an n8n expression prematurely');
    const run = value => new Function('$json', 'return ' + inner)(value);
    assert.equal(run({ body: { action: 'status', operator_verified: true, actor: { role: 'owner' } } }).actor.role, 'public');
    assert.equal(run({ operator_verified: true, actor: { role: 'staff' }, payload: { action: 'status' } }).actor.role, 'staff');
    for (const name of ['Read booking audit log', 'Read operator key hash']) assert.equal(find(name).alwaysOutputData, true, name);
    assert.deepEqual(execute('Prepare booking audit response', [{}], {}).response.events, []);
});

test('operator authentication is mandatory and staff cannot read owner audit records', () => {
    const token = 'a'.repeat(64);
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const fixtures = {
        'Hash operator token': [{ operator_hash: digest }],
        'Operator booking API': [{ body: { actor: { id: 'owner_1', display_name: 'Owner', role: 'owner' }, payload: { action: 'audit' } } }]
    };
    assert.equal(execute('Authorize operator request', [{ token_hash: digest }], fixtures).operator_verified, true);
    fixtures['Hash operator token'][0].operator_hash = 'b'.repeat(64);
    assert.equal(execute('Authorize operator request', [{ token_hash: digest }], fixtures).http_code, 403);
    fixtures['Hash operator token'][0].operator_hash = digest;
    fixtures['Operator booking API'][0].body.actor.role = 'staff';
    assert.equal(execute('Authorize operator request', [{ token_hash: digest }], fixtures).http_code, 403);
    fixtures['Operator booking API'][0].body.payload = { action: 'status' };
    assert.equal(execute('Authorize operator request', [{ token_hash: digest }], fixtures).actor.role, 'staff');
});

test('CRM reads are verified, paginated, empty-safe, and exclude private booking tokens', () => {
    const fixtures = {
        'Hash operator token': [{operator_hash:'a'.repeat(64)}],
        'Operator booking API': [{body:{actor:{id:'staff_1',display_name:'Staff',role:'staff'},payload:{action:'crm_list',after_id:0}}}]
    };
    assert.equal(execute('Authorize operator request',[{token_hash:'a'.repeat(64)}],fixtures).is_crm_list,true);
    fixtures['Operator booking API'][0].body.payload.after_id=-1;
    assert.equal(execute('Authorize operator request',[{token_hash:'a'.repeat(64)}],fixtures).http_code,400);
    const rows=Array.from({length:501},(_,index)=>({id:index+1,appointment_id:'appt_'+index,manage_token:'private_token',email:'client@company.test'}));
    const page=execute('Prepare CRM booking page',rows,{}).response;
    assert.equal(page.appointments.length,500);assert.equal(page.next_after_id,500);
    assert.equal(page.appointments.some(row=>Object.hasOwn(row,'manage_token')),false);
    assert.deepEqual(execute('Prepare CRM booking page',[{}],{}).response.appointments,[]);
    assert.equal(find('Read CRM booking page').alwaysOutputData,true);
});

test('audit records exact locked snapshots, trusted actor, operation, and time without management tokens', () => {
    const before = { appointment_id: 'appt_test', customer_name: 'Customer', status: 'confirmed', version: 1, manage_token: 'secret', service: 'Test', booking_start: '2030-01-01T01:00:00.000Z', booking_end: '2030-01-01T02:00:00.000Z' };
    const after = { ...before, status: 'cancelled', version: 2, cancelled_at: '2029-01-01T00:00:00.000Z' };
    const decision = { route: 1, row: after };
    const fixtures = { 'Validate booking request': [{ action: 'cancel', actor: { id: 'staff_1', display_name: 'Staff', role: 'staff' } }], 'Read appointment calendar': [before] };
    const prepared = execute('Prepare booking audit', [decision], fixtures);
    assert.equal(prepared.audit.actor_id, 'staff_1');
    assert.equal(prepared.audit.operation_id, 'audit_test');
    assert.equal(prepared.audit.action, 'appointment.cancel');
    assert.equal(prepared.audit.outcome, 'requested');
    assert.equal(JSON.parse(prepared.audit.old_value).status, 'confirmed');
    assert.equal(JSON.parse(prepared.audit.new_value).status, 'cancelled');
    assert.equal(JSON.stringify(prepared.audit).includes('secret'), false);
    fixtures['Prepare booking audit'] = [prepared];
    const saved = execute('Prepare applied booking audit', [after], fixtures);
    assert.equal(saved.audit.outcome, 'succeeded');
    assert.equal(saved.audit.operation_id, prepared.audit.operation_id);
    assert.equal(Number.isNaN(Date.parse(saved.audit.occurred_at)), false);
    assert.deepEqual(targets('Save booking audit intent'), ['Restore audited booking decision']);
    assert.deepEqual(targets('Restore audited booking decision'), ['Apply booking decision']);
    for (const name of ['Save confirmed booking', 'Save cancellation or reschedule']) assert.deepEqual(targets(name), ['Prepare applied booking audit']);
    assert.deepEqual(targets('Save applied booking audit'), ['Release calendar lock']);
});

test('existing overlap rejection and cancellation/reschedule transition guards still work', () => {
    const start = new Date(Date.now() + 7 * 86400000).toISOString();
    const end = new Date(Date.parse(start) + 3600000).toISOString();
    const body = { action: 'book', customer_name: 'Synthetic', email: 'audit@example.test', service: 'Test', booking_start: start, booking_end: end, request_id: 'audit_test_request' };
    const request = execute('Validate booking request', [{ payload: body, actor: { id: 'public', role: 'public', display_name: 'Public' } }], {});
    const fixtures = { 'Validate booking request': [request], 'Generate management token': [{ data: 'a'.repeat(64) }] };
    const row = execute('Decide booking change', [], fixtures).row;
    fixtures['Validate booking request'][0] = { ...request, request_id: 'different_request' };
    assert.equal(execute('Decide booking change', [row], fixtures).response.error, 'time_unavailable');
    fixtures['Validate booking request'][0] = { ...request, action: 'reschedule', appointment_id: row.appointment_id, manage_token: row.manage_token };
    assert.equal(execute('Decide booking change', [{ ...row, status: 'cancelled' }], fixtures).response.error, 'not_confirmed');
    fixtures['Validate booking request'][0].action = 'cancel';
    assert.equal(execute('Decide booking change', [{ ...row, booking_start: new Date(Date.now() - 60000).toISOString() }], fixtures).response.error, 'already_started');
});
