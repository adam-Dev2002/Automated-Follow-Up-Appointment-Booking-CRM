// Produces an additive patch; existing booking decisions and automation nodes stay byte-for-byte intact.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const base = path.resolve(__dirname, '..');
const auditTable = { __rl: true, mode: 'list', value: 'REPLACE_WITH_APPOINTMENT_AUDIT_LOG_TABLE_ID', cachedResultName: 'appointment_audit_log' };
const keyTable = { __rl: true, mode: 'list', value: 'REPLACE_WITH_APPOINTMENT_OPERATOR_KEYS_TABLE_ID', cachedResultName: 'appointment_operator_keys' };
const migration = require('../workflow/migrations/001-access-audit.json');
const source = JSON.parse(fs.readFileSync(path.join(base, '.local/backups/batch-1-original-workflow.json'), 'utf8'));
const updated = structuredClone(source);
const operations = [];
const add = (name, type, typeVersion, parameters, position, extra = {}) => {
    const item = { id: crypto.randomUUID(), name, type: 'n8n-nodes-base.' + type, typeVersion, parameters, position, ...extra };
    updated.nodes.push(item);
    operations.push({ type: 'addNode', node: item });
    if (item.alwaysOutputData !== undefined) operations.push({ type: 'setNodeSettings', nodeName: name, settings: { alwaysOutputData: item.alwaysOutputData } });
    return item;
};
const connect = (from, to, index = 0) => {
    const main = (updated.connections[from] ||= { main: [] }).main;
    while (main.length <= index) main.push([]);
    main[index].push({ node: to, type: 'main', index: 0 });
    operations.push({ type: 'addConnection', source: from, target: to, sourceIndex: index, targetIndex: 0 });
};
const disconnect = (from, to, index = 0) => {
    updated.connections[from].main[index] = updated.connections[from].main[index].filter(edge => edge.node !== to);
    operations.push({ type: 'removeConnection', source: from, target: to, sourceIndex: index, targetIndex: 0 });
};
const parameters = (name, change) => {
    const item = updated.nodes.find(n => n.name === name);
    item.parameters = change(item.parameters);
    operations.push({ type: 'updateNodeParameters', nodeName: name, parameters: item.parameters, replace: true });
};
const condition = expression => ({ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: expression, operator: { type: 'boolean', operation: 'true', singleValue: true }, rightValue: '' }], combinator: 'and' }, options: {} });
const code = (name, jsCode, position) => add(name, 'code', 2, { mode: 'runOnceForAllItems', jsCode }, position);
const auditColumns = Object.fromEntries(migration.tables[0].columns.map(c => [c.name, '={{ $json.audit.' + c.name + ' }}']));
const auditParameters = () => ({ resource: 'row', operation: 'insert', dataTableId: auditTable, columns: { mappingMode: 'defineBelow', value: auditColumns, matchingColumns: [], schema: migration.tables[0].columns.map(c => ({ id: c.name, displayName: c.name, required: false, defaultMatch: false, display: true, type: c.type, canBeUsedToMatch: true })) }, options: {} });

