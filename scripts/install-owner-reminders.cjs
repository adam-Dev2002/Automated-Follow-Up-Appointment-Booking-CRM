const appointmentWorkflowId=process.env.APPOINTMENTS_N8N_WORKFLOW_ID;
// Add owner copies to the existing workflow without changing booking decisions,
// delivery claims, schedules, or receipt sending. Uses the existing callback key.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { withOwnerReminders, readerName } = require('./prepare-owner-reminders.cjs');
const args = process.argv.slice(2), apply = args.includes('--apply');
const configIndex = args.indexOf('--config');
const config = configIndex >= 0 ? JSON.parse(fs.readFileSync(path.resolve(args[configIndex+1]), 'utf8').replace(/^\uFEFF/, '')) : {apiKey:process.env.APPOINTMENTS_N8N_API_KEY};
const directory = path.resolve(process.env.APPOINTMENTS_DATA_DIR || path.join(__dirname, '../.local'));

async function api(resource, method = 'GET', body) {
    const response = await fetch('http://127.0.0.1:5678/api/v1/'+resource, {
        method,headers:{'X-N8N-API-KEY':config.apiKey,'Content-Type':'application/json'},
        ...(body ? {body:JSON.stringify(body)} : {}),redirect:'error',signal:AbortSignal.timeout(25000)
    });
    if (!response.ok) throw new Error('Local n8n request failed with HTTP '+response.status+'.');
    return response.json();
}
const graph = workflow => ({nodes:workflow.nodes,connections:workflow.connections,settings:workflow.settings});
function verify(actual, expected) {
    const clean = nodes => nodes.map(node => {
        const copy = structuredClone(node);
        copy.credentials = Object.fromEntries(Object.entries(copy.credentials || {}).map(([key,value]) => [key,{id:value.id}]));
        if (copy.type === 'n8n-nodes-base.gmail') delete copy.webhookId;
        return copy;
    });
    if (!isDeepStrictEqual(clean(actual.nodes),clean(expected.nodes)) || !isDeepStrictEqual(actual.connections,expected.connections)) throw new Error('The updated reminder graph differs from the prepared change.');
}
(async () => {
    if(!appointmentWorkflowId)throw new Error('Set APPOINTMENTS_N8N_WORKFLOW_ID to your imported appointment workflow ID.');
    if(!config.apiKey) throw new Error('Supply the existing local n8n operator config with --config.');
    const original = await api('workflows/'+appointmentWorkflowId);
    const receiptInstall = JSON.parse(fs.readFileSync(path.join(directory,'receipt-sender-install.json'),'utf8'));
    const receipt = await api('workflows/'+receiptInstall.workflowId);
    const credential = receipt.nodes.find(node => node.name === 'Claim one receipt')?.credentials?.httpHeaderAuth;
    if (!credential?.id) throw new Error('The existing dashboard callback credential is required.');
    const updated = withOwnerReminders(original,credential);
    console.log(JSON.stringify({apply,workflowId:original.id,wasActive:original.active,ownerAddress:'Set by the owner in Automated reminders',newNode:readerName}));
    if (!apply) return;
    if (isDeepStrictEqual(graph(original),graph(updated))) { console.log('Owner reminders already installed.'); return; }
    const backup = path.join(directory,'backups','owner-reminders-'+Date.now());
    fs.mkdirSync(backup,{recursive:true});
    fs.writeFileSync(path.join(backup,'workflow-before.private.json'),JSON.stringify(original,null,2),{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(backup,'workflow-proposed.private.json'),JSON.stringify(updated,null,2),{flag:'wx',mode:0o600});
    const journalFile = path.join(backup,'install.json');
    const journal = phase => fs.writeFileSync(journalFile,JSON.stringify({phase,workflowId:original.id,wasActive:original.active,backup},null,2));
    // Check Docker's callback connection before touching the running workflow.
    const { execFileSync } = require('node:child_process');
    const callbackCheck = "const fs=require('fs');let token='';process.stdin.on('data',c=>token+=c);process.stdin.on('end',async()=>{const r=await fetch('http://host.docker.internal:3002/api/reminder-config',{headers:{'X-Appoint-Operator':token},signal:AbortSignal.timeout(10000)});const b=await r.json();if(!r.ok||!b.ok||typeof b.owner_email!=='string')process.exit(1);console.log('Authenticated reminder callback reachable');});";
    execFileSync('docker',['exec','-i','n8n','node','-e',callbackCheck],{input:fs.readFileSync(path.join(directory,'operator-token'),'utf8'),windowsHide:true,stdio:['pipe','pipe','pipe']});
    journal('updating');
    await api('workflows/'+original.id,'PUT',{name:updated.name,nodes:updated.nodes,connections:updated.connections,settings:updated.settings});
    const saved = await api('workflows/'+original.id);
    verify(saved,updated);
    if (original.active) { journal('publishing'); await api('workflows/'+original.id+'/activate','POST',{}); }
    const after = await api('workflows/'+original.id);
    verify(after,updated);
    if (after.active !== original.active) throw new Error('The workflow active state changed unexpectedly.');
    const receiptAfter = await api('workflows/'+receipt.id);
    if (!isDeepStrictEqual(graph(receipt),graph(receiptAfter)) || receipt.active !== receiptAfter.active) throw new Error('The separate receipt sender changed unexpectedly.');
    const exported = withOwnerReminders(JSON.parse(fs.readFileSync(path.resolve(__dirname,'../workflow/appointments.updated.json'),'utf8')));
    exported.active = false;
    fs.writeFileSync(path.resolve(__dirname,'../workflow/appointments.updated.json'),JSON.stringify(exported,null,2)+'\n');
    journal('complete');
    console.log(JSON.stringify({installed:true,active:after.active,receiptSenderUnchanged:true,backup}));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
