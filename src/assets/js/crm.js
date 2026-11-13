(async () => {
    'use strict';
    const access = await window.appointAccess;
    if (!access?.user) return;
    const clientIdentities = await window.appointClients;
    const $ = id => document.getElementById(id);
    const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money = minor => minor === null || minor === undefined ? 'Not set' : new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(minor/100);
    const date = value => value ? new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : 'No bookings yet';
    const inputTime = value => new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,16);
    const labels = { unpriced:'Price not set',unpaid:'Unpaid',paid:'Paid',partial:'Partially paid',deposit:'Deposit received',refunded:'Refunded',refund:'Refund',cash:'Cash',card:'Card',bank_transfer:'Bank transfer',other:'Other',confirmed:'Confirmed',cancelled:'Cancelled',pending:'Pending',rescheduled:'Rescheduled',completed:'Completed',no_show:'No-show' };
    const label = value => labels[value] || value;
    const badge = status => `<span class="crm-badge crm-badge-${esc(status)}">${esc(label(status))}</span>`;
    const person = (id,name,subtitle='',profile={}) => clientIdentities.personMarkup({...profile,id,customer_name:name},subtitle);
    const clientLink = (id,name,subtitle='',profile={}) => clientIdentities.linkMarkup({...profile,id,client_id:id,customer_name:name},subtitle);
    const owner = access.user.role === 'owner';
    document.querySelectorAll('.crm-owner-only').forEach(node=>{node.hidden=!owner;});
    const clientModal = new bootstrap.Modal($('crm-client-modal'));
    const paymentModal = bootstrap.Modal.getOrCreateInstance($('crm-payment-modal'));
    const confirmModal = new bootstrap.Modal($('crm-confirm-modal'));
    let clientsPage = 1, paymentsPage = 1, currentClient = null, clientRequest = '', selectedPayment = null, paymentRequest = null, pending = null, mutationBusy = false, report = null, reportFilters = null;
    let clientSearchSequence=0,paymentSearchSequence=0,reportSequence=0,clientOpenSequence=0,paymentOpenSequence=0;
    let paymentView = 'history';
    const refundOption = $('crm-payment-kind').querySelector('[value="refund"]');
    refundOption.hidden = !owner; refundOption.disabled = !owner;
    async function request(url,options={}) {
        const response = await fetch(url,{...options,headers:{'Content-Type':'application/json','X-CSRF-Token':access.csrf_token,...options.headers}});
        const data = await response.json();
        if(response.status===401){location.replace('/pages/access.html');throw new Error('Sign in to continue.');}
        if(!response.ok||!data.ok)throw new Error(data.message||'The request could not be completed.');
        return data;
    }
    function error(id,problem){$(id).textContent=problem.message;$(id).hidden=false;}
    function showLoading(value){$('crm-loading').hidden=!value;}
    function pageControls(kind,data){$(`crm-${kind}-count`).textContent=data.total?`${(data.page-1)*data.page_size+1}–${Math.min(data.page*data.page_size,data.total)} of ${data.total}`:'0 records';$(`crm-${kind}-prev`).disabled=data.page<=1;$(`crm-${kind}-next`).disabled=data.page*data.page_size>=data.total;}
    function services(select,values){const previous=select.value;select.innerHTML='<option value="">All services</option>'+values.map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join('');select.value=values.includes(previous)?previous:'';}
    async function loadClients(){
        const sequence=++clientSearchSequence;showLoading(true);$('crm-error').hidden=true;
        try{const data=await request('/api/crm/clients?'+new URLSearchParams({q:$('crm-client-search').value.trim(),page:clientsPage}));if(sequence!==clientSearchSequence)return;clientIdentities.remember(data.clients);
            $('crm-client-rows').innerHTML=data.clients.map(client=>`<tr><td data-label="Client">${clientLink(client.id,client.customer_name,'',client)}</td><td data-label="Contact">${esc(client.email||'No email')}<small class="d-block text-gray-500">${esc(client.phone||'No phone')}</small></td><td data-label="Bookings">${client.bookings}</td><td data-label="Last booking">${esc(date(client.last_booking))}</td><td data-label="Actions"><button class="btn btn-sm btn-action btn-icon action-view" type="button" data-client="${esc(client.id)}" aria-label="Profile &amp; history" title="Profile &amp; history"><svg class="ai ai-sm" aria-hidden="true"><use href="#i-users"/></svg></button></td></tr>`).join('');$('crm-clients-empty').hidden=data.total>0;pageControls('clients',data);
        }catch(problem){error('crm-error',problem);}finally{if(sequence===clientSearchSequence)showLoading(false);}
    }
    async function openClient(id=null){
        if(mutationBusy)return;const sequence=++clientOpenSequence;
        $('crm-client-error').hidden=true;$('crm-client-form').reset();currentClient=null;clientRequest=crypto.randomUUID();$('crm-client-history').hidden=true;$('crm-client-identity').innerHTML='';$('crm-client-avatar-controls').hidden=true;$('crm-client-title').textContent=id?'Client profile':'Add client';
        if(id){try{const data=await request('/api/crm/clients/'+encodeURIComponent(id));if(sequence!==clientOpenSequence)return;currentClient=data.client;clientIdentities.remember([data.client]);$('crm-client-identity').innerHTML=person(data.client.id,data.client.customer_name,data.client.email||data.client.phone);for(const [field,key]of[['crm-client-name','customer_name'],['crm-client-email','email'],['crm-client-phone','phone']])$(field).value=data.client[key]||'';
                $('crm-client-history').hidden=false;$('crm-client-bookings').innerHTML=data.bookings.map(booking=>`<tr><td data-label="Reference">${esc(booking.appointment_id)}${booking.is_test?'<small class="d-block text-gray-500">Test booking</small>':''}</td><td data-label="Service / time">${esc(booking.service)}<small class="d-block text-gray-500">${esc(date(booking.booking_start))}</small></td><td data-label="Booking status">${badge(booking.status)}</td><td data-label="Payment">${badge(booking.payment_status)}</td><td data-label="Actions"><button class="btn btn-sm btn-action btn-icon action-payment" type="button" data-client-payment="${esc(booking.appointment_id)}" aria-label="View payment" title="View payment"><svg class="ai ai-sm" aria-hidden="true"><use href="#i-wallet"/></svg></button></td></tr>`).join('');$('crm-client-history-empty').hidden=data.bookings.length>0;
                $('crm-client-payment-history').innerHTML=data.payments.map(payment=>`<tr><td data-label="Date">${esc(date(payment.received_at))}</td><td data-label="Booking">${esc(payment.appointment_id)}</td><td data-label="Type">${esc(label(payment.kind))}</td><td data-label="Method">${esc(label(payment.method))}</td><td data-label="Amount">${money(payment.amount_minor)}</td></tr>`).join('');$('crm-client-payments-empty').hidden=data.payments.length>0;
            }catch(problem){error('crm-error',problem);return;}}
        renderClientIdentity();clientModal.show();
    }
    function renderClientIdentity(){
        $('crm-client-avatar-controls').hidden=!currentClient;
        if(!currentClient)return;
        $('crm-client-identity').innerHTML=person(currentClient.id,currentClient.customer_name,currentClient.email||currentClient.phone,currentClient);
        $('crm-client-avatar-remove').disabled=!currentClient.has_avatar;
    }
    async function loadPayments(){
        const sequence=++paymentSearchSequence;showLoading(true);$('crm-error').hidden=true;
        try{const data=await request((paymentView==='history'?'/api/crm/payments?':'/api/crm/appointments?')+new URLSearchParams({q:$('crm-payment-search').value.trim(),service:$('crm-payment-service').value,include_test:true,page:paymentsPage}));if(sequence!==paymentSearchSequence)return;services($('crm-payment-service'),data.services);clientIdentities.remember(data.payments || data.appointments);
            if(paymentView==='history'){
                $('crm-transaction-rows').innerHTML=data.payments.map(payment=>`<tr><td data-label="Client / booking">${clientLink(payment.client_id,payment.customer_name,payment.appointment_id,payment)}</td><td data-label="Transaction date">${esc(date(payment.received_at))}<small class="d-block text-gray-500">Asia/Manila</small></td><td data-label="Service">${esc(payment.service)}</td><td data-label="Transaction"><strong>${esc(payment.kind==='paid'?'Full payment':label(payment.kind))}</strong><small class="d-block text-gray-500">${esc(label(payment.method))}${payment.is_test?' · Test booking':''}</small></td><td data-label="Amount" class="text-nowrap"><strong>${payment.kind==='refund'?'−':''}${money(payment.amount_minor)}</strong></td><td data-label="Receipt"><span title="${esc(payment.receipt_number)}">${esc(payment.receipt_number)}</span>${payment.receipt_reference?`<small class="d-block text-gray-500">${esc(payment.receipt_reference)}</small>`:''}</td><td data-label="Actions"><div class="d-flex gap-2"><button class="btn btn-sm btn-action btn-icon action-payment" type="button" data-payment="${esc(payment.appointment_id)}" aria-label="Payment details" title="Payment details"><svg class="ai ai-sm" aria-hidden="true"><use href="#i-wallet"/></svg></button><a class="btn btn-sm btn-action btn-icon action-print" href="/api/crm/payments/${encodeURIComponent(payment.id)}/receipt?print=1" target="_blank" rel="noopener" aria-label="Print receipt" title="Print receipt"><svg class="ai ai-sm" aria-hidden="true"><use href="#i-print"/></svg></a></div></td></tr>`).join('');
                clientIdentities.remember(data.payments);
                $('crm-transactions-empty').hidden=data.total>0;
            }else{
            $('crm-payment-rows').innerHTML=data.appointments.map(booking=>`<tr><td data-label="Client / booking">${clientLink(booking.client_id,booking.customer_name,booking.appointment_id,booking)}${booking.is_test?'<span class="small text-gray-500">Test booking</span>':''}</td><td data-label="Service / time">${esc(booking.service)}<small class="d-block text-gray-500">${esc(date(booking.booking_start))}</small>${badge(booking.status)}</td><td data-label="Price">${money(booking.price_minor)}</td><td data-label="Retained">${money(booking.net_minor)}</td><td data-label="Balance">${money(booking.balance_minor)}</td><td data-label="Payment">${badge(booking.payment_status)}</td><td data-label="Actions"><button class="btn btn-sm btn-action btn-icon action-payment" type="button" data-payment="${esc(booking.appointment_id)}" aria-label="Payment details" title="Payment details"><svg class="ai ai-sm" aria-hidden="true"><use href="#i-wallet"/></svg></button></td></tr>`).join('');$('crm-payments-empty').hidden=data.total>0;pageControls('payments',data);
            }
            pageControls('payments',data);
        }catch(problem){error('crm-error',problem);}finally{if(sequence===paymentSearchSequence)showLoading(false);}
    }
    function switchPaymentView(name){
        paymentView=name;paymentsPage=1;
        $('crm-transaction-history').hidden=name!=='history';$('crm-booking-balances').hidden=name!=='balances';
        document.querySelectorAll('[data-payment-view]').forEach(button=>{const selected=button.dataset.paymentView===name;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
        $('crm-payment-search-label').textContent=name==='history'?'Search transactions':'Find a booking';
        $('crm-payment-search').value='';$('crm-payment-service').value='';loadPayments();
    }
    async function saveAvatar(image){
        if(mutationBusy||!currentClient)return;
        mutationBusy=true;$('crm-client-avatar').disabled=true;$('crm-client-avatar-remove').disabled=true;$('crm-client-save').disabled=true;$('crm-client-error').hidden=true;
        try{
            const data=await request('/api/crm/clients/'+encodeURIComponent(currentClient.id)+'/avatar',{method:'PUT',body:JSON.stringify({image,version:currentClient.avatar_version||0})});
            Object.assign(currentClient,data.avatar);clientIdentities.remember([currentClient]);renderClientIdentity();
            document.dispatchEvent(new CustomEvent('appoint:clients-updated'));
            if(location.hash==='#clients')await loadClients();
            if(location.hash==='#payments')await loadPayments();
        }catch(problem){error('crm-client-error',problem);}
        finally{mutationBusy=false;$('crm-client-avatar').disabled=false;$('crm-client-save').disabled=false;$('crm-client-avatar-remove').disabled=!currentClient.has_avatar;$('crm-client-avatar').value='';}
    }
    $('crm-client-avatar').addEventListener('change',async event=>{
        const file=event.target.files[0];if(!file||mutationBusy)return;
        try{
            if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024)throw new Error('Choose a JPG, PNG, or WebP photo or logo up to 5 MB.');
            const image=await createImageBitmap(file);
            const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;
            const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,128,128);
            const scale=Math.min(128/image.width,128/image.height),width=image.width*scale,height=image.height*scale;
            context.drawImage(image,(128-width)/2,(128-height)/2,width,height);image.close();
            await saveAvatar(canvas.toDataURL('image/jpeg',0.85));
        }catch(problem){error('crm-client-error',problem);event.target.value='';}
    });
    $('crm-client-avatar-remove').addEventListener('click',()=>saveAvatar(''));
    document.querySelectorAll('[data-payment-view]').forEach(button=>button.addEventListener('click',()=>switchPaymentView(button.dataset.paymentView)));
    document.addEventListener('click',event=>{
        const link=event.target.closest('[data-client-profile]');if(!link)return;event.preventDefault();if(mutationBusy)return;
        const visible=document.querySelector('.modal.show');
        if(visible){visible.addEventListener('hidden.bs.modal',()=>openClient(link.dataset.clientProfile),{once:true});bootstrap.Modal.getOrCreateInstance(visible).hide();}
        else openClient(link.dataset.clientProfile);
    });
    function paymentKind(){
        if(!selectedPayment)return;const summary=selectedPayment.summary;const refund=$('crm-payment-kind').value==='refund';$('crm-refund-field').hidden=!refund;$('crm-refund-receipt').disabled=!refund;$('crm-refund-receipt').required=refund;
        $('crm-payment-review').classList.toggle('action-delete',refund);$('crm-payment-review').classList.toggle('action-payment',!refund);
        const available=refund?summary.payments.some(row=>row.refundable_minor>0):summary.price_minor!==null&&summary.balance_minor>0;
        $('crm-payment-review').disabled=!available;
        $('crm-payment-help').textContent=summary.price_minor===null?'Save the appointment price before adding a payment.':refund?'Select the original receipt. Only owners can record refunds.':summary.balance_minor===0?'This booking has no outstanding balance.':`Remaining balance: ${money(summary.balance_minor)}.`;
        if($('crm-payment-kind').value==='paid'&&summary.balance_minor>0)$('crm-payment-amount').value=(summary.balance_minor/100).toFixed(2);
        if(refund){const receipt=summary.payments.find(row=>row.id===$('crm-refund-receipt').value);if(receipt){$('crm-payment-amount').value=(receipt.refundable_minor/100).toFixed(2);$('crm-payment-amount').max=(receipt.refundable_minor/100).toFixed(2);}}
        else $('crm-payment-amount').max=summary.balance_minor>0?(summary.balance_minor/100).toFixed(2):'1000000000';
    }
    function renderPayment(){
        const {booking,summary}=selectedPayment;
        $('crm-payment-identity').innerHTML=clientLink(booking.client_id,booking.customer_name,`${booking.service} · ${booking.appointment_id}`,booking)+`<p class="small text-gray-500 mt-2">${esc(date(booking.booking_start))} · Asia/Manila ${booking.is_test?'· Test booking':''}</p>`;
        $('crm-payment-summary').innerHTML=[['Price',summary.price_minor],['Retained after refunds',summary.net_minor],['Balance due',summary.balance_minor]].map(([name,value])=>`<div class="col-md-4"><div class="crm-summary-box"><small>${name}</small><strong>${money(value)}</strong></div></div>`).join('')+`<div class="col-12">${badge(summary.payment_status)}</div>`;
        $('crm-booking-price').value=summary.price_minor===null?'':(summary.price_minor/100).toFixed(2);
        $('crm-payment-history').innerHTML=summary.payments.map(payment=>`<tr><td data-label="Date">${esc(date(payment.received_at))}</td><td data-label="Type / method">${esc(label(payment.kind))}<small class="d-block text-gray-500">${esc(label(payment.method))}</small></td><td data-label="Amount">${money(payment.amount_minor)}</td><td data-label="Reference">${esc(payment.receipt_reference||'—')}</td><td data-label="Note">${esc(payment.note||'—')}</td></tr>`).join('');$('crm-payment-history-empty').hidden=summary.payments.length>0;
        $('crm-refund-receipt').innerHTML=summary.payments.filter(payment=>payment.refundable_minor>0).map(payment=>`<option value="${esc(payment.id)}">${esc(label(payment.kind))} · ${money(payment.amount_minor)} · ${money(payment.refundable_minor)} refundable · ${esc(payment.receipt_reference||date(payment.received_at))}</option>`).join('');paymentKind();
    }
    document.addEventListener('appoint:receipt-refresh',event=>{
        if(selectedPayment?.booking.appointment_id===event.detail.booking.appointment_id)selectedPayment.summary=event.detail.summary;
    });
    async function openPayment(id){
        if(mutationBusy)return;const sequence=++paymentOpenSequence;
        $('crm-payment-error').hidden=true;
        try{const data=await request('/api/crm/appointments/'+encodeURIComponent(id));if(sequence!==paymentOpenSequence)return;selectedPayment=data;paymentRequest=null;$('crm-record-payment-form').reset();$('crm-payment-date').value=inputTime(Date.now());renderPayment();document.dispatchEvent(new CustomEvent('appoint:receipt-payment',{detail:selectedPayment}));paymentModal.show();}
        catch(problem){error('crm-error',problem);}
    }
    function review(change,title,description,note){
        pending=change;$('crm-confirm-title').textContent=title;$('crm-confirm-description').textContent=description;$('crm-confirm-note').textContent=note;$('crm-confirm-error').hidden=true;
        $('crm-confirm-submit').className='btn '+(change.payload.kind==='refund'?'btn-danger':'btn-success');
        $('crm-payment-modal').addEventListener('hidden.bs.modal',()=>confirmModal.show(),{once:true});paymentModal.hide();
    }
    function currentReportFilters(){return{from:$('crm-report-from').value,to:$('crm-report-to').value,service:$('crm-report-service').value,include_test:true};}
    function renderRevenue(){if(!report)return;const group=$('crm-revenue-group').value;const rows=report[group];$('crm-revenue-label').textContent={revenue_day:'Day',revenue_month:'Month',revenue_service:'Service'}[group];$('crm-revenue-rows').innerHTML=rows.map(row=>`<tr><td data-label="Period / service"><strong>${esc(row.label)}</strong></td><td data-label="Received" class="${row.received_minor?'report-money-received':'text-gray-500'}">${money(row.received_minor)}</td><td data-label="Refunded" class="${row.refunded_minor?'report-money-refunded':'text-gray-500'}">${money(row.refunded_minor)}</td><td data-label="Net receipts" class="${row.net_minor<0?'report-money-refunded':row.net_minor?'report-money-net':'text-gray-500'}"><strong>${money(row.net_minor)}</strong></td></tr>`).join('');$('crm-revenue-empty').hidden=rows.length>0;}
    async function loadReports(){
        if(!owner){error('crm-error',new Error('Only an owner can view reports.'));return;}
        const sequence=++reportSequence;showLoading(true);$('crm-error').hidden=true;$('crm-report-apply').disabled=true;
        try{const applied=currentReportFilters();const data=await request('/api/crm/reports?'+new URLSearchParams(applied));if(sequence!==reportSequence)return;report=data.report;reportFilters=applied;services($('crm-report-service'),data.services);const summary=report.summary;
            $('crm-report-stats').innerHTML=[['Bookings',summary.bookings,'info','calendar'],['Received',money(summary.received_minor),'success','wallet'],['Refunded',money(summary.refunded_minor),'danger','refund'],['Net receipts',money(summary.net_minor),summary.net_minor<0?'danger':'purple','chart']].map(([name,value,tone,icon])=>`<div class="col-sm-6 col-xl-3"><div class="card card-body shadow-sm crm-report-stat report-tone-${tone}"><span class="report-stat-icon" aria-hidden="true"><svg class="ai"><use href="#i-${icon}"/></svg></span><div class="report-stat-value"><small>${name}</small><strong>${esc(value)}</strong></div></div></div>`).join('');renderRevenue();
            const peakService=Math.max(1,...report.top_services.map(row=>row.bookings)),peakTime=Math.max(1,...report.busiest_times.map(row=>row.bookings));
            const countMarkup=(count,peak,color)=>`<div class="report-demand"><span class="report-count">${count}</span><div class="progress report-demand-bar" aria-hidden="true"><div class="progress-bar bg-${color}" style="width:${Math.round(count/peak*100)}%"></div></div></div>`;
            $('crm-top-service-rows').innerHTML=report.top_services.map(row=>`<tr><td data-label="Service"><strong>${esc(row.service)}</strong></td><td data-label="Bookings">${countMarkup(row.bookings,peakService,'info')}</td></tr>`).join('')||'<tr><td colspan="2">No matching bookings.</td></tr>';
            $('crm-busy-rows').innerHTML=report.busiest_times.map(row=>`<tr><td data-label="Time"><strong>${esc(row.label)}</strong></td><td data-label="Bookings">${countMarkup(row.bookings,peakTime,'warning')}</td></tr>`).join('')||'<tr><td colspan="2">No matching bookings.</td></tr>';$('crm-report-updated').textContent='Updated '+date(report.generated_at)+' · Asia/Manila';
        }catch(problem){error('crm-error',problem);}finally{if(sequence===reportSequence){showLoading(false);$('crm-report-apply').disabled=false;}}
    }
    async function download(button){
        if(!reportFilters){error('crm-error',new Error('Apply your report filters before downloading.'));return;}
        button.disabled=true;
        try{const dataset=button.dataset.dataset||$('crm-export-dataset').value;const format=button.dataset.format;const response=await fetch('/api/crm/export?'+new URLSearchParams({...reportFilters,dataset,format}));
            if(!response.ok){const data=await response.json();throw new Error(data.message||'The download could not be prepared.');}
            const url=URL.createObjectURL(await response.blob());const anchor=document.createElement('a');anchor.href=url;anchor.download=response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]||`appoint-${dataset}.${format}`;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
        }catch(problem){error('crm-error',problem);}finally{button.disabled=false;}
    }
    let searchTimer;
    function debounce(work){clearTimeout(searchTimer);searchTimer=setTimeout(work,300);}
    $('crm-client-search').addEventListener('input',()=>{clientsPage=1;debounce(loadClients);});$('crm-payment-search').addEventListener('input',()=>{paymentsPage=1;debounce(loadPayments);});
    $('crm-payment-service').addEventListener('change',()=>{paymentsPage=1;loadPayments();});
    for(const [kind,load]of[['clients',loadClients],['payments',loadPayments]])for(const [suffix,delta]of[['prev',-1],['next',1]])$(`crm-${kind}-${suffix}`).addEventListener('click',()=>{if(kind==='clients')clientsPage+=delta;else paymentsPage+=delta;load();});
    $('crm-add-client').addEventListener('click',()=>openClient());$('crm-client-rows').addEventListener('click',event=>{const button=event.target.closest('[data-client]');if(button)openClient(button.dataset.client);});
    $('crm-client-bookings').addEventListener('click',event=>{const button=event.target.closest('[data-client-payment]');if(!button)return;$('crm-client-modal').addEventListener('hidden.bs.modal',()=>openPayment(button.dataset.clientPayment),{once:true});clientModal.hide();});
    document.querySelector('[data-crm-view="payments"]').addEventListener('click',event=>{const button=event.target.closest('[data-payment]');if(button)openPayment(button.dataset.payment);});
    $('crm-client-form').addEventListener('submit',async event=>{event.preventDefault();if(mutationBusy)return;mutationBusy=true;$('crm-client-save').disabled=true;$('crm-client-error').hidden=true;try{const payload={customer_name:$('crm-client-name').value.trim(),email:$('crm-client-email').value.trim(),phone:$('crm-client-phone').value.trim(),request_id:clientRequest,version:currentClient?.version};const data=await request('/api/crm/clients'+(currentClient?'/'+currentClient.id:''),{method:currentClient?'PATCH':'POST',body:JSON.stringify(payload)});currentClient=data.client;$('crm-client-title').textContent='Client profile';clientIdentities.remember([data.client]);renderClientIdentity();document.dispatchEvent(new CustomEvent('appoint:clients-updated'));if(location.hash==='#clients')await loadClients();}catch(problem){error('crm-client-error',problem);}finally{mutationBusy=false;$('crm-client-save').disabled=false;}});
    $('crm-payment-kind').addEventListener('change',()=>{$('crm-payment-amount').value='';paymentKind();});
    $('crm-refund-receipt').addEventListener('change',paymentKind);
    $('crm-price-form').addEventListener('submit',event=>{event.preventDefault();if(mutationBusy||!selectedPayment)return;const payload={price:$('crm-booking-price').value,version:selectedPayment.summary.price_version,confirm:true};review({path:'/api/crm/appointments/'+selectedPayment.booking.appointment_id+'/price',method:'PUT',payload},'Review appointment price',`Save an appointment price of ${money(Math.round(Number(payload.price)*100))} for ${selectedPayment.booking.customer_name}?`,'This changes the balance due. Recorded receipts and refunds remain in the history.');});
    $('crm-record-payment-form').addEventListener('submit',event=>{event.preventDefault();if(mutationBusy||!selectedPayment)return;const payload={kind:$('crm-payment-kind').value,amount:$('crm-payment-amount').value,method:$('crm-payment-method').value,received_at:new Date($('crm-payment-date').value+'+08:00').toISOString(),receipt_reference:$('crm-receipt-reference').value.trim(),note:$('crm-payment-note').value.trim(),refund_of:$('crm-refund-receipt').value||null,confirm:true};const fingerprint=JSON.stringify(payload);if(!paymentRequest||paymentRequest.fingerprint!==fingerprint)paymentRequest={fingerprint,id:crypto.randomUUID()};payload.request_id=paymentRequest.id;review({path:'/api/crm/appointments/'+selectedPayment.booking.appointment_id+'/payments',method:'POST',payload},payload.kind==='refund'?'Review refund record':'Review payment record',`Record ${money(Math.round(Number(payload.amount)*100))} as ${label(payload.kind).toLowerCase()} by ${label(payload.method).toLowerCase()} for ${selectedPayment.booking.customer_name}?`,payload.kind==='refund'?'Confirm only after this refund has already been issued. The app will record it against the selected receipt.':'Confirm only after this money has already been received. No money is charged by this form.');});
    $('crm-confirm-form').addEventListener('submit',async event=>{event.preventDefault();if(mutationBusy||!pending)return;mutationBusy=true;$('crm-confirm-submit').disabled=true;try{const data=await request(pending.path,{method:pending.method,body:JSON.stringify(pending.payload)});selectedPayment.summary=data.summary;paymentRequest=null;$('crm-record-payment-form').reset();$('crm-payment-date').value=inputTime(Date.now());renderPayment();mutationBusy=false;confirmModal.hide();if(location.hash==='#payments')loadPayments();}catch(problem){error('crm-confirm-error',problem);}finally{mutationBusy=false;$('crm-confirm-submit').disabled=false;}});
    for(const id of['crm-client-modal','crm-payment-modal','crm-confirm-modal'])$(id).addEventListener('hide.bs.modal',event=>{if(mutationBusy)event.preventDefault();});
    $('crm-confirm-modal').addEventListener('hidden.bs.modal',()=>{pending=null;paymentModal.show();});
    $('crm-report-filter').addEventListener('submit',event=>{event.preventDefault();loadReports();});$('crm-revenue-group').addEventListener('change',renderRevenue);document.querySelectorAll('.crm-export').forEach(button=>button.addEventListener('click',()=>download(button)));
    document.addEventListener('appoint:payment',event=>openPayment(event.detail.appointment_id));
    function view(name){if(name==='reports'&&!owner){location.hash='#clients';return;}if(name==='clients')loadClients();else if(name==='payments')loadPayments();else if(name==='reports')loadReports();}
    document.addEventListener('appoint:view',event=>view(event.detail.name));
    const today=inputTime(Date.now()).slice(0,10);$('crm-report-from').value=today.slice(0,8)+'01';$('crm-report-to').value=today;
    view(location.hash.slice(1));
})();