add('Operator booking API', 'webhook', 2.1, { httpMethod: 'POST', path: 'appointments-operator-api', responseMode: 'responseNode', options: {} }, [-1440, -420]);
add('Hash operator token', 'crypto', 2, { action: 'hash', type: 'SHA256', value: '={{ $json.headers?.["x-appoint-operator"] || "" }}', dataPropertyName: 'operator_hash', encoding: 'hex' }, [-1210, -420]);
add('Read operator key hash', 'dataTable', 1.1, { resource: 'row', operation: 'get', dataTableId: keyTable, matchType: 'allConditions', filters: { conditions: [{ keyName: 'key_name', keyValue: 'dashboard' }] }, returnAll: false, limit: 1 }, [-990, -420], { alwaysOutputData: true });
code('Authorize operator request', `const expected = String($input.first().json.token_hash || '');
const supplied = String($('Hash operator token').first().json.operator_hash || '');
const reject = (http_code, message) => [{json:{operator_valid:false,http_code,response:{ok:false,message},appointment_id:''}}];
if (!/^[a-f0-9]{64}$/.test(expected) || supplied.length !== 64) return reject(403, 'Operator authentication failed.');
let difference = 0;
for (let i = 0; i < 64; i++) difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
if (difference) return reject(403, 'Operator authentication failed.');
const body = $('Operator booking API').first().json.body;
const actor = body?.actor;
if (!body || typeof body.payload !== 'object' || !body.payload || Array.isArray(body.payload) || !actor || !['owner','staff'].includes(actor.role) || typeof actor.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actor.id) || typeof actor.display_name !== 'string' || !actor.display_name.trim() || actor.display_name.length > 120) return reject(400, 'A verified account and payload are required.');
const is_audit = body.payload.action === 'audit';
if (is_audit && actor.role !== 'owner') return reject(403, 'Only an owner can read the audit log.');
const before = body.payload.before_id === undefined ? Number.MAX_SAFE_INTEGER : Number(body.payload.before_id);
const ref = typeof body.payload.appointment_id === 'string' ? body.payload.appointment_id.trim() : '';
if (is_audit && (!Number.isSafeInteger(before) || before < 1 || (ref && !/^[A-Za-z0-9_-]{1,200}$/.test(ref)))) return reject(400, 'Invalid audit cursor or booking reference.');
return [{json:{operator_valid:true,operator_verified:true,is_audit,payload:body.payload,actor:{id:actor.id,display_name:actor.display_name,role:actor.role},before_id:before,audit_ref:ref}}];`, [-770, -420]);
add('Operator request is authorized', 'if', 2.2, condition('={{ $json.operator_valid === true }}'), [-540, -420]);
add('Operator requests audit log', 'if', 2.2, condition('={{ $json.is_audit === true }}'), [-320, -420]);
add('Return operator response', 'respondToWebhook', 1.4, structuredClone(source.nodes.find(n => n.name === 'Return booking response').parameters), [360, -600]);
add('Read booking audit log', 'dataTable', 1.1, { resource: 'row', operation: 'get', dataTableId: auditTable, matchType: 'allConditions', filters: { conditions: [{ keyName: 'id', condition: 'lt', keyValue: '={{ $json.before_id }}' }, { keyName: '={{ $json.audit_ref ? "entity_id" : "id" }}', condition: '={{ $json.audit_ref ? "eq" : "gte" }}', keyValue: '={{ $json.audit_ref || "0" }}' }] }, returnAll: false, limit: 51, orderBy: true, orderByColumn: 'id', orderByDirection: 'DESC' }, [-100, -600], { alwaysOutputData: true });
code('Prepare booking audit response', `const rows = $input.all().map(i => i.json).filter(r => r.operation_id);
const page = rows.slice(0, 50);
const events = page.map(r => ({...r,id:'booking:'+r.id,source:'appointments',entity_type:'appointment',old_value:JSON.parse(r.old_value),new_value:JSON.parse(r.new_value)}));
return [{json:{http_code:200,response:{ok:true,events,next_before_id:rows.length>50?page[page.length-1].id:null},appointment_id:''}}];`, [120, -600]);

parameters('Normalize request body', params => ({ ...params, jsonOutput: '={{ ({ payload: $json.operator_verified === true ? $json.payload : ($json.body ?? $json), actor: $json.operator_verified === true ? $json.actor : { id: "public", display_name: "Public", role: "public" } }) }}' }));
parameters('Validate booking request', params => ({ ...params, jsCode: params.jsCode.replace('return [{json:{valid:true,...data}}];', 'return [{json:{valid:true,...data,actor:$input.first().json.actor || {id:"public",display_name:"Public",role:"public"}}}];') }));

add('Booking change needs audit', 'if', 2.2, condition('={{ $json.route === 0 || $json.route === 1 }}'), [520, 560]);
code('Prepare booking audit', `const decision = $input.first().json;
const request = $('Validate booking request').first().json;
const previous = $('Read appointment calendar').all().map(i=>i.json).find(row=>row.appointment_id===decision.row.appointment_id) || null;
const snapshot = row => row ? Object.fromEntries(['appointment_id','customer_name','email','service','booking_start','booking_end','timezone','status','version','cancelled_at'].map(key=>[key,row[key]??null])) : null;
const actor = request.actor || {id:'public',display_name:'Public',role:'public'};
return [{json:{...decision,audit:{operation_id:String($execution.id),actor_id:actor.id,actor_name:actor.display_name,actor_role:actor.role,action:'appointment.'+request.action,entity_id:decision.row.appointment_id,old_value:JSON.stringify(snapshot(previous)),new_value:JSON.stringify(snapshot(decision.row)),outcome:'requested',occurred_at:new Date().toISOString()}}}];`, [740, 520]);
add('Save booking audit intent', 'dataTable', 1.1, auditParameters(), [960, 520]);
add('Restore audited booking decision', 'set', 3.4, { mode: 'raw', jsonOutput: '={{ $("Prepare booking audit").first().json }}', options: {} }, [1180, 520]);
code('Prepare applied booking audit', `const audit = $('Prepare booking audit').first().json.audit;
const row = $input.first().json;
const snapshot = Object.fromEntries(['appointment_id','customer_name','email','service','booking_start','booking_end','timezone','status','version','cancelled_at'].map(key=>[key,row[key]??null]));
return [{json:{audit:{...audit,new_value:JSON.stringify(snapshot),outcome:'succeeded',occurred_at:new Date().toISOString()}}}];`, [1400, 800]);
add('Save applied booking audit', 'dataTable', 1.1, auditParameters(), [1620, 800]);

