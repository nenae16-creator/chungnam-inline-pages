/* =====================================================================
 * 충남 인라인 — 공개 관중 사이트 (React + htm, 빌드 불필요)
 * design/ 목업을 정본으로 React 컴포넌트 + CSS(ui.css)로 재현.
 * 코드로 불가능한 실제 사진/손글씨/로고/메달만 목업 크롭 이미지를 쓴다.
 * 데이터/동기화 계층(ScoreboardSource·MeetCalc·MEET_DATA·CHUNGNAM_PUBLIC)은 그대로 소비.
 * ===================================================================== */
(function () {
  "use strict";
  const { useState, useEffect, useRef, useReducer, useCallback } = React;
  // htm → React.createElement, class/for/tabindex 를 React 표기로 변환
  const h = (type, props, ...children) => {
    if (props) {
      if ("class" in props) { props.className = props.class; delete props.class; }
      if ("for" in props) { props.htmlFor = props.for; delete props.for; }
      if ("tabindex" in props) { props.tabIndex = props.tabindex; delete props.tabindex; }
    }
    return React.createElement(type, props, ...children);
  };
  const html = htm.bind(h);
  const root = document.getElementById("root");
  const announce = document.getElementById("announcement");

  // 이전에 공유된 #judge 주소도 독립 심판 기록 화면으로 연다.
  if (location.hash === "#judge") {
    location.replace(new URL("../judge/", location.href).href);
    return;
  }

  const data = window.MEET_DATA;
  const site = window.CHUNGNAM_PUBLIC || {};
  if (!data || !window.ScoreboardSource || !window.MeetCalc) {
    root.innerHTML = '<div class="ci-empty"><h1>대회 정보를 불러오지 못했습니다</h1><p>연결 상태를 확인한 뒤 페이지를 다시 열어 주세요.</p><button onclick="location.reload()">다시 불러오기</button></div>';
    return;
  }
  // ponytail: 관람객은 최대 약 45초 늦게 갱신된다. 더 빠른 1000명 동시 갱신은 공유 캐시가 필요하다.
  const source = ScoreboardSource.open({ data, mode: "auto", pollIntervalMs: 30000 });
  const RACE_ALERT_KEY = "chungnam_public_race_alerts_" + (data.meta?.id || "current") + "_v1";

  function loadRaceAlertState() {
    try {
      const saved = JSON.parse(localStorage.getItem(RACE_ALERT_KEY) || "{}");
      return {
        watched: new Set(Array.isArray(saved.watched) ? saved.watched.filter(Number.isInteger) : []),
        notified: new Set(Array.isArray(saved.notified) ? saved.notified.filter((key) => typeof key === "string") : []),
      };
    } catch (_) { return { watched: new Set(), notified: new Set() }; }
  }

  function saveRaceAlertState(state) {
    try {
      localStorage.setItem(RACE_ALERT_KEY, JSON.stringify({ watched: [...state.watched], notified: [...state.notified] }));
    } catch (_) { /* 현재 열린 화면의 알림은 계속 작동한다. */ }
  }

  /* ---------- assets ---------- */
  // 각 메뉴에 맞는 별도 홍보 장면. 실제 경기장·선수 사진으로 오인하지 않도록 장식 이미지로 사용한다.
  const HERO = {
    home: "assets/campaign/home-kit.webp",
    schedule: "assets/campaign/schedule-kit.webp",
    event: "assets/campaign/event-kit.webp",
    live: "assets/campaign/live-kit.webp",
    results: "assets/campaign/results-kit.webp",
    athletes: "assets/campaign/athletes-kit.webp",
    athlete: "assets/campaign/profile-kit.webp",
    notices: "assets/campaign/notices-kit.webp",
    participation: "assets/campaign/participation-kit.webp",
    meetRules: "assets/campaign/meet-rules-kit.webp",
    raceGuide: "assets/campaign/race-guide-kit.webp",
    guide: "assets/campaign/directions-kit.webp",
    about: "assets/campaign/about-kit.webp",
    plain: "assets/campaign/notices-kit.webp",
  };
  const heroImg = (k) => HERO[k] || HERO.plain;
  const HEROCLEAN = HERO;
  const ICON_IMG = "assets/campaign/skater-icon.png";
  const STORY_IMG = "assets/campaign/story-kit.webp";
  const MEDAL = { g: "assets/mockup/medal-gold.png", s: "assets/mockup/medal-silver.png", b: "assets/mockup/medal-bronze.png" };

  /* ---------- helpers ---------- */
  const Ic = ({ n, cls }) => html`<svg class=${"ci-ic " + (cls || "")} viewBox="0 0 24 24" aria-hidden="true"><use href=${"#i-" + n} /></svg>`;
  const year = () => (meetTitle().match(/20\d{2}/) || ["2026"])[0];
  const meetTitle = () => data.meta?.title || site.campaign?.title || "충남 인라인 대회";
  // 카탈로그에서 첫 대회(현재) 여부. 과거 대회 선택 시 날짜/카운트다운을 그 대회 기준으로.
  const isCurrentMeet = () => !window.MEET_LIST || !window.MEET_LIST.length || window.MEET_SELECTED_ID === window.MEET_LIST[0].id;
  const parseMeetDate = (s) => { const m = String(s || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3], 9, 0, 0) : null; };
  const meetDate = () => isCurrentMeet() ? (site.dateLabel || data.meta?.date || "개최일 확인 중") : (data.meta?.date || "개최일 확인 중");
  const meetStartMs = () => { if (isCurrentMeet()) { const t = Date.parse(site.campaign?.startAt || ""); if (Number.isFinite(t)) return t; } const d = parseMeetDate(data.meta?.date); return d ? d.getTime() : NaN; };
  const eventHasRecords = (ev) => {
    if (!ev) return false;
    if (Number(ev.progress?.done) > 0) return true;
    const view = source.eventView(ev.id);
    return !!view?.heats?.some((heat) => heat.done > 0 || heat.confirmed);
  };
  const meetHasRecords = () => events().some(eventHasRecords);
  const meetAllHeatsConfirmed = () => {
    const views = events().map((ev) => source.eventView(ev.id)).filter(Boolean);
    return views.length > 0 && views.every((view) => view.heats.length > 0 && view.heats.every((heat) => heat.confirmed));
  };
  const withinMeetDay = (now = Date.now()) => {
    const start = meetStartMs();
    const end = isCurrentMeet() ? Date.parse(site.campaign?.endAt || "") : (Number.isFinite(start) ? start + 9 * 3600 * 1000 : NaN);
    return Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end;
  };
  // 시작 시각 미정일 때는 자정이 LIVE 시작 시각이 아니다. 심판 기록이 게시된 종목만 표시한다.
  const meetStarted = () => {
    if (isCurrentMeet() && site.campaign?.timeTBD) return withinMeetDay() && meetHasRecords();
    const s = meetStartMs();
    return Number.isFinite(s) ? Date.now() >= s : true;
  };
  const isLiveEv = (ev) => !!ev.isLive && (isCurrentMeet() && site.campaign?.timeTBD
    ? withinMeetDay() && eventHasRecords(ev)
    : meetStarted());
  const meetVenue = () => site.venue?.name || (data.meta?.place ? data.meta.place + " · 경기장 확인 중" : "경기장 확인 중");
  const bibN = (id) => String(id).padStart(3, "0");
  // 한글 이름 → 로마자(개정 로마자 표기 + 흔한 성씨 관용 표기). 목업의 "KIM SEOYEON" 부제용.
  const RR_INI = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
  const RR_MED = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
  const RR_FIN = ["", "g", "kk", "gs", "n", "nj", "nh", "d", "l", "lg", "lm", "lb", "ls", "lt", "lp", "lh", "m", "b", "bs", "s", "ss", "ng", "j", "ch", "k", "t", "p", "h"];
  const SURNAME = { "김": "KIM", "이": "LEE", "박": "PARK", "최": "CHOI", "정": "JUNG", "강": "KANG", "조": "CHO", "윤": "YOON", "장": "JANG", "임": "LIM", "한": "HAN", "오": "OH", "서": "SEO", "신": "SHIN", "권": "KWON", "황": "HWANG", "안": "AHN", "송": "SONG", "전": "JEON", "홍": "HONG", "유": "YOO", "고": "KO", "문": "MOON", "양": "YANG", "손": "SON", "배": "BAE", "백": "BAEK", "허": "HEO", "남": "NAM", "심": "SHIM", "노": "NOH", "하": "HA", "곽": "KWAK", "성": "SUNG", "차": "CHA", "주": "JOO", "우": "WOO", "구": "KOO", "민": "MIN", "류": "RYU", "나": "NA", "진": "JIN", "지": "JI", "채": "CHAE", "원": "WON", "천": "CHEON", "방": "BANG", "공": "KONG", "현": "HYUN" };
  const romSyl = (ch) => { const c = ch.charCodeAt(0) - 0xac00; if (c < 0 || c > 11171) return ""; return RR_INI[Math.floor(c / 588)] + RR_MED[Math.floor((c % 588) / 28)] + RR_FIN[c % 28]; };
  const romanizeName = (name) => { const s = String(name || "").trim(); if (!s) return ""; const sur = SURNAME[s[0]] || romSyl(s[0]).toUpperCase(); const given = [...s.slice(1)].map(romSyl).join("").toUpperCase(); return (sur + " " + given).trim(); };
  const events = () => source.events();
  // 공지는 실제 대회 데이터(MEET_DATA.meta)에서만 만든다. 가짜 공지 레코드를 넣지 않는다.
  const notices = () => {
    const meta = data.meta || {};
    const title = meta.title || meetTitle();
    const nA = (data.athletes || []).length, nE = events().length;
    const when = [meta.date, meta.start].filter(Boolean).join(" ");
    const phase = timeState(Date.now()).phase;
    const held = phase === "live" ? "경기 기록이 업데이트되고 있습니다"
      : phase === "ended" ? "대회가 종료되었습니다"
      : phase === "past" ? "개최일이 지났습니다. 종료 여부와 최종 결과는 주최 측 안내를 확인해 주세요"
      : "개최 예정입니다";
    const out = [];
    out.push({
      id: "open", isNew: true, title: title + " 개최 안내",
      body: isCurrentMeet()
        ? `${when ? when + ", " : ""}${meta.place || "경기장 미정"}에서 ${phase === "live" ? "현재 " + title + " 경기 기록이 업데이트되고 있습니다." : phase === "ended" ? title + " 기록이 모두 확정되었습니다." : phase === "past" ? "개최 예정일이 지났습니다. 종료 여부와 최종 결과는 주최 측 안내를 확인해 주세요." : title + " 개최 예정입니다."} 출전 선수 명단·경기 순서·경기 시각은 아직 등록되지 않았습니다(미정).`
        : `${when ? when + ", " : ""}${meta.place || "경기장 미정"}에서 ${title}가 ${held}. 총 ${nE}개 경기에 ${nA}명의 선수가 참가합니다. 경기 순서와 출전 명단은 대회 일정 화면에서 확인할 수 있습니다.`,
      date: meta.date || "",
    });
    if (meta.note) out.push({ id: "note", title: "부별 편성 및 유의사항 안내", body: meta.note, date: meta.date || "" });
    (site.announcements || []).forEach((n) => { if (n.published === true) out.push(n); });
    return out;
  };
  const distanceList = () => [...new Set(events().map((e) => e.dist))];
  const kindList = () => [...new Set(events().map((e) => e.kind))];
  function eventDivision(ev) {
    const cat = ev.cat || "", name = ev.name || "";
    if (/특수/.test(cat) || /특수/.test(name)) return "특수부";
    if (/유치/.test(cat) || /유치/.test(name)) return "유치부";
    if (/성인/.test(cat) || /성인/.test(name)) return "성인부";
    if (/중고/.test(cat) || /중·?고/.test(name)) return "중고등부";
    if (/^중/.test(cat) || /중등/.test(name)) return "중등부";
    if (/^고/.test(cat) || /고등/.test(name)) return "고등부";
    if (/^핏/.test(cat) || /피트니스|최강전/.test(name)) return "최강전";
    if (/^초/.test(cat) || /초등/.test(name)) return "초등부";
    // 학년 기반(예: "레이싱 5~6학년 …"): 1~6학년 초등부 · 7~9 중등부 · 그 외 고등부
    const g = (cat + " " + name).match(/(\d+)\s*(?:~\s*\d+)?\s*학년/);
    if (g) { const n = +g[1]; return n <= 6 ? "초등부" : n <= 9 ? "중등부" : "고등부"; }
    return "기타";
  }
  const divisionList = () => [...new Set(events().map(eventDivision))];
  const meetVenueShort = () => { const v = meetVenue().trim().split(/\s+/); return v[v.length - 1] || v; };
  function shortDateLabel() {
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    const ms = meetStartMs();
    const d = new Date(Number.isFinite(ms) ? ms : Date.now());
    if (!Number.isFinite(d.getTime())) return meetDate();
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
  }
  function scheduleDates() {
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    const ms = meetStartMs();
    const base = new Date(Number.isFinite(ms) ? ms : Date.now());
    const out = [];
    for (let i = -2; i <= 2; i++) {
      const d = new Date(base); d.setDate(d.getDate() + i);
      out.push({ key: i, m: d.getMonth() + 1, day: d.getDate(), dow: days[d.getDay()], active: i === 0 });
    }
    return out;
  }
  // 경기별 예상 진행 시각: day 필드에 시각이 있으면 사용, 없으면 09:00부터 조 수 기준 누적.
  let _schedTimes = null;
  function scheduleTimes() {
    if (_schedTimes) return _schedTimes;
    _schedTimes = {};
    if (site.campaign?.timeTBD) { events().forEach((ev) => { const m = String(ev.day || "").match(/(\d{1,2}):(\d{2})/); _schedTimes[ev.id] = m ? m[1].padStart(2, "0") + ":" + m[2] : "미정"; }); return _schedTimes; }
    let mins = 9 * 60;
    events().forEach((ev) => {
      const m = String(ev.day || "").match(/(\d{1,2}):(\d{2})/);
      if (m) mins = Number(m[1]) * 60 + Number(m[2]);
      _schedTimes[ev.id] = String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
      mins += Math.max(1, ev.heatCount || 1) * 8 + 6;
    });
    return _schedTimes;
  }

  function parseTimeSec(str) {
    if (!str) return null;
    const m = String(str).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    return (m[1] ? Number(m[1]) : 0) * 60 + Number(m[2]);
  }
  function eventStatus(ev) {
    const view = source.eventView(ev.id);
    if (view?.lineupPending) return { label: "진출자 대기", cls: "wait", cat: "waiting" };
    if (view?.heats.length && view.heats.every((x) => x.confirmed)) return { label: "확정", cls: "done", cat: "done" };
    if (ev.progress.done > 0) return { label: "잠정 기록", cls: "prov", cat: "recorded" };
    return { label: "예정", cls: "wait", cat: "waiting" };
  }
  function scheduleStatus(ev) {
    const s = eventStatus(ev);
    if (isLiveEv(ev) && s.cat !== "done") return "current";
    if (s.cat === "done") return "done";
    return "pending";
  }
  const catLabel = { all: "전체", kinder: "유치부", elementary: "초등부", middle: "중등부", high: "고등부", adult: "성인부", special: "특수부" };
  function athleteCategory(a) {
    const g = String(a.grade || "");
    if (/특수/.test(g)) return "special";
    if (/유치/.test(g)) return "kinder";
    if (/중/.test(g)) return "middle";
    if (/고/.test(g)) return "high";
    if (/학년|세/.test(g) && !/성인/.test(g)) return "elementary";
    return "adult";
  }
  function athleteEntries(id) {
    return events()
      .map((ev) => ({ ev, rows: source.eventView(ev.id).overall.filter((r) => r.athleteId === id) }))
      .filter((x) => x.rows.length);
  }
  function bestTime(id) {
    let best = null;
    athleteEntries(id).forEach(({ ev, rows }) => rows.forEach((r) => {
      if (!r.hasResult || r.dnx) return;
      const sec = parseTimeSec(r.timeText);
      if (sec == null) return;
      if (!best || sec < best.sec) best = { sec, timeText: r.timeText, dist: ev.dist };
    }));
    return best;
  }
  function medalTotals() {
    let g = 0, s = 0, b = 0;
    events().forEach((ev) => {
      if (eventStatus(ev).cat !== "done") return;
      source.eventView(ev.id).overall.forEach((r) => {
        if (r.overallPlace === 1) g++; else if (r.overallPlace === 2) s++; else if (r.overallPlace === 3) b++;
      });
    });
    return { g, s, b };
  }
  function nextEvent() {
    const evs = events();
    const cur = source.currentEventId();
    const i = evs.findIndex((e) => e.id === cur);
    return i >= 0 ? evs[i + 1] || null : evs[0] || null;
  }
  function timeState(now) {
    const start = meetStartMs();
    const end = isCurrentMeet() ? Date.parse(site.campaign?.endAt || "") : (Number.isFinite(start) ? start + 9 * 3600 * 1000 : NaN);
    if (!Number.isFinite(start)) return { label: "대회 일정 확인 중", sub: "확정 후 안내합니다", values: ["—", "—", "—", "—"], phase: "unknown" };
    if (isCurrentMeet() && site.campaign?.timeTBD) {
      if (now < start) {
        const days = Math.max(0, Math.ceil((start - now) / 86400000));
        return { label: "대회일까지", sub: "경기 시작 시각은 미정입니다", countdown: { value: String(days), unit: "일" }, phase: "upcoming" };
      }
      if (Number.isFinite(end) && now <= end) {
        if (meetHasRecords()) return { label: "경기 기록 업데이트 중", sub: "심판 기록 데이터 기준 · 현장 진행 상황은 다를 수 있습니다", stateText: "기록 업데이트 중", phase: "live" };
        return { label: "오늘 대회 예정", sub: "경기 시작 시각과 순서는 미정입니다", stateText: "경기 시작 시각 미정", phase: "upcoming" };
      }
      if (meetAllHeatsConfirmed()) return { label: "대회가 종료되었습니다", sub: "함께해 주셔서 감사합니다", stateText: "최종 기록 확정", phase: "ended" };
      return { label: "대회일 경과", sub: "종료 여부와 최종 결과는 주최 측 안내를 확인하세요", stateText: "최종 결과 확인 중", phase: "past" };
    }
    if (now >= start) {
      const ended = Number.isFinite(end) && now >= end;
      return { label: ended ? "대회가 종료되었습니다" : "대회가 진행 중입니다", sub: ended ? "함께해 주셔서 감사합니다" : "지금, 열정의 순간!", values: ["0", "00", "00", "00"], phase: ended ? "ended" : "live" };
    }
    let s = Math.floor((start - now) / 1000);
    const d = Math.floor(s / 86400); s %= 86400;
    const hh = Math.floor(s / 3600); s %= 3600;
    const mm = Math.floor(s / 60); s %= 60;
    return { label: site.campaign?.timeTBD ? "대회일까지" : "대회 시작까지", sub: site.campaign?.timeTBD ? "경기 시작 시각은 미정입니다" : "지금, 열정의 순간을 함께하세요!", values: [String(d), String(hh).padStart(2, "0"), String(mm).padStart(2, "0"), String(s).padStart(2, "0")], phase: "upcoming" };
  }

  /* ---------- favorites (localStorage) ---------- */
  const FAV_KEY = "chungnam_public_favorites_v1";
  function loadFavs() {
    try { const s = JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); return new Set(Array.isArray(s) ? s.filter(Number.isInteger) : []); } catch { return new Set(); }
  }

  /* =================================================================
   * shared chrome
   * ================================================================= */
  function Header({ onDark, onMenu }) {
    return html`<header class=${"ci-head " + (onDark ? "on-dark" : "")}>
      <a class="ci-brand" href="#home" aria-label=${meetTitle() + " 홈"}>
        <img src=${ICON_IMG} width="38" height="38" alt="" />
        <span><strong>${meetTitle()}</strong><small>CHUNGNAM INLINE ${year()}</small></span>
      </a>
      <div class="ci-head-r">
        <span class="ci-head-hand" aria-hidden="true">제1회 충청남도<br />체육회장기</span>
        <button class="ci-menu-btn" type="button" aria-label="전체 메뉴 열기" onClick=${onMenu}><${Ic} n="menu" /></button>
      </div>
    </header>`;
  }
  const Signature = () => html`<div class="ci-hero-sign" aria-hidden="true"><em class="ci-hand">더 빠르게<br />더 높이<br />하나로!</em><span class="ci-wm">CHUNGNAM<br />INLINE<br />${year()}</span></div>`;

  function Footer() {
    return html`<footer class="ci-foot">
      <div class="ci-foot-main">
        <div class="ci-foot-org"><img class="ci-foot-emblem" src=${ICON_IMG} alt="" width="36" height="32" /><span><strong>${site.organizer?.name || "주최 미정"}</strong><small>${site.organizer?.nameEn || ""}</small></span></div>
        <p class="ci-foot-slogan">주최·주관<br />${site.organizer?.host || "미정"}</p>
        <div class="ci-foot-social" aria-label="문의">${site.organizer?.email ? html`<a href=${"mailto:" + site.organizer.email}>${site.organizer.email}</a>` : null}</div>
      </div>
      <div class="ci-foot-base"><small>${meetTitle()}</small><small>후원 ${site.organizer?.sponsors || "미정"}</small></div>
    </footer>`;
  }

  function Menu({ open, onClose }) {
    useEffect(() => {
      const onKey = (e) => { if (e.key === "Escape") onClose(); };
      if (open) window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);
    const links = [
      ["#home", "홈", "home"], ["#schedule", "대회 일정", "calendar"], ["#live", "경기 현황", "live"],
      ["#results", "경기 결과", "trophy"], ["#athletes", "선수 찾기", "users"], ["#notices", "공지사항", "info"],
      ["#guide", "오시는 길", "pin"], ["#participation", "참가안내", "users"], ["#meet-rules", "대회요강", "clipboard"], ["#race-guide", "시합 규칙 쉽게보기", "info"],
      ["../judge/", "심판 기록", "clipboard"],
    ];
    return html`<${React.Fragment}>
      <div class=${"ci-drawer-bg" + (open ? " open" : "")} onClick=${onClose} aria-hidden="true"></div>
      <aside class=${"ci-drawer" + (open ? " open" : "")} aria-label="대회 메뉴" aria-hidden=${!open}>
        <div class="ci-drawer-top">
          <div><strong>대회 메뉴</strong><small>CHUNGNAM INLINE ${year()}</small></div>
          <button type="button" aria-label="메뉴 닫기" onClick=${onClose}><${Ic} n="close" /></button>
        </div>
        <nav>${links.map(([href, l, ic]) => html`<a key=${href} href=${href} onClick=${onClose}><span class="ci-drawer-ic"><${Ic} n=${ic} /></span><span>${l}</span><${Ic} n="chevron" cls="go" /></a>`)}</nav>
        ${(window.MEET_LIST && window.MEET_LIST.length > 1) ? html`<div class="ci-drawer-meet">
          <label for="ci-meet-select">대회 기록 선택</label>
          <div class="ci-select">
            <${Ic} n="trophy" />
            <select id="ci-meet-select" value=${window.MEET_SELECTED_ID} onChange=${(e) => {
              const u = new URL(location.href); u.search = ""; u.hash = "";
              if (e.target.value !== window.MEET_LIST[0].id) u.searchParams.set("meet", e.target.value);
              location.assign(u.href);
            }}>
              ${window.MEET_LIST.map((m) => html`<option key=${m.id} value=${m.id}>${m.title}${m.current ? " · 현재" : ""} · ${m.date}</option>`)}
            </select>
            <${Ic} n="chevron" />
          </div>
        </div>` : null}
        <p class="ci-drawer-foot">${meetTitle()}</p>
      </aside>
    </${React.Fragment}>`;
  }

  const twoTone = (a, b) => html`<span><span class="t1">${a}</span> <span class="t2">${b}</span></span>`;

  function SubHero({ kind, title, subtitle, back, backLabel, crumb, onMenu }) {
    // heroClean: 목업 히어로 이미지(선수+손글씨, 제목·헤더 지움) full-bleed + 코드 헤더/제목만 얹음.
    if (HEROCLEAN[kind]) {
      return html`<section class=${"ci-sub-hero ci-hero-baked ci-sub-" + kind}>
        <img src=${HEROCLEAN[kind]} alt="" aria-hidden="true" />
        <${Header} onDark=${false} onMenu=${onMenu} />
        <div class="ci-sub-copy">
          ${back ? html`<a class="ci-sub-back" href=${back}><${Ic} n="back" /><span>${backLabel || "이전"}</span></a>` : null}
          ${crumb ? html`<p class="ci-sub-crumb">${crumb}</p>` : null}
          <h1 tabindex="-1">${title}</h1>
          ${subtitle ? html`<p class="ci-sub-sub">${subtitle}</p>` : null}
        </div>
      </section>`;
    }
    // 문구(코드 텍스트)와 이미지(깨끗한 선수 사진)만으로 구성 — 투명 클릭레이어 없음.
    return html`<section class=${"ci-sub-hero ci-sub-" + kind}>
      <img src=${heroImg(kind)} alt="" aria-hidden="true" />
      <${Header} onDark=${false} onMenu=${onMenu} />
      <${Signature} />
      <div class="ci-sub-copy">
        ${back ? html`<a class="ci-sub-back" href=${back}><${Ic} n="back" /><span>${backLabel || "이전"}</span></a>` : null}
        ${crumb ? html`<p class="ci-sub-crumb">${crumb}</p>` : null}
        <h1 tabindex="-1">${title}</h1>
        ${subtitle ? html`<p class="ci-sub-sub">${subtitle}</p>` : null}
      </div>
    </section>`;
  }

  const Empty = ({ h: head, p, children }) => html`<div class="ci-empty"><h2>${head}</h2><p>${p}</p>${children}</div>`;
  const DataProvenance = () => isCurrentMeet() && !(data.athletes || []).length ? html`<p class="ci-data-warning" role="note">출전 선수 명단·조 편성·경기 순서·경기 시각은 아직 등록되지 않았습니다(미정). 종목은 대회요강 기준이며 경기번호는 임시 번호입니다.</p>` : null;
  const Chip = ({ cls, children }) => html`<span class=${"ci-chip " + (cls || "")}>${children}</span>`;
  const Rank = ({ place }) => html`<span class=${"ci-rank r" + (place <= 3 ? place : 0)}>${place}</span>`;
  const Avatar = ({ cls }) => html`<span class=${"ci-avatar " + (cls || "")}><img src=${ICON_IMG} alt="" aria-hidden="true" /></span>`;

  /* =================================================================
   * HOME (목업 1)
   * ================================================================= */
  function Countdown() {
    const [now, setNow] = useState(Date.now());
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
    const st = timeState(now);
    return html`<section class="ci-count" data-phase=${st.phase} aria-label="대회 카운트다운">
      <div class="ci-count-head"><${Ic} n="clock" cls="b" /><div><strong>${st.label}</strong><small>${st.sub}</small></div></div>
      ${st.countdown ? html`<div class="ci-count-vals" role="timer"><div><strong>${st.countdown.value}</strong><span>${st.countdown.unit}</span></div></div>`
        : st.stateText ? html`<div class="ci-count-status" role="status">${st.stateText}</div>`
        : html`<div class="ci-count-vals" role="timer">${st.values.map((v, i) => html`<div key=${i}><strong>${v}</strong><span>${["일", "시간", "분", "초"][i]}</span></div>`)}</div>`}
    </section>`;
  }
  function StoryBanner({ compact }) {
    return html`<a class="ci-home-story" href="#meet-rules">
      <img class="ci-home-story-photo" src=${STORY_IMG} alt="" aria-hidden="true" />
      <div class="ci-home-story-copy">
        <h2>함께 달리는<br />충남의 레이스</h2>
        ${compact ? html`<p>${meetVenue()} · ${meetDate()}</p>` : html`<p>${meetDate()}<br />${meetVenue()}</p><span class="ci-home-story-cta">종목·안전 안내 보기 <${Ic} n="arrow" /></span>`}
      </div>
    </a>`;
  }
  function NoticeRow({ n, tag }) {
    const label = tag || (n.isNew ? "중요" : "안내");
    return html`<a class="ci-notice-row" href=${"#notice/" + encodeURIComponent(n.id)}>
      <span class=${"ci-notice-tag " + (n.isNew ? "hot" : "")}>${label}</span>
      <strong>${n.title}</strong><time>${n.date || ""}</time>
    </a>`;
  }
  function CurrentRace() {
    const view = source.eventView(source.currentEventId());
    if (!view) return null;
    const ev = view.event;
    const hasRecords = meetHasRecords();
    const finished = view.heats.length > 0 && view.heats.every((heat) => heat.confirmed);
    const next = nextEvent();
    return html`<section class="ci-current-race" aria-label="경기 현황" aria-live="polite">
      <div class="ci-sec-head"><h2>경기 현황</h2><span>${finished ? "마감" : hasRecords ? "기록 업데이트" : "경기 편성 대기"}</span></div>
      <a class="ci-next-card" href=${hasRecords ? "#live" : "#schedule"}>
        <div class="ci-next-no">${hasRecords ? `제${Number(ev.no)}경기` : "편성 미정"}</div>
        <div class="ci-next-main"><strong>${hasRecords ? ev.name : "출전 편성 확인 중"}</strong><span>${hasRecords ? (view.lineupPending ? "출전 명단 확정 대기" : !view.heats.length ? "출전 명단·조 편성 미등록" : finished ? "모든 조 마감" : (view.liveHeat || 1) + "조 / " + view.heats.length + "조") : "선수 명단·경기 순서·시각이 등록되면 안내합니다."}</span><span>${hasRecords ? "기록·순위 보기" : "요강 기준 종목 보기"}</span></div>
        <${Ic} n="chevron" cls="go" />
      </a>
      <p>${hasRecords ? (next ? "다음 경기: 제" + Number(next.no) + "경기 · " + next.name : finished ? "마지막 경기까지 마감되었습니다." : "마지막 경기입니다.") : "대회요강의 종목은 확인할 수 있습니다. 경기 일정은 공식 공지 후 표시합니다."}</p>
    </section>`;
  }
  function Home({ onMenu }) {
    const cards = [
      ["#about", "trophy", "대회소개", "대회 개요와 비전을 확인하세요"],
      ["#guide", "pin", "오시는 길", "경기장 위치와 교통 정보를 확인하세요"],
      ["#meet-rules", "clipboard", "대회요강", "참가요강·경기 종목을 확인하세요"],
      ["#race-guide", "info", "시합 규칙 쉽게보기", "처음 출전해도 이해할 수 있어요"],
    ];
    const pub = notices();
    return html`<div class="ci-page ci-home">
      <section class="ci-home-hero">
        <img src=${heroImg("home")} alt="가슴에 CHUNGNAM 문구가 있는 경기복을 입고 주행하는 인라인 선수들의 홍보 이미지" fetchpriority="high" />
        <${Header} onDark=${false} onMenu=${onMenu} />
        <div class="ci-home-copy">
          <h1>제1회 충청남도<br /><em>체육회장기</em></h1>
          <p class="ci-home-lead">인라인스피드대회<br />주최·주관 ${site.organizer?.host || "미정"}</p>
          <div class="ci-home-meta"><span><${Ic} n="calendar" />${meetDate()}</span><span><${Ic} n="pin" />${meetVenue()}</span></div>
        </div>
      </section>
      <main class="ci-home-body">
        <${DataProvenance} />
        <${CurrentRace} />
        <${Countdown} />
        <nav class="ci-home-cards" aria-label="대회 핵심 메뉴">
          ${cards.map(([href, ic, t, d]) => html`<a key=${href} href=${href}><span class="ci-home-card-ic"><${Ic} n=${ic} /></span><span class="ci-home-card-tx"><strong>${t}</strong><small>${d}</small></span><i class="ci-home-card-go"><${Ic} n="arrow" /></i></a>`)}
        </nav>
        <${StoryBanner} />
        <section class="ci-home-notices">
          <header><h2>공지사항</h2><a href="#notices">전체보기 <${Ic} n="arrow" /></a></header>
          <div class="ci-notice-list">${pub.length ? pub.slice(0, 3).map((n) => html`<${NoticeRow} key=${n.id} n=${n} />`) : html`<p class="ci-notice-empty">등록된 공지가 없습니다.</p>`}</div>
        </section>
      </main>
      <${Footer} />
    </div>`;
  }

  /* =================================================================
   * SCHEDULE (목업 2)
   * ================================================================= */
  function ScheduleRow({ ev, fav, onFav }) {
    const s = eventStatus(ev);
    const live = isLiveEv(ev) && s.cat !== "done";
    const div = eventDivision(ev) === "기타" ? (ev.cat || ev.gender || "부문") : eventDivision(ev);
    return html`<a class=${"ci-sched-row " + (live ? "is-live" : "")} href=${"#event/" + ev.id}>
      <span class="ci-sched-time"><strong>${scheduleTimes()[ev.id] || "—"}</strong></span>
      <span class="ci-sched-main">
        <span class="ci-sched-head"><span class="ci-sched-tag">제${Number(ev.no)}경기</span><strong>${ev.name}</strong></span>
        <span class="ci-sched-meta"><em><${Ic} n="users" />${div}</em><em><${Ic} n="route" />${ev.dist}</em><em><${Ic} n="pin" />${meetVenueShort()}</em></span>
      </span>
      <span class="ci-sched-end">
        ${live ? html`<span class="ci-chip live">진행중</span>` : html`<span class=${"ci-chip " + s.cls}>${s.label}</span>`}
        <button class="ci-star" type="button" aria-label="관심 경기" aria-pressed=${fav} onClick=${(e) => { e.preventDefault(); onFav(); }}><${Ic} n=${fav ? "star-fill" : "star"} /></button>
      </span>
    </a>`;
  }
  function DateScroller() {
    const [sel, setSel] = useState(0);
    const dates = scheduleDates();
    return html`<div class="ci-date-scroll" role="group" aria-label="날짜 선택">
      <button class="ci-date-nav" type="button" aria-label="이전 날짜" onClick=${() => setSel((v) => Math.max(-2, v - 1))}><${Ic} n="back" /></button>
      <div class="ci-date-list">${dates.map((d) => html`<button key=${d.key} type="button" class=${"ci-date-tile" + (d.key === sel ? " on" : "")} aria-pressed=${d.key === sel} onClick=${() => setSel(d.key)}><strong>${d.m}.${d.day}</strong><small>(${d.dow})</small></button>`)}</div>
      <button class="ci-date-nav" type="button" aria-label="다음 날짜" onClick=${() => setSel((v) => Math.min(2, v + 1))}><${Ic} n="chevron" /></button>
    </div>`;
  }
  function Schedule({ onMenu, favs, toggleFav }) {
    const [dist, setDist] = useState("all");
    const [division, setDivision] = useState("all");
    const [status, setStatus] = useState("all");
    const list = events().filter((ev) =>
      (dist === "all" || ev.dist === dist) &&
      (division === "all" || eventDivision(ev) === division) &&
      (status === "all" || scheduleStatus(ev) === status));
    const total = events().length;
    return html`<div class="ci-page">
      <${SubHero} kind="schedule" title="대회 일정" subtitle=${html`인라인으로 하나 되는 열정의 순간,<br />대회 일정을 확인하세요.`} onMenu=${onMenu} />
      <main class="ci-content">
        <${DataProvenance} />
        <section class="ci-sched-tools"><div class="ci-sched-selects cols-3">
          <label class="ci-select"><${Ic} n="route" /><select value=${dist} onChange=${(e) => setDist(e.target.value)}><option value="all">거리 전체</option>${distanceList().map((d) => html`<option key=${d} value=${d}>${d}</option>`)}</select><${Ic} n="chevron" /></label>
          <label class="ci-select"><${Ic} n="users" /><select value=${division} onChange=${(e) => setDivision(e.target.value)}><option value="all">부문 전체</option>${divisionList().map((d) => html`<option key=${d} value=${d}>${d}</option>`)}</select><${Ic} n="chevron" /></label>
          <label class="ci-select"><${Ic} n="clipboard" /><select value=${status} onChange=${(e) => setStatus(e.target.value)}><option value="all">상태 전체</option><option value="current">진행중</option><option value="pending">예정·대기</option><option value="done">확정</option></select><${Ic} n="chevron" /></label>
        </div></section>
        <${DateScroller} />
        <section class="ci-day-card">
          <div class="ci-day-l"><${Ic} n="calendar" cls="b" /><div><strong>${shortDateLabel()} 대회 일정</strong><small>${site.campaign?.timeTBD ? "요강 기준 종목 · 경기 시각 미정" : "대회 당일 경기 일정"}</small></div></div>
          <div class="ci-day-r"><div><small>표시 종목</small><strong>${total}<em>개</em></strong></div><span><${Ic} n="pin" />${meetVenue()}</span></div>
        </section>
        <div class="ci-sched-list">${list.length ? list.map((ev) => html`<${ScheduleRow} key=${ev.id} ev=${ev} fav=${favs.has(-ev.id)} onFav=${() => toggleFav(-ev.id)} />`) : html`<${Empty} h="조건에 맞는 경기가 없습니다" p="다른 필터를 선택해 주세요." ><button class="ci-btn ghost" onClick=${() => { setDist("all"); setDivision("all"); setStatus("all"); }}>필터 초기화</button><//>`}</div>
        <a class="ci-wide-link" href="#results">경기 결과 보기 <${Ic} n="arrow" /></a>
      </main>
      <${Footer} />
    </div>`;
  }

  /* =================================================================
   * EVENT / LIVE (목업 3)
   * ================================================================= */
  function LiveTable({ view }) {
    const heat = view.heats.find((x) => x.heat === view.liveHeat) || view.heats[0];
    if (!heat) return null;
    const rows = heat.done ? heat.ranking : heat.lanes;
    const now = new Date();
    const hhmmss = [now.getHours(), now.getMinutes(), now.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
    return html`<section class="ci-live-results">
      <div class="ci-sec-head"><h2><${Ic} n="trophy" cls="b" />실시간 경기 결과</h2><span class="ci-live-upd">마지막 업데이트 ${hhmmss} <i class="ci-live-dot" aria-hidden="true"></i><${Ic} n="refresh" /></span></div>
      <div class="ci-rtable">
        <div class="ci-rtable-head"><span>레인</span><span>배번</span><span>선수명</span><span>소속팀</span><span>기록</span><span>순위</span></div>
        ${rows.map((r) => {
          const place = heat.done ? r.place : null;
          return html`<a class="ci-rtable-row" key=${r.key || r.athleteId} href=${"#athlete/" + r.athleteId}>
            <span class="ci-lane">${r.lane}</span><span class="ci-bib">${bibN(r.athleteId)}</span>
            <span class="ci-rname">${r.name}</span><span class="ci-rclub">${r.clubShort || r.club}</span>
            <span class="ci-rtime">${r.hasResult ? (r.timeText || r.dnx || "—") : "—"}</span>
            <span class="ci-rrank">${typeof place === "number" ? html`<${Rank} place=${place} />` : (r.dnx ? html`<span class="ci-rank dnx">${r.dnx}</span>` : html`<span class="ci-rank">—</span>`)}</span>
          </a>`;
        })}
      </div>
    </section>`;
  }
  function EventDetail({ id, fromHome, onMenu }) {
    const view = source.eventView(id);
    if (!view) return html`<${NotFound} onMenu=${onMenu} />`;
    const ev = view.event;
    const s = eventStatus(ev);
    const heat = view.heats.find((x) => x.heat === view.liveHeat) || view.heats[0];
    const live = isLiveEv(ev) && s.cat !== "done";
    const hasRecords = meetHasRecords();
    const nx = nextEvent();
    return html`<div class="ci-page">
      <${SubHero} kind=${fromHome ? "live" : "event"} title=${live ? twoTone("실시간", "경기 현황") : "경기 현황"} subtitle=${html`${meetTitle()}<br />${meetVenue()}${live || !isCurrentMeet() || !site.campaign?.timeTBD ? "" : " · 경기 시각 미정"}`} back=${fromHome ? "#home" : "#schedule"} backLabel=${fromHome ? "대회 홈" : "대회 일정"} crumb=${(fromHome ? "대회 홈" : "대회 일정") + " › 경기 상세"} onMenu=${onMenu} />
      <main class="ci-content">
        <${DataProvenance} />
        <section class="ci-event-card"><div class="ci-event-top">
          <div class="ci-event-no"><small>경기번호</small><strong>${ev.no}</strong><span class="ci-event-skate"><${Ic} n="trophy" /></span></div>
          <div class="ci-event-copy">
            <div class="ci-event-title-row"><h2>${ev.name}</h2>${live ? html`<span class="ci-livepill"><${Ic} n="live" />LIVE</span>` : html`<span class=${"ci-chip " + s.cls}>${s.label}</span>`}</div>
            <div class="ci-event-meta"><span><${Ic} n="calendar" />${meetDate()} ${scheduleTimes()[ev.id] || ""}</span><span><${Ic} n="pin" />${meetVenue()}</span></div>
            <div class="ci-event-heatline">
              <div class="ci-heat-info">
                <span>${view.lineupPending ? "진출자 확정 후 편성" : !view.heats.length ? "출전 명단·조 편성 미등록" : (heat?.heat || 1) + "조 / " + view.heats.length + "조"}</span>
                ${view.lineupPending ? null : html`<div class="ci-heat-bar" aria-hidden="true">${view.heats.map((x, i) => html`<i key=${i} class=${x.heat <= (heat?.heat || 1) ? "on" : ""}></i>`)}</div>`}
              </div>
            </div>
          </div>
        </div></section>
        ${view.lineupPending
          ? html`<${Empty} h="최강전 출전 명단을 기다리고 있습니다" p="앞선 경기의 결과가 확정되면 출전 선수가 표시됩니다." />`
          : hasRecords ? html`<${LiveTable} view=${view} />
            <div class="ci-sec-head sub"><h2><${Ic} n="clock" cls="b" />다음 경기 안내</h2><span>이어서 진행됩니다.</span></div>
            ${nx ? html`<a class="ci-next-card" href=${"#event/" + nx.id}><div class="ci-next-no">제${Number(nx.no)}경기</div><div class="ci-next-main"><strong>${nx.name}</strong><span><${Ic} n="calendar" />${meetDate()} ${scheduleTimes()[nx.id] || ""}</span><span><${Ic} n="pin" />${meetVenueShort()}</span></div><${Ic} n="chevron" cls="go" /></a>` : null}`
          : html`<${Empty} h="아직 게시된 경기 기록이 없습니다" p="출전 명단·조 편성·경기 순서와 시작 시각은 공식 안내 후 표시합니다."><a class="ci-btn ghost" href="#schedule">대회 종목 안내</a><//>`}
        <${StoryBanner} compact=${true} />
      </main>
      <${Footer} />
    </div>`;
  }

  /* =================================================================
   * RESULTS (목업 4)
   * ================================================================= */
  function ResultCard({ ev, featured }) {
    const view = source.eventView(ev.id);
    const s = eventStatus(ev);
    const podium = view.overall.filter((r) => r.hasResult && typeof r.overallPlace === "number").sort((a, b) => a.overallPlace - b.overallPlace).slice(0, 3);
    const rows = podium.length ? podium : view.overall.slice(0, 3);
    return html`<section class=${"ci-result-card " + (featured ? "feat" : "")}>
      <a class="ci-result-head" href=${"#event/" + ev.id}><div><strong>${ev.name}</strong><span><${Ic} n="calendar" />${meetDate()} ${scheduleTimes()[ev.id] || ""} · <${Ic} n="pin" />${meetVenue()}</span></div><span class=${"ci-chip " + s.cls}>${s.label}</span></a>
      ${view.lineupPending ? html`<p class="ci-quiet">앞선 경기 확정 후 출전 명단이 표시됩니다.</p>`
        : html`<div class=${"ci-podium n" + rows.length}>${rows.map((r, i) => {
            const place = typeof r.overallPlace === "number" ? r.overallPlace : i + 1;
            return html`<a class="ci-podium-row" key=${r.athleteId} href=${"#athlete/" + r.athleteId}><span class="ci-podium-top"><${Rank} place=${place} /><${Avatar} cls="sm" /></span><strong class="ci-podium-name">${r.name}</strong><small class="ci-podium-club">${r.clubShort || r.club}</small><em>${r.hasResult ? (r.timeText || r.dnx || "—") : "기록 대기"}</em></a>`;
          })}</div>`}
    </section>`;
  }
  function Results({ onMenu }) {
    const [resStatus, setResStatus] = useState("confirmed");
    const [division, setDivision] = useState("all");
    const [kind, setKind] = useState("all");
    const [q, setQ] = useState("");
    const m = medalTotals();
    const list = events().filter((ev) => {
      const s = eventStatus(ev);
      const match = !q || (ev.name + " " + ev.no + " " + ev.dist + " " + ev.kind).toLowerCase().includes(q.trim().toLowerCase());
      const statusOk = resStatus === "confirmed" ? s.cat === "done" : (s.cat !== "done" && (isLiveEv(ev) || ev.progress.done > 0));
      return match && statusOk && (division === "all" || eventDivision(ev) === division) && (kind === "all" || ev.kind === kind);
    });
    return html`<div class="ci-page">
      <${SubHero} kind="results" title=${twoTone("경기", "결과")} subtitle="땀과 노력이 만들어낸 빛나는 기록을 만나보세요." onMenu=${onMenu} />
      <main class="ci-content">
        <${DataProvenance} />
        <section class="ci-res-tools"><div class="ci-sched-selects cols-3">
          <label class="ci-select"><${Ic} n="calendar" /><select value="cur" onChange=${() => {}}><option value="cur">${meetDate()}</option></select><${Ic} n="chevron" /></label>
          <label class="ci-select"><${Ic} n="users" /><select value=${division} onChange=${(e) => setDivision(e.target.value)}><option value="all">전체 부문</option>${divisionList().map((d) => html`<option key=${d} value=${d}>${d}</option>`)}</select><${Ic} n="chevron" /></label>
          <label class="ci-select"><${Ic} n="flag" /><select value=${kind} onChange=${(e) => setKind(e.target.value)}><option value="all">전체 종목</option>${kindList().map((k) => html`<option key=${k} value=${k}>${k}</option>`)}</select><${Ic} n="chevron" /></label>
        </div>
        <div class="ci-seg" role="group" aria-label="결과 상태"><button aria-pressed=${resStatus === "confirmed"} onClick=${() => setResStatus("confirmed")}>확정 결과</button><button aria-pressed=${resStatus === "open"} onClick=${() => setResStatus("open")}>잠정 결과</button></div>
        <label class="ci-select ci-res-search"><${Ic} n="search" /><input type="search" placeholder="선수명 또는 소속팀을 검색하세요." value=${q} onChange=${(e) => setQ(e.target.value)} /></label>
        </section>
        <section class="ci-medal-card">
          <div class="ci-medal-lead"><${Ic} n="trophy" cls="b" /><div><strong>대회 하이라이트</strong><small>선수들의 빛나는 성과를<br />한눈에 확인하세요</small></div></div>
          <div class="ci-medals">
            <div class="ci-medal gold"><span class="ci-medal-ic"><img src=${MEDAL.g} alt="" /></span><span class="ci-medal-txt"><strong>${m.g}</strong><small>금메달</small></span></div>
            <div class="ci-medal silver"><span class="ci-medal-ic"><img src=${MEDAL.s} alt="" /></span><span class="ci-medal-txt"><strong>${m.s}</strong><small>은메달</small></span></div>
            <div class="ci-medal bronze"><span class="ci-medal-ic"><img src=${MEDAL.b} alt="" /></span><span class="ci-medal-txt"><strong>${m.b}</strong><small>동메달</small></span></div>
          </div>
        </section>
        <div class="ci-result-list">${list.length ? list.map((ev, i) => html`<${ResultCard} key=${ev.id} ev=${ev} featured=${i === 0} />`) : html`<${Empty} h=${resStatus === "confirmed" ? "확정된 경기 결과가 없습니다" : "진행 중인 경기가 없습니다"} p=${resStatus === "confirmed" ? "심판이 모든 조의 기록을 확정하면 표시됩니다." : "일정에서 출전 명단을 확인해 주세요."}><a class="ci-btn ghost" href="#schedule">대회 일정 보기</a><//>`}</div>
        <a class="ci-wide-link" href="#schedule">더 많은 경기 결과 보기 <${Ic} n="arrow" /></a>
      </main>
      <${Footer} />
    </div>`;
  }

  /* =================================================================
   * ATHLETES (목업 5)
   * ================================================================= */
  function Featured({ a, fav, onFav }) {
    const dists = [...new Set(athleteEntries(a.id).map((e) => e.ev.dist))].slice(0, 4);
    return html`<article class="ci-ath-feat">
      <div class="ci-ath-feat-photo"><${Avatar} cls="xl" /><span class="ci-feat-tag"><${Ic} n="star-fill" />추천 선수</span></div>
      <div class="ci-ath-feat-body">
        <p class="ci-feat-quote">“더 빠른 내일을 위해”</p>
        <div class="ci-feat-head">
          <div class="ci-feat-idn"><div class="ci-feat-name"><strong>${a.name}</strong><${Ic} n="verify" cls="vf" /></div><p class="ci-feat-club">${a.club}</p></div>
          <div class="ci-feat-meta"><span class="ci-ath-bib big">#${bibN(a.id)}</span><span class="ci-chip soft">${catLabel[athleteCategory(a)]}</span></div>
        </div>
        <div class="ci-feat-dists"><small>주요 출전 종목</small>${dists.length ? dists.map((d) => html`<em key=${d}>${d}</em>`) : html`<em>편성 대기</em>`}</div>
        <a class="ci-feat-open" href=${"#athlete/" + a.id}>선수 상세 · 시합 알림 설정 <${Ic} n="arrow" /></a>
      </div>
      <button class="ci-feat-heart" type="button" aria-label="찜하기" aria-pressed=${fav} onClick=${onFav}><${Ic} n=${fav ? "heart-fill" : "heart"} /><span>찜하기</span></button>
    </article>`;
  }
  function AthleteRow({ a, rank, fav, onFav }) {
    const dists = [...new Set(athleteEntries(a.id).map((e) => e.ev.dist))].slice(0, 2);
    return html`<a class="ci-ath-row" href=${"#athlete/" + a.id}>
      <span class="ci-ath-rank">${rank}</span><${Avatar} />
      <span class="ci-ath-main"><strong>${a.name}</strong><small>${a.club}</small></span>
      <span class="ci-chip soft">${catLabel[athleteCategory(a)]}</span>
      <span class="ci-ath-bib">#${bibN(a.id)}</span>
      <span class="ci-ath-dists">${dists.map((d) => html`<em key=${d}>${d}</em>`)}</span>
      <button class="ci-heart" type="button" aria-label="관심 선수" aria-pressed=${fav} onClick=${(e) => { e.preventDefault(); onFav(); }}><${Ic} n=${fav ? "heart-fill" : "heart"} /></button>
    </a>`;
  }
  function Athletes({ onMenu, favs, toggleFav }) {
    const [cat, setCat] = useState("all");
    const [q, setQ] = useState("");
    const [sort, setSort] = useState("name");
    const [favOnly, setFavOnly] = useState(false);
    const cats = ["all", "kinder", "elementary", "middle", "high", "adult", "special"];
    const list = data.athletes.filter((a) =>
      (!q || (a.name + " " + a.club + " " + a.id).toLowerCase().includes(q.trim().toLowerCase())) &&
      (!favOnly || favs.has(a.id)) && (cat === "all" || athleteCategory(a) === cat))
      .sort((a, b) => sort === "bib" ? a.id - b.id : a.name.localeCompare(b.name, "ko-KR"));
    return html`<div class="ci-page">
      <${SubHero} kind="athletes" title=${twoTone("선수", "찾기")} subtitle=${html`당신이 응원하는 선수를 찾아보세요.<span class="ci-sub-desc">인라인으로 하나 되는 선수들,<br />그 열정을 지금 바로 만나보세요.</span>`} onMenu=${onMenu} />
      <main class="ci-content">
        <${DataProvenance} />
        <section class="ci-ath-tools">
          <label class="ci-search-big"><${Ic} n="search" /><input type="search" placeholder="선수 이름, 소속팀을 검색하세요." value=${q} onChange=${(e) => setQ(e.target.value)} /><span class="ci-search-go">검색</span></label>
          <p class="ci-alarm-hint">선수를 선택하면 다음 시합의 5경기 전 알림을 설정할 수 있습니다.</p>
          <div class="ci-pills" role="group" aria-label="선수 부문">${cats.map((c) => html`<button key=${c} aria-pressed=${cat === c} onClick=${() => setCat(c)}>${catLabel[c]}</button>`)}</div>
        </section>
        ${list.length ? html`<div>
          <div class="ci-ath-count"><span>총 <strong>${list.length}명</strong>의 선수를 찾았습니다.</span><div class="ci-ath-count-r"><label class="ci-select mini"><select value=${sort} onChange=${(e) => setSort(e.target.value)}><option value="name">이름순</option><option value="bib">배번순</option></select><${Ic} n="chevron" /></label></div></div>
          <${Featured} a=${list[0]} fav=${favs.has(list[0].id)} onFav=${() => toggleFav(list[0].id)} />
          <div class="ci-ath-list">${list.slice(1).map((a, i) => html`<${AthleteRow} key=${a.id} a=${a} rank=${i + 2} fav=${favs.has(a.id)} onFav=${() => toggleFav(a.id)} />`)}</div>
        </div>` : html`<div><div class="ci-ath-count"><span>검색 결과 <strong>0명</strong></span></div><${Empty} h="찾으시는 선수가 없습니다" p="선수 이름, 소속 또는 배번을 다시 확인해 주세요."><button class="ci-btn ghost" onClick=${() => { setQ(""); setCat("all"); setFavOnly(false); }}>검색 초기화</button><//></div>`}
        <a class="ci-follow-banner" href="#athletes"><img class="ci-follow-bg" src=${STORY_IMG} alt="" aria-hidden="true" /><div class="ci-follow-txt"><strong>응원할 선수를 찾아보세요</strong><span>선수 화면에서 다가올 시합 알림을 켤 수 있습니다.</span></div><span class="ci-follow-hand">함께하는<br />더 뜨거운 응원!</span><span class="ci-follow-go"><${Ic} n="arrow" cls="go" /></span></a>
      </main>
      <${Footer} />
    </div>`;
  }

  /* =================================================================
   * ATHLETE DETAIL (목업 6)
   * ================================================================= */
  function AthleteDetail({ id, onMenu, favs, toggleFav, alarms, toggleAlarm }) {
    const [tab, setTab] = useState("record");
    const a = data.athletes.find((x) => x.id === id);
    if (!a) return html`<${NotFound} onMenu=${onMenu} />`;
    const entries = athleteEntries(id);
    const best = bestTime(id);
    const fav = favs.has(id);
    const recorded = entries.flatMap((x) => x.rows).filter((r) => r.hasResult && !r.provisional).length;
    const next = entries.map(({ ev }) => ({ ev, remaining: RaceAlerts.distance(events(), source.currentEventId(), ev.id) })).find(({ remaining }) => remaining != null && remaining >= 0);
    return html`<div class="ci-page ci-prof-page">
      <section class="ci-prof-hero">
        <img src=${heroImg("athlete")} alt="" aria-hidden="true" />
        <${Header} onDark=${true} onMenu=${onMenu} />
        <div class="ci-prof-copy">
          <a class="ci-prof-back" href="#athletes" aria-label="선수 목록으로"><${Ic} n="back" /></a>
          <h1 tabindex="-1">${a.name}</h1>
          <p class="ci-prof-roman">${romanizeName(a.name)}</p>
          <p class="ci-prof-team">${a.club} <${Ic} n="arrow" /></p>
          <dl class="ci-prof-facts">
            <div><dt><${Ic} n="users" />종목</dt><dd>스피드 인라인</dd></div>
            <div><dt><${Ic} n="flag" />세부종목</dt><dd>${[...new Set(entries.map((e) => e.ev.dist))].join(" · ") || "편성 대기"}</dd></div>
            <div><dt>#배번호</dt><dd>${bibN(id)}</dd></div>
          </dl>
          <p class="ci-prof-hand">“오늘도,<br />더 빠른 내가 되기 위해<br />달립니다.”</p>
        </div>
      </section>
      <main class="ci-content ci-prof">
        <section class="ci-prof-stats">
          <div><span class="ci-stat-ic"><${Ic} n="clock" /></span><small>개인 최고기록</small><strong>${best ? best.timeText : "—"}</strong><em>${best ? best.dist : "기록 대기"}</em></div>
          <div><span class="ci-stat-ic"><${Ic} n="trophy" /></span><small>이번 대회 출전</small><strong>${entries.length}</strong><em>경기</em></div>
          <div><span class="ci-stat-ic"><${Ic} n="verify" /></span><small>확정 기록</small><strong>${recorded}</strong><em>건</em></div>
          <div><span class="ci-stat-ic"><${Ic} n="users" /></span><small>소속팀</small><strong class="sm">${a.club}</strong><em>인라인팀</em></div>
        </section>
        <section class="ci-alarm-card" aria-label="선수 시합 알림">
          <div><span class="ci-alarm-kicker">다가올 시합</span><strong>${next ? `제${Number(next.ev.no)}경기 · ${next.ev.name}` : "현재 확정된 다음 출전 경기가 없습니다"}</strong><p>${next ? (next.remaining ? `현재 경기에서 ${next.remaining}경기 후 시합입니다.` : "현재 경기입니다.") : "추후 출전이 확정되면 알림 대상에 포함됩니다."}</p></div>
          ${isCurrentMeet() ? html`<button type="button" aria-pressed=${alarms.has(id)} onClick=${() => toggleAlarm(id)}>${alarms.has(id) ? "5경기 전 알림 끄기" : "5경기 전 알림 켜기"}</button>` : null}
          <small>현재 경기 번호가 바뀌면 이 앱에서 알려드립니다. 브라우저 알림은 허용한 기기에서만 표시되며 앱을 열어 두어야 합니다.</small>
        </section>
        <div class="ci-seg wide" role="group" aria-label="선수 정보"><button aria-pressed=${tab === "record"} onClick=${() => setTab("record")}>기록</button><button aria-pressed=${tab === "about"} onClick=${() => setTab("about")}>소개</button><button aria-pressed=${tab === "entries"} onClick=${() => setTab("entries")}>출전</button></div>
        ${tab === "about"
          ? html`<section class="ci-prof-sec"><div class="ci-sec-head"><h2>선수 소개</h2></div><dl class="ci-prof-about"><div><dt>이름</dt><dd>${a.name}</dd></div><div><dt>소속</dt><dd>${a.club}</dd></div><div><dt>부문</dt><dd>${a.grade} · ${a.gender}</dd></div><div><dt>배번</dt><dd>#${bibN(id)}</dd></div><div><dt>출전 경기</dt><dd>${entries.length}경기</dd></div></dl></section>`
          : html`<section class="ci-prof-sec"><div class="ci-sec-head"><h2><${Ic} n="calendar" cls="b" />이번 대회 출전 경기</h2><a href="#schedule">전체보기 <${Ic} n="arrow" /></a></div>
            <div class="ci-prof-entries">${entries.length ? entries.map(({ ev, rows }) => {
              const r = rows[0]; const s = eventStatus(ev);
              const when = meetDate().replace(/^\s*\d{4}\.\s*/, "");
              const stat = r.dnx || (r.hasResult ? (r.provisional ? "잠정" : "확정") : (meetStarted() ? s.label : "출전예정"));
              return html`<a class="ci-prof-entry" key=${ev.id} href=${"#event/" + ev.id}>
                <span class="ci-pe-when">${when}<br />${scheduleTimes()[ev.id] || ""}</span>
                <span class="ci-pe-info"><strong>${ev.name}</strong><small>${meetVenue()}</small></span>
                <span class=${"ci-chip " + (r.hasResult ? (r.provisional ? "prov" : "done") : s.cls)}>${stat}</span>
              </a>`;
            }) : html`<${Empty} h="출전 경기 편성 대기" p="편성이 등록되면 표시됩니다." />`}</div></section>`}
        <section class=${"ci-cheer" + (fav ? " is-on" : "")}>
          <img class="ci-cheer-bg" src=${STORY_IMG} alt="" aria-hidden="true" />
          <p class="ci-cheer-copy"><span class="ci-cheer-hand">${a.name} 선수를</span><span class="ci-cheer-hand">함께 응원해주세요!</span></p>
          <button class="ci-cheer-btn" type="button" aria-pressed=${fav} onClick=${() => toggleFav(id)}><${Ic} n=${fav ? "heart-fill" : "heart"} /><span>${fav ? "응원 중" : "응원하기"}</span> <${Ic} n="arrow" /></button>
        </section>
      </main>
      <${Footer} />
    </div>`;
  }

  /* =================================================================
   * simple pages
   * ================================================================= */
  function Notices({ onMenu }) {
    const pub = notices();
    return html`<div class="ci-page"><${SubHero} kind="notices" title="공지사항" subtitle="대회 운영 소식을 확인하세요." onMenu=${onMenu} />
      <main class="ci-content">${pub.length ? html`<div class="ci-notice-list boxed">${pub.map((n) => html`<${NoticeRow} key=${n.id} n=${n} tag=${n.isNew ? "중요" : "안내"} />`)}</div>` : html`<${Empty} h="등록된 공지가 없습니다" p="주최 측에서 공개한 공지는 이곳에 표시됩니다." />`}</main><${Footer} /></div>`;
  }
  function NoticeDetail({ id, onMenu }) {
    const n = notices().find((x) => String(x.id) === String(id));
    if (!n) return html`<${NotFound} onMenu=${onMenu} />`;
    return html`<div class="ci-page"><${SubHero} kind="notices" title="공지사항" subtitle="" back="#notices" backLabel="공지 목록" onMenu=${onMenu} />
      <main class="ci-content"><article class="ci-article"><span class=${"ci-notice-tag " + (n.isNew ? "hot" : "")}>${n.isNew ? "중요" : "안내"}</span><h2>${n.title}</h2><time>${n.date || ""}</time><p>${n.body}</p></article></main><${Footer} /></div>`;
  }
  function Participation({ onMenu }) {
    const p = site.participation || {};
    const rows = [["대회 일정", meetDate()], ["대회 장소", meetVenue()], ["참가 자격", p.eligibility || "확인 후 안내합니다."], ["신청 기간", p.period || "확인 중"], ["신청 방법", p.instructions || "확인 중"], ["문의", p.contact || "확인 중"]];
    return html`<div class="ci-page"><${SubHero} kind="participation" title="참가안내" subtitle="참가 자격·접수 일정·신청 방법" onMenu=${onMenu} />
      <main class="ci-content"><section class="ci-info-card ci-participation-card">
        <div class="ci-participation-status"><span class="ci-status-pill closed">${p.status === "closed" ? "접수 종료" : "접수 안내"}</span><div><h2>${p.statusTitle || "참가신청 안내"}</h2><p>${p.statusBody || "공식 접수처를 확인해 주세요."}</p></div></div>
        <dl class="ci-participation-facts">${rows.map(([t, d]) => html`<div key=${t}><dt>${t}</dt><dd>${d}</dd></div>`)}</dl>
      </section></main><${Footer} /></div>`;
  }
  function MeetRules({ onMenu }) {
    const g = site.meetGuide || {};
    const facts = g.facts || [["대회", meetTitle()], ["일시", meetDate()], ["장소", meetVenue()]];
    return html`<div class="ci-page"><${SubHero} kind="meetRules" title="대회요강" subtitle=${meetTitle()} onMenu=${onMenu} />
      <main class="ci-content ci-rules-page">
        <section class="ci-info-card"><h2>대회 개요</h2><dl>${facts.map(([label, value]) => html`<div key=${label}><dt>${label}</dt><dd>${value}</dd></div>`)}</dl></section>
        ${(g.eventTable || []).length ? html`<section class="ci-info-card"><h2>경기 종목</h2><div class="ci-rules-table"><table><thead><tr><th>부별</th><th>학년</th><th>성별</th><th>종목</th></tr></thead><tbody>${g.eventTable.map(([div, grade, gender, dist], i) => html`<tr key=${i}><th scope="row">${div}</th><td>${grade}</td><td>${gender}</td><td>${dist}</td></tr>`)}</tbody></table></div>${g.eventTableNote ? html`<p>${g.eventTableNote}</p>` : null}</section>` : null}
        ${(g.sections || []).map((sec) => html`<section class="ci-info-card" key=${sec.title}><h2>${sec.title}</h2><ul class="ci-rules-list">${sec.items.map((t, i) => html`<li key=${i}>${t}</li>`)}</ul></section>`)}
        <section class="ci-info-card"><h2>안전과 참가 준비</h2><a class="ci-btn" href="#race-guide">시합 규칙 쉽게보기 <${Ic} n="arrow" /></a></section>
        <p class="ci-rules-note">${g.sourceNote || "주최 측 요강이 등록되면 표시됩니다."}</p>
      </main><${Footer} /></div>`;
  }
  function RaceGuide({ onMenu }) {
    const rules = [
      ["30분 전", "경기장 집합", "선수는 경기 개시 30분 전에 경기장에 집합해야 합니다. (요강 5-(1))"],
      ["장비", "안전모와 보호장비", "안전모와 보호장비를 반드시 착용하세요. 착용하지 않으면 출전할 수 없습니다.\n유치부는 이름표와 보호대를 반드시 착용하며, 스케이트는 피트니스로 합니다(레이싱 제외)."],
      ["복장", "유니폼 착용", "유니폼을 착용해야 합니다. 학교운동복과 각 단체 운동복은 허용됩니다."],
      ["경기", "오픈레이스", "전 종목 오픈레이스로 경기합니다. 1인 2종목, 종목당 2명 이내로 각 학년별로 참가합니다."],
      ["출발", "신호 뒤에 출발", "출발 심판의 지시를 듣고 신호가 날 때까지 멈춰 있으세요. (일반 경기규정)"],
      ["주행", "밀거나 잡지 않기", "경기 도중 다른 선수를 밀거나 잡으면 퇴장입니다. (요강 5-(6))"],
      ["추월", "1바퀴 추월 시 퇴장", "경기 도중 선두에게 1바퀴 추월당하면 퇴장합니다. 단, 등위 안에 든 선수는 예외입니다. (요강 5-(7))"],
      ["결승", "앞 스케이트의 바퀴", "순위는 앞 스케이트의 첫 바퀴가 결승선을 통과하는 순간으로 판단합니다. (일반 경기규정)"],
      ["이의", "15분 이내 서면 신청", "판정에 이의가 있으면 15분 이내에 대표자 명의로 서면 신청합니다. 재판결정에는 이의를 제기할 수 없습니다."],
      ["계주", "1,600m 계주", "초등부 혼성계주·중등부 계주·고등부 계주는 1,600m입니다. 교대 방법은 현장 심판 안내를 따르세요."],
    ];
    return html`<div class="ci-page"><${SubHero} kind="raceGuide" title="시합 규칙 쉽게보기" subtitle="처음 출전하는 선수와 보호자를 위한 안내" onMenu=${onMenu} />
      <main class="ci-content ci-rules-page"><p class="ci-rules-note">이 안내는 ${meetTitle()} 참가요강과 스피드 경기규정을 쉽게 설명한 것입니다. 경기규칙은 대한롤러스포츠연맹 규칙에 준하며, 현장 심판의 지시와 대회 운영 안내를 따르세요.</p>
        ${rules.map(([step, title, body], i) => html`<section class="ci-info-card ci-rule-step" key=${step}><span>${String(i + 1).padStart(2, "0")} · ${step}</span><h2>${title}</h2><p>${body}</p></section>`)}
        <section class="ci-info-card ci-code-guide"><h2>경기 결과 코드</h2><p>이 사이트에서 사용하는 표기 중 고고인라인 용어 안내에 설명된 코드입니다.</p><dl>
          <div><dt>DNS · Did Not Start</dt><dd>출발하지 않음</dd></div>
          <div><dt>DNF · Did Not Finish</dt><dd>출발했으나 완주하지 못함</dd></div>
          <div><dt>DQ · Disqualified</dt><dd>실격 처리</dd></div>
        </dl><p class="ci-code-source">약어 설명은 <a href="https://gogoinline.com/results/jemnan-inline-rules" target="_blank" rel="noopener noreferrer">고고인라인 경기 용어 안내</a>를 참고해 이 대회 화면에 맞게 정리했습니다. REL 등 다른 표기는 이 대회 심판에게 뜻을 확인하세요. 기록·순위와 판정은 대회요강 및 현장 심판 기록을 따릅니다.</p></section>
        <section class="ci-info-card"><h2>근거 자료</h2><p>제공된 ${meetTitle()} 참가요강 · <a href="https://koreaskate.or.kr/sports/speed/" target="_blank" rel="noopener noreferrer">대한롤러스포츠연맹 스피드 안내</a></p></section>
      </main><${Footer} /></div>`;
  }
  // 오시는 길: Leaflet + OpenStreetMap(키 불필요)을 필요할 때만 불러온다. 실패하면 지도 앱 링크만 남는다.
  const LEAFLET = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/";
  let leafletLoading = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement("link"); css.rel = "stylesheet"; css.href = LEAFLET + "leaflet.css"; document.head.appendChild(css);
      const js = document.createElement("script"); js.src = LEAFLET + "leaflet.js"; js.async = true;
      js.onload = () => resolve(window.L); js.onerror = () => { leafletLoading = null; reject(new Error("leaflet")); };
      document.head.appendChild(js);
    });
    return leafletLoading;
  }
  function VenueMap({ v }) {
    const ref = useRef(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (!(v.lat && v.lng)) return undefined;
      let map = null, alive = true;
      loadLeaflet().then((L) => {
        if (!alive || !ref.current) return;
        map = L.map(ref.current, { scrollWheelZoom: false, tap: false }).setView([v.lat, v.lng], 16);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(map);
        L.circleMarker([v.lat, v.lng], { radius: 11, color: "#ffffff", weight: 3, fillColor: "#0b63f6", fillOpacity: 1 }).addTo(map).bindTooltip(v.name, { permanent: true, direction: "top", offset: [0, -12] });
      }).catch(() => alive && setFailed(true));
      return () => { alive = false; if (map) map.remove(); };
    }, [v.lat, v.lng]);
    if (!(v.lat && v.lng) || failed) return html`<div class="ci-map-ph"><${Ic} n="map" /><p>${failed ? "지도를 불러오지 못했습니다. 아래 지도 앱 버튼을 이용하세요." : "지도 위치 미등록"}</p></div>`;
    return html`<div class="ci-venue-map" ref=${ref} role="img" aria-label=${v.name + " 위치 지도"}></div>`;
  }
  function Guide({ onMenu }) {
    const v = site.venue || {};
    const name = v.name || meetVenue();
    const q = encodeURIComponent(v.mapQuery || name);
    const nq = encodeURIComponent(name);
    const links = v.lat && v.lng ? [
      ["네이버지도", "https://map.naver.com/p/search/" + q, "naver"],
      ["카카오맵", `https://map.kakao.com/link/map/${nq},${v.lat},${v.lng}`, "kakao"],
      ["카카오 길찾기", `https://map.kakao.com/link/to/${nq},${v.lat},${v.lng}`, "kakao"],
      ["T맵 (앱)", `tmap://route?goalname=${nq}&goalx=${v.lng}&goaly=${v.lat}`, "tmap"],
      ["OpenStreetMap", `https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lng}#map=17/${v.lat}/${v.lng}`, "osm"],
    ] : [];
    return html`<div class="ci-page"><${SubHero} kind="guide" title="오시는 길" subtitle="경기장 위치와 교통 정보를 확인하세요." onMenu=${onMenu} />
      <main class="ci-content">
        <section class="ci-info-card"><div class="ci-guide-head"><${Ic} n="pin" cls="b" /><div><strong>${name}</strong><small>${v.address || "세부 장소는 확정 후 안내합니다."}</small></div></div>
          <${VenueMap} v=${v} />
          ${links.length ? html`<div class="ci-map-links">${links.map(([label, href, k]) => html`<a key=${k + label} class=${"ci-map-link is-" + k} href=${href} target=${href.startsWith("tmap:") ? undefined : "_blank"} rel="noopener">${label}</a>`)}</div>` : null}
          ${v.coordNote ? html`<p class="ci-guide-note">${v.coordNote} T맵 버튼은 앱이 설치된 휴대폰에서만 열립니다.</p>` : null}
        </section>
        <section class="ci-info-card"><h2>주소</h2><dl class="ci-dl">
          ${v.roadAddress ? html`<div><dt>도로명</dt><dd>${v.roadAddress}${v.postcode ? ` (우 ${v.postcode})` : ""}</dd></div>` : null}
          ${v.jibunAddress ? html`<div><dt>지번</dt><dd>${v.jibunAddress}</dd></div>` : null}
          ${v.addressNote ? html`<div><dt>참고</dt><dd>${v.addressNote}</dd></div>` : null}
        </dl></section>
        ${(v.transit || []).length ? html`<section class="ci-info-card"><h2>대중교통 · 택시</h2><ul class="ci-transit">${v.transit.map((t) => html`<li key=${t.title}><strong>${t.title}</strong><p>${t.body}</p></li>`)}</ul></section>` : null}
        <section class="ci-info-card"><h2>주차</h2><p class="ci-guide-text">${v.parking || "미확인"}</p></section>
        ${v.contact ? html`<section class="ci-info-card"><h2>문의</h2><p class="ci-guide-text">${v.contact}</p></section>` : null}
        <section class="ci-info-card"><h2>경기장 배치도</h2><p class="ci-guide-text">${v.diagram ? html`<img src=${v.diagram} alt="경기장 배치도" />` : "미등록"}</p>
          ${v.sources ? html`<p class="ci-guide-note">출처 · ${v.sources}</p>` : null}</section>
      </main><${Footer} /></div>`;
  }
  function About({ onMenu }) {
    return html`<div class="ci-page"><${SubHero} kind="about" title="대회소개" subtitle=${meetTitle()} onMenu=${onMenu} />
      <main class="ci-content"><section class="ci-info-card ci-about"><img src=${STORY_IMG} alt="가슴에 CHUNGNAM 문구가 있는 경기복을 입고 주행하는 인라인 선수들의 홍보 이미지" /><h2>${meetTitle()}</h2><p>${site.campaign?.story || "충청남도 학생과 동호인이 함께하는 인라인스피드대회입니다. 출전 선수와 경기 순서, 경기 시작 시각은 공식 안내 후 공개합니다."}</p><dl><div><dt>대회명</dt><dd>${meetTitle()}</dd></div><div><dt>일정</dt><dd>${meetDate()}</dd></div><div><dt>장소</dt><dd>${meetVenue()}</dd></div><div><dt>주최·주관</dt><dd>${site.organizer?.host || "미정"}</dd></div><div><dt>후원</dt><dd>${site.organizer?.sponsors || "미정"}</dd></div></dl></section></main><${Footer} /></div>`;
  }
  function NotFound({ onMenu }) {
    return html`<div class="ci-page"><${SubHero} kind="plain" title="정보를 찾을 수 없습니다" subtitle="" onMenu=${onMenu} />
      <main class="ci-content"><${Empty} h="요청한 정보를 찾을 수 없습니다" p="대회 홈에서 다시 선택해 주세요."><a class="ci-btn" href="#home">홈으로</a><//></main><${Footer} /></div>`;
  }

  /* =================================================================
   * App — router + state
   * ================================================================= */
  function parseHash() {
    const raw = location.hash.slice(1);
    const [name = "home", ...rest] = raw.split("/");
    let id = rest.join("/");
    try { id = decodeURIComponent(id); } catch { id = ""; }
    return { name: name || "home", id };
  }
  function App() {
    const [route, setRoute] = useState(parseHash());
    const [favs, setFavs] = useState(loadFavs);
    const [menuOpen, setMenuOpen] = useState(false);
    const alarmState = useRef(loadRaceAlertState());
    const [alarms, setAlarms] = useState(() => new Set(alarmState.current.watched));
    const [activeAlerts, setActiveAlerts] = useState([]);
    const [, tick] = useReducer((x) => x + 1, 0);

    function checkRaceAlerts() {
      if (!isCurrentMeet() || !meetStarted()) return;
      const list = events();
      const current = source.currentEventId();
      const start = new Date(meetStartMs());
      const now = new Date();
      if (now.toDateString() !== start.toDateString()) return;
      if (source.meta().waiting && current === list[0]?.id) return;
      const due = RaceAlerts.due(list, current, alarmState.current.watched, alarmState.current.notified,
        (eventId, athleteId) => source.eventView(eventId)?.overall.some((row) => row.athleteId === athleteId));
      if (!due.length) return;
      const messages = due.map((alert) => {
        alarmState.current.notified.add(alert.key);
        const athlete = data.athletes.find((item) => item.id === alert.athleteId);
        const message = RaceAlerts.message(athlete.name, alert.event, alert.remaining);
        RaceAlerts.notify("선수 시합 알림", message, alert.key, location.href.split("#")[0] + "#athlete/" + athlete.id, "../shared/race-notification-sw.js");
        return { key: alert.key, message };
      });
      saveRaceAlertState(alarmState.current);
      setActiveAlerts((prev) => [...prev, ...messages]);
    }

    useEffect(() => {
      const on = () => {
        if (location.hash === "#judge") {
          location.replace(new URL("../judge/", location.href).href);
          return;
        }
        setRoute(parseHash()); setMenuOpen(false); window.scrollTo({ top: 0 });
      };
      window.addEventListener("hashchange", on);
      return () => window.removeEventListener("hashchange", on);
    }, []);
    useEffect(() => {
      const unsubscribe = source.subscribe(() => { tick(); checkRaceAlerts(); if (announce) announce.textContent = "경기 기록이 갱신되었습니다."; });
      source.start();
      checkRaceAlerts();
      const timer = setInterval(checkRaceAlerts, 30000);
      return () => { unsubscribe(); clearInterval(timer); try { source.stop && source.stop(); } catch {} };
    }, []);
    useEffect(() => { document.body.dataset.route = route.name; }, [route.name]);

    const toggleFav = useCallback((id) => {
      setFavs((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        try { localStorage.setItem(FAV_KEY, JSON.stringify([...next].filter((n) => n > 0))); } catch {}
        return next;
      });
    }, []);
    const toggleAlarm = (id) => {
      const state = alarmState.current;
      if (state.watched.has(id)) {
        state.watched.delete(id);
        [...state.notified].filter((key) => key.startsWith(id + ":")).forEach((key) => state.notified.delete(key));
      } else {
        state.watched.add(id);
        try { if (window.Notification?.permission === "default") Promise.resolve(window.Notification.requestPermission()).catch(() => {}); } catch (_) {}
      }
      saveRaceAlertState(state);
      setAlarms(new Set(state.watched));
      checkRaceAlerts();
    };
    const onMenu = useCallback(() => setMenuOpen(true), []);
    const closeMenu = useCallback(() => setMenuOpen(false), []);

    const p = { onMenu, favs, toggleFav };
    let screen;
    switch (route.name) {
      case "schedule": screen = html`<${Schedule} ...${p} />`; break;
      case "results": screen = html`<${Results} onMenu=${onMenu} />`; break;
      case "athletes": screen = html`<${Athletes} ...${p} />`; break;
      case "live": screen = html`<${EventDetail} id=${source.currentEventId()} fromHome=${true} onMenu=${onMenu} />`; break;
      case "event": screen = html`<${EventDetail} id=${Number(route.id)} onMenu=${onMenu} />`; break;
      case "athlete": screen = html`<${AthleteDetail} id=${Number(route.id)} ...${p} alarms=${alarms} toggleAlarm=${toggleAlarm} />`; break;
      case "notice": screen = html`<${NoticeDetail} id=${route.id} onMenu=${onMenu} />`; break;
      case "notices": screen = html`<${Notices} onMenu=${onMenu} />`; break;
      case "participation": screen = html`<${Participation} onMenu=${onMenu} />`; break;
      case "meet-rules": screen = html`<${MeetRules} onMenu=${onMenu} />`; break;
      case "race-guide": screen = html`<${RaceGuide} onMenu=${onMenu} />`; break;
      case "guide": screen = html`<${Guide} onMenu=${onMenu} />`; break;
      case "about": screen = html`<${About} onMenu=${onMenu} />`; break;
      case "home": screen = html`<${Home} onMenu=${onMenu} />`; break;
      default: screen = html`<${NotFound} onMenu=${onMenu} />`;
    }
    return html`<${React.Fragment}>${screen}<${Menu} open=${menuOpen} onClose=${closeMenu} />
      ${activeAlerts.length ? html`<div class="ci-race-alerts">${activeAlerts.map((alert) => html`<div class="ci-race-alert" role="alert" key=${alert.key}><strong>${alert.message}</strong><button type="button" onClick=${() => setActiveAlerts((prev) => prev.filter((item) => item.key !== alert.key))}>닫기</button></div>`)}</div>` : null}
    </${React.Fragment}>`;
  }

  ReactDOM.createRoot(root).render(html`<${App} />`);
})();
