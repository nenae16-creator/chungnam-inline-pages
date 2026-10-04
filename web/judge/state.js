/*!
 * chungnam-inline — web/judge/state.js
 *
 * 심판 콘솔의 로컬 기록 상태.
 *
 * 저장 위치는 legacy 앱·전광판과 **같은 localStorage 키**다(`chungnam_inline_2026_v1`).
 * 전광판이 이 키를 2초마다 폴링하고 storage 이벤트도 듣는다.
 *
 * ── 전광판과의 저장 계약 (하나라도 어긋나면 전광판이 조용히 잘못 뜬다) ──
 *   1. 키 이름은 정확히 `chungnam_inline_2026_v1`
 *   2. `currentEvent` — 전광판의 "지금 경기"는 이 값 하나로 정해진다
 *   3. `fitnessHeats` — 최강전 수동 조편성. 빠지면 심판이 짠 조가 화면에서 사라진다
 *   4. `confirmed`   — { "종목id:조": ISO시각 }. 없으면 전광판이 전부 "잠정"으로 남는다
 *   그리고 셀을 비울 때는 키를 지우지 말고 **빈 문자열**을 넣는다.
 *   → persist() 가 state 를 통째로 쓴다. 일부만 덮어쓰는 경로를 만들지 않는다.
 *
 * 규칙
 *  - 입력은 **즉시** 로컬에 쓴다. 전송 성공을 기다리지 않는다.
 *  - 모든 셀 변경은 write*() 한 곳을 지난다. 발행 훅을 걸 자리가 하나다.
 *  - 순위·최강전 진출자 계산은 web/shared/calc.js 가 한다. 여기서 다시 만들지 않고,
 *    **계산 결과를 저장하지도 않는다.** 심판 콘솔은 심판이 적은 값만 쓴다.
 *
 * UMD: 브라우저에서는 window.JudgeState.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JudgeState = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STORE_KEY = "chungnam_inline_2026_v1"; // legacy/app.js 8행과 같은 키

  // legacy/app.js 71행
  function keyOf(heat, aid) {
    return heat + ":" + aid;
  }

  // 전광판(web/scoreboard/data-source.js 92행)이 읽는 확정 키와 같은 모양이다.
  function confirmKey(eid, heat) {
    return eid + ":" + heat;
  }

  /**
   * 조 마감을 sync.js 의 meet 스코프에 태울 때 쓰는 필드명.
   * cellKey → "m|confirmed:14:2" 로 조 하나가 셀 하나가 된다.
   * (sync.js 의 스코프는 result/fitness/meet 셋뿐이다. 조 마감은 조 단위 충돌 판정이
   *  맞으므로 meet 필드명에 키를 실어 셀을 쪼갰다. ★ sync·scoreboard 와 합의 필요 — 보고서 참조)
   */
  function confirmField(eid, heat) {
    return "confirmed:" + eid + ":" + heat;
  }

  function isConfirmField(field) {
    return typeof field === "string" && field.indexOf("confirmed:") === 0;
  }

  function blankRow(aid, heat, lane) {
    return {
      athleteId: aid,
      heat: heat,
      lane: lane || 1,
      time: "",
      rank: "",
      status: "",
      note: "",
    };
  }

  function create(DATA, opts) {
    opts = opts || {};
    var storage = opts.storage !== undefined ? opts.storage : safeStorage();
    var listeners = [];

    /* 리허설에서 창 두 개를 서로 다른 기기처럼 띄우려면 저장소도 갈라야 한다.
       접미사가 없으면 legacy 앱·전광판과 같은 칸을 쓴다 — 그게 운영 기본값이다. */
    var storeKey = STORE_KEY + (opts.storeKeySuffix ? "__" + opts.storeKeySuffix : "");

    /* ★ state 객체는 한 번 만들고 **절대 갈아치우지 않는다.**
       web/shared/calc.js 가 이 참조를 그대로 붙들고 계산한다.
       다시 읽어올 때도 새 객체를 만들지 않고 이 객체의 내용만 바꾼다(adopt). */
    var state = load();

    /* 계산은 전부 공용 calc.js 것을 쓴다. 심판 콘솔에 사본을 두지 않는다 —
       같은 "1:05.87" 이 전광판과 다르게 읽히면 대회가 끝난다. */
    var MeetCalc = opts.MeetCalc || (typeof globalThis !== "undefined" ? globalThis.MeetCalc : null);
    if (!MeetCalc || typeof MeetCalc.create !== "function") {
      throw new Error("JudgeState: web/shared/calc.js 를 먼저 불러와야 한다");
    }
    var calc = MeetCalc.create(DATA, state);

    function safeStorage() {
      try {
        if (typeof localStorage === "undefined") return null;
        localStorage.setItem("__probe", "1");
        localStorage.removeItem("__probe");
        return localStorage;
      } catch (e) {
        return null; // 사파리 프라이빗 등. 메모리로만 돈다.
      }
    }

    function defaultState() {
      var results = {};
      (DATA.events || []).forEach(function (ev) {
        results[ev.id] = {};
        (ev.heats || []).forEach(function (heat, hi) {
          (heat || []).forEach(function (aid, li) {
            if (!aid) return;
            results[ev.id][keyOf(hi + 1, aid)] = blankRow(aid, hi + 1, li + 1);
          });
        });
      });
      return {
        results: results,
        currentEvent: (DATA.events && DATA.events.length && DATA.events[0].id) || 1,
        qualifyCount: (DATA.meta && DATA.meta.qualifyCount) || 6,
        fitnessHeats: {},
        confirmed: {},
        updatedAt: null,
        rev: 0,
      };
    }

    function load() {
      var base = defaultState();
      if (!storage) return base;
      try {
        var raw = storage.getItem(storeKey);
        if (!raw) return base;
        var saved = JSON.parse(raw);
        return merge(base, saved);
      } catch (e) {
        return base;
      }
    }

    /** 저장본을 기본 뼈대 위에 얹는다. 페어링이 바뀌어도 기록은 살린다. */
    function merge(base, saved) {
      if (!saved || typeof saved !== "object") return base;
      Object.keys(saved.results || {}).forEach(function (eid) {
        if (!base.results[eid]) base.results[eid] = {};
        Object.keys(saved.results[eid] || {}).forEach(function (k) {
          var row = saved.results[eid][k] || {};
          base.results[eid][k] = Object.assign(
            blankRow(row.athleteId, row.heat, row.lane),
            base.results[eid][k],
            row
          );
        });
      });
      if (saved.currentEvent) base.currentEvent = saved.currentEvent;
      if (saved.qualifyCount) base.qualifyCount = saved.qualifyCount;
      base.fitnessHeats = saved.fitnessHeats || {};
      base.confirmed = saved.confirmed || {};
      base.updatedAt = saved.updatedAt || null;
      base.rev = saved.rev || 0;
      return base;
    }

    function persist() {
      state.updatedAt = new Date().toISOString();
      state.rev = (state.rev || 0) + 1;
      if (!storage) return;
      try {
        storage.setItem(storeKey, JSON.stringify(state));
      } catch (e) {
        emit({ type: "storage-error", error: e });
      }
    }

    function emit(ev) {
      listeners.forEach(function (fn) {
        try {
          fn(ev);
        } catch (e) {
          /* 화면 콜백이 터져도 기록은 이미 저장됐다 */
        }
      });
    }

    /* ── 읽기 ─────────────────────────────────────────────────────────── */

    function rowOf(eid, heat, aid) {
      var bucket = state.results[eid];
      return (bucket && bucket[keyOf(heat, aid)]) || null;
    }

    function valueOf(eid, heat, aid, field) {
      var r = rowOf(eid, heat, aid);
      return r && r[field] != null ? r[field] : "";
    }

    /**
     * 그 종목의 조 편성. 공용 calc.effectiveHeats 를 그대로 쓴다.
     * 최강전이면 fitnessHeats 의 수동 편성이 우선이고, 없으면 calc 가 진출자를 뽑아 준다.
     * 뽑아 준 결과는 **화면에만 쓰고 저장하지 않는다.**
     */
    function heatsOf(ev) {
      if (!ev) return [[]];
      var h = calc.effectiveHeats(ev);
      return h && h.length ? h : [[]];
    }

    /** 조 하나를 레인 순으로. 종이 기록지와 같은 순서다. */
    function laneRows(ev, heat) {
      var lanes = heatsOf(ev)[heat - 1] || [];
      var out = [];
      lanes.forEach(function (aid, li) {
        if (!aid) {
          out.push({ lane: li + 1, athleteId: null, athlete: null, row: blankRow(null, heat, li + 1) });
          return;
        }
        var row = rowOf(ev.id, heat, aid) || blankRow(aid, heat, li + 1);
        out.push({
          lane: li + 1,
          athleteId: aid,
          athlete: athById()[aid] || null,
          row: row,
        });
      });
      return out;
    }

    var _athIndex = null;
    function athById() {
      if (!_athIndex) {
        _athIndex = {};
        (DATA.athletes || []).forEach(function (a) {
          _athIndex[a.id] = a;
        });
      }
      return _athIndex;
    }

    /** 그 조의 입력 진행도. 순위는 세지 않는다 — 비워 두는 게 정상이라서다. */
    function heatProgress(ev, heat) {
      var rows = laneRows(ev, heat).filter(function (r) {
        return r.athleteId;
      });
      var done = rows.filter(function (r) {
        return (r.row.time || "").trim() || (r.row.status || "").trim();
      }).length;
      return { total: rows.length, done: done };
    }

    /** 종목 진행도는 공용 calc 것을 쓴다 — 전광판이 세는 것과 같은 수여야 한다. */
    function eventProgress(ev) {
      return calc.eventProgress(ev);
    }

    function isConfirmed(eid, heat) {
      return !!state.confirmed[confirmKey(eid, heat)];
    }

    /* ── 쓰기 (모든 셀 변경의 단일 통로) ──────────────────────────────── */

    /**
     * 기록 셀 하나를 쓴다.
     * 값이 그대로면 null 을 돌려준다 — 발행 큐를 늘리지 않는다(legacy 패치 P12 와 같은 규칙).
     * @returns {null|{scope,eid,heat,athleteId,field,value,oldValue}}
     */
    function writeResult(eid, heat, aid, field, value) {
      eid = +eid;
      heat = +heat;
      aid = +aid;
      if (!state.results[eid]) state.results[eid] = {};
      var k = keyOf(heat, aid);
      var prev = state.results[eid][k];
      var oldValue = prev && prev[field] != null ? prev[field] : "";
      var next = value == null ? "" : value;
      state.results[eid][k] = Object.assign(blankRow(aid, heat, (prev && prev.lane) || 1), prev, {
        athleteId: aid,
        heat: heat,
      });
      state.results[eid][k][field] = next;
      if (oldValue === next) {
        // 값이 그대로면 저장도 발행도 하지 않는다. 같은 칸에서 Tab 만 눌러도 큐가 늘면 안 된다.
        return null;
      }
      persist();
      var change = {
        scope: "result",
        eid: eid,
        heat: heat,
        athleteId: aid,
        field: field,
        value: next,
        oldValue: oldValue,
      };
      emit({ type: "local", cells: [change] });
      return change;
    }

    /** 조 마감 / 마감 해제. value 는 ISO 시각 또는 "" */
    function setConfirmed(eid, heat, at) {
      eid = +eid;
      heat = +heat;
      var key = confirmKey(eid, heat);
      var oldValue = state.confirmed[key] || "";
      var next = at || "";
      if (next) state.confirmed[key] = next;
      else delete state.confirmed[key];
      persist();
      if (oldValue === next) return null;
      var change = {
        scope: "meet",
        field: confirmField(eid, heat),
        value: next,
        oldValue: oldValue,
      };
      emit({ type: "local", cells: [change] });
      return change;
    }

    /**
     * 전광판의 "지금 경기". 이 값 하나로 대형 화면이 어느 종목을 보여줄지 정해진다.
     * 아무도 전광판을 조작하지 않으므로, 심판이 종목을 옮기면 여기도 반드시 따라와야 한다.
     */
    function setCurrentEvent(eid) {
      return setMeet("currentEvent", +eid);
    }

    function setMeet(field, value) {
      var oldValue = state[field];
      if (oldValue === value) return null;
      state[field] = value;
      persist();
      var change = { scope: "meet", field: field, value: value, oldValue: oldValue };
      emit({ type: "local", cells: [change] });
      return change;
    }

    function setFitness(eid, heats) {
      eid = +eid;
      var oldValue = state.fitnessHeats[eid] || null;
      state.fitnessHeats[eid] = heats;
      persist();
      var change = { scope: "fitness", eid: eid, field: "fitnessHeats", value: heats, oldValue: oldValue };
      emit({ type: "local", cells: [change] });
      return change;
    }

    /* ── 원격 반영 ───────────────────────────────────────────────────── */

    /**
     * 서버에서 온 셀 하나. sync.js 가 device_id / version / 충돌을 이미 걸러 낸 뒤다.
     * legacy 적용 명세 P3 의 applyPatch 와 같은 자리, 같은 의미다.
     */
    function applyPatch(p, quiet) {
      if (!p) return;
      if (p.scope === "result") {
        if (!state.results[p.eid]) state.results[p.eid] = {};
        var k = keyOf(p.heat, p.athleteId);
        var prev = state.results[p.eid][k];
        state.results[p.eid][k] = Object.assign(
          blankRow(p.athleteId, p.heat, (prev && prev.lane) || 1),
          prev,
          { athleteId: p.athleteId, heat: p.heat }
        );
        state.results[p.eid][k][p.field] = p.value == null ? "" : p.value;
      } else if (p.scope === "fitness") {
        state.fitnessHeats[p.eid] = p.value;
      } else if (p.scope === "meet") {
        if (isConfirmField(p.field)) {
          var ck = p.field.slice("confirmed:".length);
          if (p.value) state.confirmed[ck] = p.value;
          else delete state.confirmed[ck];
        } else {
          state[p.field] = p.value;
        }
      } else {
        return;
      }
      if (quiet) return;
      persist();
      emit({ type: "remote", cells: [p] });
    }

    /** 여러 셀을 한 번에. 저장과 다시 그리기는 마지막에 한 번만 한다. */
    function applyPatches(list) {
      var cells = (list || []).filter(Boolean);
      if (!cells.length) return;
      cells.forEach(function (p) {
        applyPatch(p, true);
      });
      persist();
      emit({ type: "remote", cells: cells });
    }

    /**
     * 다른 탭(legacy 앱·전광판)이 같은 localStorage 를 고쳤다. 통째로 다시 읽는다.
     * ★ state 를 새 객체로 갈아치우면 calc.js 가 붙들고 있는 참조가 낡은 것을 가리킨다.
     *   그래서 새로 읽은 내용을 **기존 객체 안으로 옮겨 담는다.**
     */
    function reloadFromStorage() {
      var fresh = load();
      Object.keys(state).forEach(function (k) {
        if (!(k in fresh)) delete state[k];
      });
      Object.keys(fresh).forEach(function (k) {
        state[k] = fresh[k];
      });
      emit({ type: "reload", cells: [] });
    }

    return {
      STORE_KEY: storeKey, // 이 인스턴스가 실제로 쓰는 키 (storage 이벤트 필터용)
      calc: calc, // 공용 web/shared/calc.js 인스턴스. state 참조를 공유한다
      keyOf: keyOf,
      confirmKey: confirmKey,
      confirmField: confirmField,
      isConfirmField: isConfirmField,

      get raw() {
        return state;
      },
      athById: athById,
      heatsOf: heatsOf,
      laneRows: laneRows,
      heatProgress: heatProgress,
      eventProgress: eventProgress,
      rowOf: rowOf,
      valueOf: valueOf,
      isConfirmed: isConfirmed,

      writeResult: writeResult,
      setConfirmed: setConfirmed,
      setCurrentEvent: setCurrentEvent,
      setMeet: setMeet,
      setFitness: setFitness,

      applyPatch: applyPatch,
      applyPatches: applyPatches,
      reloadFromStorage: reloadFromStorage,

      subscribe: function (fn) {
        listeners.push(fn);
        return function () {
          listeners = listeners.filter(function (f) {
            return f !== fn;
          });
        };
      },
    };
  }

  return { create: create, STORE_KEY: STORE_KEY, keyOf: keyOf, confirmKey: confirmKey };
});
