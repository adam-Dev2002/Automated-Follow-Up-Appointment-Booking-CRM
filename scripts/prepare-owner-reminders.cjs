const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const readerName = 'Read owner reminder email';
const bccExpression = `={{ ['reminder_24h','reminder_1h'].includes($("Choose next notification").item.json.kind) && !$("Choose next notification").item.json.is_test && $("${readerName}").item.json.owner_email.toLowerCase() !== $("Choose next notification").item.json.row.email.toLowerCase() ? $("${readerName}").item.json.owner_email : "" }}`;

function withOwnerReminders(workflow, callbackCredential) {
    const updated = structuredClone(workflow);
    const prepare = updated.nodes.find(node => node.name === 'Prepare dispatch context');
    const gmail = updated.nodes.find(node => node.name === 'Gmail appointment email');
    if (!prepare || !gmail) throw new Error('The existing appointment dispatch nodes are required.');
    if (!updated.nodes.some(node => node.name === readerName)) updated.nodes.push({
        id:crypto.createHash('sha256').update('appoint:'+readerName).digest('hex').slice(0,32),
        name:readerName, type:'n8n-nodes-base.httpRequest', typeVersion:4.2,
        position:[prepare.position[0]+180,prepare.position[1]+140],
        parameters:{
            url:'http://host.docker.internal:3002/api/reminder-config',
            authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',
            options:{timeout:10000}
        },
        credentials:callbackCredential ? {httpHeaderAuth:callbackCredential} : {},
        retryOnFail:true,maxTries:2,waitBetweenTries:1000
    });
    updated.connections[prepare.name] = {main:[[{node:readerName,type:'main',index:0}]]};
    updated.connections[readerName] = {main:[[{node:'Acquire email dispatch lock',type:'main',index:0}]]};
    gmail.parameters.options.bccList = bccExpression;
    return updated;
}

if (require.main === module) {
    const filename = path.resolve(__dirname, '../workflow/appointments.updated.json');
    const updated = withOwnerReminders(JSON.parse(fs.readFileSync(filename, 'utf8')));
    updated.active = false;
    fs.writeFileSync(filename, JSON.stringify(updated, null, 2)+'\n');
    console.log('Prepared owner reminder callback and private reminder copies. Bind the dashboard header credential when importing.');
}
module.exports = { withOwnerReminders, readerName, bccExpression };
