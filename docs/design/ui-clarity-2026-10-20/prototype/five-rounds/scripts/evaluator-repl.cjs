const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { openCandidate, observe } = require('./browser-session.cjs');
const { saveEvidence } = require('./evaluator-evidence.cjs');
let session;
let evidenceDirectory;
let actions = [];
function locate(page, spec) {
  if (spec.role) return page.getByRole(spec.role, { name: spec.name, exact: spec.exact !== false });
  if (spec.label) return page.getByLabel(spec.label, { exact: spec.exact !== false });
  if (spec.text) return page.getByText(spec.text, { exact: spec.exact !== false });
  if (spec.placeholder) return page.getByPlaceholder(spec.placeholder, { exact: spec.exact !== false });
  if (spec.selector) return page.locator(spec.selector);
  throw new Error('Use a visible control from the observed DOM.');
}
async function run(cmd) {
  const { op } = cmd;
  if (op === 'open') {
    if (session) await session.browser.close();
    session = await openCandidate(cmd.file, { viewport: cmd.viewport, url: cmd.url, colorScheme: cmd.colorScheme });
    session.page.setDefaultTimeout(5000);
    evidenceDirectory = cmd.evidenceDirectory;
    actions = [];
  } else if (op === 'close') {
    if (session) await session.browser.close();
    session = null;
    return { closed: true };
  } else {
    if (!session) throw new Error('Open a candidate first.');
    const page = session.page;
    if (op === 'click') await locate(page, cmd).nth(cmd.index || 0).click();
    else if (op === 'fill') await locate(page, cmd).nth(cmd.index || 0).fill(cmd.value);
    else if (op === 'check') await locate(page, cmd).nth(cmd.index || 0).setChecked(cmd.checked);
    else if (op === 'select') await locate(page, cmd).nth(cmd.index || 0).selectOption(cmd.value);
    else if (op === 'press') await locate(page, cmd).nth(cmd.index || 0).press(cmd.key);
    else if (op === 'key') await page.keyboard.press(cmd.key);
    else if (op === 'scroll') await page.mouse.wheel(cmd.dx || 0, cmd.dy || 600);
    else if (op === 'hover') await locate(page, cmd).nth(cmd.index || 0).hover();
    else if (op === 'waitForText') await locate(page, cmd).first().waitFor({state:'visible'});
    else if (op === 'reload') await page.reload();
    else if (op === 'back') await page.goBack();
    else if (op === 'resize') await page.setViewportSize(cmd.viewport);
    else if (op === 'observe' || op === 'save') {}
    else throw new Error('Unknown operation: ' + op);
  }
  actions.push({ at: new Date().toISOString(), ...cmd });
  const snapshot = cmd.save ? await saveEvidence(session.page, evidenceDirectory, cmd.save) : await observe(session.page);
  if (evidenceDirectory) {
    await fs.mkdir(evidenceDirectory, { recursive: true });
    await fs.writeFile(path.join(evidenceDirectory, 'actions.json'), JSON.stringify(actions, null, 2) + '\n');
  }
  return { ...snapshot, browserErrors: session.errors };
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
rl.on('line', line => {
  queue = queue.then(async () => {
    try { console.log(JSON.stringify({ ok: true, result: await run(JSON.parse(line)) })); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }
  });
});
rl.on('close', () => queue.then(async () => { if (session) await session.browser.close(); }));
console.log(JSON.stringify({ ready: true, interaction_scope: 'Rendered DOM and ordinary user actions only' }));
