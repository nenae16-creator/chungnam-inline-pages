import assert from 'node:assert/strict';
import { scryptSync, createHmac } from 'node:crypto';
import middleware, { config } from '../middleware.js';

process.env.JUDGE_SESSION_SECRET = 'auth-check-secret-'.repeat(4);
process.env.JUDGE_LOGIN_HASH = scryptSync('test-admin\0test-password', process.env.JUDGE_SESSION_SECRET, 64).toString('hex');
const origin = 'https://chungnam-inline-pages.vercel.app';
const get = (path, headers = {}) => middleware(new Request(origin + path, { headers }));
const login = (password, target = '/judge/?event=1', requestOrigin = origin) => middleware(new Request(origin + '/judge-auth/login/', {
  method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'test-admin', password, next: target }),
}));

assert.ok(config.matcher.includes('/app/:path*'));
const blocked = await get('/judge/');
assert.ok((await blocked.text()).includes('심판 로그인'));
assert.ok((await (await get('/app/?view=judge')).text()).includes('심판 로그인'));
assert.equal((await get('/judge/judge.js', { 'Sec-Fetch-Dest': 'script' })).status, 401);
assert.equal((await login('wrong')).status, 401);
assert.equal((await login('test-password', '/judge/', 'https://attacker.invalid')).status, 403);
const success = await login('test-password');
assert.equal(success.status, 303);
assert.equal(success.headers.get('location'), '/judge/?event=1');
const cookie = success.headers.get('set-cookie');
for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=28800']) assert.ok(cookie.includes(flag));
const valid = cookie.split(';')[0];
assert.equal((await get('/judge/', { Cookie: valid })).headers.get('x-middleware-next'), '1');
assert.equal((await get('/app/', { Cookie: valid })).headers.get('cache-control'), 'private, no-store, max-age=0');
assert.equal((await get('/judge-auth/session/', { Cookie: valid })).status, 200);
assert.equal((await get('/judge-auth/session/', { Cookie: valid + 'x' })).status, 401);
assert.equal((await login('test-password', '//attacker.invalid')).headers.get('location'), '/judge/');
const expires = String(Math.floor(Date.now() / 1000) - 1);
const sig = createHmac('sha256', process.env.JUDGE_SESSION_SECRET).update(expires).digest('hex');
assert.equal((await get('/judge-auth/session/', { Cookie: `__Host-chungnam-judge=${expires}.${sig}` })).status, 401);
const logout = await middleware(new Request(origin + '/judge-auth/logout/', { method: 'POST', headers: { Origin: origin, Cookie: valid } }));
assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
delete process.env.JUDGE_SESSION_SECRET;
assert.equal((await get('/judge/')).status, 503);
console.log('Judge login, blocked access, signed session, expiry and logout checks passed.');
