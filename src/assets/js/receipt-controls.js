(async () => {
    'use strict';
    const access=await window.appointAccess;
    if(!access?.user)return;
    const $=id=>document.getElementById(id);
    const modal=new bootstrap.Modal($('crm-receipt-modal'));
    const paymentModal=bootstrap.Modal.getOrCreateInstance($('crm-payment-modal'));
    let selected=null,preview=null,requestId='',busy=false,polling=false,lastPoll=0;
    const money=value=>new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(value/100);
    const receiptUrl=id=>'/api/crm/payments/'+encodeURIComponent(id)+'/receipt';
    function actionIcon(button,icon,label){
        button.classList.add(icon==='send'?'action-send':'action-print');
        button.setAttribute('aria-label',label);button.title=label;
        button.innerHTML='<svg class="ai ai-sm" aria-hidden="true"><use href="#i-'+icon+'"/></svg>';
    }
    async function request(url,options={}) {
        const response=await fetch(url,{...options,headers:{'Content-Type':'application/json','X-CSRF-Token':access.csrf_token}});
        const data=await response.json();
        if(!response.ok||!data.ok)throw new Error(data.message||'The receipt could not be loaded.');
        return data;
    }
    function render() {
        if(!selected)return;
        const payments=selected.summary.payments;
        $('crm-print-latest').hidden=!payments.length;
        if(payments.length)$('crm-print-latest').href=receiptUrl(payments[0].id)+'?print=1';
        Array.from($('crm-payment-history').children).forEach((row,index)=>{
            const payment=payments[index];if(!payment)return;
            let cell=row.querySelector('[data-receipt-actions]');
            if(!cell){cell=document.createElement('td');cell.dataset.label='Receipt';cell.dataset.receiptActions='';row.appendChild(cell);}
            cell.replaceChildren();
            const actions=document.createElement('div');actions.className='d-flex flex-wrap gap-2';
            const print=document.createElement('a');print.className='btn btn-sm btn-action btn-icon';print.href=receiptUrl(payment.id)+'?print=1';print.target='_blank';print.rel='noopener';actionIcon(print,'print','Print receipt');actions.appendChild(print);
            const job=payment.receipt_email;
            if(!job){
                const send=document.createElement('button');send.type='button';send.className='btn btn-sm btn-action btn-icon';actionIcon(send,'send','Send receipt');send.dataset.sendReceipt=payment.id;
                send.disabled=Boolean(selected.booking.is_test||payment.is_test);
                if(send.disabled)send.title='Test bookings can be printed but cannot email receipts.';
                actions.appendChild(send);
            }
            cell.appendChild(actions);
            if(job){
                const status=document.createElement('p');status.className='receipt-delivery small mt-2 mb-0';status.setAttribute('role','status');
                const labels={Queued:'Waiting to send',Sending:'Sending receipt',Sent:'Sent by Gmail','Needs review':'Delivery needs review'};
                status.textContent=job.overdue?'Delivery not confirmed':labels[job.status]||job.status;status.title=job.detail||'';
                if(['Queued','Sending'].includes(job.status)&&!job.overdue){
                    const spinner=document.createElement('span');spinner.className='spinner-border spinner-border-sm me-2';spinner.setAttribute('aria-hidden','true');status.prepend(spinner);
                }
                cell.appendChild(status);
                if(job.overdue||job.status==='Needs review'){const note=document.createElement('small');note.className='d-block text-gray-500 mt-1';note.textContent=job.detail;cell.appendChild(note);}
            }
        });
    }
    document.addEventListener('appoint:receipt-payment',event=>{selected=event.detail;render();});
    // Existing payment writes re-render their table. Add the receipt controls to
    // those new rows without replacing unsaved form fields or payment behavior.
    new MutationObserver(()=>{if(selected&&!$('crm-payment-history [data-receipt-actions]'))refresh().catch(()=>{});}).observe($('crm-payment-history'),{childList:true});
    async function refresh(){
        if(!selected||polling)return;
        polling=true;const id=selected.booking.appointment_id;
        try{
            const data=await request('/api/crm/appointments/'+encodeURIComponent(id));
            if(selected?.booking.appointment_id!==id)return;
            selected=data;
            document.dispatchEvent(new CustomEvent('appoint:receipt-refresh',{detail:data}));
            render();lastPoll=Date.now();
        }finally{polling=false;}
    }
    function showPreview(data){
        preview=data;
        $('crm-receipt-to').textContent=data.receipt.email||'No email recorded';
        $('crm-receipt-from').textContent=data.sender.email||'Sending account unavailable';
        $('crm-receipt-amount').textContent=money(data.receipt.amount_minor);
        $('crm-receipt-number').textContent=data.receipt.receipt_number;
        $('crm-receipt-send').disabled=!data.sender.ready||!!data.email||data.receipt.is_test;
        $('crm-receipt-status').textContent=data.email?data.email.detail||data.email.status:!data.sender.ready?'The sending account is not ready. Refresh the status before sending.':'Ready. Confirm Send receipt to email this customer.';
    }
    $('crm-payment-history').addEventListener('click',async event=>{
        const button=event.target.closest('[data-send-receipt]');if(!button||busy)return;
        button.disabled=true;
        try{
            const data=await request(receiptUrl(button.dataset.sendReceipt)+'?format=json');
            requestId=crypto.randomUUID();$('crm-receipt-error').hidden=true;showPreview(data);
            $('crm-payment-modal').addEventListener('hidden.bs.modal',()=>modal.show(),{once:true});
            paymentModal.hide();
        }catch(error){$('crm-payment-error').textContent=error.message;$('crm-payment-error').hidden=false;}
        finally{button.disabled=false;}
    });
    $('crm-receipt-form').addEventListener('submit',async event=>{
        event.preventDefault();if(busy||!preview||$('crm-receipt-send').disabled)return;
        busy=true;$('crm-receipt-send').disabled=true;$('crm-receipt-send-label').textContent='Queueing receipt…';$('crm-receipt-error').hidden=true;
        try{
            await request(receiptUrl(preview.receipt.payment_id)+'/email',{method:'POST',body:JSON.stringify({confirm:true,to:preview.receipt.email,sender_email:preview.sender.email,receipt_digest:preview.receipt_digest,request_id:requestId})});
            await refresh();busy=false;modal.hide();
        }catch(error){$('crm-receipt-error').textContent=error.message;$('crm-receipt-error').hidden=false;}
        finally{busy=false;$('crm-receipt-send').disabled=!!preview&&(!preview.sender.ready||!!preview.email||preview.receipt.is_test);$('crm-receipt-send-label').textContent='Send receipt';}
    });
    $('crm-receipt-refresh').addEventListener('click',async()=>{
        if(busy||!preview)return;
        $('crm-receipt-refresh').disabled=true;
        try{showPreview(await request(receiptUrl(preview.receipt.payment_id)+'?format=json'));}
        catch(error){$('crm-receipt-error').textContent=error.message;$('crm-receipt-error').hidden=false;}
        finally{$('crm-receipt-refresh').disabled=false;}
    });
    $('crm-receipt-modal').addEventListener('hide.bs.modal',event=>{if(busy)event.preventDefault();});
    $('crm-receipt-modal').addEventListener('hidden.bs.modal',()=>{preview=null;paymentModal.show();});
    setInterval(()=>{
        if(document.hidden||!$('crm-payment-modal').classList.contains('show')||!selected)return;
        const active=selected.summary.payments.some(payment=>['Queued','Sending'].includes(payment.receipt_email?.status));
        if(active||Date.now()-lastPoll>30000)refresh().catch(()=>{});
    },3000);
})();
