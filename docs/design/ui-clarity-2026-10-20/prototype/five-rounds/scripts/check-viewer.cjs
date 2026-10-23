#!/usr/bin/env node
// Local review-gallery checks only. This does not score or modify a candidate.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { executablePath } = require('./browser-session.cjs');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://mote-review.invalid';
const PLATFORMS = ['web', 'mac', 'android'];
const SCENES = { first: ['library', 'empty'], library: ['library', 'populated'], import: ['import', 'empty'], sources: ['sources', 'populated'], ask: ['ask', 'populated'], todos: ['todos/schedule', 'populated'], settings: ['settings', 'populated'] };
const FONT_STYLE = '<style data-viewer-test-font>@font-face{font-family:MoteReviewCJK;src:url("/__delivery-font__/noto.otf")}body{font-family:MoteReviewCJK,sans-serif!important}button,input,select,textarea{font-family:inherit!important}</style>';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.cjs': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

function args(argv) {
  const result = { output: path.join(ROOT, 'work/delivery-viewer'), expected: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output') result.output = path.resolve(ROOT, argv[++i]);
    else if (argv[i] === '--expect-rounds') result.expected = argv[++i].split(',').map(Number);
    else if (argv[i] === '--help') { console.log('node scripts/check-viewer.cjs [--expect-rounds 30,31,32,33,34] [--output work/delivery-viewer]'); process.exit(0); }
    else throw new Error('Unknown argument: ' + argv[i]);
  }
  assert.equal(path.dirname(result.output), path.join(ROOT, 'work'), 'Output must be a direct work/delivery-* directory');
  assert.ok(path.basename(result.output).startsWith('delivery-'), 'Output must stay within the owned delivery staging scope');
  return result;
}

async function viewportDOM(surface) {
  return surface.evaluate(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.closest('[hidden],[inert]') || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS' && !parent.open) {
          const summary = [...parent.children].find(child => child.tagName === 'SUMMARY');
          if (!summary?.contains(el)) return false;
        }
      }
      return true;
    };
    const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
    return {
      url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth,
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).map(el => ({ tag: el.tagName, text: el.innerText, rect: rect(el) })),
      controls: [...document.querySelectorAll('button,a[href],input,select,textarea,summary')].filter(visible).map(el => ({ tag: el.tagName, text: el.innerText?.trim(), label: el.getAttribute('aria-label') || [...(el.labels || [])].map(label => label.innerText).join(' '), action: el.dataset.action, page: el.dataset.page, href: el.getAttribute('href'), value: ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ? el.type === 'password' ? '[redacted]' : el.value : undefined, rect: rect(el) })),
      activeElement: document.activeElement ? { tag: document.activeElement.tagName, id: document.activeElement.id, action: document.activeElement.dataset?.action } : null,
      skipLink: document.querySelector('.skip-link') ? rect(document.querySelector('.skip-link')) : null,
      scope: 'Viewport-visible rendered DOM only; captured before the viewport screenshot. No application state or localStorage inspection.'
    };
  });
}

