// Run: node scripts/check-public-navigation.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicDir = path.join(__dirname, '../web/public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(publicDir, 'release.json'), 'utf8')).version;
assert.ok(index.includes(`name="app-version" content="${version}"`));
assert.ok(index.includes(`app.js?v=${version}`));
assert.ok(app.includes('if (href === "../judge/")'));
const boot = app.slice(0, app.indexOf('  const data = window.MEET_DATA;')) + '\nwindow.checkMenuJudge = openJudge;\n})();';

async function check(href, release, hidden = false) {
  const events = {};
  const calls = [];
  const location = { href, hash: new URL(href).hash, assign: url => calls.push(url), replace: url => calls.push(url) };
  const context = {
    URL, React: {}, htm: { bind: () => () => {} }, location,
    document: {
      hidden, getElementById: () => null,
      querySelector: () => ({ content: version }),
      addEventListener: (name, fn) => { events[name] = fn; },
    },
    window: {
      addEventListener: (name, fn) => { events[name] = fn; },
      setInterval: fn => { events.interval = fn; },
    },
    fetch: async () => ({ ok: true, json: async () => ({ version: release }) }),
  };
  vm.runInNewContext(boot, context);
  if (events.interval) await events.interval();
  return { calls, context };
}

(async () => {
  const base = 'https://chungnam-inline-pages.vercel.app';
  assert.deepEqual((await check(`${base}/public/#judge`, version)).calls, [`${base}/judge/`]);
  assert.deepEqual((await check(`${base}/web/public/#judge`, version)).calls, [`${base}/web/judge/`]);
  assert.deepEqual((await check(`${base}/public/#home`, version)).calls, []);
  const next = `${version}-next`;
  assert.deepEqual((await check(`${base}/public/?filter=live#home`, next)).calls, [`${base}/public/?filter=live&v=${next}#home`]);
  assert.deepEqual((await check(`${base}/public/?v=${next}#home`, next)).calls, []);
  assert.deepEqual((await check(`${base}/public/#home`, next, true)).calls, []);
  const menu = await check(`${base}/public/#home`, version);
  menu.context.window.checkMenuJudge();
  assert.deepEqual(menu.calls, [`${base}/judge/`]);
  console.log('Public judge navigation and release refresh checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
