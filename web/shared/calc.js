/* calc.js — 계산 로직 (legacy/app.js 에서 그대로 가져옴)
 *
 * ★ 이 파일은 손으로 고치지 않는다. 생성물이다.
 *   legacy/app.js 가 바뀌면:  python web/shared/extract_calc.py
 *   어긋났는지 검사하려면:    node web/scoreboard/verify-calc.mjs
 *
 * 왜 복사인가: legacy/app.js 는 DOM 을 직접 다루는 단일 IIFE 라 <script> 로
 * 불러올 수 없다. 그래서 순위·진행·메달 계산 함수만 동일한 소스 그대로 떼어 와
 * 같은 자유변수(DATA, state, athById, evById, keyOf)를 공급하는 팩토리 클로저
 * 안에 넣었다. 로직은 한 글자도 고치지 않았다.
 *
 * 왜 공용인가: 전광판과 심판 콘솔이 같은 `1:05.87` 을 다르게 해석하면 대회가
 * 끝난다. parseTime/fmtTime/rankedHeats 는 화면마다 따로 두지 않는다.
 *
 * 출처: legacy/app.js  sha256:d9a885c33ba8eea7
 */
(function (global) {
  "use strict";

  /**
   * @param {object} DATA  window.MEET_DATA 와 같은 모양
   * @param {object} state legacy state 와 같은 모양
   *                       { results, currentEvent, qualifyCount, fitnessHeats }
   *                       — 참조를 그대로 보관하므로 호출측이 내용을 갱신하면
   *                       다음 계산부터 반영된다.
   */
  function createCalc(DATA, state) {
    var athById = Object.fromEntries(DATA.athletes.map(function (a) { return [a.id, a]; }));
    var evById = Object.fromEntries(DATA.events.map(function (e) { return [e.id, e]; }));

    function keyOf(heat, aid) {
      return heat + ":" + aid;
    }

    /* legacy/app.js L483-490 */
  function clubShort(c) {
    return (c || "")
      .replace("인라인&스키클럽", "")
      .replace("롤러스포츠클럽", "롤러")
      .replace("체련인라인교실", "체련")
      .replace("소울", "소울")
      .trim();
  }

    /* legacy/app.js L492-505 */
  function parseTime(str) {
    if (!str) return null;
    const s = String(str).trim().replace(",", ".");
    if (!s) return null;
    if (/^(dns|dnf|dq|rel)$/i.test(s)) return null;
    if (s.includes(":")) {
      const parts = s.split(":");
      if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
      if (parts.length === 3)
        return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

    /* legacy/app.js L507-515 */
  function fmtTime(sec) {
    if (sec == null || !Number.isFinite(sec)) return "—";
    if (sec >= 60) {
      const m = Math.floor(sec / 60);
      const r = sec - m * 60;
      return m + ":" + r.toFixed(2).padStart(5, "0");
    }
    return sec.toFixed(2);
  }

    /* legacy/app.js L517-542 */
  function eventEntries(ev) {
    const res = state.results[ev.id] || {};
    const heats = effectiveHeats(ev);
    const list = [];
    heats.forEach((heat, hi) => {
      (heat || []).forEach((aid, li) => {
        if (!aid) return;
        const k = keyOf(hi + 1, aid);
        const row = res[k] || {
          athleteId: aid,
          heat: hi + 1,
          lane: li + 1,
          time: "",
          rank: "",
          status: "",
        };
        list.push({ ...row, athleteId: aid, heat: hi + 1, lane: li + 1, key: k });
      });
    });
    Object.values(res).forEach((row) => {
      if (!list.some((x) => x.athleteId === row.athleteId && x.heat === row.heat)) {
        list.push({ ...row, key: keyOf(row.heat, row.athleteId) });
      }
    });
    return list;
  }

    /* legacy/app.js L544-552 */
  function effectiveHeats(ev) {
    if (ev.kind === "최강전") {
      const custom = state.fitnessHeats[ev.id];
      if (custom && custom.length) return custom;
      const auto = autoQualifiers(ev).slice(0, state.qualifyCount).map((x) => x.athleteId);
      return [auto];
    }
    return ev.heats && ev.heats.length ? ev.heats : [[]];
  }

    /* legacy/app.js L554-565 */
  function decorateEntry(row) {
    const st = (row.status || "").toUpperCase();
    const t = parseTime(row.time);
    const manual = Number(row.rank);
    return {
      ...row,
      t,
      st,
      a: athById[row.athleteId],
      manual: Number.isFinite(manual) && manual > 0 ? manual : null,
    };
  }

    /* legacy/app.js L567-573 */
  function cmpByTime(p, q) {
    if (p.t == null && q.t == null) return (p.athleteId || 0) - (q.athleteId || 0);
    if (p.t == null) return 1;
    if (q.t == null) return -1;
    if (p.t !== q.t) return p.t - q.t;
    return (p.athleteId || 0) - (q.athleteId || 0);
  }

    /* legacy/app.js L575-580 */
  function cmpHeat(p, q) {
    if (p.manual && q.manual) return p.manual - q.manual;
    if (p.manual) return -1;
    if (q.manual) return 1;
    return cmpByTime(p, q);
  }

    /* legacy/app.js L582-584 */
  function isFinished(x) {
    return (!x.st || x.st === "완주" || x.st === "OK") && (x.t != null || x.manual);
  }

    /* legacy/app.js L586-612 */
  function rankedHeats(ev) {
    const groups = {};
    eventEntries(ev).forEach((row) => {
      const e = decorateEntry(row);
      const h = e.heat || 1;
      if (!groups[h]) groups[h] = [];
      groups[h].push(e);
    });
    return Object.keys(groups)
      .map(Number)
      .sort((a, b) => a - b)
      .map((h) => {
        const entries = groups[h];
        const finished = entries.filter(isFinished).sort(cmpHeat);
        finished.forEach((x, i) => {
          x.heatPlace = x.manual || i + 1;
          x.place = x.heatPlace;
        });
        const others = entries.filter((x) => !isFinished(x));
        others.forEach((x) => {
          x.heatPlace = x.st;
          x.place = x.st;
        });
        const ordered = finished.concat(others).sort((p, q) => (p.lane || 0) - (q.lane || 0));
        return { heat: h, finished, others, all: finished.concat(others), ordered };
      });
  }

    /* legacy/app.js L614-625 */
  function rankedEvent(ev) {
    const heats = rankedHeats(ev);
    const finished = heats.flatMap((h) => h.finished).sort(cmpByTime);
    finished.forEach((x, i) => {
      x.overallPlace = i + 1;
    });
    const others = heats.flatMap((h) => h.others);
    others.forEach((x) => {
      x.overallPlace = x.st;
    });
    return { heats, finished, others, all: finished.concat(others) };
  }

    /* legacy/app.js L627-634 */
  function heatPlaceOf(ev, aid) {
    const heats = rankedHeats(ev);
    for (const h of heats) {
      const hit = h.all.find((x) => x.athleteId === aid);
      if (hit) return hit;
    }
    return null;
  }

    /* legacy/app.js L636-645 */
  function eventProgress(ev) {
    const entries = eventEntries(ev);
    if (!entries.length) return { total: 0, done: 0, status: ev.kind === "최강전" ? "대기" : "대기" };
    const done = entries.filter((x) => x.time || x.status).length;
    let status = "대기";
    if (done === 0) status = "대기";
    else if (done < entries.length) status = "진행";
    else status = "완료";
    return { total: entries.length, done, status };
  }

    /* legacy/app.js L647-683 */
  function autoQualifiers(champEv) {
    const from = champEv.qualifyFrom || [];
    const pool = [];
    from.forEach((eid) => {
      const ev = evById[eid];
      if (!ev) return;
      rankedHeats(ev).forEach((h) => {
        h.finished.forEach((row) => {
          if (row.t == null && !row.manual) return;
          pool.push({
            athleteId: row.athleteId,
            fromEvent: eid,
            fromPlace: row.heatPlace,
            heat: h.heat,
            t: row.t,
            time: row.time,
            a: row.a,
          });
        });
      });
    });
    pool.sort((p, q) => {
      const hp = typeof p.fromPlace === "number" ? p.fromPlace : 99;
      const hq = typeof q.fromPlace === "number" ? q.fromPlace : 99;
      if (hp !== hq) return hp - hq;
      if (p.t == null && q.t == null) return 0;
      if (p.t == null) return 1;
      if (q.t == null) return -1;
      return p.t - q.t;
    });
    const seen = new Set();
    return pool.filter((x) => {
      if (seen.has(x.athleteId)) return false;
      seen.add(x.athleteId);
      return true;
    });
  }

    /* legacy/app.js L1043-1048 */
  function medalKind(place) {
    if (place === 1) return "gold";
    if (place === 2) return "silver";
    if (place === 3) return "bronze";
    return null;
  }

    /* legacy/app.js L1050-1090 */
  function collectMedals() {
    const byClub = {};
    const details = [];
    DATA.events.forEach((ev) => {
      rankedHeats(ev).forEach((h) => {
        h.finished.forEach((row) => {
          const kind = medalKind(row.heatPlace);
          if (!kind || !row.a) return;
          const club = row.a.club || "무소속";
          if (!byClub[club]) byClub[club] = { club, gold: 0, silver: 0, bronze: 0, total: 0, items: [] };
          byClub[club][kind] += 1;
          byClub[club].total += 1;
          const item = {
            club,
            kind,
            place: row.heatPlace,
            athleteId: row.athleteId,
            name: row.a.name,
            evId: ev.id,
            evName: ev.name,
            heat: h.heat,
            time: row.time || (row.t != null ? fmtTime(row.t) : ""),
            champ: ev.kind === "최강전",
          };
          byClub[club].items.push(item);
          details.push(item);
        });
      });
    });
    const clubs = Object.values(byClub).sort((a, b) => {
      if (b.gold !== a.gold) return b.gold - a.gold;
      if (b.silver !== a.silver) return b.silver - a.silver;
      if (b.bronze !== a.bronze) return b.bronze - a.bronze;
      return a.club.localeCompare(b.club, "ko");
    });
    const totals = clubs.reduce((s, c) => {
      s.gold += c.gold; s.silver += c.silver; s.bronze += c.bronze; s.total += c.total;
      return s;
    }, { gold: 0, silver: 0, bronze: 0, total: 0 });
    return { clubs, totals, details };
  }

    return {
      DATA: DATA,
      state: state,
      athById: athById,
      evById: evById,
      keyOf: keyOf,
      clubShort: clubShort,
      parseTime: parseTime,
      fmtTime: fmtTime,
      eventEntries: eventEntries,
      effectiveHeats: effectiveHeats,
      decorateEntry: decorateEntry,
      isFinished: isFinished,
      rankedHeats: rankedHeats,
      rankedEvent: rankedEvent,
      heatPlaceOf: heatPlaceOf,
      eventProgress: eventProgress,
      autoQualifiers: autoQualifiers,
      medalKind: medalKind,
      collectMedals: collectMedals,
    };
  }

  global.MeetCalc = { create: createCalc, source: "legacy/app.js@d9a885c33ba8eea7" };
})(typeof window !== "undefined" ? window : globalThis);
