const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const executablePath = '/tmp/mote-ui-chrome/chrome-headless-shell-linux64/chrome-headless-shell';
const fontPath = '/tmp/mote-ui-noto-sc.otf';

async function openCandidate(file, options = {}) {
  const html = await fs.readFile(file, 'utf8');
  const font = await fs.readFile(fontPath);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 1000 }, colorScheme: options.colorScheme || 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://mote-prototype.invalid') return route.abort();
    if (url.pathname === '/fonts/noto.otf') return route.fulfill({ contentType: 'font/otf', body: font });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    return route.abort();
  });
  await page.goto(options.url || 'https://mote-prototype.invalid/?reset=1#/library');
  await page.addStyleTag({content: '@font-face{font-family:MoteEvaluationCJK;src:url("https://mote-prototype.invalid/fonts/noto.otf")}body{font-family:MoteEvaluationCJK,sans-serif!important}button,input,select,textarea{font-family:inherit!important}'});
  await page.evaluate(() => document.fonts.ready);
  return { browser, context, page, errors };
}

async function observe(page) {
  return page.evaluate(() => {
    const visible = el => {
      if(!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden],[inert]')))return false;
      for(let parent=el.parentElement;parent;parent=parent.parentElement){
        if(parent.tagName==='DETAILS'&&!parent.open){const summary=[...parent.children].find(x=>x.tagName==='SUMMARY');if(!summary?.contains(el))return false;}
      }
      return true;
    };
    const controls = [...document.querySelectorAll('button,a[href],input,textarea,select,summary')].filter(visible).map(el => ({
      tag: el.tagName.toLowerCase(), id: el.id || undefined, type: el.type || undefined,
      text: el.innerText?.trim(), label: el.getAttribute('aria-label') || [...(el.labels || [])].map(x => x.innerText).join(' ') || el.innerText?.trim(),
      value: ['INPUT','TEXTAREA','SELECT'].includes(el.tagName) ? (el.type === 'password' ? '[redacted]' : el.value) : undefined,
      checked: ['checkbox','radio'].includes(el.type) ? el.checked : undefined,
      action: el.dataset.action, page: el.dataset.page, item: el.dataset.id,
      disabled: el.disabled, expanded: el.tagName === 'SUMMARY' ? el.parentElement.open : undefined
    }));
    return { url: location.href, title: document.title, text: document.body.innerText, controls,
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).map(el=>({level:el.tagName,text:el.innerText})),
      viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth,
      scope: 'Rendered DOM and visible controls only; no internal application state' };
  });
}

async function saveEvidence(page, directory, name) {
  await fs.mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name + '.png'), fullPage: true });
  const dom = await observe(page);
  await fs.writeFile(path.join(directory, name + '.json'), JSON.stringify(dom, null, 2) + '\n');
  return dom;
}

module.exports = { openCandidate, observe, saveEvidence, executablePath };

if (require.main === module) {
  (async()=>{
    const session = await openCandidate(process.argv[2]);
    try { console.log(JSON.stringify({browser:session.browser.version(), title:await session.page.title(), errors:session.errors})); }
    finally { await session.browser.close(); }
  })().catch(e=>{console.error(e.message);process.exitCode=1;});
}
