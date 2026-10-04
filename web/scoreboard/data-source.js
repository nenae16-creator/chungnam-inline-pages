/* data-source.js — 전광판 화면과 데이터 사이의 유일한 접점
 * ---------------------------------------------------------------------------
 * 화면 코드(board.js)는 MEET_DATA 도, localStorage 도, 서버도 직접 보지 않는다.
 * 오직 아래 인터페이스만 쓴다. 나중에 서버 구독으로 갈아끼울 때
 * `createServerSource()` 하나만 추가하고 화면 코드는 손대지 않는다.
 *
 * ── 인터페이스 계약 ────────────────────────────────────────────────────────
 *   source.mode                    "demo" | "local" | (장차) "server"
 *   source.start()                 구독 시작
 *   source.stop()                  구독 해제
 *   source.meta()                  → { title, date, start, place, note,
 *                                      demo, sourceLabel }
 *   source.events()                → [EventSummary]  (28개 종목 전체, 진행상태 포함)
 *   source.currentEventId()        → number          심판이 지정한 "지금 경기"
 *   source.viewEventId()           → number          이 화면이 보고 있는 종목
 *   source.setViewEventId(id|null) → void            null 이면 다시 라이브 추종
 *   source.isFollowingLive()       → boolean
 *   source.eventView(id)           → EventView
 *   source.upNext(n)               → [EventSummary]  아직 시작 안 한 다음 경기들
 *   source.subscribe(fn)           → unsubscribe
 *
 * ── 타입 ──────────────────────────────────────────────────────────────────
 *   EventSummary = { id, no, name, shortName, dist, kind, cat, gender, day,
 *                    heatCount, progress:{ total, done, status }, isLive }
 *
 *   EventView    = { event, heats:[HeatView], overall:[Row],
 *                    progress, liveHeat, medalRows }
 *
 *   HeatView     = { heat, lanes:[Row],      // 레인 순 — 진행 중인 조 표시용
 *                    ranking:[Row],          // 조 순위
 *                    total, done, status, confirmed }
 *
 *   Row = { key, athleteId, name, club, clubShort, grade, gender,
 *           heat, lane,
 *           timeText,      // 심판이 적은 원문 그대로. "17.633" / "1:05.87"
 *           timeSec,       // parseTime() 환산값 (null 가능)
 *           status,        // "" | "DNS" | "DNF" | "DQ" | "REL"
 *           dnx,           // 미완주 코드 (없으면 null)
 *           place,         // 조 내 순위(number) 또는 미완주 코드
 *           overallPlace,  // 종목 전체 순위(number) 또는 미완주 코드
 *           hasResult,     // 기록/상태가 하나라도 들어왔는가
 *           provisional }  // ★ 심판 확정 전이면 true → 화면에 "잠정" 표기
 *
 * ── 변경 알림 (연출의 입력) ────────────────────────────────────────────────
 *   subscribe(fn) 의 fn 은 아래를 받는다. BRIEF 의 변경 이벤트 계약과 같은 모양이다.
 *
 *   {
 *     at: 1749270000000,
 *     currentEventId: 12,
 *     changes: [
 *       { eventId, heat, lane, athleteId, field:"time"|"status"|"rank",
 *         from: "",  to: "31.42",          // ← old_value → new_value
 *         deviceId, seq }
 *     ],
 *     confirmations: [ { eventId, heat, at } ],   // 잠정 → 확정으로 넘어간 조
 *     currentEventChanged: false
 *   }
 *
 *   서버 모드에서는 이 페이로드가 그대로 서버 이벤트에서 온다.
 *   로컬 모드에서는 어댑터가 이전 스냅샷과 비교해 직접 만들어 낸다.
 *   어느 쪽이든 화면은 같은 것을 받는다.
 *
 * ── 확정/잠정에 대한 판단 ──────────────────────────────────────────────────
 *   legacy state 에는 "심판이 확정했다"는 필드가 없다. 그래서 기본값은 **전부 잠정**이다.
 *   확정 표시는 `state.confirmed = { "종목id:조": ISO시각 }` 를 읽는다.
 *   서버가 생기면 이 자리에 `confirmed_at` 을 그대로 물리면 된다.
 *   값이 없으면 잠정으로 남는다 — 공식처럼 보이는 쪽이 아니라 안전한 쪽으로 넘어진다.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  var LEGACY_STORE_KEY = "chungnam_inline_2026_v1";
  var LEGACY_CHANNEL = "chungnam-inline";

  var DNX_CODES = ["DNS", "DNF", "DQ", "REL"];

  /* ---------------------------------------------------------------- 유틸 */

  function normStatus(s) {
    var v = String(s || "").trim().toUpperCase();
    return DNX_CODES.indexOf(v) >= 0 ? v : "";
  }

  function shortenEventName(name) {
    return String(name || "")
      .replace(/^피트니스\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function confirmKey(eventId, heat) {
    return eventId + ":" + heat;
  }

  /** legacy 와 같은 모양의 빈 state 를 만든다. */
  function blankState(DATA) {
    var results = {};
    DATA.events.forEach(function (ev) {
      results[ev.id] = {};
      (ev.heats || []).forEach(function (heat, hi) {
        (heat || []).forEach(function (aid, li) {
          if (!aid) return;
          results[ev.id][hi + 1 + ":" + aid] = {
            athleteId: aid,
            heat: hi + 1,
            lane: li + 1,
            time: "",
            rank: "",
            status: "",
            note: "",
          };
        });
      });
    });
    return {
      results: results,
      currentEvent: DATA.events.length ? DATA.events[0].id : 1,
      qualifyCount: (DATA.meta && DATA.meta.qualifyCount) || 6,
      fitnessHeats: {},
      confirmed: {},
      updatedAt: null,
      rev: 0,
    };
  }

  function unionKeys(a, b) {
    var out = {};
    Object.keys(a || {}).forEach(function (k) {
      out[k] = 1;
    });
    Object.keys(b || {}).forEach(function (k) {
      out[k] = 1;
    });
    return Object.keys(out);
  }

  /**
   * 두 results 스냅샷을 셀 단위로 비교해 변경 목록을 만든다.
   * 양쪽 키의 합집합을 훑는다 — 심판이 칸을 비우는 대신 **키를 통째로 지우는** 경우도
   * "값이 빈 문자열로 바뀐 것"으로 잡아야 화면에서 기록이 사라진다.
   */
  function diffResults(prev, next, deviceId) {
    var changes = [];
    var seq = 0;
    unionKeys(prev, next).forEach(function (eid) {
      var a = (prev && prev[eid]) || {};
      var b = (next && next[eid]) || {};
      unionKeys(a, b).forEach(function (k) {
        var before = a[k] || {};
        var after = b[k] || {};
        // 지워진 칸은 남아 있는 쪽에서 선수·조·레인을 읽는다
        var ref = b[k] ? after : before;
        ["time", "status", "rank"].forEach(function (field) {
          var from = before[field] == null ? "" : String(before[field]);
          var to = after[field] == null ? "" : String(after[field]);
          if (from === to) return;
          changes.push({
            eventId: Number(eid),
            heat: ref.heat,
            lane: ref.lane,
            athleteId: ref.athleteId,
            field: field,
            from: from,
            to: to,
            deviceId: deviceId,
            seq: ++seq,
          });
        });
      });
    });
    return changes;
  }

  /**
   * 확정 스냅샷 비교.
   * 기록과 똑같이 스냅샷 대비로 잡아야 한다. 이게 없으면 심판이 조를 확정해도
   * 값만 반영되고 화면은 다시 그려지지 않는다 — "잠정"이 남아 있다가 다음 기록이
   * 들어올 때 엉뚱한 타이밍에 사라진다. 심판은 확정이 안 먹은 줄 알고 다시 누른다.
   * @returns {{added: Array, removed: number}} added 는 알림 페이로드에 그대로 나간다.
   */
  function diffConfirmed(prev, next) {
    var p = prev || {};
    var n = next || {};
    var added = [];
    var removed = 0;
    Object.keys(n).forEach(function (k) {
      if (p[k] === n[k]) return;
      var parts = String(k).split(":");
      added.push({ eventId: Number(parts[0]), heat: Number(parts[1]), at: n[k] });
    });
    Object.keys(p).forEach(function (k) {
      if (!(k in n)) removed += 1; // 확정 취소 — 알림 대상은 아니지만 다시 그려야 한다
    });
    return { added: added, removed: removed };
  }

  /* -------------------------------------------------------- 공통 소스 본체 */

  /**
   * @param {object} opts
   *   opts.data      MEET_DATA
   *   opts.mode      "demo" | "local"
   *   opts.driver    { start(api), stop() } — state 를 갱신하는 주체 (데모 피드 등)
   *   opts.label     화면에 표시할 데이터 출처 문구
   */
  function createSource(opts) {
    var DATA = opts.data;
    var state = blankState(DATA);
    var calc = global.MeetCalc.create(DATA, state);

    var listeners = [];
    var viewEventId = null; // null = 라이브 추종
    var running = false;
    var lastSnapshot = null;

    /* --- 내부: 변경 알림 발행 --------------------------------------- */

    function snapshotResults() {
      return JSON.parse(JSON.stringify(state.results));
    }

    function emit(payload) {
      var p = Object.assign(
        {
          at: Date.now(),
          currentEventId: state.currentEvent,
          changes: [],
          confirmations: [],
          currentEventChanged: false,
        },
        payload || {}
      );
      listeners.slice().forEach(function (fn) {
        try {
          fn(p);
        } catch (e) {
          /* 한 구독자의 예외가 다른 구독자를 막지 않게 */
          if (global.console) console.error("[scoreboard] listener 오류", e);
        }
      });
    }

    /**
     * driver 가 state 를 바꾼 뒤 부르는 통로.
     * 전체 스냅샷이 들어와도 셀 단위 diff 로 바꿔 준다.
     * (서버 모드에서는 diff 가 이미 와 있으므로 changes 를 그대로 넘기면 된다.)
     */
    function commit(info) {
      info = info || {};
      var prevEvent = lastSnapshot ? lastSnapshot.currentEvent : state.currentEvent;
      var changes = info.changes;
      if (!changes) {
        changes = diffResults(
          lastSnapshot ? lastSnapshot.results : null,
          state.results,
          info.deviceId || "local"
        );
      }
      // 확정도 기록과 같은 자리에서 잡는다. 드라이버가 직접 넘겨 주면 그걸 쓰고,
      // 안 넘겨 주면(전체 스냅샷만 받는 로컬·서버 경로) 스냅샷 대비로 만들어 낸다.
      var cd = diffConfirmed(lastSnapshot ? lastSnapshot.confirmed : null, state.confirmed);
      var confirmations = info.confirmations || cd.added;

      lastSnapshot = {
        results: snapshotResults(),
        confirmed: Object.assign({}, state.confirmed),
        currentEvent: state.currentEvent,
      };
      // 확정 취소는 알림거리는 아니지만 화면은 다시 그려야 한다("잠정"이 되살아나야 한다).
      if (
        !changes.length &&
        !confirmations.length &&
        !cd.removed &&
        prevEvent === state.currentEvent
      )
        return;
      emit({
        changes: changes,
        confirmations: confirmations,
        currentEventChanged: prevEvent !== state.currentEvent,
      });
    }

    /* --- driver 에 넘겨 주는 쓰기 API -------------------------------- */

    var api = {
      DATA: DATA,
      calc: calc,
      state: state,
      /** legacy writeResult() 와 같은 셀 단위 통로 */
      write: function (eid, heat, aid, field, value) {
        if (!state.results[eid]) state.results[eid] = {};
        var k = heat + ":" + aid;
        var row = state.results[eid][k];
        if (!row) {
          row = state.results[eid][k] = {
            athleteId: aid,
            heat: heat,
            lane: 0,
            time: "",
            rank: "",
            status: "",
            note: "",
          };
        }
        row[field] = value;
      },
      setCurrentEvent: function (id) {
        state.currentEvent = id;
      },
      confirmHeat: function (eid, heat) {
        state.confirmed[confirmKey(eid, heat)] = new Date().toISOString();
      },
      /** 전체 state 교체 (localStorage / 원격 스냅샷용) */
      replaceState: function (next) {
        if (!next) return;
        state.results = Object.assign({}, blankState(DATA).results, next.results || {});
        if (next.currentEvent) state.currentEvent = next.currentEvent;
        if (next.qualifyCount) state.qualifyCount = next.qualifyCount;
        // 없는 필드는 지우지 않는다. legacy 앱의 livePayload() 처럼 일부만 실어 보내는
        // 페이로드가 섞여 들어와도 심판이 직접 짠 최강전 조와 확정 표시가 날아가면 안 된다.
        // (fitnessHeats 가 지워지면 숨김 로직이 그걸 "자동 산정"으로 오인해서
        //  심판이 정한 조를 "아직 정해지지 않았습니다"로 가려 버린다.)
        state.fitnessHeats = next.fitnessHeats || state.fitnessHeats || {};
        state.confirmed = next.confirmed || state.confirmed || {};
      },
      commit: commit,
    };

    /* --- 읽기: 뷰모델 만들기 ---------------------------------------- */

    function isConfirmed(eid, heat) {
      return !!state.confirmed[confirmKey(eid, heat)];
    }

    function toRow(x, eid, confirmed) {
      var a = x.a || calc.athById[x.athleteId] || {};
      var dnx = normStatus(x.status);
      var timeText = x.time ? String(x.time).trim() : "";
      var timeSec = x.t != null ? x.t : calc.parseTime(x.time);
      // 원문이 비었는데 환산값이 있으면(최강전 자동 산정 등) legacy 표기로 채운다.
      if (!timeText && timeSec != null) timeText = calc.fmtTime(timeSec);
      var hasResult = !!(timeText || dnx);
      return {
        key: eid + "/" + x.heat + "/" + x.athleteId,
        athleteId: x.athleteId,
        name: a.name || "?",
        club: a.club || "",
        clubShort: calc.clubShort(a.club) || a.club || "",
        grade: a.grade || "",
        gender: a.gender || "",
        note: a.note || "",
        heat: x.heat,
        lane: x.lane,
        timeText: timeText,
        timeSec: timeSec,
        status: dnx,
        dnx: dnx || null,
        place: x.heatPlace != null && x.heatPlace !== "" ? x.heatPlace : null,
        overallPlace: x.overallPlace != null && x.overallPlace !== "" ? x.overallPlace : null,
        hasResult: hasResult,
        provisional: hasResult && !confirmed,
      };
    }

    function summarize(ev) {
      // 진출자 미확정 최강전은 목록·다음경기·선택 시트 어디에서도 인원을 흘리지 않는다.
      if (lineupPendingFor(ev)) {
        return {
          id: ev.id, no: ev.no, name: ev.name, shortName: shortenEventName(ev.name),
          dist: ev.dist, kind: ev.kind, cat: ev.cat, gender: ev.gender, day: ev.day,
          heatCount: 0,
          progress: { total: 0, done: 0, status: "대기" },
          isLive: ev.id === state.currentEvent,
          lineupPending: true,
        };
      }
      var prog = calc.eventProgress(ev);
      var heats = calc.effectiveHeats(ev) || [];
      return {
        id: ev.id,
        no: ev.no,
        name: ev.name,
        shortName: shortenEventName(ev.name),
        dist: ev.dist,
        kind: ev.kind,
        cat: ev.cat,
        gender: ev.gender,
        day: ev.day,
        heatCount: heats.length,
        progress: prog,
        isLive: ev.id === state.currentEvent,
        lineupPending: false,
      };
    }

    /**
     * 최강전 진출자가 아직 안 정해졌는가.
     *
     * `autoQualifiers` 는 앞 경기가 끝나기 전에도 지금까지의 기록으로 진출자를
     * 뽑아 준다. 심판실에서는 유용하지만 **공개 화면에 띄우면 안 된다.**
     * 아이 이름이 진출자로 떴다가 앞 경기 정정으로 사라지면 그 부모는 화면을
     * 못 믿게 된다. 아직 정해지지 않은 것은 보여 주지 않는다.
     *
     * 단, 아래 둘은 "이미 정해진 것"이라 그대로 보여 준다.
     *   - 심판이 손으로 조를 짜 넣은 경우 (state.fitnessHeats)
     *   - 최강전 자체에 이미 기록이 들어온 경우
     */
    function lineupPendingFor(ev) {
      if (ev.kind !== "최강전") return null;

      var manual = state.fitnessHeats[ev.id];
      if (manual && manual.length) return null; // 심판이 직접 짠 조 — 사람이 정한 것

      var own = state.results[ev.id] || {};
      var started = Object.keys(own).some(function (k) {
        var r = own[k];
        return r && (r.time || r.status);
      });
      if (started) return null; // 이미 달리고 있다

      var feeders = ev.qualifyFrom || [];
      if (!feeders.length) return null;

      var waiting = feeders
        .map(function (eid) {
          return calc.evById[eid];
        })
        .filter(function (fe) {
          // 기록 입력 완료와 심판 확정은 다르다. 모든 조가 마감돼야 공개한다.
          return !fe || calc.eventProgress(fe).status !== "완료" ||
            calc.effectiveHeats(fe).some(function (_, hi) {
              return !isConfirmed(fe.id, hi + 1);
            });
        })
        .filter(Boolean);

      if (!waiting.length) return null;
      return waiting.map(function (fe) {
        return { id: fe.id, no: fe.no, name: fe.name };
      });
    }

    function eventView(id) {
      var ev = calc.evById[id];
      if (!ev) return null;

      // 진출자 미확정이면 레인을 비운다. 인원 수까지도 흘리지 않는다.
      var waitingOn = lineupPendingFor(ev);
      if (waitingOn) {
        return {
          event: Object.assign(summarize(ev), {
            heatCount: 0,
            progress: { total: 0, done: 0, status: "대기" },
          }),
          heats: [],
          overall: [],
          finishers: [],
          dnxRows: [],
          pendingCount: 0,
          anyProvisional: false,
          progress: { total: 0, done: 0, status: "대기" },
          liveHeat: null,
          lineupPending: true,
          lineupWaitingOn: waitingOn,
        };
      }

      var ranked = calc.rankedEvent(ev); // ← legacy 계산 그대로
      var heats = ranked.heats.map(function (h) {
        var confirmed = isConfirmed(ev.id, h.heat);
        var lanes = h.ordered.map(function (x) {
          return toRow(x, ev.id, confirmed);
        });
        var ranking = h.all.map(function (x) {
          return toRow(x, ev.id, confirmed);
        });
        var done = lanes.filter(function (r) {
          return r.hasResult;
        }).length;
        return {
          heat: h.heat,
          lanes: lanes,
          ranking: ranking,
          total: lanes.length,
          done: done,
          confirmed: confirmed,
          status: done === 0 ? "대기" : done < lanes.length ? "진행" : "완료",
        };
      });

      var overall = ranked.all.map(function (x) {
        return toRow(x, ev.id, isConfirmed(ev.id, x.heat));
      });
      // 화면이 쓰기 좋게 셋으로 갈라 둔다.
      //   finishers  기록이 있어 순위가 매겨진 선수 (전체 순위표에 오르는 행)
      //   dnxRows    DNS/DNF/DQ/REL — 순위 자리에 코드가 들어간다
      //   pending    아직 달리지 않았거나 기록이 안 들어온 선수 (수만 센다)
      var finishers = overall.filter(function (r) {
        return typeof r.overallPlace === "number";
      });
      var dnxRows = overall.filter(function (r) {
        return !!r.dnx;
      });
      var pending = overall.filter(function (r) {
        return !r.hasResult;
      });

      // Record entry alone does not advance the public race. Judge closure does.
      var liveHeat = null;
      for (var i = 0; i < heats.length; i++) {
        if (!heats[i].confirmed) {
          liveHeat = heats[i].heat;
          break;
        }
      }
      if (liveHeat == null && heats.length) liveHeat = heats[heats.length - 1].heat;

      return {
        event: summarize(ev),
        heats: heats,
        overall: overall,
        finishers: finishers,
        dnxRows: dnxRows,
        pendingCount: pending.length,
        anyProvisional: overall.some(function (r) {
          return r.provisional;
        }),
        progress: calc.eventProgress(ev),
        liveHeat: liveHeat,
        lineupPending: false,
        lineupWaitingOn: null,
      };
    }

    /* --- 공개 인터페이스 -------------------------------------------- */

    var source = {
      mode: opts.mode,
      calc: calc,
      /** 시연 모드의 일시정지 등, 드라이버 고유 기능에 접근할 때만 쓴다. */
      driver: opts.driver || null,

      meta: function () {
        var m = DATA.meta || {};
        return {
          title: m.title || "인라인 대회",
          date: m.date || "",
          start: m.start || "",
          place: m.place || "",
          note: m.note || "",
          demo: opts.mode === "demo",
          // 실기록 모드인데 아직 기록이 한 칸도 안 들어온 상태.
          // 화면이 고장난 게 아니라 대회가 아직 시작 전이라는 뜻이므로 그렇게 밝힌다.
          waiting: opts.mode !== "demo" && !anyRecorded(state),
          sourceLabel: typeof opts.label === "function" ? opts.label(state) : opts.label || "",
        };
      },

      events: function () {
        return DATA.events.map(summarize);
      },

      currentEventId: function () {
        return state.currentEvent;
      },

      viewEventId: function () {
        return viewEventId == null ? state.currentEvent : viewEventId;
      },

      setViewEventId: function (id) {
        viewEventId = id == null ? null : Number(id);
        emit({ currentEventChanged: true });
      },

      isFollowingLive: function () {
        return viewEventId == null;
      },

      eventView: eventView,

      upNext: function (n) {
        var cur = state.currentEvent;
        var out = [];
        var seen = false;
        DATA.events.forEach(function (ev) {
          if (ev.id === cur) {
            seen = true;
            return;
          }
          if (!seen) return;
          if (out.length >= (n || 3)) return;
          out.push(summarize(ev));
        });
        // 현재 경기가 마지막이면 아직 기록이 없는 종목으로 채운다.
        if (!out.length) {
          DATA.events.forEach(function (ev) {
            if (out.length >= (n || 3)) return;
            if (ev.id === cur) return;
            if (calc.eventProgress(ev).status === "대기") out.push(summarize(ev));
          });
        }
        return out;
      },

      subscribe: function (fn) {
        listeners.push(fn);
        return function () {
          var i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },

      start: function () {
        if (running) return;
        running = true;
        lastSnapshot = {
          results: snapshotResults(),
          confirmed: Object.assign({}, state.confirmed),
          currentEvent: state.currentEvent,
        };
        if (opts.driver) opts.driver.start(api);
        emit({});
      },

      stop: function () {
        if (!running) return;
        running = false;
        if (opts.driver) opts.driver.stop();
      },
    };

    return source;
  }

  /* ------------------------------------------------ 드라이버: 로컬 심판앱 */

  /**
   * legacy 심판 앱이 같은 브라우저(같은 출처)에서 돌 때 쓰는 드라이버.
   * localStorage 와 BroadcastChannel("chungnam-inline") 을 그대로 읽는다.
   * legacy/saveState() 가 이 채널로 쏘고 있으므로 별도 수정 없이 붙는다.
   */
  function legacyLocalDriver() {
    var timer = null;
    var chan = null;
    var onStorage = null;
    var lastRaw = "";

    function pull(api) {
      var raw = "";
      try {
        raw = localStorage.getItem(LEGACY_STORE_KEY) || "";
      } catch (e) {
        return;
      }
      if (!raw || raw === lastRaw) return;
      lastRaw = raw;
      try {
        api.replaceState(JSON.parse(raw));
        api.commit({ deviceId: "legacy-local" });
      } catch (e) {
        /* 손상된 저장값은 무시 — 화면은 마지막으로 성공한 상태를 유지한다 */
      }
    }

    return {
      start: function (api) {
        pull(api);
        try {
          chan = new BroadcastChannel(LEGACY_CHANNEL);
          chan.onmessage = function (ev) {
            var d = ev && ev.data;
            if (!d || d.type !== "state" || !d.payload) return;
            api.replaceState(d.payload.state || d.payload);
            api.commit({ deviceId: d.from || "legacy-bc" });
          };
        } catch (e) {
          chan = null;
        }
        onStorage = function (e) {
          if (e.key && e.key !== LEGACY_STORE_KEY) return;
          pull(api);
        };
        window.addEventListener("storage", onStorage);
        // BroadcastChannel 이 없는 브라우저를 위한 저비용 폴백
        timer = setInterval(function () {
          pull(api);
        }, 2000);
      },
      stop: function () {
        if (timer) clearInterval(timer);
        if (chan) chan.close();
        if (onStorage) window.removeEventListener("storage", onStorage);
        timer = chan = onStorage = null;
      },
    };
  }

  /* ----------------------------------------------- 드라이버: 공개 서버 */

  /**
   * Supabase 변경 로그를 읽기 전용으로 구독한다. 관중 앱은 commit RPC를 호출하지
   * 않으며, 공개가 허용된 대회의 sync_pull/Realtime SELECT만 사용한다.
   */
  function supabaseServerDriver(options) {
    var opts = options || {};
    var adapter = opts.adapter;
    var pollIntervalMs = Number(opts.pollIntervalMs) || 0;
    var timer = null;
    var stopped = false;
    var catchingUp = true;
    var buffered = [];
    var cursor = 0;

    function apply(api, rows) {
      if (stopped || !rows || !rows.length) return;
      rows.forEach(function (row) {
        if (!row) return;
        var patch = {
          cell: row.cell,
          scope: row.scope,
          eid: row.eid,
          heat: row.heat,
          athlete_id: row.athlete_id,
          athleteId: row.athlete_id,
          field: row.field,
          value: row.value === undefined ? row.new_value : row.value,
        };
        if (global.ChungnamSyncBridge && global.ChungnamSyncBridge.applyPatchToState) {
          global.ChungnamSyncBridge.applyPatchToState(api.state, patch);
        }
      });
      api.commit({ deviceId: "supabase-public" });
    }

    function poll(api) {
      if (stopped) return;
      Promise.resolve().then(function () { return adapter.pull(cursor); }).then(function (snapshot) {
        if (stopped || !snapshot) return;
        apply(api, snapshot.changes || []);
        if (snapshot.cursor != null) cursor = snapshot.cursor;
      }).catch(function (err) {
        if (global.console) console.error("[scoreboard] 서버 조회 실패", err);
      }).then(function () {
        if (!stopped) timer = setTimeout(function () { poll(api); }, pollIntervalMs + Math.random() * pollIntervalMs / 2);
      });
    }

    return {
      start: function (api) {
        stopped = false;
        if (pollIntervalMs) {
          timer = setTimeout(function () { poll(api); }, Math.random() * pollIntervalMs);
          return;
        }
        Promise.resolve(
          adapter.connect({
            meetId: opts.meetId,
            deviceId: "public-viewer",
            onRemote: function (rows) {
              if (catchingUp) buffered = buffered.concat(rows || []);
              else apply(api, (rows || []).filter(function (row) {
                return !row.log_seq || row.log_seq > cursor;
              }));
              (rows || []).forEach(function (row) {
                if (row.log_seq && row.log_seq > cursor) cursor = row.log_seq;
              });
            },
            onStatus: function () {},
          })
        )
          .then(function () { return adapter.pull(null); })
          .then(function (snapshot) {
            var initial = (snapshot && snapshot.changes) || [];
            apply(api, initial);
            cursor = (snapshot && snapshot.cursor) || cursor;
            catchingUp = false;
            var tail = buffered.filter(function (row) { return !row.log_seq || row.log_seq > cursor; });
            buffered = [];
            apply(api, tail);
            tail.forEach(function (row) { if (row.log_seq && row.log_seq > cursor) cursor = row.log_seq; });
          })
          .catch(function (err) {
            if (global.console) console.error("[scoreboard] 서버 연결 실패", err);
          });
      },
      stop: function () {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        return adapter.disconnect ? adapter.disconnect() : undefined;
      },
    };
  }

  /* ------------------------------------------------------------ 팩토리 */

  /**
   * 심판 앱의 저장 키가 존재하는가.
   *
   * ★ "기록이 들어 있는가"를 묻지 않는다. 기록이 0건인 것은 **정상 상태**다 —
   *   첫 경기 전에는 당연히 비어 있다. 그걸 "쓸 수 없는 상태"로 보고 시연 데이터로
   *   넘어가면, 대회 시작 직전 대형 화면에 가짜 이름과 가짜 기록이 뜬다.
   */
  function hasLegacyState() {
    try {
      var raw = localStorage.getItem(LEGACY_STORE_KEY);
      if (!raw) return false;
      var s = JSON.parse(raw);
      return !!(s && s.results);
    } catch (e) {
      return false;
    }
  }

  /** 지금 어딘가에 기록이 한 칸이라도 들어와 있는가 (화면의 "기록 대기 중" 표시용). */
  function anyRecorded(state) {
    var res = state.results || {};
    return Object.keys(res).some(function (eid) {
      var rows = res[eid] || {};
      return Object.keys(rows).some(function (k) {
        var r = rows[k];
        return r && (r.time || r.status);
      });
    });
  }

  /**
   * 화면이 부를 유일한 진입점.
   * @param {object} o { data, mode:"auto"|"demo"|"local" }
   *
   * ★ 시연 데이터는 **옵트인이다. 절대 자동으로 켜지지 않는다.**
   *   `mode:"demo"`(주소의 `?demo=1`)로 명시했을 때만 켜진다.
   *   저장 키가 아예 없어도 로컬 모드로 붙어서 기다린다 — 심판 앱이 처음 저장하는
   *   순간 폴링과 storage 이벤트가 집어 올린다. 그때까지는 페어링만 뜬 대기 화면이다.
   *   **빈 화면이 가짜 기록보다 백배 낫다.**
   */
  function open(o) {
    o = o || {};
    var DATA = o.data || global.MEET_DATA;

    if (o.mode === "demo") {
      return createSource({
        data: DATA,
        mode: "demo",
        driver: global.DemoFeed.driver(o.demo || {}),
        label: "시연용 생성 기록",
      });
    }

    var cfg = o.liveConfig || global.CHUNGNAM_LIVE_CONFIG || {};
    var forceLocal = o.mode === "local" || (global.location && new URLSearchParams(global.location.search).get("sync") === "local");
    if (!forceLocal && cfg.supabaseUrl && cfg.supabaseAnonKey && cfg.meetId &&
        global.supabase && global.ChungnamSyncSupabaseAdapter && global.ChungnamSyncBridge) {
      var client = global.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      var serverAdapter = global.ChungnamSyncSupabaseAdapter.createSupabaseAdapter({
        client: client,
        meetId: cfg.meetId,
      });
      return createSource({
        data: DATA,
        mode: "server",
        driver: supabaseServerDriver({ adapter: serverAdapter, meetId: cfg.meetId, pollIntervalMs: o.pollIntervalMs }),
        label: o.pollIntervalMs ? "대회 기록 서버 (주기 갱신)" : "대회 실시간 서버",
      });
    }

    return createSource({
      data: DATA,
      mode: "local",
      driver: legacyLocalDriver(),
      // 저장 키가 나중에 생길 수 있으니 그때그때 다시 판단한다.
      label: function (state) {
        if (!hasLegacyState()) return "심판 앱 연결 대기 중";
        return anyRecorded(state) ? "심판 앱 기록 (이 브라우저)" : "심판 앱 연결됨 · 기록 대기";
      },
    });
  }

  global.ScoreboardSource = {
    open: open,
    createSource: createSource,
    legacyLocalDriver: legacyLocalDriver,
    supabaseServerDriver: supabaseServerDriver,
    hasLegacyState: hasLegacyState,
    DNX_CODES: DNX_CODES,
  };
})(typeof window !== "undefined" ? window : globalThis);
