// Prepare an isolated public source copy, leaving private working bindings intact.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'.local','github-release-'+Date.now());
const excluded=new Set(['VERIFICATION.json','BRANDING-VERIFICATION.json','.DS_Store']);
const folders=['src','scripts','workflow','docs'];
const rootFiles=['.gitignore','.gitattributes','README.md','USER-GUIDE.md','TESTING-GUIDE.md','LOCAL-DASHBOARD.md','LICENSE.md','gulpfile.js','package.json','package-lock.json'];
fs.mkdirSync(output,{recursive:true});
function copy(relative){
    const source=path.join(root,relative),dest=path.join(output,relative);
    if(excluded.has(path.basename(relative)))return;
    if(fs.statSync(source).isDirectory()){
        fs.mkdirSync(dest,{recursive:true});
        for(const child of fs.readdirSync(source))copy(path.join(relative,child));
    }else fs.copyFileSync(source,dest);
}
for(const file of [...rootFiles,...folders])copy(file);
const read=file=>fs.readFileSync(path.join(output,file),'utf8').replace(/^\uFEFF/,'');
const write=(file,data)=>fs.writeFileSync(path.join(output,file),data);
const workflow=JSON.parse(read('workflow/appointments.updated.json'));
const tableIds=new Map(),schema=new Map();
for(const node of workflow.nodes){
    const table=node.parameters.dataTableId;if(!table)continue;
    const name=table.cachedResultName,placeholder='REPLACE_WITH_'+name.toUpperCase()+'_TABLE_ID';
    tableIds.set(table.value,placeholder);
    if(!schema.has(name))schema.set(name,new Map());
    for(const column of node.parameters.columns?.schema||[])schema.get(name).set(column.id,column.type==='dateTime'?'date':column.type);
}
const migration=JSON.parse(read('workflow/migrations/001-access-audit.json'));
for(const table of migration.tables)for(const column of table.columns)schema.get(table.name).set(column.name,column.type);
function sanitize(value){
    if(Array.isArray(value))return value.map(sanitize);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['credentials','pinData','meta','staticData'].includes(key)).map(([key,item])=>[key,sanitize(item)]));
    if(typeof value==='string')for(const [id,placeholder]of tableIds)value=value.replaceAll(id,placeholder);
    return value;
}
const publicWorkflow=sanitize(workflow);publicWorkflow.active=false;
write('workflow/appointments.updated.json',JSON.stringify(publicWorkflow,null,2)+'\n');
const receipt=sanitize(JSON.parse(read('workflow/receipt-email-sender.json')));receipt.active=false;write('workflow/receipt-email-sender.json',JSON.stringify(receipt,null,2)+'\n');
const publicMigration=sanitize(migration);delete publicMigration.project_id;delete publicMigration.workflow_id;
write('workflow/migrations/001-access-audit.json',JSON.stringify(publicMigration,null,2)+'\n');
write('workflow/table-schema.json',JSON.stringify({timezone:'Asia/Manila',notes:'Create these columns in your own n8n Data Tables. n8n supplies id/createdAt/updatedAt. No live rows or credential bindings are included.',tables:[...schema].map(([name,columns])=>({name,columns:[...columns].map(([name,type])=>({name,type}))}))},null,2)+'\n');

// The regression fixture originally included local table/credential bindings.
// Rebase only its node fingerprints to the same reviewed logic with public bindings.
const baseline=JSON.parse(read('scripts/tests/fixtures/workflow-before-access.json'));
const branding=JSON.parse(read('scripts/tests/fixtures/email-branding-before.json'));
const renderer=require(path.join(root,'workflow/email-template.cjs'));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
for(const name of Object.keys(baseline.nodes)){
    if(['Normalize request body','Validate booking request'].includes(name))continue;
    const node=structuredClone(publicWorkflow.nodes.find(node=>node.name===name));
    if(name==='Choose next notification'){
        const prefix='const renderAppointmentEmail = '+renderer.toString()+';';
        if(!node.parameters.jsCode.startsWith(prefix))throw Error('Unrecognized verified email renderer.');
        node.parameters.jsCode=branding.renderer+node.parameters.jsCode.slice(prefix.length);
    }
    if(name==='Gmail appointment email')node.parameters.options.senderName=branding.senderName;
    baseline.nodes[name]=crypto.createHash('sha256').update(JSON.stringify(canonical({type:node.type,typeVersion:node.typeVersion,parameters:node.parameters,credentials:node.credentials||{},disabled:node.disabled||false}))).digest('hex');
}
write('scripts/tests/fixtures/workflow-before-access.json',JSON.stringify(baseline,null,2)+'\n');

for(const file of ['scripts/install-receipt-sender.cjs','scripts/install-owner-reminders.cjs']){
    let source=read(file);
    source="const appointmentWorkflowId=process.env.APPOINTMENTS_N8N_WORKFLOW_ID;\n"+source;
    source=source.replace(/api\('workflows\/[A-Za-z0-9]+'\)/g,"api('workflows/'+appointmentWorkflowId)");
    source=source.replace(/if\s*\(!config\.apiKey\)/,"if(!appointmentWorkflowId)throw new Error('Set APPOINTMENTS_N8N_WORKFLOW_ID to your imported appointment workflow ID.');\n    if(!config.apiKey)");
    write(file,source);
}
function scrubText(relative){
    const filename=path.join(output,relative);
    for(const entry of fs.readdirSync(filename,{withFileTypes:true})){
        const child=path.join(relative,entry.name);
        if(entry.isDirectory()){scrubText(child);continue;}
        if(!/\.(?:cjs|js|html|md|json|scss|css)$/.test(entry.name))continue;
        let source=read(child);
        for(const [id,placeholder]of tableIds)source=source.replaceAll(id,placeholder);
        source=source.replace(/http:\/\/localhost:5678\/workflow\/[A-Za-z0-9]+/g,'http://localhost:5678');
        // This legacy SDK generator is retained as a maintenance helper.
        if(child.replaceAll('\\','/')==='scripts/prepare-crm-workflow.cjs')source=source.replace(/workflow\('[A-Za-z0-9]+',/g,"workflow('REPLACE_WITH_APPOINTMENT_WORKFLOW_ID',");
        write(child,source);
    }
}
for(const folder of ['src','scripts','docs'])scrubText(folder);
write('LOCAL-DASHBOARD.md','# Local development\n\nSee [setup](docs/SETUP.md), [the user guide](USER-GUIDE.md), and [testing](TESTING-GUIDE.md).\n\nThe app serves http://localhost:3002 and proxies booking requests to local n8n. Overview booking references are browser-local; Calendar/Clients/booking balances read the protected shared source. Accounts, client photos, and transaction history are stored in private SQLite. Keep runtime data and n8n credentials outside Git.\n');
console.log(JSON.stringify({directory:output,workflowCredentialsRemoved:true,workflowTablesReplaced:tableIds.size,demoScreenshots:fs.readdirSync(path.join(output,'docs/screenshots')).filter(name=>name.endsWith('.png')).length}));
