const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
function buildReceiptWorkflow(gmailCredential, callbackCredential) {
    const node = (name,type,typeVersion,parameters,x,extra={}) => ({
        id:crypto.createHash('sha256').update('appoint-receipt:'+name).digest('hex').slice(0,32),
        name,type:'n8n-nodes-base.'+type,typeVersion,parameters,position:[x,0],...extra
    });
    const callback = (name,jsonBody,x) => node(name,'httpRequest',4.2,{
        method:'POST',url:'http://host.docker.internal:3002/api/receipt-emails',
        authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',
        sendBody:true,specifyBody:'json',jsonBody,options:{timeout:15000}
    },x,{credentials:callbackCredential?{httpHeaderAuth:callbackCredential}:{}});
    const nodes=[
        node('Check queued receipts','scheduleTrigger',1.4,{rule:{interval:[{field:'minutes',minutesInterval:1}]}},0),
        node('Read Gmail sending account','httpRequest',4.2,{
            url:'https://gmail.googleapis.com/gmail/v1/users/me/profile',
            authentication:'predefinedCredentialType',nodeCredentialType:'gmailOAuth2',options:{timeout:15000}
        },220,{credentials:gmailCredential?{gmailOAuth2:gmailCredential}:{},retryOnFail:true,maxTries:3,waitBetweenTries:1000}),
        callback('Claim one receipt',"={{ JSON.stringify({action:'claim',execution_id:$execution.id,sender_email:$json.emailAddress}) }}",440),
        node('Receipt waiting?','if',2.3,{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{leftValue:'={{ !!$json.job }}',rightValue:'',operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}},660),
        node('Gmail receipt email','gmail',2.2,{
            sendTo:'={{ $json.job.to }}',subject:'={{ $json.job.subject }}',emailType:'html',message:'={{ $json.job.html }}',
            options:{appendAttribution:false,senderName:'Appointment Booking CRM'}
        },880,{credentials:gmailCredential?{gmailOAuth2:gmailCredential}:{},onError:'continueRegularOutput',retryOnFail:false}),
        node('Record receipt result','code',2,{
            jsCode:"const claim = $('Claim one receipt').first().json;\nconst result = $input.first().json;\nconst id = typeof result.id === 'string' && /^[a-f0-9]{6,100}$/i.test(result.id) ? result.id : '';\nreturn [{json:{action:'result',job_id:claim.job.id,execution_id:$execution.id,outcome:!result.error && id?'sent':'uncertain',gmail_message_id:!result.error?id:''}}];"
        },1100),
        {...callback('Confirm receipt result','={{ JSON.stringify($json) }}',1320),retryOnFail:true,maxTries:3,waitBetweenTries:1000}
    ];
    const connections={};
    for(let i=0;i<nodes.length-1;i++)connections[nodes[i].name]={main:[[{node:nodes[i+1].name,type:'main',index:0}],...(nodes[i].name==='Receipt waiting?'?[[]]:[])]};
    return {name:'Appointment Booking CRM — confirmed payment receipt emails',nodes,connections,settings:{
        executionOrder:'v1',timezone:'Asia/Manila',executionTimeout:120,saveDataSuccessExecution:'all',saveDataErrorExecution:'all',saveManualExecutions:false
    }};
}
if(require.main===module){
    const target=path.resolve(__dirname,'../workflow/receipt-email-sender.json');
    fs.writeFileSync(target,JSON.stringify({...buildReceiptWorkflow(),active:false},null,2));
    console.log('Prepared receipt sender template without credentials: '+target);
}
module.exports={buildReceiptWorkflow};
