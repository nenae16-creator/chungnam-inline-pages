/*!
 * chungnam-inline — web/shared/adapter-broadcast.js
 *
 * 서버 0으로 도는 어댑터. 같은 기기의 여러 창/탭이 서로 실시간으로 반영된다.
 * 인프라가 하나도 없어도 심판 콘솔과 전광판을 나란히 띄워 시연할 수 있다.
 *
 *   저장소  localStorage   — 서버의 테이블 역할. 새로고침해도 살아남는다.
 *   전파    BroadcastChannel — 서버의 realtime 채널 역할. (없으면 storage 이벤트로 폴백)
 *   직렬화  navigator.locks  — 커밋의 원자성. (없으면 localStorage 스핀락으로 폴백)
 *
 * 인터페이스는 adapter-memory / adapter-supabase 와 완전히 같다.
 * connect(ctx) / commit(events) / pull(cursor) / disconnect(). 나중에 한 줄로 교체된다.
 *
 * 판정 규칙도 adapter-memory.js 의 createMemoryServer 와 같다:
 *   1. 이미 본 이벤트 id            -> "duplicate" (그때 확정된 version 을 그대로 돌려준다)
 *   2. base_version == 현재 version -> "applied",  version+1, 이력 추가, 다른 탭에 전파
 *   3. 값이 이미 같다               -> "applied",  version 그대로, 이력 없음 (수렴)
 *   4. 그 외                        -> "conflict", 서버의 현재 값과 version 을 돌려준다
 *
 * ── 리더를 두지 않는 이유 ──────────────────────────────────────────────
 * "한 탭이 서버 역할을 맡고 닫히면 인계"는 인계 공백 동안 쓰기가 멈추고, 인계 판정을
 * 하트비트 타임아웃에 의존하게 된다. 여기서는 모든 탭이 대등하게 공유 상태에 직접 쓰고
 * 잠금으로만 순서를 맞춘다. 맡은 역할이 없으니 넘길 것도 없고, 어느 탭을 닫아도
 * 나머지는 그 즉시 그대로 돈다. Web Locks 는 탭이 죽으면 브라우저가 잠금을 회수한다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChungnamSyncBroadcastAdapter = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var NS = "chungnam_sync_bc_v1";

  function clone(v) {
    return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
  }
  function sameValue(a, b) {
    return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  }
  function rand() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /* ------------------------------------------------------------------ *
   * 전파 채널 — BroadcastChannel, 없으면 storage 이벤트
   * ------------------------------------------------------------------ */
  function defaultChannel(name, storage) {
    if (typeof BroadcastChannel !== "undefined") {
      var ch = new BroadcastChannel(name);
      // Node 에서는 채널이 이벤트 루프를 붙잡는다. 브라우저엔 unref 가 없다.
      if (typeof ch.unref === "function") ch.unref();
      return {
        kind: "broadcastchannel",
        post: function (msg) {
          ch.postMessage(msg);
        },
        onMessage: function (fn) {
          ch.onmessage = function (e) {
            fn(e.data);
          };
        },
        close: function () {
          try {
            ch.close();
          } catch (e) {}
        },
      };
    }
    // 폴백: storage 이벤트. 쓰는 탭에는 안 오고 다른 탭에만 온다 — 우리가 원하는 동작 그대로다.
    var key = name + ":signal";
    var handler = null;
    return {
      kind: "storage-event",
      post: function (msg) {
        try {
          storage.setItem(key, JSON.stringify({ at: Date.now(), n: Math.random(), msg: msg }));
        } catch (e) {}
      },
      onMessage: function (fn) {
        handler = function (e) {
          if (!e || e.key !== key || !e.newValue) return;
          try {
            fn(JSON.parse(e.newValue).msg);
          } catch (err) {}
        };
        if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("storage", handler);
      },
      close: function () {
        if (handler && typeof window !== "undefined" && window.removeEventListener) window.removeEventListener("storage", handler);
        handler = null;
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * 잠금 — Web Locks, 없으면 localStorage 스핀락
   * ------------------------------------------------------------------ */
  function makeLock(lockName, locks, storage) {
    if (locks && typeof locks.request === "function") {
      return function (fn) {
        return locks.request(lockName, fn);
      };
    }
    var key = lockName + ":lock";
    var TTL = 4000;

    function read() {
      try {
        return JSON.parse(storage.getItem(key) || "null");
      } catch (e) {
        return null;
      }
    }
    async function acquire() {
      for (var i = 0; i < 400; i++) {
        var cur = read();
        var now = Date.now();
        if (cur && cur.exp > now) {
          await sleep(3 + Math.floor(Math.random() * 12));
          continue;
        }
        var token = rand();
        try {
          storage.setItem(key, JSON.stringify({ token: token, exp: now + TTL }));
        } catch (e) {
          await sleep(10);
          continue;
        }
        // 같은 순간에 쓴 다른 탭이 있으면 마지막 쓴 쪽이 이긴다. 잠깐 뒤 확인한다.
        await sleep(4);
        var after = read();
        if (after && after.token === token) return token;
      }
      // 여기까지 오면 잠금이 고장난 것이다. 멈추는 것보다 진행하는 편이 낫다.
      return null;
    }
    function release(token) {
      var cur = read();
      if (!token || (cur && cur.token === token)) {
        try {
          storage.removeItem(key);
        } catch (e) {}
      }
    }

    // 같은 탭 안에서는 프로미스 체인으로 먼저 직렬화한다 (스핀락 경합을 줄인다)
    var chain = Promise.resolve();
    return function (fn) {
      var run = async function () {
        var token = await acquire();
        try {
          return await fn();
        } finally {
          release(token);
        }
      };
      chain = chain.then(run, run);
      return chain;
    };
  }

  /* ------------------------------------------------------------------ *
   * 어댑터
   * ------------------------------------------------------------------ */
  function createBroadcastAdapter(options) {
    var opts = options || {};
    var meetId = opts.meetId || "chungnam-inline-2026";
    var ns = (opts.namespace || NS) + ":" + meetId;
    var storage =
      opts.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!storage) throw new Error("adapter-broadcast: localStorage 가 없습니다. storage 를 주입하세요");

    var maxLog = opts.maxLog || 500;    // 짧은 끊김 따라잡기용. 더 오래된 건 스냅샷으로 준다.
    var maxSeen = opts.maxSeen || 3000; // 재전송 멱등 창

    var K = {
      cells: ns + ":cells",
      log: ns + ":log",
      seen: ns + ":seen",
      seq: ns + ":seq",
    };

    var channel = (opts.createChannel || defaultChannel)(ns, storage);
    var withLock = makeLock(
      ns,
      opts.locks !== undefined ? opts.locks : typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null,
      storage
    );

    var ctx = null;
    var closed = false;

    /* ---- 저장소 접근 ---- */
    function readJson(key, dflt) {
      try {
        var raw = storage.getItem(key);
        return raw === null || raw === undefined ? dflt : JSON.parse(raw);
      } catch (e) {
        return dflt;
      }
    }
    function writeJson(key, v) {
      try {
        storage.setItem(key, JSON.stringify(v));
        return true;
      } catch (e) {
        // 용량 초과. 이력부터 버린다 — 셀 현재값이 이력보다 중요하다.
        try {
          storage.removeItem(K.log);
          storage.setItem(key, JSON.stringify(v));
          return true;
        } catch (e2) {
          if (ctx && ctx.onStatus) ctx.onStatus({ lastError: "저장 공간이 가득 찼습니다" });
          return false;
        }
      }
    }
    function loadState() {
      return {
        cells: readJson(K.cells, {}),
        log: readJson(K.log, []),
        seen: readJson(K.seen, { order: [], map: {} }),
        seq: readJson(K.seq, 0),
      };
    }

    function rememberSeen(seen, id, version) {
      if (seen.map[id] === undefined) seen.order.push(id);
      seen.map[id] = version;
      while (seen.order.length > maxSeen) {
        var old = seen.order.shift();
        delete seen.map[old];
      }
    }

    /* ---- 커밋 (adapter-memory 의 규칙과 동일) ---- */
    function applyEvents(state, events) {
      var results = [];
      var changes = [];
      var touched = { cells: false, log: false, seen: false };
      // 이 배치에서 이미 충돌이 난 셀. adapter-memory 와 같은 규칙이다.
      var conflicted = {};

      (events || []).forEach(function (ev) {
        var prior = state.seen.map[ev.id];
        var cur = state.cells[ev.cell] || { value: null, version: 0, device_id: null, at: null };

        if (prior !== undefined) {
          results.push({ id: ev.id, cell: ev.cell, status: "duplicate", version: prior, value: clone(cur.value) });
          return;
        }

        function reject() {
          conflicted[ev.cell] = true;
          results.push({
            id: ev.id,
            cell: ev.cell,
            status: "conflict",
            version: cur.version,
            value: clone(cur.value),
            device_id: cur.device_id,
            at: cur.at,
          });
        }
        function converged() {
          rememberSeen(state.seen, ev.id, cur.version);
          touched.seen = true;
          results.push({ id: ev.id, cell: ev.cell, status: "applied", version: cur.version, value: clone(cur.value) });
        }

        // ① 이 배치에서 이 셀이 이미 거부됐다면 나머지도 전부 거부한다.
        //    낡은 체인이 거부로 올라간 version 과 우연히 맞아 통과하면 먼저 쓴 심판의 값이 조용히 덮인다.
        if (conflicted[ev.cell]) {
          if (sameValue(cur.value, ev.new_value)) return converged();
          return reject();
        }
        if (ev.base_version !== cur.version && !sameValue(cur.value, ev.new_value)) {
          return reject();
        }
        if (ev.base_version !== cur.version) {
          return converged();
        }

        var next = {
          value: clone(ev.new_value),
          version: cur.version + 1,
          device_id: ev.device_id,
          client_seq: ev.client_seq,
          at: ev.at,
        };
        state.cells[ev.cell] = next;
        state.seq += 1;
        var change = {
          log_seq: state.seq,
          meet_id: ev.meet_id,
          cell: ev.cell,
          scope: ev.scope,
          eid: ev.eid,
          heat: ev.heat,
          athlete_id: ev.athlete_id,
          field: ev.field,
          old_value: clone(cur.value),
          value: clone(ev.new_value),
          version: next.version,
          device_id: ev.device_id,
          client_seq: ev.client_seq,
          at: ev.at,
        };
        state.log.push(change);
        changes.push(change);
        rememberSeen(state.seen, ev.id, next.version);
        touched.cells = touched.log = touched.seen = true;
        results.push({ id: ev.id, cell: ev.cell, status: "applied", version: next.version, value: clone(next.value) });
      });

      if (state.log.length > maxLog) {
        state.log = state.log.slice(state.log.length - maxLog);
        touched.log = true;
      }
      return { results: results, changes: changes, touched: touched };
    }

    function commit(events) {
      if (closed) return Promise.reject(new Error("adapter-broadcast: 연결이 닫혔습니다"));
      return withLock(function () {
        var state = loadState();
        var r = applyEvents(state, events);
        if (r.touched.cells) writeJson(K.cells, state.cells);
        if (r.touched.log) writeJson(K.log, state.log);
        if (r.touched.seen) writeJson(K.seen, state.seen);
        if (r.changes.length) writeJson(K.seq, state.seq);
        if (r.changes.length) channel.post({ type: "changes", changes: r.changes });
        return r.results;
      });
    }

    /* ---- 따라잡기 ---- *
     * 이력이 남아 있으면 그 구간만, 커서가 이력보다 오래됐거나 처음이면
     * 현재 셀 전체를 스냅샷처럼 만들어 준다. 어느 쪽이든 클라이언트는 델타로 받는다. */
    function pull(cursor) {
      if (closed) return Promise.reject(new Error("adapter-broadcast: 연결이 닫혔습니다"));
      var state = loadState();
      var since = cursor == null ? 0 : cursor;
      var oldest = state.log.length ? state.log[0].log_seq : state.seq + 1;

      if (since > 0 && since >= oldest - 1) {
        return Promise.resolve({
          changes: clone(
            state.log.filter(function (c) {
              return c.log_seq > since;
            })
          ),
          cursor: state.seq,
        });
      }

      var snapshot = Object.keys(state.cells).map(function (cell) {
        var c = state.cells[cell];
        var p = parseCellKey(cell);
        return {
          log_seq: null,
          meet_id: meetId,
          cell: cell,
          scope: p.scope,
          eid: p.eid,
          heat: p.heat,
          athlete_id: p.athleteId,
          field: p.field,
          old_value: null,
          value: clone(c.value),
          version: c.version,
          device_id: c.device_id,
          client_seq: c.client_seq,
          at: c.at,
        };
      });
      return Promise.resolve({ changes: snapshot, cursor: state.seq });
    }

    function parseCellKey(cell) {
      var p = String(cell).split("|");
      if (p[0] === "r") return { scope: "result", eid: +p[1], heat: +p[2], athleteId: +p[3], field: p[4] };
      if (p[0] === "f") return { scope: "fitness", eid: +p[1], heat: null, athleteId: null, field: "fitnessHeats" };
      if (p[0] === "m") return { scope: "meet", eid: null, heat: null, athleteId: null, field: p[1] };
      return { scope: "unknown", eid: null, heat: null, athleteId: null, field: cell };
    }

    /* ---- 수명주기 ---- */
    function connect(c) {
      ctx = c;
      closed = false;
      channel.onMessage(function (msg) {
        if (!msg || msg.type !== "changes" || !ctx) return;
        ctx.onRemote(msg.changes || []);
      });
      if (ctx.onStatus) ctx.onStatus({ connected: true });
      return Promise.resolve();
    }

    function disconnect() {
      closed = true;
      channel.close();
      ctx = null;
      return Promise.resolve();
    }

    return {
      name: "broadcast",
      transport: channel.kind,
      connect: connect,
      commit: commit,
      pull: pull,
      disconnect: disconnect,

      /* ---- 검사·진단용 ---- */
      value: function (cell) {
        var c = loadState().cells[cell];
        return c ? clone(c.value) : null;
      },
      version: function (cell) {
        var c = loadState().cells[cell];
        return c ? c.version : 0;
      },
      cells: function () {
        return loadState().cells;
      },
      log: function () {
        return loadState().log;
      },
      stats: function () {
        var s = loadState();
        return { cells: Object.keys(s.cells).length, log: s.log.length, seen: s.seen.order.length, seq: s.seq };
      },
      reset: function () {
        [K.cells, K.log, K.seen, K.seq].forEach(function (k) {
          try {
            storage.removeItem(k);
          } catch (e) {}
        });
      },
    };
  }

  return { createBroadcastAdapter: createBroadcastAdapter, NAMESPACE: NS };
});
