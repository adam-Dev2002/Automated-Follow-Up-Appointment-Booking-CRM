const appointmentWorkflowId=process.env.APPOINTMENTS_N8N_WORKFLOW_ID;
// Installs a separate receipt sender; the existing appointment graph is retained.
// The default prints a plan. --apply configures and enables the empty-queue sender.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {buildReceiptWorkflow}=require('./build-receipt-workflow.cjs');
const args=process.argv.slice(2),apply=args.includes('--apply');
const configIndex=args.indexOf('--config');
const config=configIndex>=0?JSON.parse(fs.readFileSync(path.resolve(args[configIndex+1]),'utf8').replace(/^\uFEFF/,'')):{apiKey:process.env.APPOINTMENTS_N8N_API_KEY};
const directory=path.resolve(process.env.APPOINTMENTS_DATA_DIR||path.join(__dirname,'../.local'));
const journalPath=path.join(directory,'receipt-sender-install.json');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const graph=workflow=>({nodes:workflow.nodes,connections:workflow.connections,active:workflow.active});
const {isDeepStrictEqual}=require('node:util');
function comparableNodes(nodes){
    return nodes.map(node=>{
        const value={...node,credentials:Object.fromEntries(Object.entries(node.credentials||{}).map(([key,item])=>[key,{id:item.id}]))};
        // Reviewed n8n normalization: it assigns a webhookId to Gmail nodes even
        // when they only send mail. This field is unused by that send operation.
        if(value.type==='n8n-nodes-base.gmail' && (!value.parameters.operation || value.parameters.operation==='send'))delete value.webhookId;
        return value;
    });
}
function verifyGraph(actual,expected){
    if(!isDeepStrictEqual(comparableNodes(actual.nodes),comparableNodes(expected.nodes))||!isDeepStrictEqual(actual.connections,expected.connections))throw new Error('The imported receipt graph differs; activation was blocked.');
}
function journal(value){fs.writeFileSync(journalPath,JSON.stringify(value,null,2),{mode:0o600});}
async function api(resource,method='GET',body){
    const response=await fetch('http://127.0.0.1:5678/api/v1/'+resource,{method,headers:{'X-N8N-API-KEY':config.apiKey,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(25000)});
    if(!response.ok)throw new Error('n8n operator request failed with HTTP '+response.status+'. Private response withheld.');
    return response.json();
}
(async()=>{
    if(!appointmentWorkflowId)throw new Error('Set APPOINTMENTS_N8N_WORKFLOW_ID to your imported appointment workflow ID.');
    if(!config.apiKey)throw new Error('Supply the existing private local n8n operator config with --config.');
    const original=await api('workflows/'+appointmentWorkflowId),before=hash(graph(original));
    const gmail=original.nodes.find(node=>node.name==='Gmail appointment email')?.credentials?.gmailOAuth2;
    if(!gmail?.id)throw new Error('The existing appointment Gmail binding is unavailable.');
    if(fs.existsSync(journalPath)){
        const saved=JSON.parse(fs.readFileSync(journalPath));
        if(saved.phase!=='complete'){
            if(!args.includes('--review-import')||saved.phase!=='activating-workflow'||!saved.workflowId)throw new Error('A prior installation needs review. Retain its journal and inspect resources before retrying.');
            if(before!==saved.originalGraphSHA256)throw new Error('The original appointment graph changed; review required.');
            const current=await api('workflows/'+saved.workflowId);
            const expected=JSON.parse(fs.readFileSync(path.join(saved.backup,'receipt-workflow.private.json'),'utf8'));
            verifyGraph(current,expected);
            if(current.active)throw new Error('The imported sender is already active; inspect it before continuing.');
            if(!apply){console.log(JSON.stringify({reviewed:true,workflowId:current.id,active:false,normalization:'Generated Gmail send-node webhook ID only'}));return;}
            const enabled=await api('workflows/'+current.id+'/activate','POST',{});
            journal({...saved,phase:'complete',active:enabled.active,nodeCount:expected.nodes.length,reviewedNormalization:'n8n-generated Gmail send-only webhookId'});
            console.log(JSON.stringify({workflowId:current.id,active:enabled.active,originalAppointmentWorkflowUnchanged:true,existingImportedWorkflowReused:true}));return;
        }
        const workflow=await api('workflows/'+saved.workflowId);
        console.log(JSON.stringify({alreadyInstalled:true,workflowId:workflow.id,active:workflow.active,originalAppointmentWorkflowUnchanged:before===saved.originalGraphSHA256}));return;
    }
    console.log(JSON.stringify({apply,originalWorkflow:original.id,originalActive:original.active,gmailCredentialId:gmail.id,newWorkflowName:buildReceiptWorkflow().name,bookingWorkflowWillChange:false}));
    if(!apply)return;
    const db=new DatabaseSync(path.join(directory,'access.sqlite'),{readOnly:true});
    if(db.prepare('SELECT count(*) AS total FROM crm_receipt_emails').get().total!==0)throw new Error('Review existing receipt jobs before enabling a new sender.');
    db.close();
    const backup=path.join(directory,'backups','receipt-sender-'+crypto.randomUUID());
    fs.mkdirSync(backup,{recursive:true});
    fs.writeFileSync(path.join(backup,'appointment-workflow-before.private.json'),JSON.stringify(original),{mode:0o600,flag:'wx'});
    const base={originalWorkflowId:original.id,originalGraphSHA256:before,backup,at:new Date().toISOString()};
    journal({...base,phase:'creating-callback-credential'});
    const token=fs.readFileSync(path.join(directory,'operator-token'),'utf8');
    const credential=await api('credentials','POST',{name:'Appointment receipt sender — dashboard',type:'httpHeaderAuth',data:{name:'X-Appoint-Operator',value:token}});
    journal({...base,phase:'creating-workflow',credentialId:credential.id});
    const expected=buildReceiptWorkflow(gmail,{id:credential.id,name:credential.name});
    fs.writeFileSync(path.join(backup,'receipt-workflow.private.json'),JSON.stringify(expected,null,2),{mode:0o600,flag:'wx'});
    const created=await api('workflows','POST',expected);
    journal({...base,phase:'activating-workflow',credentialId:credential.id,workflowId:created.id});
    const read=await api('workflows/'+created.id);
    verifyGraph(read,expected);
    const enabled=await api('workflows/'+created.id+'/activate','POST',{});
    const after=await api('workflows/'+appointmentWorkflowId);
    if(hash(graph(after))!==before)throw new Error('The existing appointment graph changed during installation; review required.');
    journal({...base,phase:'complete',credentialId:credential.id,workflowId:created.id,active:enabled.active,nodeCount:expected.nodes.length});
    console.log(JSON.stringify({workflowId:created.id,active:enabled.active,nodeCount:expected.nodes.length,originalAppointmentWorkflowUnchanged:true,journal:journalPath,backup}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
