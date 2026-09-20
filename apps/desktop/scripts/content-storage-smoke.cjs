require('../../../scripts/fixture-language.cjs');
const { app, safeStorage } = require('electron');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { readFile, readdir, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { defaultConfig } = require('../dist/config');
const { isEncryptedContent } = require('../dist/local-content');

// Dedicated generated profile; mock the OS secret adapter, never read screen/user content.
const profile = mkdtempSync(join(tmpdir(), 'mote-content-ui-'));
app.setPath('userData', profile);
process.env.MOTE_PROFILE = 'legacy'; delete process.env.MOTE_URL; delete process.env.MOTE_TOKEN; delete process.env.MOTE_ENV_FILE;
safeStorage.isEncryptionAvailable = () => true;
safeStorage.encryptString = value => Buffer.from(value).map(byte => byte ^ 91);
safeStorage.decryptString = value => Buffer.from(value).map(byte => byte ^ 91).toString();
writeFileSync(join(profile, 'config.json'), JSON.stringify({ version: 1, config: { ...defaultConfig(), serverUrl: '', syncMode: 'manual', metadataEnabled: false, deviceName: 'Generated content fixture' } }));
const timeout = setTimeout(() => { process.stderr.write('Content storage UI timeout\n'); app.exit(1); }, 45000);
let finished = false;
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      const js = code => window.webContents.executeJavaScript(code);
      await js("window.confirm=()=>true;true;");
      const wait = async (label, predicate) => {
        const end = Date.now() + 15000;
        while (!await predicate()) { assert(Date.now() < end, label); await new Promise(resolve => setTimeout(resolve, 30)); }
      };
      await wait('renderer settings', () => js('Boolean(document.querySelector("#device-name").value)'));
      assert.equal((await js('window.mote.status()')).config.localContentEncryption, false);
      assert.equal(await js('Boolean(document.querySelector("#local-content-encryption"))'),false);
      assert.equal(await js('Boolean(document.querySelector("#content-decrypt"))'),false);
      assert.equal(await js('typeof window.mote.decryptLocalContent'), 'undefined');
      const note=await js(`window.mote.noteDraft().then(draft=>window.mote.saveNote({...draft,text:'Generated plaintext note',revision:draft.revision+1}))`);
      const eventPath=join(profile,'queue','events',note.id+'.json');
      assert(!isEncryptedContent(await readFile(eventPath)));
      assert(!isEncryptedContent(await readFile(join(profile,'notes','draft.json'))));
      process.stdout.write(JSON.stringify({ok:true,generatedFixtureOnly:true,plaintextWrites:true,encryptionControlsRemoved:true,capturedPersonalScreen:false})+'\n');
      finished = true; clearTimeout(timeout); app.quit();
    })().catch(error => { process.stderr.write(`Content storage UI failed: ${error.stack}\n`); app.exit(1); });
  });
});
app.on('quit', () => { if (finished) void rm(profile, { recursive: true, force: true }); });
require('../dist/main');
