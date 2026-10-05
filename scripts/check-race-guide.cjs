// Run: node scripts/check-race-guide.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require('node:path').join(__dirname, '../web/public/app.js'), 'utf8');
const body = app.slice(app.indexOf('  function RaceGuide('), app.indexOf('  // 오시는 길:'));
const html = (parts, ...values) => parts.reduce((out, part, i) => out + part + (values[i] == null ? '' : [values[i]].flat(Infinity).join('')), '');
const output = vm.runInNewContext(body + '\nRaceGuide({});', {
  html, SubHero() {}, Footer() {}, Ic() {}, meetTitle: () => '충남 대회',
});
assert.equal((output.match(/<dt>/g) || []).length, 7);
assert.equal((output.match(/<details /g) || []).length, 10);
for (const code of ['Q', 'DQ', 'DNS', 'DNF', 'EL', 'MT', 'AD']) assert.ok(output.includes(`<dt>${code}</dt>`));
assert.ok(output.includes('20명까지는 바로 결승, 21명부터는 예선'));
assert.ok(output.includes('매 짝수 바퀴와 마지막 도착 바퀴'));
assert.ok(output.includes('팀 동료를 도와주거나 뒤에서 밀어주는 행위도 팀 실격'));
assert.ok(output.includes('2025.03.10.'));
assert.ok(output.includes('국제 규정 2026 변경 사항'));
assert.doesNotMatch(output, /고고|gogoinline/i);
const index = fs.readFileSync(require('node:path').join(__dirname, '../web/public/index.html'), 'utf8');
const { version } = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../web/public/release.json'), 'utf8'));
for (const value of [`content="${version}"`, `app.js?v=${version}`, `ui.css?v=${version}`]) assert.ok(index.includes(value));
console.log('Race guide: 7 codes, 10 rule sections, corrected domestic rules and release references passed.');
