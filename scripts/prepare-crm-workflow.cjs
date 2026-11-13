// Add a verified, paginated booking read path. Existing write/automation nodes stay intact.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const original = JSON.parse(fs.readFileSync(path.join(root, 'workflow/appointments.updated.json'), 'utf8'));
if (original.nodes.some(n => n.name === 'Operator requests booking list')) throw new Error('The CRM read path is already installed.');
const candidate = structuredClone(original);
const additions = [
    { id: crypto.randomUUID(), name: 'Operator requests booking list', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [-100, -200], parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: '={{ $json.is_crm_list === true }}', operator: { type: 'boolean', operation: 'true', singleValue: true }, rightValue: '' }], combinator: 'and' }, options: {} } },
    { id: crypto.randomUUID(), name: 'Read CRM booking page', type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position: [120, -200], alwaysOutputData: true, parameters: { resource: 'row', operation: 'get', dataTableId: structuredClone(original.nodes.find(n => n.name === 'Read appointment calendar').parameters.dataTableId), matchType: 'allConditions', filters: { conditions: [{ keyName: 'id', condition: 'gt', keyValue: '={{ $json.crm_after_id }}' }] }, returnAll: false, limit: 501, orderBy: true, orderByColumn: 'id', orderByDirection: 'ASC' } },
    { id: crypto.randomUUID(), name: 'Prepare CRM booking page', type: 'n8n-nodes-base.code', typeVersion: 2, position: [340, -200], parameters: { mode: 'runOnceForAllItems', jsCode: `const rows = $input.all().map(item => item.json).filter(row => row.appointment_id);
const page = rows.slice(0, 500);
const fields = ['id','appointment_id','customer_name','email','service','booking_start','booking_end','timezone','status','version','is_test','createdAt','updatedAt'];
const appointments = page.map(row => Object.fromEntries(fields.map(key => [key,row[key]??null])));
return [{json:{http_code:200,response:{ok:true,appointments,next_after_id:rows.length>500?page[page.length-1].id:null},appointment_id:''}}];` } }
];
const authorization = candidate.nodes.find(n => n.name === 'Authorize operator request');
authorization.parameters.jsCode = authorization.parameters.jsCode.replace('const is_audit =', `const is_crm_list = body.payload.action === 'crm_list';
const crm_after_id = body.payload.after_id === undefined ? 0 : Number(body.payload.after_id);
if (is_crm_list && (!Number.isSafeInteger(crm_after_id) || crm_after_id < 0)) return reject(400, 'Invalid booking cursor.');
const is_audit =`).replace('operator_valid:true,operator_verified:true,is_audit,payload:', 'operator_valid:true,operator_verified:true,is_audit,is_crm_list,crm_after_id,payload:');
candidate.nodes.push(...additions);
const edge = name => ({ node: name, type: 'main', index: 0 });
candidate.connections['Operator requests audit log'].main[1] = [edge('Operator requests booking list')];
candidate.connections['Operator requests booking list'] = { main: [[edge('Read CRM booking page')], [edge('Normalize request body')]] };
candidate.connections['Read CRM booking page'] = { main: [[edge('Prepare CRM booking page')]] };
candidate.connections['Prepare CRM booking page'] = { main: [[edge('Return operator response')]] };
const group = { name: 'Read CRM bookings', nodeNames: ['Read CRM booking page', 'Prepare CRM booking page'], description: 'Read a verified page of appointments for client history and reports; exclude private management tokens.' };
candidate.nodeGroups.push({ id: crypto.randomUUID(), ...group });
const operations = [
    { type: 'updateNodeParameters', nodeName: authorization.name, parameters: authorization.parameters, replace: true },
    ...additions.map(node => ({ type: 'addNode', node })),
    { type: 'setNodeSettings', nodeName: 'Read CRM booking page', settings: { alwaysOutputData: true } },
    { type: 'removeConnection', source: 'Operator requests audit log', target: 'Normalize request body', sourceIndex: 1, targetIndex: 0 },
    { type: 'addConnection', source: 'Operator requests audit log', target: 'Operator requests booking list', sourceIndex: 1, targetIndex: 0 },
    { type: 'addConnection', source: 'Operator requests booking list', target: 'Read CRM booking page', sourceIndex: 0, targetIndex: 0 },
    { type: 'addConnection', source: 'Operator requests booking list', target: 'Normalize request body', sourceIndex: 1, targetIndex: 0 },
    { type: 'addConnection', source: 'Read CRM booking page', target: 'Prepare CRM booking page', sourceIndex: 0, targetIndex: 0 },
    { type: 'addConnection', source: 'Prepare CRM booking page', target: 'Return operator response', sourceIndex: 0, targetIndex: 0 },
    { type: 'addNodeGroup', name: group.name, nodeNames: group.nodeNames, description: group.description }
];
const value = item => Array.isArray(item) ? '[' + item.map(value).join(',') + ']' : item && typeof item === 'object' ? '{' + Object.entries(item).map(([key,itemValue]) => JSON.stringify(key) + ':' + value(itemValue)).join(',') + '}' : typeof item === 'string' && item.startsWith('={{') ? 'expr(' + JSON.stringify(item.slice(1)) + ')' : JSON.stringify(item);
const handles = new Map(candidate.nodes.map((node,index) => [node.name,'step'+index]));
let sdk = "import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';\n";
for (const item of candidate.nodes) {
    const config = { name:item.name, parameters:item.parameters, position:item.position };
    for (const field of ['credentials','alwaysOutputData','executeOnce','onError','retryOnFail','maxTries','waitBetweenTries','disabled']) if (item[field] !== undefined) config[field] = item[field];
    const output = item.name === 'Authorize operator request' ? [{ operator_valid:true,is_crm_list:true,crm_after_id:0 }] : item.name === 'Read CRM booking page' ? [{ appointment_id:'appt_example',id:1 }] : [{}];
    sdk += 'const '+handles.get(item.name)+' = '+(/webhook|scheduleTrigger/.test(item.type)?'trigger':'node')+'('+value({type:item.type,version:item.typeVersion,config,output})+');\n';
}
sdk += "export default workflow('REPLACE_WITH_APPOINTMENT_WORKFLOW_ID'," + JSON.stringify(candidate.name) + ')\n';
for (const item of candidate.nodes) sdk += ' .add('+handles.get(item.name)+')\n';
for (const [from,types] of Object.entries(candidate.connections)) for (const [index,edges] of (types.main||[]).entries()) for (const item of edges||[]) sdk += ' .add('+handles.get(from)+'.output('+index+').to('+handles.get(item.node)+'.input('+item.index+')))\n';
sdk += ';\n';
fs.writeFileSync(path.join(root,'.local/crm-workflow.candidate.json'),JSON.stringify(candidate,null,2));
fs.writeFileSync(path.join(root,'.local/crm-workflow.operations.json'),JSON.stringify(operations,null,2));
fs.writeFileSync(path.join(root,'.local/crm-workflow.sdk.js'),sdk);
console.log('Prepared',operations.length,'additive workflow operations; existing booking writes are unchanged.');
