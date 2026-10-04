/*!
 * chungnam-inline — web/shared/sync.js
 *
 * 셀 단위 변경 이벤트 동기화 계층.
 *
 *  - 로컬 우선: publish() 는 아웃박스에 적으면 곧바로 반환한다. 회선과 무관하다.
 *  - 멱등: 모든 이벤트에 device_id + 단조증가 client_seq. 같은 이벤트를 몇 번 보내도 한 번만 반영된다.
 *  - 델타: 전체 스냅샷을 보내지 않는다. 셀 하나의 old_value → new_value 만 오간다.
 *  - 충돌: 셀마다 version 을 비교한다. 서버가 거부하면 조용히 넘어가지 않고 항상 onConflict 로 알린다.
 *
 * 전송·구독은 어댑터가 담당한다(adapter-memory.js / adapter-supabase.js).
 * 저장은 store 가 담당한다(createMemoryStore / createIndexedDbStore).
 *
 * UMD: 브라우저에서는 window.ChungnamSync, Node 에서는 module.exports.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChungnamSync = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_MEET = "chungnam-inline-2026";

  /* ------------------------------------------------------------------ *
   * 셀 키
   *
   *  result   r|{eid}|{heat}|{athleteId}|{field}   기록 셀 (time/rank/status/note)
   *  fitness  f|{eid}                              최강전 조편성 배열 통째로
   *  meet     m|{field}                            currentEvent / qualifyCount
   * ------------------------------------------------------------------ */

  function cellKey(c) {
    var scope = c.scope || "result";
    if (scope === "result") return "r|" + c.eid + "|" + c.heat + "|" + c.athleteId + "|" + c.field;
    if (scope === "fitness") return "f|" + c.eid;
    if (scope === "meet") return "m|" + c.field;
    throw new Error("sync: unknown scope " + scope);
  }

  function parseCell(cell) {
    var p = String(cell).split("|");
    if (p[0] === "r") return { scope: "result", eid: +p[1], heat: +p[2], athleteId: +p[3], field: p[4] };
    if (p[0] === "f") return { scope: "fitness", eid: +p[1], athleteId: null, heat: null, field: "fitnessHeats" };
    if (p[0] === "m") return { scope: "meet", eid: null, heat: null, athleteId: null, field: p[1] };
    return { scope: "unknown", eid: null, heat: null, athleteId: null, field: cell };
  }

  function clone(v) {
    return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
  }

  function norm(v) {
    return v === undefined ? null : v;
  }


  function randomId(prefix) {
    return (
      prefix +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  /* ------------------------------------------------------------------ *
   * 저장소 (아웃박스 + 메타 + 셀 버전)
   *
   * 인터페이스:
   *   init()                    -> Promise<void>
   *   appendEvent(ev)           -> Promise<void>
   *   listEvents(limit)         -> Promise<Event[]>   client_seq 오름차순
   *   removeEvents(ids)         -> Promise<number>    실제로 지운 개수
   *   countEvents()             -> Promise<number>
   *   getMeta(k) / setMeta(k,v)
   *   getVersions()             -> Promise<{cell:version}>
   *   setVersions(patch)        -> Promise<void>      병합
   * ------------------------------------------------------------------ */

  function createMemoryStore(seed) {
    var events = seed && seed.events ? clone(seed.events) : [];
    var meta = seed && seed.meta ? clone(seed.meta) : {};
    var versions = seed && seed.versions ? clone(seed.versions) : {};

    return {
      kind: "memory",
      init: function () {
        return Promise.resolve();
      },
      appendEvent: function (ev) {
        events.push(clone(ev));
        return Promise.resolve();
      },
      listEvents: function (limit) {
        var out = events
          .slice()
          .sort(function (a, b) {
            return a.client_seq - b.client_seq;
          })
          .map(clone);
        return Promise.resolve(limit ? out.slice(0, limit) : out);
      },
      removeEvents: function (ids) {
        var kill = {};
        (ids || []).forEach(function (id) {
          kill[id] = 1;
        });
        var before = events.length;
        events = events.filter(function (e) {
          return !kill[e.id];
        });
        return Promise.resolve(before - events.length);
      },
      countEvents: function () {
        return Promise.resolve(events.length);
      },
      getMeta: function (k) {
        return Promise.resolve(meta[k]);
      },
      setMeta: function (k, v) {
        meta[k] = v;
        return Promise.resolve();
      },
      getVersions: function () {
        return Promise.resolve(clone(versions));
      },
      setVersions: function (patch) {
        Object.keys(patch || {}).forEach(function (k) {
          versions[k] = patch[k];
        });
        return Promise.resolve();
      },
      clearVersions: function () {
        versions = {};
        return Promise.resolve();
      },
      // 테스트에서 "탭을 닫았다 다시 연다"를 흉내내기 위한 덤프
      snapshot: function () {
        return { events: clone(events), meta: clone(meta), versions: clone(versions) };
      },
    };
  }

  /* IndexedDB 구현. 브라우저 전용 — Node 테스트에서는 createMemoryStore 를 쓴다. */
  function createIndexedDbStore(opts) {
    opts = opts || {};
    var dbName = opts.dbName || "chungnam_inline_sync";
    var version = 1;
    var dbp = null;

    function idb() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var req = indexedDB.open(dbName, version);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains("outbox")) {
            var os = db.createObjectStore("outbox", { keyPath: "id" });
            os.createIndex("client_seq", "client_seq", { unique: false });
          }
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
          if (!db.objectStoreNames.contains("versions")) db.createObjectStore("versions");
        };
        req.onsuccess = function () {
          resolve(req.result);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
      return dbp;
    }


    function reqValue(request) {
      return new Promise(function (resolve, reject) {
        request.onsuccess = function () {
          resolve(request.result);
        };
        request.onerror = function () {
          reject(request.error);
        };
      });
    }

    return {
      kind: "indexeddb",
      init: function () {
        return idb().then(function () {});
      },
      appendEvent: function (ev) {
        return idb().then(function (db) {
          var t = db.transaction("outbox", "readwrite");
          t.objectStore("outbox").put(clone(ev));
          return new Promise(function (resolve, reject) {
            t.oncomplete = resolve;
            t.onerror = function () {
              reject(t.error);
            };
          });
        });
      },
      listEvents: function (limit) {
        return idb().then(function (db) {
          var t = db.transaction("outbox", "readonly");
          var idx = t.objectStore("outbox").index("client_seq");
          return reqValue(idx.getAll(undefined, limit || undefined));
        });
      },
      removeEvents: function (ids) {
        return idb().then(function (db) {
          var t = db.transaction("outbox", "readwrite");
          var os = t.objectStore("outbox");
          (ids || []).forEach(function (id) {
            os.delete(id);
          });
          return new Promise(function (resolve, reject) {
            t.oncomplete = function () {
              resolve((ids || []).length);
            };
            t.onerror = function () {
              reject(t.error);
            };
          });
        });
      },
      countEvents: function () {
        return idb().then(function (db) {
          return reqValue(db.transaction("outbox", "readonly").objectStore("outbox").count());
        });
      },
      getMeta: function (k) {
        return idb().then(function (db) {
          return reqValue(db.transaction("meta", "readonly").objectStore("meta").get(k));
        });
      },
      setMeta: function (k, v) {
        return idb().then(function (db) {
          var t = db.transaction("meta", "readwrite");
          t.objectStore("meta").put(v, k);
          return new Promise(function (resolve, reject) {
            t.oncomplete = resolve;
            t.onerror = function () {
              reject(t.error);
            };
          });
        });
      },
      getVersions: function () {
        return idb().then(function (db) {
          var t = db.transaction("versions", "readonly");
          var os = t.objectStore("versions");
          return Promise.all([reqValue(os.getAllKeys()), reqValue(os.getAll())]).then(function (r) {
            var out = {};
            r[0].forEach(function (k, i) {
              out[k] = r[1][i];
            });
            return out;
          });
        });
      },
      setVersions: function (patch) {
        return idb().then(function (db) {
          var t = db.transaction("versions", "readwrite");
          var os = t.objectStore("versions");
          Object.keys(patch || {}).forEach(function (k) {
            os.put(patch[k], k);
          });
          return new Promise(function (resolve, reject) {
            t.oncomplete = resolve;
            t.onerror = function () {
              reject(t.error);
            };
          });
        });
      },
      clearVersions: function () {
        return idb().then(function (db) {
          var t = db.transaction("versions", "readwrite");
          t.objectStore("versions").clear();
          return new Promise(function (resolve, reject) {
            t.oncomplete = resolve;
            t.onerror = function () {
              reject(t.error);
            };
          });
        });
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * 동기화 코어
   * ------------------------------------------------------------------ */

  function createSync(options) {
    var opts = options || {};
    if (!opts.adapter) throw new Error("sync: adapter is required");

    var meetId = opts.meetId || DEFAULT_MEET;
    var adapter = opts.adapter;
    var store = opts.store || createMemoryStore();
    var clock = opts.now || Date.now;
    var timers = opts.timers || {
      setTimeout: function (f, ms) {
        return setTimeout(f, ms);
      },
      clearTimeout: function (h) {
        clearTimeout(h);
      },
      setInterval: function (f, ms) {
        return setInterval(f, ms);
      },
      clearInterval: function (h) {
        clearInterval(h);
      },
    };

    var autoFlush = opts.autoFlush !== false;
    var flushIntervalMs = opts.flushIntervalMs || 2000;
    var flushDebounceMs = opts.flushDebounceMs == null ? 200 : opts.flushDebounceMs;
    var maxBatch = opts.maxBatch || 200;
    var backoff = Object.assign({ baseMs: 500, maxMs: 30000, factor: 2, jitter: 0.25 }, opts.backoff);

    var onRemote = opts.onRemote || function () {};
    var onConflict = opts.onConflict || function () {};
    var onStatus = opts.onStatus || function () {};
    var onError = opts.onError || function () {};

    var defaultOnline =
      typeof navigator !== "undefined" && navigator && typeof navigator.onLine === "boolean"
        ? function () {
            return navigator.onLine;
          }
        : function () {
            return true;
          };
    var onlineOverride = null;
    var isOnlineFn = opts.isOnline || defaultOnline;
    function isOnline() {
      return onlineOverride === null ? !!isOnlineFn() : !!onlineOverride;
    }

    var deviceId = opts.deviceId || null;
    var clientSeq = 0;
    var versions = {};       // cell -> 서버가 확인해 준 마지막 version
    var pendingByCell = {};  // cell -> 아웃박스에 남아 있는 이 셀의 이벤트 수
    var editing = {};        // cell -> true (사용자가 입력 중인 셀. 원격값으로 덮지 않는다)
    var openConflicts = {};  // cell -> conflict 레코드 (사용자 판단 대기)

    var started = false;
    var flushing = false;
    var flushQueued = false;
    var attempt = 0;
    var retryHandle = null;
    var intervalHandle = null;
    var debounceHandle = null;
    var pullCursor = null;

    var status = {
      deviceId: null,
      online: isOnline(),
      connected: false,
      pending: 0,
      lastSyncAt: null,
      lastError: null,
      conflicts: 0,
      retryInMs: 0,
    };

    function emitStatus(patch) {
      if (patch) Object.assign(status, patch);
      status.online = isOnline();
      status.conflicts = Object.keys(openConflicts).length;
      try {
        onStatus(Object.assign({}, status));
      } catch (e) {
        /* UI 콜백 실패가 동기화를 멈추게 두지 않는다 */
      }
    }

    function bumpPending(cell, delta) {
      var n = (pendingByCell[cell] || 0) + delta;
      if (n <= 0) delete pendingByCell[cell];
      else pendingByCell[cell] = n;
    }

    function baseVersionFor(cell) {
      // 아직 서버에 못 보낸 내 이벤트가 있으면 그만큼 앞을 본다.
      return (versions[cell] || 0) + (pendingByCell[cell] || 0);
    }

    function changeOf(cell, rec) {
      var parsed = parseCell(cell);
      return {
        cell: cell,
        scope: parsed.scope,
        eid: parsed.eid,
        heat: parsed.heat,
        athleteId: parsed.athleteId,
        field: parsed.field,
        value: clone(rec.value),
        oldValue: clone(rec.old_value !== undefined ? rec.old_value : rec.oldValue),
        version: rec.version,
        deviceId: rec.device_id || rec.deviceId || null,
        at: rec.at || null,
      };
    }

    /* ---------------- 발행 ---------------- */

    function publish(change) {
      return publishMany([change]).then(function (evs) {
        return evs[0];
      });
    }

    function publishMany(changes) {
      if (!started) return Promise.reject(new Error("sync: start() first"));
      var list = (changes || []).filter(Boolean);
      if (!list.length) return Promise.resolve([]);

      var events = list.map(function (c) {
        var cell = c.cell || cellKey(c);
        var parsed = parseCell(cell);
        clientSeq += 1;
        var ev = {
          id: deviceId + ":" + clientSeq,
          meet_id: meetId,
          device_id: deviceId,
          client_seq: clientSeq,
          scope: parsed.scope,
          cell: cell,
          eid: parsed.eid,
          heat: parsed.heat,
          athlete_id: parsed.athleteId,
          field: parsed.field,
          base_version: baseVersionFor(cell),
          old_value: norm(c.oldValue),
          new_value: norm(c.value),
          at: new Date(clock()).toISOString(),
        };
        bumpPending(cell, 1);
        // 내가 방금 쓴 셀에 대한 미해결 충돌은 사용자가 판단을 내린 것으로 본다.
        delete openConflicts[cell];
        return ev;
      });

      var chain = store.setMeta("client_seq", clientSeq);
      events.forEach(function (ev) {
        chain = chain.then(function () {
          return store.appendEvent(ev);
        });
      });

      return chain
        .then(function () {
          return store.countEvents();
        })
        .then(function (n) {
          emitStatus({ pending: n });
          scheduleFlush();
          return events;
        });
    }

    /* ---------------- 전송 ---------------- */

    function scheduleFlush() {
      if (!autoFlush) return;
      if (debounceHandle) return;
      debounceHandle = timers.setTimeout(function () {
        debounceHandle = null;
        flush();
      }, flushDebounceMs);
    }

    function scheduleRetry() {
      if (!autoFlush) return;
      if (retryHandle) return;
      var delay = Math.min(backoff.maxMs, backoff.baseMs * Math.pow(backoff.factor, Math.max(0, attempt - 1)));
      if (backoff.jitter) delay = Math.round(delay * (1 - backoff.jitter + Math.random() * backoff.jitter * 2));
      emitStatus({ retryInMs: delay });
      retryHandle = timers.setTimeout(function () {
        retryHandle = null;
        emitStatus({ retryInMs: 0 });
        flush();
      }, delay);
    }

    function flush(force) {
      if (!started) return Promise.resolve();
      if (flushing) {
        flushQueued = true;
        return Promise.resolve();
      }
      if (!force && !isOnline()) {
        return store.countEvents().then(function (n) {
          emitStatus({ pending: n });
        });
      }
      flushing = true;
      return runFlush(force)
        .catch(function (err) {
          try {
            onError(err);
          } catch (e) {}
          emitStatus({ lastError: String((err && err.message) || err) });
        })
        .then(function () {
          flushing = false;
          if (flushQueued) {
            flushQueued = false;
            return flush(force);
          }
        });
    }

    function runFlush(force) {
      return store.listEvents(maxBatch).then(function (batch) {
        if (!batch.length) {
          attempt = 0;
          return store.countEvents().then(function (n) {
            emitStatus({ pending: n, lastError: null });
          });
        }
        if (!force && !isOnline()) {
          return emitStatus({ pending: batch.length });
        }
        return Promise.resolve()
          .then(function () {
            return adapter.commit(batch.map(clone));
          })
          .then(
            function (results) {
              attempt = 0;
              return applyCommitResults(batch, results || []).then(function (removed) {
                emitStatus({ lastSyncAt: new Date(clock()).toISOString(), lastError: null, connected: true });
                if (removed === 0) return; // 서버가 아무 결과도 안 줬다. 헛바퀴 방지.
                return store.countEvents().then(function (n) {
                  emitStatus({ pending: n });
                  if (n > 0) return runFlush(force);
                });
              });
            },
            function (err) {
              // 전송 실패. 큐는 그대로 둔다 — 이벤트 id 가 고정이라 재전송이 안전하다.
              attempt += 1;
              emitStatus({ lastError: String((err && err.message) || err), connected: false });
              try {
                onError(err);
              } catch (e) {}
              scheduleRetry();
            }
          );
      });
    }

    function applyCommitResults(batch, results) {
      var byId = {};
      results.forEach(function (r) {
        if (r && r.id) byId[r.id] = r;
      });

      var remove = [];
      var versionPatch = {};
      var conflictCells = {};

      batch.forEach(function (ev) {
        var r = byId[ev.id];
        if (!r) return; // 서버 응답 누락 — 큐에 남겨 다음 회차에 재전송
        if (r.status === "applied" || r.status === "duplicate") {
          remove.push(ev.id);
          bumpPending(ev.cell, -1);
          if (typeof r.version === "number" && r.version >= (versions[ev.cell] || 0)) {
            versions[ev.cell] = r.version;
            versionPatch[ev.cell] = r.version;
          }
        } else if (r.status === "conflict") {
          remove.push(ev.id);
          bumpPending(ev.cell, -1);
          if (!conflictCells[ev.cell]) conflictCells[ev.cell] = { server: r, local: ev };
          else conflictCells[ev.cell].local = ev; // 같은 셀이면 마지막 의도를 남긴다
        } else {
          // rejected — 권한/검증 실패. 되돌릴 방법이 없으니 버리고 알린다.
          remove.push(ev.id);
          bumpPending(ev.cell, -1);
          try {
            onError(new Error("sync: rejected " + ev.cell + " — " + (r.reason || r.status)));
          } catch (e) {}
        }
      });

      var chain = remove.length ? store.removeEvents(remove) : Promise.resolve(0);
      return chain
        .then(function (removed) {
          if (Object.keys(versionPatch).length) return store.setVersions(versionPatch).then(function () { return removed; });
          return removed;
        })
        .then(function (removed) {
          var cells = Object.keys(conflictCells);
          if (!cells.length) return removed;
          var seq = Promise.resolve();
          cells.forEach(function (cell) {
            seq = seq.then(function () {
              return handleConflict(cell, conflictCells[cell].local, conflictCells[cell].server);
            });
          });
          return seq.then(function () {
            return removed;
          });
        });
    }

    // 같은 셀에 남아 있던 다른 대기 이벤트도 함께 버린다. 전부 낡은 base_version 위에 서 있다.
    function dropQueuedForCell(cell) {
      return store.listEvents().then(function (all) {
        var ids = all
          .filter(function (e) {
            return e.cell === cell;
          })
          .map(function (e) {
            return e.id;
          });
        delete pendingByCell[cell];
        if (!ids.length) return { ids: [], last: null };
        var last = all
          .filter(function (e) {
            return e.cell === cell;
          })
          .pop();
        return store.removeEvents(ids).then(function () {
          return { ids: ids, last: last };
        });
      });
    }

    function handleConflict(cell, localEv, serverRes) {
      return dropQueuedForCell(cell).then(function (dropped) {
        var localEvent = dropped.last || localEv;
        var serverVersion = typeof serverRes.version === "number" ? serverRes.version : versions[cell] || 0;
        versions[cell] = serverVersion;

        var parsed = parseCell(cell);
        var conflict = {
          cell: cell,
          scope: parsed.scope,
          eid: parsed.eid,
          heat: parsed.heat,
          athleteId: parsed.athleteId,
          field: parsed.field,
          local: { value: clone(localEvent.new_value), baseVersion: localEvent.base_version, at: localEvent.at },
          server: {
            value: clone(serverRes.value),
            version: serverVersion,
            deviceId: serverRes.device_id || null,
            at: serverRes.at || null,
          },
          resolution: editing[cell] ? "pending" : "server",
          at: new Date(clock()).toISOString(),
        };

        return store.setVersions(makePatch(cell, serverVersion)).then(function () {
          if (conflict.resolution === "server") {
            // 사용자가 만지고 있지 않은 셀 — 서버 최신값으로 로컬을 갱신한다.
            deliverRemote([
              changeOf(cell, {
                value: serverRes.value,
                old_value: localEvent.new_value,
                version: serverVersion,
                device_id: serverRes.device_id,
                at: serverRes.at,
              }),
            ]);
          } else {
            // 입력 중인 셀 — 덮어쓰지 않는다. 사용자가 고를 때까지 남겨 둔다.
            openConflicts[cell] = conflict;
          }
          try {
            onConflict(clone(conflict));
          } catch (e) {}
          emitStatus();
        });
      });
    }

    function makePatch(k, v) {
      var o = {};
      o[k] = v;
      return o;
    }

    /* ---------------- 수신 ---------------- */

    function deliverRemote(changes) {
      if (!changes.length) return;
      try {
        onRemote(clone(changes));
      } catch (e) {
        try {
          onError(e);
        } catch (e2) {}
      }
    }

    // opts.force — resync 전용. 내 기기가 만든 변경도 다시 적용한다.
    // 평시에는 내 메아리를 건너뛰지만(커밋 결과가 이미 version 을 확정했다),
    // resync 는 로컬이 비었다는 전제라 이력을 처음부터 그대로 되짚어야 한다.
    function handleRemote(rawChanges, opts) {
      var force = !!(opts && opts.force);
      var list = (rawChanges || []).filter(Boolean);
      if (!list.length) return Promise.resolve();

      var apply = [];
      var versionPatch = {};

      list.forEach(function (raw) {
        var cell = raw.cell || cellKey(raw);
        var version = typeof raw.version === "number" ? raw.version : 0;
        var from = raw.device_id || raw.deviceId || null;

        if (!force && from === deviceId) return;             // 내 이벤트의 메아리
        if (version <= (versions[cell] || 0)) return;        // 이미 반영됨
        if (pendingByCell[cell]) return;                     // 내 미전송 쓰기가 있다. 커밋 때 서버가 판정한다.

        versions[cell] = version;
        versionPatch[cell] = version;
        apply.push(changeOf(cell, raw));
      });

      if (!apply.length) {
        if (Object.keys(versionPatch).length) return store.setVersions(versionPatch);
        return Promise.resolve();
      }

      deliverRemote(apply);
      return store.setVersions(versionPatch).then(function () {
        emitStatus({ lastSyncAt: new Date(clock()).toISOString(), connected: true });
      });
    }

    function pull(opts) {
      if (typeof adapter.pull !== "function") return Promise.resolve();
      return Promise.resolve(adapter.pull(pullCursor)).then(
        function (res) {
          if (!res) return;
          if (res.cursor !== undefined && res.cursor !== null) {
            pullCursor = res.cursor;
            return handleRemote(res.changes || [], opts).then(function () {
              return store.setMeta("pull_cursor", pullCursor);
            });
          }
          return handleRemote(res.changes || [], opts);
        },
        function (err) {
          emitStatus({ lastError: String((err && err.message) || err), connected: false });
        }
      );
    }

    /* ---------------- 수명주기 ---------------- */

    function start() {
      if (started) return Promise.resolve(api);
      return store
        .init()
        .then(function () {
          return Promise.all([store.getMeta("device_id"), store.getMeta("client_seq"), store.getMeta("pull_cursor"), store.getVersions(), store.listEvents()]);
        })
        .then(function (r) {
          deviceId = deviceId || r[0] || randomId("dev-");
          clientSeq = Math.max(r[1] || 0, 0);
          pullCursor = r[2] === undefined ? null : r[2];
          versions = r[3] || {};
          pendingByCell = {};
          (r[4] || []).forEach(function (ev) {
            bumpPending(ev.cell, 1);
            if (ev.client_seq > clientSeq) clientSeq = ev.client_seq;
          });
          return Promise.all([store.setMeta("device_id", deviceId), store.setMeta("client_seq", clientSeq)]);
        })
        .then(function () {
          started = true;
          status.deviceId = deviceId;
          bindNetworkEvents();
          return Promise.resolve(
            adapter.connect({
              meetId: meetId,
              deviceId: deviceId,
              onRemote: handleRemote,
              onStatus: function (p) {
                emitStatus(p);
              },
            })
          ).catch(function (err) {
            emitStatus({ lastError: String((err && err.message) || err), connected: false });
          });
        })
        .then(function () {
          return store.countEvents();
        })
        .then(function (n) {
          emitStatus({ pending: n, connected: true });
          if (autoFlush) {
            intervalHandle = timers.setInterval(function () {
              flush();
            }, flushIntervalMs);
          }
          if (isOnline()) return pull().then(function () { return flush(); });
        })
        .then(function () {
          return api;
        });
    }

    var netHandlers = null;
    function bindNetworkEvents() {
      if (netHandlers || typeof window === "undefined" || !window.addEventListener) return;
      netHandlers = {
        online: function () {
          emitStatus();
          pull().then(function () {
            return flush();
          });
        },
        offline: function () {
          emitStatus({ connected: false });
        },
      };
      window.addEventListener("online", netHandlers.online);
      window.addEventListener("offline", netHandlers.offline);
    }

    function stop() {
      started = false;
      if (intervalHandle) timers.clearInterval(intervalHandle);
      if (retryHandle) timers.clearTimeout(retryHandle);
      if (debounceHandle) timers.clearTimeout(debounceHandle);
      intervalHandle = retryHandle = debounceHandle = null;
      if (netHandlers && typeof window !== "undefined" && window.removeEventListener) {
        window.removeEventListener("online", netHandlers.online);
        window.removeEventListener("offline", netHandlers.offline);
        netHandlers = null;
      }
      emitStatus({ connected: false });
      return Promise.resolve(adapter.disconnect ? adapter.disconnect() : undefined);
    }

    /* ---------------- 충돌 처리 / 편집 표시 ---------------- */

    function markEditing(cellOrChange) {
      var cell = typeof cellOrChange === "string" ? cellOrChange : cellKey(cellOrChange);
      editing[cell] = true;
      return cell;
    }

    function clearEditing(cellOrChange) {
      var cell = typeof cellOrChange === "string" ? cellOrChange : cellKey(cellOrChange);
      delete editing[cell];
      return cell;
    }

    // choice: "server" 서버값 채택 / "local" 내 값으로 다시 쓴다
    function resolveConflict(cell, choice) {
      var c = openConflicts[cell];
      if (!c) return Promise.resolve(null);
      delete openConflicts[cell];
      delete editing[cell];
      if (choice === "local") {
        return publish({
          cell: cell,
          value: c.local.value,
          oldValue: c.server.value,
        }).then(function () {
          emitStatus();
          return c;
        });
      }
      deliverRemote([
        changeOf(cell, {
          value: c.server.value,
          old_value: c.local.value,
          version: c.server.version,
          device_id: c.server.deviceId,
          at: c.server.at,
        }),
      ]);
      emitStatus();
      return Promise.resolve(c);
    }

    /**
     * 이 기기를 서버 기준으로 다시 맞춘다.
     * 셀 버전 기억과 pull 커서를 버리고 처음부터 전부 다시 받는다.
     * 미전송 이벤트가 있는 셀은 건드리지 않는다 — 아직 내 쓰기가 유효하기 때문이다.
     */
    function resync() {
      versions = {};
      pullCursor = null;
      return Promise.resolve(store.clearVersions ? store.clearVersions() : null)
        .then(function () {
          return store.setMeta("pull_cursor", null);
        })
        .then(function () {
          return pull({ force: true });
        });
    }

    var api = {
      start: start,
      stop: stop,
      publish: publish,
      publishMany: publishMany,
      flush: function () {
        return flush(true);
      },
      pull: function (o) {
        return pull(o);
      },
      resync: resync,
      markEditing: markEditing,
      clearEditing: clearEditing,
      resolveConflict: resolveConflict,
      listConflicts: function () {
        return Object.keys(openConflicts).map(function (k) {
          return clone(openConflicts[k]);
        });
      },
      getStatus: function () {
        status.online = isOnline();
        status.conflicts = Object.keys(openConflicts).length;
        return Object.assign({}, status);
      },
      getVersion: function (cell) {
        return versions[cell] || 0;
      },
      getPending: function () {
        return store.countEvents();
      },
      setOnline: function (v) {
        onlineOverride = v === null ? null : !!v;
        emitStatus();
        if (isOnline()) return pull().then(function () { return flush(); });
        return Promise.resolve();
      },
      get deviceId() {
        return deviceId;
      },
      cellKey: cellKey,
      parseCell: parseCell,
      _store: store,
    };

    return api;
  }

  return {
    createSync: createSync,
    createMemoryStore: createMemoryStore,
    createIndexedDbStore: createIndexedDbStore,
    cellKey: cellKey,
    parseCell: parseCell,
    DEFAULT_MEET: DEFAULT_MEET,
  };
});
