/*!
 * chungnam-inline — web/shared/adapter-memory.js
 *
 * 인메모리 어댑터 + 참조 서버.
 *
 * createMemoryServer() 는 서버가 반드시 지켜야 할 규칙의 실행 가능한 명세다.
 * Supabase RPC / SQL 을 쓸 때 이 로직과 1:1로 맞춰야 한다.
 *
 *   1. 이벤트 id (= device_id + ':' + client_seq) 를 이미 본 적이 있으면 다시 반영하지 않고
 *      이전 결과를 그대로 돌려준다.                          -> status "duplicate"
 *   2. base_version 이 셀의 현재 version 과 같으면 반영하고 version 을 1 올린다. -> status "applied"
 *   3. 다르지만 서버 값이 이미 보내려던 값과 같으면 반영된 것으로 본다.          -> status "applied"
 *   4. 다르면 거부하고 서버의 현재 값과 version 을 돌려준다.                    -> status "conflict"
 *
 * 반영된 변경은 log 에 log_seq 를 달아 쌓고 구독자에게 델타로 밀어 준다.
 * pull(cursor) 은 재접속한 기기가 놓친 구간을 따라잡는 경로다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChungnamSyncMemoryAdapter = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clone(v) {
    return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
  }

  function sameValue(a, b) {
    return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  }

  function createMemoryServer(opts) {
    opts = opts || {};
    var cells = {};        // cell -> { value, version, device_id, client_seq, at }
    var seen = {};         // event id -> commit result (멱등 보장)
    var log = [];          // 반영된 변경 이력 (연출용 old→new 포함)
    var logSeq = 0;
    var subs = [];         // { deviceId, onRemote }
    var commits = 0;

    function broadcast(changes) {
      if (!changes.length) return Promise.resolve();
      return Promise.all(
        subs.map(function (s) {
          try {
            return Promise.resolve(s.onRemote(clone(changes)));
          } catch (e) {
            return Promise.resolve();
          }
        })
      );
    }

    function commit(events) {
      commits += 1;
      var results = [];
      var changes = [];
      // 이 배치에서 이미 충돌이 난 셀. 뒤따르는 같은 셀 이벤트가 낡은 체인을 이어붙이지 못하게 막는다.
      var conflicted = {};

      (events || []).forEach(function (ev) {
        if (seen[ev.id]) {
          var prev = clone(seen[ev.id]);
          prev.status = "duplicate";
          results.push(prev);
          return;
        }

        var cur = cells[ev.cell] || { value: null, version: 0, device_id: null, at: null };
        var res;

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
          // 이미 같은 값이다. 새 version 도 이력도 만들지 않는다.
          res = { id: ev.id, cell: ev.cell, status: "applied", version: cur.version, value: clone(cur.value) };
          seen[ev.id] = clone(res);
          results.push(res);
        }

        // ① 이 배치에서 이 셀이 이미 거부됐다면, 나머지도 전부 거부한다.
        //    막지 않으면 base_version 1,2,3… 체인이 거부로 올라간 서버 version 과 우연히 맞아떨어져
        //    통과해 버리고, 먼저 쓴 심판의 값이 조용히 덮인다.
        if (conflicted[ev.cell]) {
          if (sameValue(cur.value, ev.new_value)) return converged();
          return reject();
        }

        if (ev.base_version !== cur.version && !sameValue(cur.value, ev.new_value)) {
          return reject();
        }

        if (ev.base_version !== cur.version && sameValue(cur.value, ev.new_value)) {
          return converged();
        }

        var next = {
          value: clone(ev.new_value),
          version: cur.version + 1,
          device_id: ev.device_id,
          client_seq: ev.client_seq,
          at: ev.at,
        };
        cells[ev.cell] = next;
        logSeq += 1;
        var change = {
          log_seq: logSeq,
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
        log.push(change);
        changes.push(change);

        res = { id: ev.id, cell: ev.cell, status: "applied", version: next.version, value: clone(next.value) };
        seen[ev.id] = clone(res);
        results.push(res);
      });

      return broadcast(changes).then(function () {
        return results;
      });
    }

    return {
      commit: commit,
      pull: function (cursor) {
        var since = cursor == null ? 0 : cursor;
        var changes = log.filter(function (c) {
          return c.log_seq > since;
        });
        return Promise.resolve({ changes: clone(changes), cursor: logSeq });
      },
      subscribe: function (sub) {
        subs.push(sub);
        return function () {
          subs = subs.filter(function (s) {
            return s !== sub;
          });
        };
      },
      // ---- 검사용 ----
      value: function (cell) {
        return cells[cell] ? clone(cells[cell].value) : null;
      },
      version: function (cell) {
        return cells[cell] ? cells[cell].version : 0;
      },
      cells: function () {
        return clone(cells);
      },
      log: function () {
        return clone(log);
      },
      commitCount: function () {
        return commits;
      },
      subscriberCount: function () {
        return subs.length;
      },
    };
  }

  /**
   * 서버 하나에 붙는 클라이언트 어댑터.
   *
   * opts.failNext  n 번의 commit 을 네트워크 오류로 만든다 (백오프 재시도 검증용)
   * opts.offline   true 인 동안 commit/pull 이 모두 실패한다
   * opts.beforeCommit(events) 훅 — 중복 전송 실험 등에 쓴다
   */
  function createMemoryAdapter(server, opts) {
    opts = opts || {};
    var ctx = null;
    var unsub = null;
    var self = {
      name: "memory",
      failNext: opts.failNext || 0,
      offline: !!opts.offline,
      commitCalls: 0,
      sentEvents: [],

      connect: function (c) {
        ctx = c;
        if (unsub) unsub();
        unsub = server.subscribe({
          deviceId: c.deviceId,
          onRemote: function (changes) {
            return c.onRemote(changes);
          },
        });
        return Promise.resolve();
      },

      commit: function (events) {
        self.commitCalls += 1;
        if (opts.beforeCommit) opts.beforeCommit(events);
        if (self.offline) return Promise.reject(new Error("memory adapter: offline"));
        if (self.failNext > 0) {
          self.failNext -= 1;
          return Promise.reject(new Error("memory adapter: transient failure"));
        }
        events.forEach(function (e) {
          self.sentEvents.push(e.id);
        });
        return server.commit(events);
      },

      pull: function (cursor) {
        if (self.offline) return Promise.reject(new Error("memory adapter: offline"));
        return server.pull(cursor);
      },

      disconnect: function () {
        if (unsub) unsub();
        unsub = null;
        ctx = null;
        return Promise.resolve();
      },
    };
    return self;
  }

  return { createMemoryServer: createMemoryServer, createMemoryAdapter: createMemoryAdapter };
});
