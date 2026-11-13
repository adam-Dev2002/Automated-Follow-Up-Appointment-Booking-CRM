const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const { browserOptions } = require('./test-server.cjs');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'src/assets/docs');
const esc = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(text) {
    return esc(text).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function markdown(source) {
    const html = [];
    let list = '';
    const close = () => { if (list) html.push(`</${list}>`); list = ''; };
    for (const line of source.split(/\r?\n/)) {
        if (!line.trim()) { close(); continue; }
        if (line === '<!-- pagebreak -->') { close(); html.push('<div class="pagebreak"></div>'); continue; }
        const heading = line.match(/^(#{1,3}) (.+)$/);
        if (heading) { close(); html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
        const item = line.match(/^(?:([-]) |(\d+)\. )(.+)$/);
        if (item) {
            const kind = item[1] ? 'ul' : 'ol';
            if (list !== kind) { close(); list = kind; html.push(`<${kind}${kind === 'ol' && item[2] !== '1' ? ` start="${item[2]}"` : ''}>`); }
            html.push(`<li>${inline(item[3])}</li>`); continue;
        }
        close(); html.push(`<p>${inline(line)}</p>`);
    }
    close(); return html.join('\n');
}
(async () => {
    fs.mkdirSync(folder, { recursive: true });
    const guide = fs.readFileSync(path.join(root, 'USER-GUIDE.md'), 'utf8');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Appoint user guide</title><style>
    @page{size:A4;margin:17mm 17mm 19mm}*{box-sizing:border-box}body{font:10pt/1.55 Arial,Helvetica,sans-serif;color:#374151;margin:0}h1{font-size:25pt;color:#5f419c;line-height:1.2;margin:0 0 6mm;border-left:5px solid #d4c1ef;padding-left:5mm}h2{font-size:14pt;color:#5f419c;margin:7mm 0 3mm;break-after:avoid}h3{font-size:12pt;color:#374151}p{margin:0 0 3mm}h1+p{color:#806f99;background:#f4effc;border-radius:5px;padding:3mm;margin-bottom:5mm}li{margin-bottom:2.5mm;padding-left:1mm}ol,ul{padding-left:6mm;margin:0 0 4mm}strong{color:#34334f}a{color:#7053c1;text-decoration:none;overflow-wrap:anywhere}.pagebreak{break-before:page}h2:first-child{margin-top:0}li,p{orphans:2;widows:2}ul li::marker{color:#a885d6}ol li::marker{color:#7053c1;font-weight:bold}@media screen{body{max-width:800px;margin:40px auto;padding:30px;background:white}html{background:#f3f1f8}.pagebreak{height:30px;border-top:1px solid #ddd;margin-top:30px}}
    </style></head><body>${markdown(guide)}</body></html>`;
    const htmlPath = path.join(folder, 'appointment-guide.html');
    fs.writeFileSync(htmlPath, html);
    const browser = await chromium.launch(browserOptions());
    try {
        const page = await browser.newPage();
        await page.goto(pathToFileURL(htmlPath).href);
        await page.pdf({ path: path.join(folder, 'appointment-guide.pdf'), format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font:8px Arial;width:100%;padding:0 17mm;color:#9ca3af;display:flex;justify-content:space-between"><span>APPOINT · OWNER &amp; CUSTOMER GUIDE · ASIA/MANILA</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>' });
        console.log('PDF guide created:', path.join(folder, 'appointment-guide.pdf'));
    } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
