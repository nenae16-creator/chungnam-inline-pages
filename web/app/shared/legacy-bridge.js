/*!
 * chungnam-inline — web/shared/legacy-bridge.js
 *
 * legacy/app.js 가 건드릴 줄 수를 최소화하기 위한 접착층.
 * 큐잉·재시도·충돌·상태 표시는 전부 여기서 처리하고, legacy 쪽에는
 * "값이 바뀌었다"를 알리는 호출과 "원격 값이 왔다"를 받는 콜백만 남긴다.
 *
 *   const bridge = ChungnamSyncBridge.attach({
 *     adapter: ChungnamSyncSupabaseAdapter.createSupabaseAdapter({ client, meetId }),
 *     applyPatch,          // (patch) => void   legacy 안에서 state 를 직접 갱신
 *     onStatus,            // (status) => void  선택
 *     onConflict,          // (conflict) => void 선택
 *     toast,               // (msg) => void     선택
 *   });
 *
 * attach() 는 비동기 초기화를 기다리지 않는다. start() 전에 들어온 발행은
 * 내부 버퍼에 담았다가 준비되는 즉시 흘려보낸다 — 심판 입력이 먼저 멈추면 안 된다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./sync.js"));
  } else {
    root.ChungnamSyncBridge = factory(root.ChungnamSync);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (ChungnamSync) {
  "use strict";

  /**
   * 이 창의 기기 ID 를 정한다.
   *
   * 한 노트북에서 창을 두 개 열면(심판 콘솔 + 전광판) 두 창이 같은 IndexedDB 를 쓰므로
   * 그냥 두면 device_id 가 같아진다. device_id 가 같으면 sync 가 상대 창의 변경을
   * "내 메아리"로 걸러 버려서 서로 아무것도 안 보인다.
   *
   * 그래서 Web Locks 로 대표 자리를 하나만 잡게 한다.
   *   - 자리를 잡은 창  -> 기기 고유 ID 를 그대로 쓴다. 아웃박스도 그대로 이어받는다.
   *                       (기기 한 대에 창 하나인 평소 상황 = 새로고침해도 대기열이 살아남는다)
   *   - 못 잡은 창      -> 창 전용 ID 를 쓴다. 자기 아웃박스를 따로 갖는다.
   *
   * 잠금은 창이 죽으면 브라우저가 회수하므로, 살아 있는지 따로 물어볼 필요가 없다.
   * Web Locks 가 없는 브라우저에서는 항상 창 전용 ID 를 쓴다 (안전한 쪽).
   */
  function resolveDeviceId(opts) {
    var BASE_KEY = "chungnam_sync_device";
    var TAB_KEY = "chungnam_sync_tab";
    var ls = opts.localStorage || (typeof localStorage !== "undefined" ? localStorage : null);
    var ss = opts.sessionStorage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    var locks = opts.locks !== undefined ? opts.locks : typeof navigator !== "undefined" ? navigator.locks : null;
    var waitMs = opts.claimWaitMs == null ? 250 : opts.claimWaitMs;

    function rnd(p) {
      return p + Math.random().toString(36).slice(2, 8);
    }
    function get(store, k) {
      try {
        return store && store.getItem(k);
      } catch (e) {
        return null;
      }
    }
    function set(store, k, v) {
      try {
        if (store) store.setItem(k, v);
      } catch (e) {}
    }

    var base = get(ls, BASE_KEY);
    if (!base) {
      base = rnd("dev-");
      set(ls, BASE_KEY, base);
    }
    // 창 전용 ID. sessionStorage 라 새로고침에는 살아남고 창을 닫으면 사라진다.
    var tab = get(ss, TAB_KEY);
    if (!tab) {
      tab = rnd("w");
      set(ss, TAB_KEY, tab);
    }

    if (!locks || typeof locks.request !== "function") {
      return Promise.resolve({ deviceId: base + "-" + tab, primary: false, reason: "web-locks 없음" });
    }

    return new Promise(function (resolve) {
      var settled = false;
      function done(v) {
        if (settled) return;
        settled = true;
        resolve(v);
      }
      // 대표 자리를 잡으면 창이 살아 있는 동안 계속 붙들고 있는다 (콜백을 끝내지 않는다).
      locks
        .request("chungnam_sync_owner:" + base, function () {
          done({ deviceId: base, primary: true, reason: "대표 창" });
          return new Promise(function () {});
        })
        .catch(function () {
          done({ deviceId: base + "-" + tab, primary: false, reason: "잠금 실패" });
        });
      // 이미 다른 창이 잡고 있으면 위 콜백이 안 불린다. 잠깐 기다렸다가 창 전용 ID 로 간다.
      setTimeout(function () {
        done({ deviceId: base + "-" + tab, primary: false, reason: "다른 창이 대표" });
      }, waitMs);
    });
  }

  /* ------------------------------------------------------------------ *
   * 델타 착지 지점 — 세 팀(심판 콘솔 · 전광판 · 통합앱)의 계약이다.
   * 흩어지면 조용히 어긋나므로 여기 한 곳에만 둔다.
   *
   *   r|{eid}|{heat}|{aid}|{field}   → state.results[eid]["{heat}:{aid}"][field]
   *   f|{eid}                        → state.fitnessHeats[eid]
   *   m|confirmed:{eid}:{heat}       → state.confirmed["{eid}:{heat}"]     ← 조 마감
   *   m|{그 외}                      → state[field]   (currentEvent, qualifyCount)
   *
   * 조 마감을 조마다 셀 하나로 나눈 이유: 심판 둘이 서로 다른 조를 동시에 마감하는 것은
   * 정상 동작이다. confirmed 전체를 셀 하나로 묶으면 그 둘이 서로 충돌한다.
   * ------------------------------------------------------------------ */

  var CONFIRM_PREFIX = "confirmed:";

  /** 조 마감 셀의 meet 필드 이름. 심판 콘솔이 발행할 때 이걸 쓴다. */
  function confirmedField(eid, heat) {
    return CONFIRM_PREFIX + eid + ":" + heat;
  }
  /** state.confirmed 의 키. 전광판이 읽을 때 이걸 쓴다. */
  function confirmedKey(eid, heat) {
    return eid + ":" + heat;
  }

  function applyPatchToState(state, p) {
    if (!state || !p) return { kind: "none", changed: false };

    if (p.scope === "result") {
      if (!state.results) state.results = {};
      if (!state.results[p.eid]) state.results[p.eid] = {};
      var k = p.heat + ":" + p.athleteId;
      var base = { athleteId: p.athleteId, heat: p.heat, lane: 1, time: "", rank: "", status: "", note: "" };
      var prev = state.results[p.eid][k];
      var next = {};
      var kk;
      for (kk in base) if (Object.prototype.hasOwnProperty.call(base, kk)) next[kk] = base[kk];
      for (kk in prev) if (Object.prototype.hasOwnProperty.call(prev, kk)) next[kk] = prev[kk];
      next[p.field] = p.value == null ? "" : p.value;
      state.results[p.eid][k] = next;
      return { kind: "result", changed: true };
    }

    if (p.scope === "fitness") {
      if (!state.fitnessHeats) state.fitnessHeats = {};
      state.fitnessHeats[p.eid] = p.value;
      return { kind: "fitness", changed: true };
    }

    if (p.scope === "meet") {
      if (String(p.field).indexOf(CONFIRM_PREFIX) === 0) {
        if (!state.confirmed) state.confirmed = {};
        var ck = String(p.field).slice(CONFIRM_PREFIX.length); // "14:2"
        if (p.value == null || p.value === "") delete state.confirmed[ck];
        else state.confirmed[ck] = p.value;
        return { kind: "confirmed", changed: true, confirmKey: ck };
      }
      state[p.field] = p.value;
      return { kind: "meet", changed: true, field: p.field };
    }

    return { kind: "unknown", changed: false };
  }

  function attach(options) {
    var opts = options || {};
    if (!opts.adapter) throw new Error("bridge: adapter 가 필요합니다");

    var applyPatch = opts.applyPatch || function () {};
    var toast = opts.toast || function () {};
    var onStatusCb = opts.onStatus || function () {};
    var onConflictCb = opts.onConflict || function () {};

    var buffered = [];
    var ready = false;
    var sync = null;
    var device = { deviceId: null, primary: false, reason: "준비 중" };
    var lastStatus = { online: true, connected: false, pending: 0, lastSyncAt: null, conflicts: 0 };

    // 기기 ID 를 먼저 정하고(창마다 달라야 한다) 그 ID 로 아웃박스를 연다.
    resolveDeviceId(opts)
      .then(function (info) {
        device = info;
        var store =
          opts.store ||
          (typeof indexedDB !== "undefined"
            ? ChungnamSync.createIndexedDbStore({ dbName: (opts.dbName || "chungnam_inline_sync") + "__" + info.deviceId })
            : ChungnamSync.createMemoryStore());

        sync = ChungnamSync.createSync({
          meetId: opts.meetId || ChungnamSync.DEFAULT_MEET,
          adapter: opts.adapter,
          store: store,
          deviceId: info.deviceId,
          flushIntervalMs: opts.flushIntervalMs || 2000,
          onRemote: function (changes) {
            for (var i = 0; i < changes.length; i++) applyPatch(changes[i]);
          },
          onConflict: function (c) {
            if (c.resolution === "pending") {
              toast("이 칸을 다른 기기가 먼저 고쳤습니다. 값을 확인하세요");
            } else {
              toast("다른 기기의 값으로 맞췄습니다 · " + describeCell(c));
            }
            onConflictCb(c);
          },
          onStatus: function (s) {
            lastStatus = s;
            onStatusCb(s);
          },
          onError: function (e) {
            if (opts.debug) console.warn("[sync]", e);
          },
        });
        return sync.start();
      })
      .then(function () {
        ready = true;
        onStatusCb(lastStatus);
        if (buffered.length) {
          var pending = buffered;
          buffered = [];
          return sync.publishMany(pending);
        }
      })
      .catch(function (e) {
        toast("동기화를 시작하지 못했습니다. 입력은 기기에 계속 저장됩니다");
        if (opts.debug) console.warn("[sync] start failed", e);
      });

    function describeCell(c) {
      if (c.scope !== "result") return c.field;
      return c.eid + "경기 " + c.heat + "조 " + c.athleteId + "번 " + c.field;
    }

    function send(change) {
      if (!ready) {
        buffered.push(change);
        return;
      }
      sync.publish(change);
    }

    function sendMany(changes) {
      if (!changes || !changes.length) return;
      if (!ready) {
        buffered = buffered.concat(changes);
        return;
      }
      sync.publishMany(changes);
    }

    var api = {
      // sync 인스턴스는 기기 ID 를 정한 뒤에 생긴다. 그 전에는 null 이다.
      get sync() {
        return sync;
      },
      get ready() {
        return ready;
      },
      adapterName: (opts.adapter && opts.adapter.name) || "unknown",
      deviceId: function () {
        return device.deviceId;
      },
      isPrimaryTab: function () {
        return !!device.primary;
      },

      /* legacy writeResult 자리 */
      publishResult: function (eid, heat, aid, field, value, oldValue) {
        send({ scope: "result", eid: +eid, heat: +heat, athleteId: +aid, field: field, value: value, oldValue: oldValue });
      },
      /* currentEvent / qualifyCount */
      publishMeet: function (field, value, oldValue) {
        send({ scope: "meet", field: field, value: value, oldValue: oldValue });
      },
      /* fitnessHeats[eid] 통째로 */
      publishFitness: function (eid, value, oldValue) {
        send({ scope: "fitness", eid: +eid, value: value, oldValue: oldValue });
      },
      /* 엑셀 일괄 반영처럼 여러 건을 한 번에 */
      publishMany: sendMany,

      markEditing: function (eid, heat, aid, field) {
        if (sync) sync.markEditing({ scope: "result", eid: +eid, heat: +heat, athleteId: +aid, field: field });
      },
      clearEditing: function (eid, heat, aid, field) {
        if (sync) sync.clearEditing({ scope: "result", eid: +eid, heat: +heat, athleteId: +aid, field: field });
      },

      status: function () {
        return lastStatus;
      },

      /* 상태 표시줄을 통째로 그려 준다. legacy 의 updateShareUI 를 한 줄로 만든다. */
      renderStatusInto: function (el) {
        if (!el) return;
        var s = lastStatus || {};
        var cls = !s.online ? "off" : s.pending ? "wait" : s.connected ? "live" : "retry";
        var label = !s.online
          ? "오프라인 · 대기 " + (s.pending || 0) + "건"
          : s.pending
          ? "전송 중 " + s.pending + "건"
          : s.connected
          ? "실시간 연결됨"
          : "재연결 중";
        var when = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleTimeString("ko-KR") : "";
        el.innerHTML =
          '<span class="sync-pill ' + cls + '">' + label + "</span>" +
          (when ? ' <span class="muted" style="font-size:12px">' + when + "</span>" : "") +
          (s.conflicts ? ' <span class="sync-pill error">충돌 ' + s.conflicts + "건</span>" : "");
      },

      listConflicts: function () {
        return sync ? sync.listConflicts() : [];
      },
      /* 지금 당장 보낸다 */
      flush: function () {
        return sync ? sync.flush() : Promise.resolve();
      },
      /* 이 기기를 버리고 저장소 기준으로 다시 받는다 */
      resync: function () {
        return sync ? sync.resync() : Promise.resolve();
      },
      resolveConflict: function (cell, choice) {
        return sync ? sync.resolveConflict(cell, choice) : Promise.resolve(null);
      },
      stop: function () {
        return sync ? sync.stop() : Promise.resolve();
      },
    };

    return api;
  }

  return {
    attach: attach,
    resolveDeviceId: resolveDeviceId,
    applyPatchToState: applyPatchToState,
    confirmedField: confirmedField,
    confirmedKey: confirmedKey,
  };
});
