import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { next } from '@vercel/functions';

export const config = {
  runtime: 'nodejs',
  matcher: ['/judge/:path*', '/app/:path*', '/judge-auth/:path*', '/web/judge/:path*', '/web/app/:path*'],
};
const cookieName = '__Host-chungnam-judge';
const noCache = { 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Cookie' };
const cookieOptions = 'Path=/; HttpOnly; Secure; SameSite=Strict';
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const signature = (payload, secret) => createHmac('sha256', secret).update(payload).digest('hex');

function destination(value) {
  // Only these local paths can be used after login; never redirect to another host.
  return typeof value === 'string' && /^\/(?:judge|app)(?:\/|\?|$)/.test(value) && !/[\\\r\n]/.test(value)
    ? value : '/judge/';
}

function hasSession(request, secret) {
  const value = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  const match = value?.match(/^(\d{10})\.([a-f0-9]{64})$/);
  const now = Math.floor(Date.now() / 1000);
  return !!match && Number(match[1]) > now && Number(match[1]) <= now + 28800
    && equal(Buffer.from(match[2], 'hex'), Buffer.from(signature(match[1], secret), 'hex'));
}

function loginPage(target, error = '', status = 200) {
  const safeTarget = target.replace(/[&"<>']/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', "'": '&#39;' }[c]));
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>심판 로그인 · 충남 인라인</title><style>
  *{box-sizing:border-box}body{margin:0;background:#edf3fa;color:#082d67;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;padding:24px}main{width:100%;max-width:420px;background:white;border:1px solid #dce7f5;border-radius:24px;padding:32px;box-shadow:0 16px 48px #082d6710}small{font-weight:700;color:#0766ed;letter-spacing:.12em}h1{margin:12px 0 8px;font-size:28px}p{color:#526780;margin:0 0 24px}label{display:block;font-weight:700;margin:16px 0}input{display:block;width:100%;margin-top:8px;padding:13px;border:1px solid #b9cde5;border-radius:12px;font:inherit}input:focus{outline:3px solid #b9d8ff;border-color:#0869ed}button{width:100%;border:0;border-radius:12px;padding:14px;background:#0869ed;color:white;font:700 16px system-ui;cursor:pointer}a{display:block;text-align:center;color:#526780;margin-top:22px}#error{color:#b42318;margin-bottom:16px;font-size:14px}
  </style></head><body><main><small>CHUNGNAM INLINE 2026</small><h1>심판 로그인</h1><p>심판 기록과 운영 화면은 관리자만 이용할 수 있습니다.</p>${error ? `<p id="error" role="alert">${error}</p>` : ''}<form action="/judge-auth/login/" method="post"><input type="hidden" name="next" value="${safeTarget}"><label>아이디<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" required autofocus></label><label>비밀번호<input type="password" name="password" autocomplete="current-password" maxlength="128" required></label><button type="submit">로그인</button></form><a href="/public/#home">대회 홈으로 돌아가기</a></main></body></html>`, {
    status, headers: { ...noCache, 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' },
  });
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const secret = process.env.JUDGE_SESSION_SECRET;
  const passwordHash = process.env.JUDGE_LOGIN_HASH;
  if (!secret || secret.length < 32 || !/^[a-f0-9]{128}$/.test(passwordHash || '')) {
    return new Response('로그인 설정을 확인 중입니다. 잠시 후 다시 접속해 주세요.', { status: 503, headers: noCache });
  }
  const session = hasSession(request, secret);
  const authPath = url.pathname.replace(/\/$/, '');
  if (authPath === '/judge-auth/session') {
    return Response.json({ authenticated: session }, { status: session ? 200 : 401, headers: noCache });
  }
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin) {
    return new Response('요청을 확인할 수 없습니다.', { status: 403, headers: noCache });
  }
  if (authPath === '/judge-auth/logout' && request.method === 'POST') {
    return new Response(null, { status: 303, headers: { ...noCache, Location: '/judge/', 'Set-Cookie': `${cookieName}=; ${cookieOptions}; Max-Age=0` } });
  }
  if (authPath === '/judge-auth/login' && request.method === 'POST') {
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded') || Number(request.headers.get('content-length') || 0) > 4096) {
      return new Response('잘못된 로그인 요청입니다.', { status: 400, headers: noCache });
    }
    const body = await request.text();
    if (body.length > 4096) return new Response('로그인 요청이 너무 큽니다.', { status: 413, headers: noCache });
    const form = new URLSearchParams(body);
    const target = destination(form.get('next'));
    const username = form.get('username') || '';
    const password = form.get('password') || '';
    if (username.length > 32 || password.length > 128 || !username || !password) return loginPage(target, '아이디와 비밀번호를 확인해 주세요.', 401);
    const actual = scryptSync(username + '\0' + password, secret, 64);
    if (!equal(actual, Buffer.from(passwordHash, 'hex'))) return loginPage(target, '아이디 또는 비밀번호가 올바르지 않습니다.', 401);
    const expires = String(Math.floor(Date.now() / 1000) + 28800);
    return new Response(null, { status: 303, headers: { ...noCache, Location: target, 'Set-Cookie': `${cookieName}=${expires}.${signature(expires, secret)}; ${cookieOptions}; Max-Age=28800` } });
  }
  if (authPath.startsWith('/judge-auth')) return new Response('찾을 수 없는 주소입니다.', { status: 404, headers: noCache });
  if (!session) {
    if (request.headers.get('sec-fetch-dest') && request.headers.get('sec-fetch-dest') !== 'document') {
      return new Response('로그인이 필요합니다.', { status: 401, headers: noCache });
    }
    return loginPage(destination(url.pathname.replace(/^\/web/, '') + url.search));
  }
  return next({ headers: noCache });
}
