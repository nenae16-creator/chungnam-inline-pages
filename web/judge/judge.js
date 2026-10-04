/*!
 * chungnam-inline — web/judge/judge.js
 *
 * 심판 기록 입력 콘솔.
 *
 * 한 화면에 한 조. 탭 없음. 심판은 자기 조만 본다.
 *   종목 고르기 → 조 고르기 → 기록 입력 → 조 마감 → 다음 조
 *   URL 로 바로 들어올 수도 있다:  index.html?event=14&heat=2
 *
 * 규칙
 *  - 입력은 로컬에 즉시 쓴다. 전송은 뒤에서. 회선이 끊겨도 멈추지 않는다.
 *  - 계산은 전부 공용 `web/shared/calc.js` 것을 쓴다. 사본을 만들지 않는다.
 *    자동 순위는 **보여만 주고 저장하지 않는다** — 심판 콘솔은 심판이 적은 값만 쓴다.
 *  - 충돌은 조용히 덮지 않는다. 항상 화면에 띄우고 되돌릴 길을 준다.
 *  - 전광판과의 저장 계약은 state.js 머리말 참조 (키·currentEvent·fitnessHeats·confirmed).
 */
(function () {
  "use strict";

  var DATA = window.MEET_DATA;
  if (!DATA) {
    document.body.innerHTML =
      '<div class="screen"><p class="empty">대회 데이터를 불러오지 못했습니다.<br>data.js 경로를 확인하세요.</p></div>';
    return;
  }

  var T = window.JudgeTime;
  var CFG = window.JUDGE_CONFIG || {};
  var qs = new URLSearchParams(location.search);

  /* 창 구분자. 리허설에서 창 두 개를 서로 다른 기기처럼 띄울 때만 쓴다.
     없으면 legacy 앱·전광판과 같은 저장소를 쓴다 (같은 기기에서 바로 물린다). */
  var WIN = (qs.get("win") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);

  var evById = {};
  (DATA.events || []).forEach(function (e) {
    evById[e.id] = e;
  });

  var S = window.JudgeState.create(DATA, { storeKeySuffix: WIN });
  var C = S.calc; // web/shared/calc.js — parseTime/fmtTime/rankedHeats 정본

  /* ── 화면 상태 (동기화 대상 아님 — 보는 사람마다 다르다) ─────────────── */
  var view = "pick-event"; // pick-event | pick-heat | sheet
  var selEvent = null;
  var selHeat = 1;
  var filter = "";
  var undoStack = [];
  var sync = null;
  var adapter = null;
  var pendingRender = false;
  var dirtyTimers = {};
  var serverClient = null;
  var forceLocalSync = false;
  var syncStarting = false;

  var $ = function (s, r) {
    return (r || document).querySelector(s);
  };

  /* ══════════════════════════════════════════════════════════ 토스트 */

  function toast(msg, opts) {
    opts = opts || {};
    var wrap = $("#toasts");
    var el = document.createElement("div");
    el.className = "toast";
    if (opts.tone) el.dataset.tone = opts.tone;
    var txt = document.createElement("div");
    txt.className = "txt";
    txt.textContent = msg;
    el.appendChild(txt);
    if (opts.action) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = opts.action;
      b.addEventListener("click", function () {
        el.remove();
        opts.onAction();
      });
      el.appendChild(b);
    }
    wrap.appendChild(el);
    var ms = opts.ms || (opts.action ? 6000 : 2200);
    setTimeout(function () {
      el.remove();
    }, ms);
    if (opts.buzz) buzz(opts.tone === "bad" ? [40, 60, 40] : 15);
  }

  /* 대회장은 시끄럽다. 소리 피드백은 무용지물이라 진동으로 알린다.
     브라우저는 사용자가 한 번 누르기 전의 진동을 막고 경고를 찍는다 — 그래서 게이트를 둔다. */
  var hadGesture = false;
  ["pointerdown", "keydown", "touchstart"].forEach(function (t) {
    window.addEventListener(t, function () {
      hadGesture = true;
    }, { once: true, capture: true });
  });

  function buzz(pattern) {
    if (!hadGesture || !navigator.vibrate) return;
    try {
      navigator.vibrate(pattern);
    } catch (e) {}
  }

  /* ══════════════════════════════════════════════════════════ 동기화 */

  function buildAdapter() {
    var meetId = CFG.meetId || "chungnam-inline-2026";
    var inner;

    // 1) Supabase 자격증명이 채워지면 그쪽으로 간다.
    if (!forceLocalSync && CFG.supabaseUrl && CFG.supabaseAnonKey && window.ChungnamSyncSupabaseAdapter && window.supabase) {
      serverClient = serverClient || window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
      inner = window.ChungnamSyncSupabaseAdapter.createSupabaseAdapter({
        client: serverClient,
        meetId: meetId,
      });
    } else if (window.ChungnamSyncBroadcastAdapter) {
      // 2) 서버가 아직 없다(MVP). 같은 기기의 창들이 localStorage + BroadcastChannel 로 이어진다.
      //    커밋 직렬화를 navigator.locks 로 한다. 이 파일의 사본을 만들지 않는다.
      inner = window.ChungnamSyncBroadcastAdapter.createBroadcastAdapter({ meetId: meetId });
    } else {
      // 3) 둘 다 없으면 동기화 없이 로컬로만 돈다. 조용히 못한 척하지 않는다.
      console.warn("[sync] 어댑터가 없다 — 이 기기에만 저장된다");
      return null;
    }

    // 리허설의 "오프라인 흉내" 스위치. 운영 화면에서는 토글이 감춰져 있다.
    return window.JudgeOfflineSwitch.wrap(inner);
  }

  function startSync() {
    if (!window.ChungnamSync || syncStarting || sync) return;
    if (!forceLocalSync && CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase) {
      serverClient = serverClient || window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
      syncStarting = true;
      serverClient.auth.getSession().then(function (res) {
        syncStarting = false;
        if (res && res.data && res.data.session) startSyncReady();
        else $("#auth-dlg").showModal();
      }).catch(function (err) {
        syncStarting = false;
        console.warn("[sync] 로그인 상태 확인 실패", err);
        $("#auth-dlg").showModal();
      });
      return;
    }
    startSyncReady();
  }

  function startSyncReady() {
    if (syncStarting || sync) return;
    syncStarting = true;
    adapter = buildAdapter();
    if (!adapter) {
      syncStarting = false;
      renderSync(null); // "동기화 꺼짐 · 이 기기에만 저장" 을 띄운다
      return;
    }
    var store;
    try {
      store = window.ChungnamSync.createIndexedDbStore({
        dbName: "chungnam_inline_judge" + (WIN ? "_" + WIN : ""),
      });
    } catch (e) {
      store = window.ChungnamSync.createMemoryStore();
    }

    sync = window.ChungnamSync.createSync({
      meetId: CFG.meetId || "chungnam-inline-2026",
      adapter: adapter,
      store: store,
      onRemote: onRemote,
      onConflict: onConflict,
      onStatus: renderSync,
      onError: function (err) {
        console.warn("[sync]", err);
      },
    });

    sync
      .start()
      .then(function () { syncStarting = false; return flushPreSync(); })
      .catch(function (err) {
        syncStarting = false;
        console.warn("[sync] 시작 실패 — 로컬로만 돕니다", err);
        toast("동기화를 시작하지 못했습니다. 기록은 이 기기에 저장됩니다", { tone: "bad" });
        renderSync(null);
      });
  }

  /**
   * 발행. 로컬 저장은 이미 끝난 뒤에 불린다.
   *
   * sync 는 IndexedDB 를 열고 채널에 붙는 동안 잠깐 null 이다. 그 사이에 심판이 친 것을
   * 버리면 조용히 한 칸이 사라진다 — 그래서 모아 뒀다가 붙는 즉시 내보낸다.
   */
  var preSync = [];
  function publish(change) {
    if (!change) return;
    if (!sync) {
      preSync.push(change);
      return;
    }
    sync.publish(change).catch(function (err) {
      console.warn("[sync] publish 실패", err);
    });
  }

  function flushPreSync() {
    if (!sync || !preSync.length) return;
    var queued = preSync;
    preSync = [];
    sync.publishMany(queued).catch(function (err) {
      console.warn("[sync] 초기 발행 실패", err);
    });
  }

  function onRemote(changes) {
    S.applyPatches(changes);
    // 지금 보고 있는 조에 닿는 변경만 화면에 반영한다.
    var touched = changes.filter(function (c) {
      return c.scope === "result" && c.eid === selEvent && c.heat === selHeat;
    });
    var structural = changes.some(function (c) {
      return c.scope !== "result" || c.eid !== selEvent;
    });

    if (view !== "sheet") {
      if (view === "pick-event" || view === "pick-heat") render();
      return;
    }

    // 심판이 칸에 커서를 두고 있으면 통째로 다시 그리지 않는다. 타이핑이 사라진다.
    var ae = document.activeElement;
    var typing = ae && ae.closest && ae.closest("#lanes");

    if (touched.length) touched.forEach(patchCell);
    if (structural) {
      if (typing) pendingRender = true;
      else render();
    }
  }

  /** 원격에서 온 셀 하나를 화면에 꽂는다. 포커스가 있는 칸은 건드리지 않는다. */
  function patchCell(c) {
    var row = document.querySelector('.lane[data-aid="' + c.athleteId + '"]');
    if (!row) return;
    var val = S.valueOf(c.eid, c.heat, c.athleteId, c.field);
    if (c.field === "time" || c.field === "rank") {
      var inp = $(c.field === "time" ? ".in-time" : ".in-rank", row);
      if (inp && document.activeElement !== inp) {
        inp.value = val;
        delete inp.dataset.dirty;
        validateTime(row);
      }
    } else if (c.field === "status") {
      paintStatus(row, val);
    }
    markLaneTone(row);
    paintAutoRanks();
    paintMissingWarning();
    row.dataset.remote = "1";
    setTimeout(function () {
      delete row.dataset.remote;
    }, 1500);
  }

  /**
   * 충돌. sync.js 는 내가 그 칸을 만지고 있지 않으면 서버 값으로 조용히 맞춘다.
   * 그래도 **말은 한다.** 심판이 적은 값이 사라졌는데 모르는 게 제일 나쁘다.
   */
  function onConflict(c) {
    var who = describeCell(c);
    if (c.resolution === "pending") {
      toast(who + " — 다른 기기와 값이 다릅니다. 눌러서 고르세요", {
        tone: "bad",
        buzz: true,
        action: "고르기",
        onAction: openConflicts,
        ms: 12000,
      });
    } else {
      toast(who + " — 다른 기기 값(" + showVal(c.server.value) + ")으로 바뀌었습니다", {
        tone: "bad",
        buzz: true,
        action: "내 값으로",
        ms: 12000,
        onAction: function () {
          publish({ cell: c.cell, value: c.local.value, oldValue: c.server.value });
          applyLocalFromCell(c.cell, c.local.value);
          toast("내 값(" + showVal(c.local.value) + ")으로 다시 보냈습니다", { tone: "ok" });
        },
      });
    }
    renderSync(sync ? sync.getStatus() : null);
    if (view === "sheet") render();
  }

  function applyLocalFromCell(cell, value) {
    var p = window.ChungnamSync.parseCell(cell);
    S.applyPatch({
      scope: p.scope,
      eid: p.eid,
      heat: p.heat,
      athleteId: p.athleteId,
      field: p.field,
      value: value,
    });
    if (view === "sheet") render();
  }

  function showVal(v) {
    if (v === "" || v == null) return "(빈칸)";
    if (typeof v === "object") return "조편성";
    return String(v);
  }

  var FIELD_KO = { time: "기록", rank: "순위", status: "상태", note: "비고" };

  function describeCell(c) {
    if (c.scope === "result") {
      var a = S.athById()[c.athleteId];
      var ev = evById[c.eid];
      return (
        (ev ? "No." + pad2(ev.id) + " " : "") +
        c.heat +
        "조 " +
        (a ? a.name : "번호 " + c.athleteId) +
        " " +
        (FIELD_KO[c.field] || c.field)
      );
    }
    if (c.scope === "fitness") return "최강전 조편성";
    if (S.isConfirmField(c.field)) return "조 마감 (" + c.field.slice(10) + ")";
    return c.field;
  }

  /* ── 상태 표시 — 항상 보인다 ────────────────────────────────────────── */

  function renderSync(st) {
    var chip = $("#sync-chip");
    var conf = $("#conflict-chip");
    if (!chip) return;

    if (!st) {
      chip.dataset.tone = "bad";
      chip.innerHTML = '<span class="dot"></span><span class="sync-txt">동기화 꺼짐 · 이 기기에만 저장</span>';
      conf.hidden = true;
      var lastOff = $("#sync-last");
      if (lastOff) lastOff.textContent = "";
      return;
    }

    var pending = st.pending || 0;
    var tone, label;
    if (!st.online) {
      tone = "warn";
      label = "오프라인 · 미전송 " + pending;
    } else if (st.lastError) {
      tone = "bad";
      label = "전송 실패 · 미전송 " + pending;
    } else if (pending > 0) {
      tone = "warn";
      label = "전송 중 · 남은 " + pending;
    } else {
      // ★ 이 문자열("전송 완료")은 verify-browser.mjs 가 정규식으로 그대로 찾는다.
      //   목업 문구("실시간 전송 중")로 바꾸면 자동검사가 깨진다 — 대신 아이콘·카드로 꾸민다.
      tone = "ok";
      label = "전송 완료";
    }
    chip.dataset.tone = tone;
    chip.innerHTML =
      '<span class="dot"></span><span class="sync-txt">' +
      label.replace(/(\d+)/, '<b class="n">$1</b>') +
      '</span><svg class="wifi" viewBox="0 0 20 20" aria-hidden="true">' +
      '<path d="M3 7.8a11 11 0 0 1 14 0M5.6 10.8a7.3 7.3 0 0 1 8.8 0M8.3 13.8a3.4 3.4 0 0 1 3.4 0" ' +
      'stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>' +
      '<circle cx="10" cy="16.2" r="1" fill="currentColor"/></svg>';
    chip.setAttribute(
      "aria-label",
      "동기화 상태: " + label + (st.lastSyncAt ? ", 마지막 전송 " + hhmm(st.lastSyncAt) : "")
    );

    var last = $("#sync-last");
    if (last) last.textContent = st.lastSyncAt ? "마지막 전송 " + fullDT(st.lastSyncAt) : "";

    var n = st.conflicts || 0;
    conf.hidden = n === 0;
    conf.textContent = "충돌 " + n + "건";
  }

  function hhmm(iso) {
    try {
      var d = new Date(iso);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    } catch (e) {
      return "";
    }
  }

  /* 목업의 "마지막 전송 2025. 11. 10. 09:41" 형식. hhmm() 은 그대로 두고(다른 곳에서도 쓴다) 별도로 둔다. */
  function fullDT(iso) {
    try {
      var d = new Date(iso);
      var p2 = function (n) {
        return String(n).padStart(2, "0");
      };
      return d.getFullYear() + ". " + p2(d.getMonth() + 1) + ". " + p2(d.getDate()) + ". " + p2(d.getHours()) + ":" + p2(d.getMinutes());
    } catch (e) {
      return "";
    }
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /* ══════════════════════════════════════════════════════════ 라우팅 */

  function go(next, opts) {
    if (view === "sheet") commitVisible();
    opts = opts || {};
    view = next;
    if (opts.event !== undefined) selEvent = opts.event;
    if (opts.heat !== undefined) selHeat = opts.heat;

    /* 전광판의 "지금 경기"를 심판이 보는 종목에 맞춘다.
       대형 화면은 아무도 조작하지 않으므로, 이걸 안 쓰면 1번 종목에 붙어 있는다.
       심판이 **의도적으로 종목을 고른 순간**에만 쓴다 — 매 렌더마다 쓰면
       심판 콘솔이 둘일 때 서로 밀어내며 핑퐁이 된다. */
    if ((view === "sheet" || view === "pick-heat") && selEvent) {
      publish(S.setCurrentEvent(selEvent));
    }

    syncUrl(opts.replace);
    render();
    window.scrollTo(0, 0);
  }

  function syncUrl(replace) {
    var p = new URLSearchParams();
    if (WIN) p.set("win", WIN);
    if (view === "sheet" && selEvent) {
      p.set("event", selEvent);
      p.set("heat", selHeat);
    } else if (view === "pick-heat" && selEvent) {
      p.set("event", selEvent);
    }
    var url = location.pathname + (p.toString() ? "?" + p.toString() : "");
    var st = { view: view, event: selEvent, heat: selHeat };
    try {
      if (replace) history.replaceState(st, "", url);
      else history.pushState(st, "", url);
    } catch (e) {}
  }

  window.addEventListener("popstate", function (e) {
    var st = e.state;
    if (!st) {
      view = "pick-event";
      selEvent = null;
    } else {
      view = st.view;
      selEvent = st.event;
      selHeat = st.heat || 1;
    }
    render();
  });

  /* ══════════════════════════════════════════════════════════ 그리기 */

  function render() {
    pendingRender = false;
    $("#pick").hidden = view === "sheet";
    $("#sheet").hidden = view !== "sheet";
    if (view === "sheet") renderSheet();
    else renderPick();
  }

  /* ── 선택 화면 ─────────────────────────────────────────────────────── */

  function renderPick() {
    var host = $("#pick");
    if (view === "pick-event") {
      host.innerHTML =
        '<h1 class="h1">종목 고르기</h1>' +
        '<p class="sub">' +
        esc(DATA.meta.title) +
        " · " +
        esc(DATA.meta.date) +
        "</p>" +
        '<input class="search" id="q" type="search" inputmode="search" placeholder="번호나 종목 이름" value="' +
        esc(filter) +
        '">' +
        '<div class="pick-list" id="ev-list"></div>';
      $("#q").addEventListener("input", function () {
        filter = this.value.trim();
        paintEventList();
      });
      paintEventList();
      return;
    }

    // 조 고르기
    var ev = evById[selEvent];
    var heats = S.heatsOf(ev);
    var items = heats
      .map(function (_, hi) {
        var h = hi + 1;
        var p = S.heatProgress(ev, h);
        var done = p.total > 0 && p.done === p.total;
        var conf = S.isConfirmed(ev.id, h);
        return (
          '<button class="pick-item" type="button" data-heat="' +
          h +
          '" data-done="' +
          (conf ? 1 : 0) +
          '">' +
          '<span class="no">' +
          h +
          "조</span>" +
          '<span><span class="nm">' +
          p.total +
          "명</span>" +
          '<span class="meta">' +
          (conf ? "마감됨" : done ? "입력 완료 · 미마감" : "입력 중") +
          "</span></span>" +
          '<span class="prog">' +
          p.done +
          "/" +
          p.total +
          "</span>" +
          "</button>"
        );
      })
      .join("");

    host.innerHTML =
      '<button class="btn" type="button" id="back-ev">← 종목 목록</button>' +
      '<h1 class="h1" style="margin-top:10px">No.' +
      pad2(ev.id) +
      " " +
      esc(ev.name) +
      "</h1>" +
      '<p class="sub">조를 고르세요</p>' +
      '<div class="pick-list">' +
      (items || '<p class="empty">조 편성이 없습니다.</p>') +
      "</div>";

    $("#back-ev").addEventListener("click", function () {
      go("pick-event", { event: null });
    });
    host.querySelectorAll("[data-heat]").forEach(function (b) {
      b.addEventListener("click", function () {
        go("sheet", { heat: +b.dataset.heat });
      });
    });
  }

  function paintEventList() {
    var list = $("#ev-list");
    if (!list) return;
    var f = filter.toLowerCase();
    var html = (DATA.events || [])
      .filter(function (ev) {
        if (!f) return true;
        return (ev.name + " " + ev.id + " " + pad2(ev.id) + " " + (ev.kind || "")).toLowerCase().includes(f);
      })
      .map(function (ev) {
        var p = S.eventProgress(ev);
        var nHeats = S.heatsOf(ev).length;
        var confN = 0;
        for (var h = 1; h <= nHeats; h++) if (S.isConfirmed(ev.id, h)) confN++;
        var allDone = nHeats > 0 && confN === nHeats;
        return (
          '<button class="pick-item" type="button" data-ev="' +
          ev.id +
          '" data-done="' +
          (allDone ? 1 : 0) +
          '">' +
          '<span class="no">' +
          pad2(ev.id) +
          "</span>" +
          "<span>" +
          '<span class="nm">' +
          esc(ev.name) +
          (ev.kind === "최강전" ? '<span class="badge champ">최강전</span>' : "") +
          "</span>" +
          '<span class="meta">' +
          nHeats +
          "개 조" +
          (confN ? " · " + confN + "개 마감" : "") +
          "</span>" +
          "</span>" +
          '<span class="prog">' +
          p.done +
          "/" +
          p.total +
          "</span>" +
          "</button>"
        );
      })
      .join("");
    list.innerHTML = html || '<p class="empty">찾는 종목이 없습니다.</p>';
    list.querySelectorAll("[data-ev]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = +b.dataset.ev;
        var n = S.heatsOf(evById[id]).length;
        if (n <= 1) go("sheet", { event: id, heat: 1 });
        else go("pick-heat", { event: id });
      });
    });
  }

  /* ── 입력 화면 ─────────────────────────────────────────────────────── */

  function commitVisible() {
    document.querySelectorAll('#lanes input[data-dirty="1"]').forEach(function (inp) {
      commit(inp.closest('.lane'), inp.dataset.field);
    });
  }

  function needsEntry(r) {
    return r.athleteId && !String(r.row.time || '').trim() && !T.normStatus(r.row.status);
  }

  function paintEntryTools() {
    var ev = evById[selEvent];
    if (!ev) return;
    var rows = S.laneRows(ev, selHeat).filter(function (r) { return r.athleteId; });
    var missing = rows.filter(needsEntry).length;
    var invalid = rows.filter(function (r) { return !T.checkTime(String(r.row.time || ''), C.parseTime).ok; }).length;
    $('#entry-summary').textContent = '입력 ' + (rows.length - missing) + ' / ' + rows.length + '명 · 미입력 ' + missing + '명 · 형식 확인 ' + invalid + '명';
    $('#next-missing').disabled = missing === 0;
    $('#heat-shortcuts').innerHTML = S.heatsOf(ev).map(function (_, i) {
      var heat = i + 1;
      var p = S.heatProgress(ev, heat);
      return '<button type="button" class="btn" data-jump-heat="' + heat + '" aria-pressed="' + (heat === selHeat) + '">' + heat + '조 · ' + (S.isConfirmed(ev.id, heat) ? '마감' : p.done + '/' + p.total) + '</button>';
    }).join('');
  }

  function findEntry(missingOnly) {
    commitVisible();
    var query = $('#lane-search').value.trim().toLowerCase();
    var rows = S.laneRows(evById[selEvent], selHeat);
    var match = rows.find(function (r) {
      if (!r.athlete) return false;
      if (missingOnly) return needsEntry(r);
      return !query || [r.athlete.name, r.athlete.id, r.athlete.club].join(' ').toLowerCase().includes(query);
    });
    if (!match) return toast(missingOnly ? '모든 선수의 기록 또는 상태가 입력됐습니다' : '이 조에서 해당 선수를 찾지 못했습니다');
    var input = $('#lanes .lane[data-aid="' + match.athleteId + '"] .in-time');
    if (input) { input.focus(); input.select(); input.scrollIntoView({ block: 'center' }); }
  }

  function renderSheet() {
    var ev = evById[selEvent];
    if (!ev) return go("pick-event", { event: null, replace: true });
    var heats = S.heatsOf(ev);
    if (selHeat > heats.length) selHeat = heats.length || 1;
    var confirmedAt = S.raw.confirmed[S.confirmKey(ev.id, selHeat)];

    $("#ev-no").textContent = "No." + pad2(ev.id);
    $("#ev-nm").textContent = ev.name;
    $("#heat-cur").innerHTML =
      esc(ev.kind || "예선") + " " + selHeat + "조 <span class=\"cur-frac\">(" + selHeat + "/" + heats.length + ")</span>";
    $("#prev-heat").disabled = selHeat <= 1;
    $("#next-heat").disabled = selHeat >= heats.length;

    var banner = $("#confirmed-banner");
    banner.hidden = !confirmedAt;
    if (confirmedAt) banner.textContent = "이 조는 " + hhmm(confirmedAt) + " 에 마감했습니다";

    var rows = S.laneRows(ev, selHeat);
    paintEntryTools();
    var lanes = $("#lanes");

    var heatCountEl = $("#heat-count-n");

    if (!rows.length) {
      lanes.innerHTML = "";
      $("#fitness").hidden = ev.kind !== "최강전";
      $("#no-lanes").hidden = ev.kind === "최강전";
      if (ev.kind === "최강전") renderFitness(ev);
      $("#close-heat").disabled = true;
      if (heatCountEl) heatCountEl.textContent = "0";
      var wm0 = $("#warn-missing");
      if (wm0) wm0.hidden = true;
      updateUndoBtn();
      return;
    }
    $("#fitness").hidden = true;
    $("#no-lanes").hidden = true;
    $("#close-heat").disabled = false;
    if (heatCountEl) heatCountEl.textContent = S.heatProgress(ev, selHeat).total;

    lanes.innerHTML = rows.map(laneHtml).join("");
    lanes.querySelectorAll(".lane").forEach(bindLane);
    paintAutoRanks();
    paintMissingWarning();

    var closeBtn = $("#close-heat");
    // textContent 로 통째로 바꾸면 안에 넣어 둔 아이콘 <svg> 까지 지워진다 — 아이콘은 남기고 글자만 바꾼다.
    var closeLbl = closeBtn.querySelector(".btn-txt");
    if (!closeLbl) {
      closeLbl = document.createElement("span");
      closeLbl.className = "btn-txt";
      closeBtn.appendChild(closeLbl);
    }
    closeLbl.textContent = confirmedAt ? "조 마감 해제" : "조 마감 및 저장";
    closeBtn.className = "btn big " + (confirmedAt ? "danger" : "go");
    updateUndoBtn();
  }

  /**
   * 기록·상태가 둘 다 비어 있는 레인을 목업의 빨간 경고 카드로 보여 준다.
   * closeHeat() 의 missing 계산과 같은 기준(시간도 상태도 없음)을 쓴다 — 다른 판정을 만들지 않는다.
   * 화면 표시만 하고 값은 절대 바꾸지 않는다(자동 순위 안내와 같은 원칙).
   * paintAutoRanks() 와 같은 자리(커밋·상태버튼·원격반영)에서 같이 불러야 입력하는 즉시 갱신된다 —
   * renderSheet() 한 곳에서만 부르면 다시 그리기 전까지 옛 목록이 남는다.
   */
  function paintMissingWarning() {
    paintEntryTools();
    var box = $("#warn-missing");
    if (!box) return;
    var ev = evById[selEvent];
    if (!ev) return;
    var rows = S.laneRows(ev, selHeat).filter(function (r) {
      if (!r.athleteId) return false;
      return !String(r.row.time || "").trim() && !T.normStatus(r.row.status);
    });
    if (!rows.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    $("#warn-missing-list").innerHTML = rows
      .map(function (r) {
        return (
          "<li>레인 " +
          r.lane +
          "번 " +
          esc((r.athlete && r.athlete.name) || "") +
          " 선수의 기록 또는 상태를 입력해 주세요.</li>"
        );
      })
      .join("");
  }

  /* 열 순서는 엑셀 경기 시트 그대로:
     조 | 레인 | 번호 | 이름 | 클럽 | 학년 | 기록 | 순위 | 상태
     앞 6개는 읽기 전용, 심판이 채우는 것은 뒤 3개다. */
  function laneHtml(r) {
    var a = r.athlete;
    if (!a) {
      return (
        '<div class="lane" data-empty="1" data-lane="' + r.lane + '">' +
        '<span class="c-heat" data-col="heat">' +
        selHeat +
        "</span>" +
        '<span class="c-lane" data-col="lane">' +
        r.lane +
        "</span>" +
        '<span class="c-bib">—</span>' +
        '<span class="c-name">미배정</span>' +
        '<span class="c-club" data-col="club"></span><span class="c-grade"></span>' +
        '<span class="c-time" data-col="time"></span><span class="c-rank"></span><span class="c-status"></span>' +
        "</div>"
      );
    }
    var row = r.row;
    var st = T.normStatus(row.status);
    return (
      '<div class="lane" data-aid="' +
      a.id +
      '" data-lane="' +
      r.lane +
      '">' +
      '<span class="c-heat" data-col="heat">' +
      selHeat +
      "</span>" +
      '<span class="c-lane" data-col="lane">' +
      r.lane +
      "</span>" +
      '<span class="c-bib" data-col="bib">' +
      a.id +
      "</span>" +
      '<span class="c-name" data-col="name">' +
      esc(a.name) +
      "</span>" +
      '<span class="c-club" data-col="club">' +
      esc(C.clubShort(a.club)) +
      "</span>" +
      '<span class="c-grade" data-col="grade">' +
      esc(a.grade || "") +
      "</span>" +
      // 기록
      '<span class="c-time field" data-col="time"><span class="lbl">기록</span><span class="row">' +
      '<input class="in-time" data-field="time" type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off" size="7" ' +
      'autocorrect="off" autocapitalize="off" spellcheck="false" ' +
      'aria-label="' +
      esc(a.name) +
      ' 기록" placeholder="45.23" value="' +
      esc(row.time || "") +
      '">' +
      '<button class="colon" type="button" tabindex="-1" aria-label="콜론 넣기">:</button>' +
      "</span></span>" +
      // 순위
      '<span class="c-rank field" data-col="rank"><span class="lbl">순위</span>' +
      '<input class="in-rank" data-field="rank" type="text" inputmode="numeric" enterkeyhint="next" autocomplete="off" size="3" ' +
      'aria-label="' +
      esc(a.name) +
      ' 조 순위, 비우면 자동" placeholder="자동" value="' +
      esc(row.rank || "") +
      '"></span>' +
      // 상태 — 목업형 한 줄 표에 맞춘 콤팩트 선택(완주/DNS/DNF/DQ/REL)
      '<span class="c-status field" data-col="status"><span class="lbl">상태</span>' +
      '<select class="in-status" data-field="status" data-status="' +
      st +
      '" aria-label="' +
      esc(a.name) +
      ' 상태">' +
      [["", "완주"], ["DNS", "DNS"], ["DNF", "DNF"], ["DQ", "DQ"], ["REL", "REL"]]
        .map(function (o) {
          return (
            '<option value="' + o[0] + '"' + (st === o[0] ? " selected" : "") + ">" + o[1] + "</option>"
          );
        })
        .join("") +
      "</select></span>" +
      '<span class="hint"></span>' +
      "</div>"
    );
  }

  function bindLane(row) {
    var aid = +row.dataset.aid;
    if (!aid) return;
    var time = $(".in-time", row);
    var rank = $(".in-rank", row);

    markLaneTone(row);

    /* 기록 ------------------------------------------------------------- */
    time.addEventListener("focus", function () {
      if (sync) sync.markEditing(cellOf("time", aid));
    });
    time.addEventListener("input", function () {
      time.dataset.dirty = "1";
      validateTime(row);
      scheduleCommit(row, "time");
    });
    time.addEventListener("blur", function () {
      commit(row, "time");
      if (sync) sync.clearEditing(cellOf("time", aid));
      if (pendingRender) render();
    });
    time.addEventListener("keydown", function (e) {
      if (!["Enter", "ArrowDown", "ArrowUp"].includes(e.key) || e.isComposing) return;
      e.preventDefault();
      commit(row, "time");
      focusNext(row, ".in-time", e.key === "ArrowUp" || e.shiftKey ? -1 : 1);
    });

    $(".colon", row).addEventListener("click", function () {
      insertAtCursor(time, ":");
      time.dataset.dirty = "1";
      validateTime(row);
      scheduleCommit(row, "time");
      time.focus();
    });

    /* 순위 ------------------------------------------------------------- */
    rank.addEventListener("focus", function () {
      if (sync) sync.markEditing(cellOf("rank", aid));
    });
    rank.addEventListener("input", function () {
      rank.dataset.dirty = "1";
      scheduleCommit(row, "rank");
    });
    rank.addEventListener("blur", function () {
      commit(row, "rank");
      if (sync) sync.clearEditing(cellOf("rank", aid));
      if (pendingRender) render();
    });
    rank.addEventListener("keydown", function (e) {
      if (!["Enter", "ArrowDown", "ArrowUp"].includes(e.key) || e.isComposing) return;
      e.preventDefault();
      commit(row, "rank");
      focusNext(row, ".in-rank", e.key === "ArrowUp" || e.shiftKey ? -1 : 1);
    });

    /* 상태 — 목업형 표: 콤팩트 선택(완주/DNS/DNF/DQ/REL) --------------- */
    var statusSel = $(".in-status", row);
    if (statusSel) {
      statusSel.addEventListener("change", function () {
        var v = statusSel.value;
        var prev = S.valueOf(selEvent, selHeat, aid, "status");
        if (T.normStatus(prev) === v) return;
        write(aid, "status", v, prev);
        paintStatus(row, v);
        markLaneTone(row);
        paintAutoRanks();
        paintMissingWarning();
      });
    }
  }

  function cellOf(field, aid) {
    return window.ChungnamSync.cellKey({
      scope: "result",
      eid: selEvent,
      heat: selHeat,
      athleteId: aid,
      field: field,
    });
  }

  function insertAtCursor(inp, txt) {
    var s = inp.selectionStart == null ? inp.value.length : inp.selectionStart;
    var e = inp.selectionEnd == null ? s : inp.selectionEnd;
    inp.value = inp.value.slice(0, s) + txt + inp.value.slice(e);
    var p = s + txt.length;
    try {
      inp.setSelectionRange(p, p);
    } catch (err) {}
  }

  function focusNext(row, sel, direction) {
    direction = direction || 1;
    var all = Array.prototype.slice.call(document.querySelectorAll("#lanes .lane"));
    var i = all.indexOf(row);
    for (var j = i + direction; j >= 0 && j < all.length; j += direction) {
      var nx = $(sel, all[j]);
      if (nx) {
        nx.focus();
        try {
          nx.select();
        } catch (e) {}
        return;
      }
    }
    document.activeElement.blur();
  }

  /** 입력이 1초 멎으면 저장한다. 다음 칸으로 안 넘어가고 화면을 꺼도 안 잃는다. */
  function scheduleCommit(row, field) {
    var key = row.dataset.aid + ":" + field;
    clearTimeout(dirtyTimers[key]);
    dirtyTimers[key] = setTimeout(function () {
      commit(row, field);
    }, 1000);
  }

  function commit(row, field) {
    var aid = +row.dataset.aid;
    var key = aid + ":" + field;
    clearTimeout(dirtyTimers[key]);
    var inp = $(field === "time" ? ".in-time" : ".in-rank", row);
    if (!inp) return;
    var value = inp.value.trim();
    var prev = S.valueOf(selEvent, selHeat, aid, field);
    if (value === prev) {
      delete inp.dataset.dirty;
      return;
    }
    write(aid, field, value, prev);
    delete inp.dataset.dirty;
    markLaneTone(row);
    paintAutoRanks();
    if (field === "time") paintMissingWarning();
  }

  /** 셀 하나를 쓰고 발행하고 되돌리기 스택에 쌓는다. 단일 통로. */
  function write(aid, field, value, prevValue) {
    var change = S.writeResult(selEvent, selHeat, aid, field, value);
    if (!change) return;
    publish(change);
    undoStack.push({
      eid: selEvent,
      heat: selHeat,
      aid: aid,
      field: field,
      from: prevValue == null ? "" : prevValue,
      to: value,
    });
    if (undoStack.length > 50) undoStack.shift();
    updateUndoBtn();
    buzz(12);
  }

  function validateTime(row) {
    var inp = $(".in-time", row);
    var hint = $(".hint", row);
    if (!inp || !hint) return;
    var r = T.checkTime(inp.value, C.parseTime);
    if (r.ok) {
      delete inp.dataset.bad;
      inp.removeAttribute("aria-invalid");
      hint.textContent = "";
    } else {
      inp.dataset.bad = "1";
      inp.setAttribute("aria-invalid", "true");
      hint.textContent = r.hint;
    }
  }

  /**
   * 비어 있는 순위칸의 자리표시에 **지금 자동으로 매겨질 순위**를 보여 준다.
   * "비우면 자동" 이라는 문장보다 실제 숫자가 훨씬 분명하다.
   * 계산은 공용 calc.rankedHeats 가 하고, 결과는 화면에만 쓴다 — 저장하지 않는다.
   */
  function paintAutoRanks() {
    var ev = evById[selEvent];
    if (!ev) return;
    var place = {};
    try {
      C.rankedHeats(ev).forEach(function (h) {
        if (h.heat !== selHeat) return;
        h.finished.forEach(function (x, i) {
          if (!x.manual) place[x.athleteId] = i + 1; // 손으로 적은 순위가 없을 때의 자동값
        });
      });
    } catch (e) {
      return; // 계산이 안 되면 자리표시는 "자동" 그대로 둔다
    }
    document.querySelectorAll("#lanes .lane[data-aid]").forEach(function (row) {
      var inp = $(".in-rank", row);
      if (!inp) return;
      var n = place[+row.dataset.aid];
      inp.placeholder = n ? "자동 " + n : "자동";
    });
  }

  function paintStatus(row, v) {
    var norm = T.normStatus(v);
    var sel = row.querySelector(".in-status");
    if (sel) {
      sel.value = norm;
      sel.setAttribute("data-status", norm);
    }
  }

  function markLaneTone(row) {
    var aid = +row.dataset.aid;
    if (!aid) return;
    var t = S.valueOf(selEvent, selHeat, aid, "time");
    var st = T.normStatus(S.valueOf(selEvent, selHeat, aid, "status"));
    if (st) {
      row.dataset.dnx = "1";
      delete row.dataset.has;
    } else if (String(t).trim()) {
      row.dataset.has = "1";
      delete row.dataset.dnx;
    } else {
      delete row.dataset.has;
      delete row.dataset.dnx;
    }
  }

  /* ── 최강전 조편성 직접 입력 ──────────────────────────────────────────
     최강전 진출자 자동 산정은 legacy/app.js 의 autoQualifiers 가 한다.
     여기서 다시 계산하지 않는다(BRIEF). 편성이 아직 없으면 번호만 받아 둔다. */

  function renderFitness(ev) {
    var n = Math.max(4, S.raw.qualifyCount || 6);
    var cur = (S.raw.fitnessHeats[ev.id] && S.raw.fitnessHeats[ev.id][0]) || [];
    var rows = "";
    for (var i = 0; i < n; i++) {
      rows +=
        '<div class="fit-row"><span class="c-lane">' +
        (i + 1) +
        "</span>" +
        '<input class="in-rank" data-field="rank" type="text" inputmode="numeric" data-fit="' +
        i +
        '" aria-label="' +
        (i + 1) +
        '레인 배번" placeholder="배번" value="' +
        esc(cur[i] == null ? "" : cur[i]) +
        '"></div>';
    }
    $("#fit-grid").innerHTML = rows;
    $("#fit-grid")
      .querySelectorAll("[data-fit]")
      .forEach(function (inp) {
        inp.addEventListener("change", function () {
          var lanes = [];
          $("#fit-grid")
            .querySelectorAll("[data-fit]")
            .forEach(function (x) {
              var v = parseInt(x.value, 10);
              lanes.push(Number.isFinite(v) ? v : null);
            });
          while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
          var change = S.setFitness(ev.id, [lanes]);
          publish(change);
          toast("조편성을 저장했습니다");
          render();
        });
      });
  }

  /* ── 되돌리기 ──────────────────────────────────────────────────────── */

  function updateUndoBtn() {
    var b = $("#undo");
    var last = undoStack[undoStack.length - 1];
    b.disabled = !last;
    // textContent 로 통째로 바꾸면 안의 아이콘 <svg> 가 지워진다 — 글자칸만 갈아 끼운다.
    var lbl = b.querySelector(".btn-txt");
    if (!lbl) {
      lbl = document.createElement("span");
      lbl.className = "btn-txt";
      b.appendChild(lbl);
    }
    lbl.textContent = "마지막 수정 되돌리기";
    b.setAttribute(
      "aria-label",
      last
        ? "마지막 수정 되돌리기: " +
            (S.athById()[last.aid] || {}).name +
            " " +
            (FIELD_KO[last.field] || last.field) +
            " " +
            showVal(last.to) +
            " → " +
            showVal(last.from)
        : "되돌릴 것이 없습니다"
    );
  }

  function undo() {
    var last = undoStack.pop();
    if (!last) return;
    var change = S.writeResult(last.eid, last.heat, last.aid, last.field, last.from);
    publish(change);
    var a = S.athById()[last.aid] || {};
    toast(
      (a.name || last.aid) +
        " " +
        (FIELD_KO[last.field] || last.field) +
        " → " +
        showVal(last.from) +
        " 로 되돌렸습니다",
      { tone: "ok", buzz: true }
    );
    if (last.eid !== selEvent || last.heat !== selHeat) {
      go("sheet", { event: last.eid, heat: last.heat });
    } else {
      render();
    }
    updateUndoBtn();
  }

  /* ── 조 마감 ───────────────────────────────────────────────────────── */

  function closeHeat() {
    commitVisible();
    var ev = evById[selEvent];
    var already = S.isConfirmed(ev.id, selHeat);

    if (already) {
      var change0 = S.setConfirmed(ev.id, selHeat, "");
      publish(change0);
      toast(selHeat + "조 마감을 해제했습니다", { tone: "ok", buzz: true });
      render();
      return;
    }

    var missing = S.laneRows(ev, selHeat).filter(function (r) {
      if (!r.athleteId) return false;
      return !String(r.row.time || "").trim() && !T.normStatus(r.row.status);
    });

    if (missing.length) {
      var dlg = $("#confirm-close");
      $("#missing-list").innerHTML = missing
        .map(function (r) {
          return "<li>" + r.lane + "레인 " + esc((r.athlete && r.athlete.name) || "") + "</li>";
        })
        .join("");
      $("#missing-n").textContent = missing.length;
      dlg.returnValue = "";
      dlg.showModal();
      return;
    }
    doClose();
  }

  function doClose() {
    var ev = evById[selEvent];
    var change = S.setConfirmed(ev.id, selHeat, new Date().toISOString());
    publish(change);
    toast(selHeat + "조를 마감했습니다", { tone: "ok", buzz: true });

    // Keep judge and spectator on the same first unconfirmed heat. Do not
    // skip an earlier heat when the judge closes heats out of order.
    var start = DATA.events.findIndex(function (item) { return item.id === ev.id; });
    for (var i = start; i < DATA.events.length; i++) {
      var next = DATA.events[i];
      var heats = S.heatsOf(next);
      for (var hi = 0; hi < heats.length; hi++) {
        if (!S.isConfirmed(next.id, hi + 1)) {
          go("sheet", { event: next.id, heat: hi + 1 });
          toast("No." + pad2(next.id) + " · " + (hi + 1) + "조로 넘어왔습니다", { tone: "ok" });
          return;
        }
      }
      // A final without a lineup must wait here rather than disappear.
      if (!heats.length) {
        go("sheet", { event: next.id, heat: 1 });
        return;
      }
    }
    render();
    toast("마지막 경기까지 마감했습니다. 기록을 확인해 주세요.", { tone: "ok" });
  }

  /* ── 충돌 화면 ─────────────────────────────────────────────────────── */

  function openConflicts() {
    var list = sync ? sync.listConflicts() : [];
    var body = $("#conflict-list");
    if (!list.length) {
      body.innerHTML = '<p class="empty">해결할 충돌이 없습니다.</p>';
    } else {
      body.innerHTML = list
        .map(function (c) {
          return (
            '<div class="conflict" data-cell="' +
            esc(c.cell) +
            '">' +
            "<h3>" +
            esc(describeCell(c)) +
            "</h3>" +
            '<div class="vals">' +
            '<div class="val"><b>내가 적은 값</b><span>' +
            esc(showVal(c.local.value)) +
            "</span></div>" +
            '<div class="val"><b>다른 기기 값' +
            (c.server.at ? " · " + hhmm(c.server.at) : "") +
            "</b><span>" +
            esc(showVal(c.server.value)) +
            "</span></div>" +
            "</div>" +
            '<div class="acts">' +
            '<button class="btn primary" type="button" data-pick="local">내 값 쓰기</button>' +
            '<button class="btn" type="button" data-pick="server">다른 기기 값 쓰기</button>' +
            "</div></div>"
          );
        })
        .join("");
      body.querySelectorAll(".conflict").forEach(function (box) {
        box.querySelectorAll("[data-pick]").forEach(function (b) {
          b.addEventListener("click", function () {
            var cell = box.dataset.cell;
            var choice = b.dataset.pick;
            var rec = sync.listConflicts().filter(function (x) {
              return x.cell === cell;
            })[0];
            sync.resolveConflict(cell, choice).then(function () {
              if (rec) applyLocalFromCell(cell, choice === "local" ? rec.local.value : rec.server.value);
              toast("반영했습니다", { tone: "ok" });
              openConflicts();
              renderSync(sync.getStatus());
              render();
            });
          });
        });
      });
    }
    $("#conflict-dlg").showModal();
  }

  /* ── 동기화 상세 ───────────────────────────────────────────────────── */

  function openSyncSheet() {
    var st = sync ? sync.getStatus() : null;
    $("#sync-kv").innerHTML = st
      ? "<dt>연결</dt><dd>" +
        (st.online ? "온라인" : "오프라인") +
        (st.connected ? "" : " (서버 미연결)") +
        "</dd>" +
        "<dt>미전송</dt><dd>" +
        (st.pending || 0) +
        "건</dd>" +
        "<dt>마지막 전송</dt><dd>" +
        (st.lastSyncAt ? hhmm(st.lastSyncAt) : "없음") +
        "</dd>" +
        "<dt>충돌</dt><dd>" +
        (st.conflicts || 0) +
        "건</dd>" +
        "<dt>이 기기</dt><dd>" +
        esc(st.deviceId || "") +
        "</dd>" +
        (st.lastError ? "<dt>마지막 오류</dt><dd>" + esc(st.lastError) + "</dd>" : "")
      : "<dt>동기화</dt><dd>꺼짐 — 이 기기에만 저장됩니다</dd>";
    $("#sync-dlg").showModal();
  }

  function exportExcel() {
    if (!window.XLSX) {
      toast("엑셀 모듈을 불러오지 못했습니다. 인터넷 연결 후 다시 시도하세요", { tone: "bad", ms: 6000 });
      return;
    }
    var rows = [];
    (DATA.events || []).forEach(function (ev) {
      C.rankedEvent(ev).all.forEach(function (x) {
        rows.push({
          경기번호: ev.id,
          경기명: ev.name,
          조: x.heat,
          레인: x.lane,
          번호: x.athleteId,
          이름: x.a ? x.a.name : "",
          클럽: x.a ? x.a.club : "",
          학년: x.a ? x.a.grade : "",
          성별: x.a ? x.a.gender : "",
          기록: x.time || "",
          조순위: typeof x.heatPlace === "number" ? x.heatPlace : "",
          전체순위: typeof x.overallPlace === "number" ? x.overallPlace : "",
          상태: x.st || "",
        });
      });
    });
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [8, 34, 6, 6, 8, 14, 22, 10, 8, 12, 9, 9, 9].map(function (wch) { return { wch: wch }; });
    XLSX.utils.book_append_sheet(wb, ws, "전체기록");
    XLSX.writeFile(wb, "2026_충남체육회장기_인라인_경기기록.xlsx");
    toast("현재 기록을 엑셀로 저장했습니다", { tone: "ok" });
  }

  /* ══════════════════════════════════════════════════════════ 부팅 */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function boot() {
    $('#heat-shortcuts').addEventListener('click', function (e) {
      var button = e.target.closest('[data-jump-heat]');
      if (button) go('sheet', { heat: Number(button.dataset.jumpHeat) });
    });
    $('#find-lane').addEventListener('click', function () { findEntry(false); });
    $('#next-missing').addEventListener('click', function () { findEntry(true); });
    $('#lane-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); findEntry(false); }
    });
    $("#meet-title").textContent = DATA.meta.title;

    // 상단 햄버거 — 목업 오른쪽 위 ≡ 아이콘. 사이드바에 있던 나머지 메뉴(경기 편성 등)를 여기로 옮겼다.
    var moreBtn = $("#topbar-more");
    var moreMenu = $("#more-menu");
    if (moreBtn && moreMenu) {
      moreBtn.addEventListener("click", function () {
        var willOpen = moreMenu.hidden;
        moreMenu.hidden = !willOpen;
        moreBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
      });
      document.addEventListener("click", function (e) {
        if (moreMenu.hidden) return;
        if (moreMenu.contains(e.target) || moreBtn.contains(e.target)) return;
        moreMenu.hidden = true;
        moreBtn.setAttribute("aria-expanded", "false");
      });
    }

    $("#sync-chip").addEventListener("click", openSyncSheet);
    $("#conflict-chip").addEventListener("click", openConflicts);
    $("#back-heat").addEventListener("click", function () {
      var n = S.heatsOf(evById[selEvent]).length;
      go(n > 1 ? "pick-heat" : "pick-event", n > 1 ? {} : { event: null });
    });
    $("#prev-heat").addEventListener("click", function () {
      if (selHeat > 1) go("sheet", { heat: selHeat - 1 });
    });
    $("#next-heat").addEventListener("click", function () {
      if (selHeat < S.heatsOf(evById[selEvent]).length) go("sheet", { heat: selHeat + 1 });
    });
    $("#undo").addEventListener("click", undo);
    $("#export-xlsx").addEventListener("click", exportExcel);
    $("#close-heat").addEventListener("click", closeHeat);
    $("#do-close").addEventListener("click", function () {
      $("#confirm-close").close();
      doClose();
    });
    document.querySelectorAll("[data-close-dlg]").forEach(function (b) {
      b.addEventListener("click", function () {
        b.closest("dialog").close();
      });
    });
    $("#flush-now").addEventListener("click", function () {
      if (!sync) return;
      sync.flush().then(function () {
        toast("전송을 시도했습니다", { tone: "ok" });
        renderSync(sync.getStatus());
      });
    });
    $("#resync").addEventListener("click", function () {
      if (!sync) return;
      sync.resync().then(function () {
        toast("서버 기준으로 다시 맞췄습니다", { tone: "ok" });
        render();
        renderSync(sync.getStatus());
      });
    });
    $("#auth-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var identity = $("#auth-email").value;
      var email = window.ChungnamAuthIdentity.resolve(identity, (window.CHUNGNAM_LIVE_CONFIG || {}).loginAliases);
      var password = $("#auth-password").value;
      var submit = $("#auth-submit");
      var error = $("#auth-error");
      if (!serverClient || !password) return;
      if (!email) {
        error.textContent = "아이디 또는 이메일과 비밀번호를 확인하세요.";
        error.hidden = false;
        $("#auth-email").focus();
        return;
      }
      submit.disabled = true;
      error.hidden = true;
      serverClient.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        submit.disabled = false;
        if (res.error) throw res.error;
        $("#auth-dlg").close();
        $("#auth-password").value = "";
        startSyncReady();
      }).catch(function () {
        submit.disabled = false;
        error.textContent = "로그인할 수 없습니다. 아이디 또는 이메일과 비밀번호를 확인하세요.";
        error.hidden = false;
        $("#auth-password").focus();
      });
    });
    $("#auth-local").addEventListener("click", function () {
      forceLocalSync = true;
      $("#auth-dlg").close();
      startSyncReady();
      toast("이 기기에만 저장합니다", { tone: "ok" });
    });
    // 오프라인 흉내는 리허설 도구다. 대회 당일 화면에서는 아예 안 보이게 한다.
    if (!(WIN || qs.get("dev") === "1")) {
      var devrow = document.querySelector(".devrow");
      if (devrow) devrow.hidden = true;
    }
    $("#fake-offline").addEventListener("change", function () {
      var off = this.checked;
      if (adapter && adapter.setOffline) adapter.setOffline(off);
      if (sync) sync.setOnline(off ? false : null);
      toast(off ? "오프라인 흉내 켬 — 입력은 계속됩니다" : "오프라인 흉내 끔", { tone: off ? "bad" : "ok" });
      renderSync(sync ? sync.getStatus() : null);
    });

    // 같은 기기의 다른 탭(legacy 앱·전광판)이 같은 저장소를 고쳤다.
    window.addEventListener("storage", function (e) {
      if (e.key && e.key !== S.STORE_KEY) return;
      S.reloadFromStorage();
      render();
    });

    // 회선 상태 변화는 sync 가 잡지만, 칩은 즉시 바꿔 준다.
    window.addEventListener("online", function () {
      renderSync(sync ? sync.getStatus() : null);
    });
    window.addEventListener("offline", function () {
      renderSync(sync ? sync.getStatus() : null);
    });

    S.subscribe(function (ev) {
      if (ev.type === "storage-error") {
        toast("이 기기에 저장하지 못했습니다. 종이 기록지를 꼭 유지하세요", { tone: "bad", buzz: true, ms: 9000 });
      }
    });

    // URL 로 바로 들어오는 경로: ?event=14&heat=2
    var e0 = parseInt(qs.get("event"), 10);
    var h0 = parseInt(qs.get("heat"), 10);
    if (Number.isFinite(e0) && evById[e0]) {
      selEvent = e0;
      selHeat = Number.isFinite(h0) && h0 > 0 ? h0 : 1;
      view = qs.get("heat") ? "sheet" : S.heatsOf(evById[e0]).length > 1 ? "pick-heat" : "sheet";
      // URL 로 바로 들어오는 경로도 go() 와 똑같이 "지금 경기"를 주장해야 한다.
      // 이게 없으면 전광판이 1번 종목에 붙어 있는다. (sync 가 아직 null 이라 발행은 큐에 쌓인다)
      publish(S.setCurrentEvent(selEvent));
    }
    syncUrl(true);
    renderSync(null);
    render();
    startSync();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