connect('Operator booking API', 'Hash operator token');
connect('Hash operator token', 'Read operator key hash');
connect('Read operator key hash', 'Authorize operator request');
connect('Authorize operator request', 'Operator request is authorized');
connect('Operator request is authorized', 'Operator requests audit log');
connect('Operator request is authorized', 'Return operator response', 1);
connect('Operator requests audit log', 'Read booking audit log');
connect('Operator requests audit log', 'Normalize request body', 1);
connect('Read booking audit log', 'Prepare booking audit response');
connect('Prepare booking audit response', 'Return operator response');
disconnect('Decide booking change', 'Apply booking decision');
connect('Decide booking change', 'Booking change needs audit');
connect('Booking change needs audit', 'Prepare booking audit');
connect('Booking change needs audit', 'Apply booking decision', 1);
connect('Prepare booking audit', 'Save booking audit intent');
connect('Save booking audit intent', 'Restore audited booking decision');
connect('Restore audited booking decision', 'Apply booking decision');
for (const name of ['Save confirmed booking', 'Save cancellation or reschedule']) {
    disconnect(name, 'Release calendar lock');
    connect(name, 'Prepare applied booking audit');
}
connect('Prepare applied booking audit', 'Save applied booking audit');
connect('Save applied booking audit', 'Release calendar lock');
const manage = updated.nodeGroups.find(g => g.name === 'Manage appointments');
manage.nodeNames.push('Booking change needs audit', 'Prepare booking audit', 'Save booking audit intent', 'Restore audited booking decision', 'Prepare applied booking audit', 'Save applied booking audit');
operations.push({ type: 'updateNodeGroup', groupName: manage.name, nodeNames: manage.nodeNames, description: manage.description });
for (const group of [
    { name: 'Verify workspace account', nodeNames: ['Hash operator token', 'Read operator key hash', 'Authorize operator request', 'Operator request is authorized'], description: 'Verify the server credential and trusted owner or staff identity.' },
    { name: 'Read booking audit', nodeNames: ['Read booking audit log', 'Prepare booking audit response'], description: 'Read a page of booking changes for an authorized owner.' }
]) {
    updated.nodeGroups.push({ id: crypto.randomUUID(), ...group });
    operations.push({ type: 'addNodeGroup', name: group.name, nodeNames: group.nodeNames, description: group.description });
}

// Only the generated SDK text is interpreted by n8n; this generator is normal local Node code.
const expressionValues = value => {
    if (Array.isArray(value)) return '[' + value.map(expressionValues).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.entries(value).map(([k,v]) => JSON.stringify(k) + ':' + expressionValues(v)).join(',') + '}';
    if (typeof value === 'string' && value.startsWith('={{')) return 'expr(' + JSON.stringify(value.slice(1)) + ')';
    return JSON.stringify(value);
};
const names = new Map(updated.nodes.map((n,i) => [n.name, 'step' + i]));
let sdk = "import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';\n";
for (const item of updated.nodes) {
    const config = { name: item.name, parameters: item.parameters, position: item.position };
    for (const key of ['credentials','alwaysOutputData','onError','executeOnce','retryOnFail','maxTries','waitBetweenTries','disabled','notes']) if (item[key] !== undefined) config[key] = item[key];
    const builder = /webhook|scheduleTrigger/.test(item.type) ? 'trigger' : 'node';
    sdk += 'const ' + names.get(item.name) + ' = ' + builder + '(' + expressionValues({ type: item.type, version: item.typeVersion, config, output: [{}] }) + ');\n';
}
sdk += 'export default workflow(' + JSON.stringify(source.id) + ',' + JSON.stringify(source.name) + ')\n';
for (const item of updated.nodes) sdk += '  .add(' + names.get(item.name) + ')\n';
for (const [from, types] of Object.entries(updated.connections)) for (const [type, branches] of Object.entries(types)) {
    if (type !== 'main') throw new Error('Unexpected connection type: ' + type);
    for (const [index, edges] of branches.entries()) for (const edge of edges || []) sdk += '  .add(' + names.get(from) + '.output(' + index + ').to(' + names.get(edge.node) + '.input(' + edge.index + ')))\n';
}
sdk += ';\n';
fs.writeFileSync(path.join(base, '.local/access-workflow.sdk.js'), sdk);
fs.writeFileSync(path.join(base, '.local/access-workflow.operations.json'), JSON.stringify(operations, null, 2));
fs.writeFileSync(path.join(base, '.local/access-workflow.candidate.json'), JSON.stringify(updated, null, 2));
console.log('Prepared', operations.length, 'additive workflow operations; nodes:', updated.nodes.length);
