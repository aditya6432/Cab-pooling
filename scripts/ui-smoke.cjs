// Optional UI smoke test: logs in as the demo student, opens every page, fails on any
// console error, page error, failed API call or horizontal overflow, and saves screenshots.
//   npm i -g playwright && npx playwright install chromium
//   node scripts/ui-smoke.cjs http://localhost:4000 docs/screenshots [light|dark] [width]
const path = require('path');
let pw; try { pw = require('playwright'); } catch { pw = require(path.join(process.env.npm_config_prefix || '', 'lib/node_modules/playwright')); }
const [,, base = 'http://localhost:4000', out = 'docs/screenshots', mode = 'light', width = '1440'] = process.argv;
const ROUTES = ['/home', '/search', '/create', '/rides', '/expenses', '/money', '/money/payments', '/money/statement', '/rate',
  '/profile/2023A7PS0001H', '/leaderboard', '/dashboard', '/insights/rides', '/money/dashboard', '/lab', '/sql', '/database'];
(async () => {
  const opts = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  const browser = await pw.chromium.launch(opts);
  const page = await (await browser.newContext({ viewport: { width: Number(width), height: 900 }, colorScheme: mode })).newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && problems.push(`HTTP ${r.status()} ${r.url()}`));
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Fill in the demo login' }).click();
  await page.getByRole('button', { name: 'Log in', exact: true }).last().click();
  await page.waitForURL('**/home');
  for (const r of ROUTES) {
    await page.goto(base + r, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 2) problems.push(`horizontal overflow of ${overflow}px on ${r}`);
    await page.screenshot({ path: path.join(out, `${mode}-${width}${r.replace(/\//g, '_')}.png`), fullPage: true });
  }
  await browser.close();
  console.log(problems.length ? `✗ ${problems.length} problem(s)\n${problems.join('\n')}` : `✓ ${ROUTES.length} pages, no errors (${mode}, ${width}px)`);
  process.exitCode = problems.length ? 1 : 0;
})();
