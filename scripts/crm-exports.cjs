const ExcelJS = require('exceljs');
const { fail } = require('./security-store.cjs');
const localDate = value => value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : '';
const definitions = {
    appointments: { title: 'Appointments', source: 'bookings', columns: [['appointment_id','Reference'],['customer_name','Client'],['email','Email'],['phone','Phone'],['service','Service'],['booking_start','Start (Asia/Manila)','date'],['booking_end','End (Asia/Manila)','date'],['status','Booking status'],['price_minor','Price (PHP)','money'],['net_minor','Retained (PHP)','money'],['balance_minor','Balance (PHP)','money'],['payment_status','Payment status'],['is_test','Test booking','boolean']] },
    clients: { title: 'Clients', source: 'clients', columns: [['id','Client ID'],['customer_name','Name'],['email','Email'],['phone','Phone'],['bookings','Lifetime bookings','number'],['last_booking','Last booking (Asia/Manila)','date'],['source','Source']] },
    payments: { title: 'Payments', source: 'payments', columns: [['id','Receipt ID'],['appointment_id','Booking reference'],['customer_name','Client'],['service','Service'],['kind','Payment type'],['amount_minor','Amount (PHP)','money'],['method','Method'],['receipt_reference','External receipt reference'],['refund_of','Refund of receipt'],['received_at','Payment date (Asia/Manila)','date'],['note','Note'],['is_test','Test booking','boolean']] },
    revenue_day: { title: 'Revenue by day', source: 'revenue_day', columns: [['label','Day'],['received_minor','Received (PHP)','money'],['refunded_minor','Refunded (PHP)','money'],['net_minor','Net receipts (PHP)','money']] },
    revenue_month: { title: 'Revenue by month', source: 'revenue_month', columns: [['label','Month'],['received_minor','Received (PHP)','money'],['refunded_minor','Refunded (PHP)','money'],['net_minor','Net receipts (PHP)','money']] },
    revenue_service: { title: 'Revenue by service', source: 'revenue_service', columns: [['label','Service'],['received_minor','Received (PHP)','money'],['refunded_minor','Refunded (PHP)','money'],['net_minor','Net receipts (PHP)','money']] },
    top_services: { title: 'Top services', source: 'top_services', columns: [['service','Service'],['bookings','Bookings excluding cancellations','number']] },
    busiest_times: { title: 'Busiest times', source: 'busiest_times', columns: [['label','Scheduled start (Asia/Manila)'],['bookings','Bookings excluding cancellations','number']] }
};
function cellValue(row, [key, , type]) {
    const value = row[key];
    if (value === null || value === undefined) return null;
    if (type === 'money') return value / 100;
    if (type === 'date') return localDate(value);
    if (type === 'boolean') return value ? 'Yes' : 'No';
    if (['status','payment_status','kind','method','source'].includes(key)) return ({confirmed:'Confirmed',cancelled:'Cancelled',pending:'Pending',rescheduled:'Rescheduled',completed:'Completed',no_show:'No-show',unpriced:'Price not set',unpaid:'Unpaid',paid:'Paid',partial:'Partial',deposit:'Deposit',refunded:'Refunded',refund:'Refund',cash:'Cash',card:'Card',bank_transfer:'Bank transfer',other:'Other',manual:'Manual',booking:'Booking'})[value] || value;
    return value;
}
function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (typeof value === 'string' && /^[\s\uFEFF]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}
async function exportReport(report, dataset, format) {
    if (!['csv','xlsx'].includes(format) || (dataset !== 'full_report' && !definitions[dataset]) || (dataset === 'full_report' && format !== 'xlsx')) throw fail(400, 'Choose a supported export table and file format.');
    const datasets = dataset === 'full_report' ? Object.keys(definitions) : [dataset];
    let totalRows = 0;
    for (const key of datasets) { const count = report[definitions[key].source].length; if (count > 50000) throw fail(422, 'This export has too many rows. Use a smaller date range.'); totalRows += count; }
    if (format === 'csv') {
        const definition = definitions[dataset];
        const records = [definition.columns.map(column => column[1]), ...report[definition.source].map(row => definition.columns.map(column => cellValue(row,column)))];
        return { buffer: Buffer.from('\uFEFF' + records.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n','utf8'), contentType: 'text/csv; charset=utf-8', rows: totalRows };
    }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Appoint'; workbook.created = new Date(report.generated_at);
    for (const key of datasets) {
        const definition = definitions[key];
        const sheet = workbook.addWorksheet(definition.title, { views: [{ state: 'frozen', ySplit: 1 }] });
        sheet.columns = definition.columns.map(([,header,type]) => ({ header, width: type === 'money' ? 19 : type === 'date' ? 27 : Math.max(18,Math.min(32,header.length+5)) }));
        for (const row of report[definition.source]) sheet.addRow(definition.columns.map(column => cellValue(row,column)));
        sheet.getRow(1).font = { bold: true, color: { argb:'FFFFFFFF' } };
        sheet.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF7053C1'} };
        sheet.getRow(1).height = 32; sheet.getRow(1).alignment = { vertical:'middle', wrapText:true };
        sheet.autoFilter = { from:{row:1,column:1},to:{row:sheet.rowCount,column:definition.columns.length} };
        definition.columns.forEach((column,index) => { if (column[2] === 'money') sheet.getColumn(index+1).numFmt = '#,##0.00;[Red]-#,##0.00'; });
    }
    const info = workbook.addWorksheet('Report info');
    info.columns = [{ header:'Setting',width:30 },{ header:'Value',width:70 }];
    info.addRows([['Generated (Asia/Manila)',localDate(report.generated_at)],['Currency',report.currency],['Time zone',report.timezone],['From',report.filters.from || 'All dates'],['To',report.filters.to || 'All dates'],['Service',report.filters.service || 'All services'],['Booking status',report.filters.status || 'All statuses'],['Search',report.filters.q || 'None'],['Booking scope',report.filters.include_test ? 'All bookings':'Non-test bookings'],['Revenue basis','Receipts minus refunds, grouped by payment date. Amounts are payment records, not online charges.'],['Appointment date basis','Appointments are filtered by their start date.'],['Busiest times basis','Scheduled bookings excluding cancellations.'],['Client export basis','All matching contacts, including clients without bookings. Date, service, and booking-status filters do not remove contacts. Clients with only test bookings are excluded unless test data is included.'],['Client booking counts','Lifetime booking counts.']]);
    info.getRow(1).font = { bold:true }; info.getColumn(2).alignment = { wrapText:true };
    return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', rows:totalRows };
}
module.exports = { exportReport, csvCell, definitions };
