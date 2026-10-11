// node print_pdf.cjs page.html out.pdf   (Playwright + Chromium; set PLAYWRIGHT_MODULE / CHROMIUM_PATH if needed)
const path = require('path');
let pw;
try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch { pw = require('/home/claude/.npm-global/lib/node_modules/playwright'); }
(async () => {
  const [html, out] = process.argv.slice(2);
  const opts = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  else if (require('fs').existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')) opts.executablePath = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await pw.chromium.launch(opts);
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(html), { waitUntil: 'networkidle' });
  await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:7px;color:#888;width:100%;text-align:center;font-family:DejaVu Sans,sans-serif">PoolUp · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>' });
  await browser.close();
})();