async function main() {
  const options = args(process.argv.slice(2));
  await fs.mkdir(options.output, { recursive: true });
  const font = await fs.readFile(path.join(ROOT, 'work/runtime/noto-sc.otf'));
  const input = await fs.readFile(path.join(ROOT, 'index.html'));
  const checks = [], network = { blocked: [], missing: [], served: 0 }, pageErrors = [];
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, colorScheme: 'light', serviceWorkers: 'block' });
  context.on('page', page => page.on('pageerror', error => pageErrors.push({ url: page.url(), message: error.message })));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN || request.method() !== 'GET') { network.blocked.push({ url: url.href, method: request.method() }); return route.abort('blockedbyclient'); }
    if (url.pathname === '/__delivery-font__/noto.otf') return route.fulfill({ contentType: 'font/otf', body: font });
    try {
      const file = path.resolve(ROOT, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      assert.ok(file.startsWith(ROOT + path.sep), 'Outside review root');
      const real = await fs.realpath(file); assert.ok(real.startsWith(ROOT + path.sep), 'Symlink leaves review root');
      const contentType = MIME[path.extname(file)]; assert.ok(contentType, 'Unsupported local file type');
      let body = await fs.readFile(real);
      if (path.extname(file) === '.html') body = Buffer.from(body.toString('utf8').replace('</head>', FONT_STYLE + '</head>'));
      network.served++;
      return route.fulfill({ contentType, body });
    } catch (error) { network.missing.push({ path: url.pathname, reason: error.message }); return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Local review file unavailable' }); }
  });
  const page = await context.newPage();
  async function framesFor(round, scene, platforms = PLATFORMS) {
    await page.waitForFunction(count => document.querySelectorAll('#screens iframe').length === count, platforms.length);
    const frames = [];
    for (const platform of platforms) {
      const handle = await page.locator('.screen[data-platform="' + platform + '"] iframe').elementHandle();
      const frame = await handle.contentFrame(); await handle.dispose();
      assert.ok(frame, platform + ' iframe exists');
      await frame.waitForFunction(() => document.querySelector('main')?.innerText.trim().length > 0);
      await frame.evaluate(() => document.fonts.ready);
      const url = new URL(frame.url()), expected = SCENES[scene];
      assert.equal(url.pathname, '/rounds/r' + round + '/' + platform + '.html');
      assert.equal(url.hash, '#/' + expected[0]); assert.equal(url.searchParams.get('state'), expected[1]);
      assert.ok((await frame.locator('body').innerText()).includes('R' + round), 'Visible candidate revision matches the selector');
      const viewport = await frame.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      assert.deepEqual(viewport, platform === 'android' ? { w: 390, h: 844 } : { w: 1440, h: 1000 });
      frames.push({ platform, frame });
    }
    return frames;
  }
  async function capture(name, frames) {
    const dom = { gallery: await viewportDOM(page), frames: await Promise.all(frames.map(async ({ platform, frame }) => ({ platform, ...await viewportDOM(frame) }))) };
    await fs.writeFile(path.join(options.output, name + '.json'), JSON.stringify(dom, null, 2) + '\n');
    await page.screenshot({ path: path.join(options.output, name + '.png'), fullPage: false });
  }
  async function clickNavigation(frame, destination) {
    const targets = frame.locator('[data-action="go"][data-page="' + destination + '"]');
    for (let i = 0; i < await targets.count(); i++) {
      const target = targets.nth(i);
      const inViewport = await target.evaluate(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && getComputedStyle(el).visibility !== 'hidden'; });
      if (inViewport) { await target.click(); await frame.waitForFunction(hash => location.hash === hash, '#/' + destination); return; }
    }
    throw new Error('No visible navigation to ' + destination);
  }
  try {
    await page.goto(ORIGIN + '/index.html'); await page.evaluate(() => document.fonts.ready);
    const rounds = (await page.locator('#round option').evaluateAll(items => items.map(item => Number(item.value))));
    assert.ok(rounds.length > 0, 'Gallery has frozen rounds');
    if (options.expected) assert.deepEqual(rounds, options.expected);
    for (const round of rounds) {
      await page.locator('#round').selectOption(String(round));
      const frames = await framesFor(round, 'first');
      assert.ok((await page.locator('#summary-title').innerText()).startsWith('R' + round + ' ·'));
      assert.equal(await page.locator('#report').getAttribute('href'), 'rounds/r' + round + '/reports/independent-evaluation.md');
      await capture('round-' + round + '-first', frames);
      checks.push({ check: 'Version R' + round + ' loads its three frozen candidates and matching summary/report link', result: 'passed' });
    }
    const latest = rounds.at(-1);
    for (const scene of Object.keys(SCENES)) {
      await page.locator('#scene').selectOption(scene);
      const frames = await framesFor(latest, scene);
      await capture('scene-' + scene, frames);
      checks.push({ check: 'Scene ' + scene + ' loads the expected route and data mode on all three platforms', result: 'passed' });
    }
    await page.locator('#scene').selectOption('library');
    for (const { platform, frame } of await framesFor(latest, 'library')) {
      // The Android card extends below a desktop gallery viewport. Scroll the
      // parent card into view before using its fixed bottom navigation.
      await page.locator('.screen[data-platform="' + platform + '"]').scrollIntoViewIfNeeded();
      await clickNavigation(frame, 'sources'); assert.ok((await frame.locator('main').innerText()).trim());
      await clickNavigation(frame, 'library');
      checks.push({ check: platform + ' iframe supports ordinary Sources → Library navigation', result: 'passed' });
    }
    for (const view of [...PLATFORMS, 'all']) {
      await page.locator('[data-view="' + view + '"]').click();
      const platforms = view === 'all' ? PLATFORMS : [view], frames = await framesFor(latest, 'library', platforms);
      assert.equal(await page.locator('[data-view="' + view + '"]').getAttribute('aria-pressed'), 'true');
      await capture('view-' + view, frames);
      if (view !== 'all') {
        const newPage = context.waitForEvent('page'); await page.locator('.screen-head a').click(); const standalone = await newPage;
        await standalone.waitForLoadState('domcontentloaded'); await standalone.waitForSelector('main');
        assert.equal(new URL(standalone.url()).pathname, '/rounds/r' + latest + '/' + view + '.html'); await standalone.close();
      }
      checks.push({ check: 'Platform switch ' + view + ' has matching iframe(s), selection state and standalone link', result: 'passed' });
    }
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('[data-view="android"]').click();
    const narrowFrames = await framesFor(latest, 'library', ['android']);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow gallery has no horizontal overflow');
    await capture('gallery-narrow-android', narrowFrames);
    checks.push({ check: '390-pixel gallery remains within the viewport', result: 'passed' });
    assert.deepEqual(pageErrors, [], 'Gallery and frame scripts have no page errors');
    assert.deepEqual(network.missing, [], 'All requested local review assets exist');
    const result = { scope: 'Delivery viewer checks only, not independent scoring; isolated browser route, network blocked, fixed font injected in memory; DOM before viewport-only screenshots', rounds, indexSha256: crypto.createHash('sha256').update(input).digest('hex'), checks, pageErrors, network };
    await fs.writeFile(path.join(options.output, 'observations.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ passed: checks.length, rounds, evidence: options.output, networkBlocked: network.blocked.length }));
  } catch (error) {
    await fs.writeFile(path.join(options.output, 'failure.json'), JSON.stringify({ failure: error.stack, checks, pageErrors, network, gallery: await viewportDOM(page).catch(() => null) }, null, 2) + '\n');
    await page.screenshot({ path: path.join(options.output, 'failure.png'), fullPage: false }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });

