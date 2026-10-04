/* board.js — 공개 전광판 화면
 * ---------------------------------------------------------------------------
 * 데이터는 전부 window.ScoreboardSource 뒤에 있다. 이 파일은 MEET_DATA 도
 * localStorage 도 직접 보지 않는다. 서버로 갈아끼워도 이 파일은 안 고친다.
 *
 * 연출 원칙
 *   - 순위가 바뀌면 **행이 실제로 움직인다**(FLIP). 목록을 다시 그려 튀지 않는다.
 *   - 새 기록은 그 행을 한 번 훑고 지나가는 빛으로 알린다. 반복하지 않는다.
 *   - 값이 정정되면 옛 값이 취소선으로 잠깐 남고 새 값이 올라온다.
 *   - prefers-reduced-motion 이면 위 셋을 전부 끄고 테두리 강조만 남긴다.
 *   - 스크린리더에는 셀마다 떠들지 않는다. 하나의 status 영역에 5초에 한 번,
 *     "무슨 일이 있었는지"를 문장으로만 알린다.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  var $ = function (s, r) {
    return (r || document).querySelector(s);
  };

  var qs = new URLSearchParams(location.search);
  if (qs.get("embedded") === "1") document.documentElement.dataset.embedded = "true";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* 모션 토큰 — board.css 와 같은 값을 쓴다 */
  var MOVE_MS = 380;
  var EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";

  var CYCLE_MS = 8000; // 대형 화면 자동 순환 간격
  var DELTA_MS = 7000; // 순위 변동 화살표가 남아 있는 시간
  var ANNOUNCE_MS = 5000; // 스크린리더 알림 최소 간격

  /* ───────────────────────────────────────────── 화면 상태 */

  var st = {
    mode: "phone",
    tab: "lanes", // 폰 전용
    heat: null, // 왼쪽 패널이 보고 있는 조
    order: "lane", // "lane" | "rank"
    cycling: true,
    announce: true,
    sheetOpen: false,
    focusLayout: qs.get("display") === "focus",
  };

  var source = null;
  var view = null; // 최근 eventView
  var prevPlaces = {}; // athleteKey -> 직전 종목 순위
  var deltas = {}; // athleteKey -> {dir, n, until}
  var pendingFx = {}; // rowKey -> {type:"new"|"fix", from, to}
  var confirmFx = {}; // "eid:heat" -> true
  var cycleTimer = null;
  var announceQueue = [];
  var lastAnnounceAt = 0;
  var announceTimer = null;

  /* ───────────────────────────────────────────── 작은 도구 */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function laneColor(lane) {
    var n = ((Number(lane) || 1) - 1) % 8;
    return "var(--lane-" + (n + 1) + ")";
  }

  /** 기록 문자열을 정수부 / 소수점 / 소수부로 쪼갠다. 소수점 위치를 고정하기 위함. */
  function timeParts(row) {
    // 미완주는 기록 자리가 아니라 **순위 자리**에 코드로 박힌다.
    // 기록 자리에까지 REL/DQ 를 겹쳐 쓰면 어느 쪽이 기록인지 헷갈린다.
    if (row.dnx) return { main: "—", dot: "", frac: "", cls: "is-empty" };
    if (!row.timeText) return { main: "—", dot: "", frac: "", cls: "is-empty" };
    var t = String(row.timeText);
    var i = t.lastIndexOf(".");
    if (i < 0) return { main: t, dot: "", frac: "", cls: "" };
    return { main: t.slice(0, i), dot: ".", frac: t.slice(i + 1), cls: "" };
  }

  /** 순위 자리 — 숫자, 미완주 코드, 또는 빈 칸 */
  function placeInfo(p) {
    if (typeof p === "number") {
      return { text: String(p), cls: p <= 3 ? "p" + p : "", label: p + "위" };
    }
    if (p) return { text: String(p), cls: "dnx", label: String(p) };
    return { text: "·", cls: "empty", label: "기록 없음" };
  }

  function isReduced() {
    return reduced.matches;
  }

  /* ───────────────────────────────── FLIP: 순위 이동을 눈에 보이게 */

  /**
   * 먼저 모든 위치를 읽고(First), 목록을 갈아 끼운 뒤 다시 읽어(Last)
   * 차이만큼 되돌려 놓고(Invert) 제자리로 애니메이션한다(Play).
   * 읽기와 쓰기를 뒤섞지 않는다 — 레이아웃 스래싱을 피하기 위함.
   */
  function captureRects(container) {
    var map = new Map();
    if (!container) return map;
    var kids = container.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i].dataset.key;
      if (k) map.set(k, kids[i].getBoundingClientRect());
    }
    return map;
  }

  function playFlip(container, before) {
    if (!container || isReduced() || !before.size) return;
    var kids = Array.prototype.slice.call(container.children);
    var reads = kids.map(function (n) {
      return [n, n.getBoundingClientRect()]; // 읽기만 모아서 먼저
    });
    reads.forEach(function (pair) {
      var node = pair[0];
      var now = pair[1];
      var was = before.get(node.dataset.key);
      if (!was) return;
      var dx = was.left - now.left;
      var dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      // 움직이는 행은 지나가는 동안 아래 행 위에 얹혀야 한다.
      // 그러지 않으면 두 행의 글자가 겹쳐 뭉개진다 — 이동이 안 읽힌다.
      node.classList.add("moving");
      var anim = node.animate(
        [
          { transform: "translate(" + dx + "px," + dy + "px)" },
          { transform: "translate(0,0)" },
        ],
        { duration: MOVE_MS, easing: EASE }
      );
      anim.finished
        .then(function () {
          node.classList.remove("moving");
        })
        .catch(function () {
          node.classList.remove("moving");
        });
    });
  }

  /** key 로 요소를 재사용하는 목록 갱신. 재사용해야 FLIP 이 성립한다. */
  function patchList(container, items, make, update) {
    var existing = new Map();
    Array.prototype.slice.call(container.children).forEach(function (n) {
      if (n.dataset.key) existing.set(n.dataset.key, n);
    });
    var prev = null;
    items.forEach(function (item) {
      var node = existing.get(item.key);
      if (node) {
        existing.delete(item.key);
        node.classList.remove("enter");
        delete node.dataset.fresh;
      } else {
        node = make(item);
        node.dataset.key = item.key;
        node.dataset.fresh = "1"; // 이번에 새로 생긴 행 — 등장 연출 대상
      }
      update(node, item); // 새로 만든 행도 반드시 채운다

      var target = prev ? prev.nextSibling : container.firstChild;
      if (node !== target) container.insertBefore(node, target);
      prev = node;
    });
    existing.forEach(function (n) {
      n.remove();
    });
  }

  /* ─────────────────────────────────────────── 연출 효과 붙이기 */

  function markChanged(node, fx) {
    if (!node) return;
    if (isReduced()) {
      node.classList.add("rm-mark");
      setTimeout(function () {
        node.classList.remove("rm-mark");
      }, 1200);
      return;
    }
    // 지나가는 빛 — 한 번만
    var s = el("span", "sweep");
    node.appendChild(s);
    s.addEventListener("animationend", function () {
      s.remove();
    });
    var t = $(".time", node);
    var fixing = fx && fx.type === "fix" && fx.from;
    if (t) {
      // 처음 들어온 기록은 밝기만 튄다(숫자가 사라지면 안 된다).
      // 정정된 기록은 옛 값이 빠지고 새 값이 올라온다.
      t.classList.remove("swap-in", "pop");
      void t.offsetWidth; // 재생 강제
      t.classList.add(fixing ? "swap-in" : "pop");
    }
    if (fixing) {
      var g = el("span", "ghost-old", fx.from);
      node.appendChild(g);
      g.addEventListener("animationend", function () {
        g.remove();
      });
    }
  }

  /* ──────────────────────────────────────── 스크린리더 알림 */

  /* 실시간 갱신이 보조기기를 도배하지 않게 하는 규칙:
   *   - 표 자체는 aria-live="off". 셀은 절대 스스로 말하지 않는다.
   *   - 알림은 role="status" 한 곳으로만 나간다.
   *   - 최소 5초 간격. 그 사이 쌓인 변경은 건수 + 가장 최근 것 하나로 뭉친다.
   *   - 숫자만 읽지 않는다. "누가 몇 초, 몇 위, 잠정인지"까지 한 문장으로.
   *   (ui-ux-pro-max --domain ux "Contextual Live Badge Updates":
   *    하나의 원자적 상태 문장으로 알리고, 여러 개를 경쟁시키지 말 것) */
  function announce(text) {
    if (!st.announce || !text) return;
    announceQueue.push(text);
    scheduleAnnounce();
  }

  function scheduleAnnounce() {
    if (announceTimer) return;
    var wait = Math.max(0, ANNOUNCE_MS - (Date.now() - lastAnnounceAt));
    announceTimer = setTimeout(function () {
      announceTimer = null;
      if (!announceQueue.length) return;
      var last = announceQueue[announceQueue.length - 1];
      var n = announceQueue.length;
      announceQueue = [];
      lastAnnounceAt = Date.now();
      var msg = n > 1 ? "갱신 " + n + "건. 최근: " + last : last;
      var region = $("#live-region");
      if (region) region.textContent = msg;
    }, wait);
  }

  /* ──────────────────────────────────────────────── 그리기 */

  function renderHeader() {
    var m = source.meta();
    $("#meet-title").textContent = m.title;
    $("#meet-date").textContent = window.CHUNGNAM_PUBLIC?.dateLabel || "개최일 확인 중";
    $("#meet-place").textContent = window.CHUNGNAM_PUBLIC?.venue?.name || "경기장 확인 중";
    $("#source-label").textContent = m.sourceLabel;
    $("#demo-flag").hidden = !m.demo;
    $("#demo-foot").hidden = !m.demo;
    $("#wait-flag").hidden = !m.waiting;
  }

  // 대회 시작 전에는 "지금 경기(LIVE)"를 표시하지 않는다(예정).
  function sbMeetStarted() {
    try {
      var s = (window.CHUNGNAM_PUBLIC && window.CHUNGNAM_PUBLIC.campaign && Date.parse(window.CHUNGNAM_PUBLIC.campaign.startAt)) || NaN;
      if (!isFinite(s)) {
        var m = String(((window.MEET_DATA || {}).meta || {}).date || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
        if (m) s = new Date(+m[1], +m[2] - 1, +m[3], 9, 0, 0).getTime();
      }
      return isFinite(s) ? Date.now() >= s : true;
    } catch (e) { return true; }
  }

  function renderEventBar() {
    var ev = view.event;
    $("#ev-no").textContent = ev.no;
    $("#ev-name").textContent = ev.name;

    var meta = $("#ev-meta");
    meta.textContent = "";
    if (source.isFollowingLive() && sbMeetStarted()) {
      var live = el("span", "badge b-live");
      live.appendChild(el("span", "dot"));
      live.appendChild(document.createTextNode("지금 경기"));
      meta.appendChild(live);
    } else if (source.isFollowingLive()) {
      meta.appendChild(el("span", "badge b-heat", "대회 예정"));
    } else {
      meta.appendChild(el("span", "badge b-heat", "선택한 경기 보는 중"));
    }
    meta.appendChild(
      el(
        "span",
        "badge " + (ev.kind === "최강전" ? "b-champ" : ev.kind === "결승" ? "b-final" : "b-heat"),
        ev.kind
      )
    );
    meta.appendChild(el("span", "badge b-heat", ev.dist));
    meta.appendChild(el("span", "badge b-heat", ev.gender));
    if (ev.heatCount > 1) meta.appendChild(el("span", "badge b-heat", ev.heatCount + "개 조"));

    $("#back-live").hidden = source.isFollowingLive();

    var p = view.progress;
    var pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $("#gauge-fill").style.width = pct + "%";
    $("#gauge-done").textContent = p.done + " / " + p.total;
    $("#gauge-status").textContent = p.status;
    var g = $("#gauge");
    g.setAttribute("aria-valuenow", String(pct));
    g.setAttribute(
      "aria-label",
      "종목 진행 " + p.status + ", " + p.total + "명 중 " + p.done + "명 기록"
    );
  }

  /* ── 레인 목록 (진행 중인 조) ── */

  function makeLane(row) {
    var li = el("li", "lane");
    li.appendChild(el("span", "lane-no"));
    li.appendChild(el("span", "place"));

    var who = el("div", "who");
    who.appendChild(el("div", "who-name"));
    var sub = el("div", "who-sub");
    sub.appendChild(el("span", "bib"));
    sub.appendChild(el("span", "club"));
    sub.appendChild(el("span", "grade"));
    who.appendChild(sub);
    li.appendChild(who);
    li.appendChild(el("span", "leader"));

    var rec = el("div", "rec");
    var t = el("span", "time");
    t.appendChild(el("b", "t-main"));
    t.appendChild(el("i", "t-dot"));
    t.appendChild(el("u", "t-frac"));
    rec.appendChild(t);
    rec.appendChild(el("div", "rec-flags"));
    li.appendChild(rec);
    return li;
  }

  function updateLane(li, row) {
    li.style.setProperty("--lane-c", laneColor(row.lane));
    li.classList.toggle("is-waiting", !row.hasResult);

    var no = $(".lane-no", li);
    no.textContent = row.lane || "-";

    var pi = placeInfo(row.place);
    var pl = $(".place", li);
    pl.className = "place " + pi.cls;
    pl.textContent = pi.text;
    pl.setAttribute("aria-label", pi.label);

    $(".who-name", li).textContent = row.name;
    $(".bib", li).textContent = "#" + String(row.athleteId).padStart(3, "0");
    $(".bib", li).setAttribute("aria-label", "배번 " + row.athleteId);
    $(".club", li).textContent = row.clubShort;
    $(".grade", li).textContent = row.grade;

    var tp = timeParts(row);
    var t = $(".time", li);
    t.className = "time " + tp.cls;
    $(".t-main", t).textContent = tp.main;
    $(".t-dot", t).textContent = tp.dot;
    $(".t-frac", t).textContent = tp.frac;

    var flags = $(".rec-flags", li);
    flags.textContent = "";
    if (row.provisional) flags.appendChild(el("span", "prov", "잠정"));

    li.setAttribute(
      "aria-label",
      row.lane +
        "레인 " +
        row.name +
        " " +
        row.clubShort +
        ", " +
        (row.dnx ? row.dnx : row.timeText ? row.timeText + (row.provisional ? " 잠정" : " 확정") : "기록 대기") +
        (typeof row.place === "number" ? ", 조 " + row.place + "위" : "")
    );
  }

  /* ── 순위 행 (조 순위 / 종목 순위 공용) ── */

  function makeRankRow() {
    var li = el("li", "rank-row");
    li.appendChild(el("span", "place"));

    var who = el("div", "who");
    who.appendChild(el("div", "who-name"));
    var sub = el("div", "who-sub");
    sub.appendChild(el("span", "club"));
    sub.appendChild(el("span", "hl"));
    sub.appendChild(el("span", "delta-slot"));
    who.appendChild(sub);
    li.appendChild(who);

    var rec = el("div", "rec");
    var t = el("span", "time");
    t.appendChild(el("b", "t-main"));
    t.appendChild(el("i", "t-dot"));
    t.appendChild(el("u", "t-frac"));
    rec.appendChild(t);
    rec.appendChild(el("div", "rec-flags"));
    li.appendChild(rec);
    return li;
  }

  function updateRankRow(li, item) {
    var row = item.row;
    var p = item.usePlace;
    li.classList.toggle("top1", p === 1);
    li.classList.toggle("top2", p === 2);
    li.classList.toggle("top3", p === 3);

    var pi = placeInfo(p);
    var pl = $(".place", li);
    pl.className = "place " + pi.cls;
    pl.textContent = pi.text;
    pl.setAttribute("aria-label", pi.label);

    $(".who-name", li).textContent = row.name;
    $(".club", li).textContent = row.clubShort;
    $(".hl", li).textContent = row.heat + "조 " + row.lane + "레인";

    var slot = $(".delta-slot", li);
    slot.textContent = "";
    var d = deltas[row.key];
    if (d && d.until > Date.now()) {
      var chip = el("span", "delta " + (d.dir > 0 ? "up" : "down"));
      chip.textContent = (d.dir > 0 ? "▲" : "▼") + d.n;
      chip.setAttribute("aria-label", d.dir > 0 ? d.n + "계단 상승" : d.n + "계단 하락");
      slot.appendChild(chip);
    }

    var tp = timeParts(row);
    var t = $(".time", li);
    t.className = "time " + tp.cls;
    $(".t-main", t).textContent = tp.main;
    $(".t-dot", t).textContent = tp.dot;
    $(".t-frac", t).textContent = tp.frac;

    var flags = $(".rec-flags", li);
    flags.textContent = "";
    if (row.provisional) flags.appendChild(el("span", "prov", "잠정"));

    li.setAttribute(
      "aria-label",
      pi.label +
        " " +
        row.name +
        " " +
        row.clubShort +
        ", " +
        (row.dnx || row.timeText || "기록 없음") +
        (row.provisional ? " 잠정" : "")
    );
  }

  /* ── 왼쪽(진행 중인 조) 패널 ── */

  function currentHeat() {
    if (!view || !view.heats.length) return null;
    var want = st.heat != null ? st.heat : view.liveHeat;
    var found = null;
    view.heats.forEach(function (h) {
      if (h.heat === want) found = h;
    });
    return found || view.heats[0];
  }

  /** 진출자가 아직 안 정해진 최강전에서 쓰는 안내. 이름을 하나도 흘리지 않는다. */
  function lineupNote() {
    var names = (view.lineupWaitingOn || [])
      .map(function (e) {
        return e.no + "번";
      })
      .join(" · ");
    return emptyNote(
      "진출자가 아직 정해지지 않았습니다",
      names
        ? names + " 경기가 끝나면 진출 선수가 표시됩니다."
        : "앞 경기가 끝나면 진출 선수가 표시됩니다."
    );
  }

  /** 레인 목록 자리에 안내문을 대신 세운다 (<ol> 안에 <div> 를 넣지 않기 위해). */
  function setLanesNote(node) {
    var list = $("#lanes");
    var pb = list.parentNode;
    var old = pb.querySelector(".empty-note");
    if (old) old.remove();
    list.hidden = !!node;
    if (node) pb.appendChild(node);
  }

  function renderLanes() {
    var body = $("#lanes");
    var head = $("#lanes-title");
    var sub = $("#lanes-sub");
    var order = $("#lanes-order");

    if (view.lineupPending) {
      body.textContent = "";
      body.dataset.count = "0";
      setLanesNote(lineupNote());
      head.textContent = "진출자 대기";
      sub.textContent = "";
      order.textContent = "";
      $("#lanes-badges").textContent = "";
      return;
    }

    var h = currentHeat();
    if (!h) {
      body.textContent = "";
      body.dataset.count = "0";
      setLanesNote(emptyNote("진행 중인 조 없음", "이 종목은 아직 조가 정해지지 않았습니다."));
      head.textContent = "진행 중인 조 없음";
      sub.textContent = "";
      order.textContent = "";
      $("#lanes-badges").textContent = "";
      return;
    }
    setLanesNote(null);

    head.textContent = h.heat + "조";
    sub.textContent =
      "전체 " + view.heats.length + "개 조 · " + h.done + "/" + h.total + " 기록";
    order.textContent = st.order === "lane" ? "레인 순" : "조 순위 순";

    var badges = $("#lanes-badges");
    badges.textContent = "";
    badges.appendChild(
      el(
        "span",
        "badge " + (h.status === "완료" ? "b-done" : h.status === "진행" ? "b-live" : "b-heat"),
        h.status === "진행" ? "계측 중" : h.status
      )
    );
    if (h.confirmed) badges.appendChild(el("span", "badge b-done", "심판 확정"));
    else if (h.done > 0) badges.appendChild(el("span", "prov", "잠정 기록"));

    var state = $("#race-state");
    var stateTitle = $("#race-state-title");
    var stateCopy = $("#race-state-copy");
    var stateCount = $("#race-state-count");
    if (state && stateTitle && stateCopy && stateCount) {
      state.className = "race-state " + (h.confirmed ? "confirmed" : h.done > 0 ? "provisional" : "waiting");
      stateTitle.textContent = h.confirmed ? "공식 확정 기록" : h.done > 0 ? "잠정 기록" : "기록 대기";
      stateCopy.textContent = h.confirmed
        ? "심판이 확정한 조 결과입니다."
        : h.done > 0
          ? "심판 확정 전이며 기록과 순위가 바뀔 수 있습니다."
          : "출전 명단이 공개되었으며 기록 입력 전입니다.";
      stateCount.textContent = h.done + " / " + h.total;
    }

    var rows = st.order === "lane" ? h.lanes : h.ranking;

    // 글자 배율의 기준은 **지금 조가 아니라 이 종목에서 가장 큰 조**다.
    // 조마다 기준을 잡으면 자동 순환으로 조가 넘어갈 때 글자 크기가 출렁인다.
    // 실제 페어링에 [3,2,2] · [3,1] 처럼 인원이 섞인 종목이 6개 있어서 반드시 생긴다.
    // 종목 단위로 고정하면 배율은 종목이 바뀔 때만 변하고, 그때는 어차피 머리글이 통째로 바뀐다.
    var maxLanes = 0;
    view.heats.forEach(function (hh) {
      if (hh.lanes.length > maxLanes) maxLanes = hh.lanes.length;
    });
    body.dataset.count = String(maxLanes || rows.length);
    var before = captureRects(body);
    patchList(
      body,
      rows.map(function (r) {
        return Object.assign({}, r, { key: r.key });
      }),
      makeLane,
      updateLane
    );
    playFlip(body, before);

    // 이번 갱신에서 값이 바뀐 행에 효과를 준다
    Array.prototype.slice.call(body.children).forEach(function (n) {
      var fx = pendingFx[n.dataset.key];
      if (fx) markChanged(n, fx);
    });
    if (confirmFx[view.event.id + ":" + h.heat] && !isReduced()) {
      var panel = $("#panel-lanes");
      panel.classList.remove("confirm-flash");
      void panel.offsetWidth;
      panel.classList.add("confirm-flash");
    }
  }

  /* 통째로 다시 그리는 목록은 내용이 실제로 바뀌었을 때만 갈아 끼운다.
     시연 모드에서는 1초에 한 번씩 갱신이 오는데, 매번 DOM 을 새로 만들면
     읽고 있는 사람 눈앞에서 목록이 깜빡인다. */
  var memo = {};
  function changed(name, sig) {
    if (memo[name] === sig) return false;
    memo[name] = sig;
    return true;
  }

  /* ── 조 순위 패널 (폰 전용 탭) ── */

  function renderHeatRanks() {
    if (view.lineupPending) {
      if (!changed("heatranks", "pending:" + view.event.id)) return;
      var w = $("#heatranks");
      w.textContent = "";
      w.appendChild(lineupNote());
      return;
    }
    var sig =
      view.event.id +
      "|" +
      view.heats
        .map(function (h) {
          return (
            h.heat +
            ":" +
            (h.confirmed ? "C" : "P") +
            ":" +
            h.ranking
              .map(function (r) {
                return r.key + "=" + r.place + "/" + r.timeText + "/" + r.status;
              })
              .join(",")
          );
        })
        .join(";");
    if (!changed("heatranks", sig)) return;

    var wrap = $("#heatranks");
    wrap.textContent = "";
    if (!view.heats.length) {
      wrap.appendChild(emptyNote("조 편성이 없습니다", "이 종목은 아직 조가 정해지지 않았습니다."));
      return;
    }
    view.heats.forEach(function (h) {
      var hd = el("div", "panel-hd");
      var t = el("div", "panel-t");
      t.appendChild(el("span", null, h.heat + "조"));
      t.appendChild(el("span", "kicker", h.done + "/" + h.total));
      hd.appendChild(t);
      if (h.confirmed) hd.appendChild(el("span", "badge b-done", "확정"));
      else if (h.done > 0) hd.appendChild(el("span", "prov", "잠정"));
      wrap.appendChild(hd);

      var ol = el("ol", "rank");
      h.ranking.forEach(function (r) {
        var li = makeRankRow();
        li.dataset.key = r.key;
        updateRankRow(li, { row: r, usePlace: r.place });
        ol.appendChild(li);
      });
      wrap.appendChild(ol);
    });
  }

  /* ── 종목 전체 순위 패널 ── */

  function renderOverall() {
    var body = $("#overall");

    if (view.lineupPending) {
      body.textContent = "";
      $("#overall-sub").textContent = "";
      body.appendChild(lineupNote());
      return;
    }

    var rows = view.finishers.concat(view.dnxRows);
    $("#overall-sub").textContent = view.pendingCount
      ? view.pendingCount + "명 기록 대기"
      : rows.length + "명 완료";

    if (!rows.length) {
      body.textContent = "";
      body.appendChild(
        emptyNote("아직 기록이 없습니다", "첫 조가 들어오면 여기에 종목 전체 순위가 쌓입니다.")
      );
      return;
    }
    if (!body.firstElementChild || body.firstElementChild.tagName !== "OL") {
      body.textContent = "";
      body.appendChild(el("ol", "rank"));
    }
    var ol = body.firstElementChild;
    var before = captureRects(ol);
    patchList(
      ol,
      rows.map(function (r) {
        return { key: r.key, row: r, usePlace: r.overallPlace };
      }),
      makeRankRow,
      updateRankRow
    );
    playFlip(ol, before);
    if (!isReduced() && before.size) {
      Array.prototype.slice.call(ol.children).forEach(function (n) {
        if (n.dataset.fresh) n.classList.add("enter");
      });
    }
  }

  /* ── 다음 경기 패널 ── */

  function renderUpNext() {
    var body = $("#upnext");
    var list = source.upNext(st.mode === "stage" ? 4 : 6);
    var sig = list
      .map(function (e) {
        return e.id + ":" + e.progress.status + ":" + e.progress.done;
      })
      .join("|");
    if (!changed("upnext", sig)) return;

    body.textContent = "";
    if (!list.length) {
      body.appendChild(emptyNote("남은 경기가 없습니다", "오늘 일정이 모두 끝났습니다."));
      return;
    }
    var ol = el("ol", "upnext");
    list.forEach(function (ev) {
      var li = el("li", "up-row");
      li.appendChild(el("span", "up-no", ev.no));
      var mid = el("div");
      mid.appendChild(el("div", "up-name", ev.name));
      mid.appendChild(
        el(
          "div",
          "up-sub",
          ev.dist + " · " + ev.kind + " · " + (ev.heatCount ? ev.heatCount + "개 조" : "편성 대기")
        )
      );
      li.appendChild(mid);
      var dot = el("span", "pdot" + (ev.progress.status === "완료" ? " done" : ev.progress.status === "진행" ? " run" : ""));
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", ev.progress.status);
      li.appendChild(dot);
      ol.appendChild(li);
    });
    body.appendChild(ol);
  }

  function emptyNote(title, body) {
    var d = el("div", "empty-note");
    d.appendChild(el("strong", null, title));
    d.appendChild(document.createTextNode(body));
    return d;
  }

  /* ── 종목 선택 시트 ── */

  function renderSheet() {
    var body = $("#sheet-body");
    body.textContent = "";
    var cur = source.viewEventId();
    source.events().forEach(function (ev) {
      var b = el("button", "ev-item");
      b.type = "button";
      b.setAttribute("aria-current", ev.id === cur ? "true" : "false");
      b.appendChild(el("span", "up-no", ev.no));
      var mid = el("div");
      mid.appendChild(el("div", "up-name", ev.name));
      mid.appendChild(
        el(
          "div",
          "up-sub",
          ev.dist +
            " · " +
            ev.kind +
            " · " +
            ev.progress.status +
            " " +
            ev.progress.done +
            "/" +
            ev.progress.total
        )
      );
      b.appendChild(mid);
      var dot = el(
        "span",
        "pdot" + (ev.progress.status === "완료" ? " done" : ev.progress.status === "진행" ? " run" : "")
      );
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", ev.progress.status);
      b.appendChild(dot);
      b.addEventListener("click", function () {
        source.setViewEventId(ev.id === source.currentEventId() ? null : ev.id);
        st.heat = null;
        closeSheet();
        syncUrl();
      });
      body.appendChild(b);
    });
  }

  function openSheet() {
    st.sheetOpen = true;
    renderSheet();
    var sheet = $("#sheet");
    sheet.hidden = false;
    $("#sheet-close").focus();
    document.addEventListener("keydown", sheetKeys);
  }

  function closeSheet() {
    st.sheetOpen = false;
    $("#sheet").hidden = true;
    document.removeEventListener("keydown", sheetKeys);
    var btn = $("#pick-event");
    if (btn) btn.focus();
  }

  function sheetKeys(e) {
    if (e.key === "Escape") closeSheet();
  }

  /* ──────────────────────────────────────────── 전체 다시 그리기 */

  function render() {
    view = source.eventView(source.viewEventId());
    if (!view) return;

    renderHeader();
    renderEventBar();
    renderLanes();
    renderOverall();
    renderUpNext();
    if (st.mode === "phone") renderHeatRanks();
    applyMode();

    document.title =
      view.event.no + " " + view.event.shortName + " · " + source.meta().title;

    pendingFx = {};
    confirmFx = {};
  }

  /* ─────────────────────────────────────────── 모드 / 탭 전환 */

  /* [탭 이름, 패널 선택자, 대형 화면에서 쓸 제목 id] */
  var PANELS = [
    ["lanes", "#panel-lanes", "lanes-title"],
    ["heatranks", "#panel-heatranks", null],
    ["overall", "#panel-overall", "overall-title"],
    ["next", "#panel-next", "next-title"],
  ];

  function applyMode() {
    document.documentElement.dataset.mode = st.mode;
    var phone = st.mode === "phone";
    $("#tabs").hidden = !phone;
    $("#stage-controls").hidden = phone;

    if (phone) {
      // 폰에서는 탭 하나가 패널 하나. 탭 의미론은 이때만 붙인다.
      PANELS.forEach(function (p) {
        var node = $(p[1]);
        node.hidden = st.tab !== p[0];
        node.setAttribute("role", "tabpanel");
        node.setAttribute("aria-labelledby", "tab-" + p[0]);
        node.tabIndex = 0;
      });
      Array.prototype.slice.call(document.querySelectorAll(".tab")).forEach(function (t) {
        var on = t.dataset.tab === st.tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
      });
    } else {
      // 대형 화면에서는 탭이 없으므로 탭 의미론을 걷어낸다.
      PANELS.forEach(function (p) {
        var node = $(p[1]);
        node.hidden = p[0] === "heatranks";
        node.removeAttribute("role");
        node.removeAttribute("tabindex");
        if (p[2]) node.setAttribute("aria-labelledby", p[2]);
        else node.removeAttribute("aria-labelledby");
      });
    }
    $("#btn-cycle").setAttribute("aria-pressed", String(st.cycling));
    $("#btn-cycle-label").textContent = st.cycling ? "자동 순환 켜짐" : "자동 순환 꺼짐";
    $("#btn-announce").setAttribute("aria-pressed", String(st.announce));
    $("#btn-announce-label").textContent = st.announce ? "읽어주기 켜짐" : "읽어주기 꺼짐";
    $("#btn-mode-label").textContent = phone ? "대형 화면으로" : "관중 폰으로";
    document.documentElement.dataset.display = st.focusLayout && !phone ? "focus" : "full";
    $("#btn-layout").setAttribute("aria-pressed", String(st.focusLayout && !phone));
    $("#btn-layout").textContent = st.focusLayout && !phone ? "전체 정보" : "간결하게";
  }

  /* 주소에 현재 화면을 남긴다. 관중이 "3학년 400m 순위" 링크를 그대로 공유할 수 있고,
     대회장 전광판 PC 는 원하는 화면을 북마크해 두었다가 그대로 띄울 수 있다. */
  function syncUrl() {
    var u = new URL(location.href);
    u.searchParams.set("mode", st.mode);
    if (st.focusLayout) u.searchParams.set("display", "focus");
    else u.searchParams.delete("display");
    if (st.mode === "phone") u.searchParams.set("tab", st.tab);
    else u.searchParams.delete("tab");
    if (source.isFollowingLive()) u.searchParams.delete("event");
    else u.searchParams.set("event", String(source.viewEventId()));
    history.replaceState(null, "", u);
  }

  function setMode(next) {
    st.mode = next;
    syncUrl();
    render();
  }

  /* ──────────────────────────────────── 자동 순환 (대형 화면) */

  /* 자동으로 돌아가는 내용에는 반드시 멈춤 수단이 있어야 한다
   * (ui-ux-pro-max --domain ux "Auto-Rotating Content Controls").
   * 일시정지·이전·다음 버튼, 마우스 오버·포커스 시 정지, Space 키를 모두 둔다.
   *
   * 다만 그 지침의 "reduced-motion 이면 자동 회전을 멈춰라" 부분은
   * **대형 화면 모드에서 의도적으로 따르지 않는다.**
   * 그 지침은 사람이 앉아서 읽는 웹페이지를 전제한다 — 자동으로 움직이면 읽기를 방해한다.
   * 전광판은 아무도 조작하지 않는 무인 표출 장치라, 1조에 멈춰 서 있으면
   * 배려가 아니라 고장이다. 순환은 장식이 아니라 콘텐츠 전달 수단이다.
   * 대신 reduced-motion 이면 **이동 애니메이션 없이 즉시 전환**한다.
   * 손에 들고 보는 관중 폰(phone)에는 애초에 자동 순환이 없다. */

  function cycleSteps() {
    if (!view || !view.heats.length) return [];
    var out = [];
    view.heats.forEach(function (h) {
      out.push({ heat: h.heat, order: "lane" });
      if (h.done > 0) out.push({ heat: h.heat, order: "rank" });
    });
    return out;
  }

  function advanceCycle(dir) {
    var steps = cycleSteps();
    if (!steps.length) return;
    var cur = 0;
    steps.forEach(function (s, i) {
      if (s.heat === (st.heat != null ? st.heat : view.liveHeat) && s.order === st.order) cur = i;
    });
    var next = (cur + (dir || 1) + steps.length) % steps.length;
    st.heat = steps[next].heat;
    st.order = steps[next].order;
    renderLanes();
  }

  function restartCycle() {
    if (cycleTimer) clearInterval(cycleTimer);
    cycleTimer = null;
    if (!st.cycling || st.mode !== "stage") return;
    cycleTimer = setInterval(function () {
      advanceCycle(1);
    }, CYCLE_MS);
  }

  /* ──────────────────────────────────────────── 변경 수신 */

  function onChange(payload) {
    var evId = source.viewEventId();

    // 1) 이 화면이 보고 있는 종목의 변경만 효과 대상으로 삼는다
    var relevant = payload.changes.filter(function (c) {
      return c.eventId === evId;
    });
    relevant.forEach(function (c) {
      var key = c.eventId + "/" + c.heat + "/" + c.athleteId;
      var type = c.from ? "fix" : "new";
      // 같은 행에 time/status 가 함께 오면 time 쪽 표현을 우선한다
      if (!pendingFx[key] || c.field === "time") {
        pendingFx[key] = { type: type, from: c.from, to: c.to, field: c.field };
      }
    });
    payload.confirmations.forEach(function (c) {
      confirmFx[c.eventId + ":" + c.heat] = true;
    });

    // 2) 새 기록이 들어온 조로 화면을 되돌린다 — 순환보다 실제 상황이 우선
    if (relevant.length && st.mode === "stage") {
      var h = relevant[relevant.length - 1].heat;
      if (h != null && h !== st.heat) {
        st.heat = h;
        st.order = "lane";
        restartCycle();
      }
    }

    // 3) 순위 변동 계산 (그리기 전의 순위를 기억해 뒀다가 비교)
    var beforePlaces = prevPlaces;
    render();
    var nowPlaces = {};
    view.finishers.forEach(function (r) {
      nowPlaces[r.key] = r.overallPlace;
      var was = beforePlaces[r.key];
      if (was && was !== r.overallPlace) {
        deltas[r.key] = {
          dir: was > r.overallPlace ? 1 : -1,
          n: Math.abs(was - r.overallPlace),
          until: Date.now() + DELTA_MS,
        };
      }
    });
    prevPlaces = nowPlaces;

    // 4) 알림 문장 만들기 — 셀 단위가 아니라 상황 단위로
    if (payload.currentEventChanged && source.isFollowingLive()) {
      announce("다음 경기 " + view.event.no + "번 " + view.event.name + " 시작.");
    }
    var last = relevant[relevant.length - 1];
    if (last && last.field === "time" && last.to) {
      var row = null;
      view.overall.forEach(function (r) {
        if (r.athleteId === last.athleteId && r.heat === last.heat) row = r;
      });
      if (row) {
        announce(
          row.heat +
            "조 " +
            row.lane +
            "레인 " +
            row.name +
            " " +
            row.timeText +
            (row.provisional ? " 잠정 기록" : " 기록") +
            (typeof row.place === "number" ? ", 조 " + row.place + "위" : "") +
            (typeof row.overallPlace === "number" ? ", 종목 " + row.overallPlace + "위" : "") +
            "."
        );
      }
    } else if (last && last.field === "status" && last.to) {
      announce(last.heat + "조 " + last.athleteId + "번 선수 " + last.to + " 처리.");
    }
    payload.confirmations.forEach(function (c) {
      if (c.eventId === evId) announce(c.heat + "조 기록이 확정되었습니다.");
    });
  }

  /* ──────────────────────────────────────────────── 시계 */

  function tickClock() {
    var d = new Date();
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var ss = String(d.getSeconds()).padStart(2, "0");
    $("#clock").textContent = hh + ":" + mm + ":" + ss;
  }

  /* ───────────────────────────────────────────────── 시작 */

  function bind() {
    $("#btn-layout").addEventListener("click", function () {
      st.focusLayout = !(st.focusLayout && st.mode === "stage");
      setMode(st.focusLayout ? "stage" : st.mode);
      restartCycle();
    });
    $("#btn-mode").addEventListener("click", function () {
      setMode(st.mode === "stage" ? "phone" : "stage");
      restartCycle();
    });
    $("#btn-cycle").addEventListener("click", function () {
      st.cycling = !st.cycling;
      applyMode();
      restartCycle();
    });
    $("#btn-announce").addEventListener("click", function () {
      st.announce = !st.announce;
      applyMode();
    });
    $("#btn-prev").addEventListener("click", function () {
      advanceCycle(-1);
      restartCycle();
    });
    $("#btn-next").addEventListener("click", function () {
      advanceCycle(1);
      restartCycle();
    });
    $("#pick-event").addEventListener("click", openSheet);
    $("#sheet-close").addEventListener("click", closeSheet);
    $("#back-live").addEventListener("click", function () {
      source.setViewEventId(null);
      st.heat = null;
    });

    // 탭: 클릭 + 좌우 화살표로 이동 (tablist 표준 동작)
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () {
        st.tab = t.dataset.tab;
        applyMode();
        syncUrl();
      });
      t.addEventListener("keydown", function (e) {
        var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        var n = tabs[(i + d + tabs.length) % tabs.length];
        st.tab = n.dataset.tab;
        applyMode();
        n.focus();
      });
    });

    // 마우스가 올라가 있거나 포커스가 안에 있으면 순환을 멈춘다
    var mainEl = $(".main");
    ["mouseenter", "focusin"].forEach(function (e) {
      mainEl.addEventListener(e, function () {
        if (cycleTimer) {
          clearInterval(cycleTimer);
          cycleTimer = null;
        }
      });
    });
    ["mouseleave", "focusout"].forEach(function (e) {
      mainEl.addEventListener(e, function () {
        restartCycle();
      });
    });

    document.addEventListener("keydown", function (e) {
      if (st.sheetOpen) return;
      if (e.target && /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.key === " ")
        return;
      if (e.key === " ") {
        e.preventDefault();
        st.cycling = !st.cycling;
        applyMode();
        restartCycle();
      } else if (e.key === "ArrowRight" && st.mode === "stage") {
        advanceCycle(1);
        restartCycle();
      } else if (e.key === "ArrowLeft" && st.mode === "stage") {
        advanceCycle(-1);
        restartCycle();
      } else if (e.key === "f" || e.key === "F") {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(function () {});
      }
    });

    // 움직임 설정이 바뀌어도 순환은 끄지 않는다. 이동 애니메이션만 알아서 빠진다.
    reduced.addEventListener("change", function () {
      applyMode();
      restartCycle();
    });
  }

  function boot() {
    if (!window.MEET_DATA) {
      document.body.innerHTML =
        '<p style="padding:24px;color:#fca5a5">data.js 를 불러오지 못했습니다.</p>';
      return;
    }

    var wantMode = qs.get("mode");
    if (wantMode !== "stage" && wantMode !== "phone") {
      wantMode = window.matchMedia("(min-width: 900px) and (min-height: 520px)").matches
        ? "stage"
        : "phone";
    }
    st.mode = wantMode;
    if (st.focusLayout && !qs.has("mode")) st.mode = "stage";
    // 무인 표출 장치라 순환은 항상 켜진 채로 시작한다 (phone 모드에는 순환 자체가 없다).
    // reduced-motion 이면 이동 애니메이션 없이 즉시 전환된다.
    st.cycling = true;
    st.announce = true;

    // 관중 전용: 대형 화면은 기본으로 하단 조작 버튼을 감춘다(무인 전광판).
    // 운영자가 화면을 만지면(포인터·터치·키) 3.5초간 나타난다. ?controls=1 이면 항상 보인다.
    if (st.mode === "stage" && qs.get("controls") !== "1") {
      document.body.classList.add("audience");
      var revealT;
      var revealCtrls = function () {
        document.body.classList.add("reveal-ctrls");
        clearTimeout(revealT);
        revealT = setTimeout(function () {
          document.body.classList.remove("reveal-ctrls");
        }, 3500);
      };
      ["pointermove", "pointerdown", "touchstart", "keydown"].forEach(function (ev) {
        window.addEventListener(ev, revealCtrls, { passive: true });
      });
    }

    var wantTab = qs.get("tab");
    if (["lanes", "heatranks", "overall", "next"].indexOf(wantTab) >= 0) st.tab = wantTab;

    // 시연(가짜) 데이터 제거. 서버 설정이 있으면 관중용 실시간 서버를,
    // 없으면 같은 기기의 심판 기록을 읽는다.
    var mode = "auto";

    source = window.ScoreboardSource.open({ data: window.MEET_DATA, mode: mode });

    var wantEvent = Number(qs.get("event"));
    if (wantEvent && source.calc.evById[wantEvent]) source.setViewEventId(wantEvent);

    // 특정 조에 고정. 자동 순환은 여전히 돌지만 시작 지점이 정해진다.
    var wantHeat = Number(qs.get("heat"));
    if (wantHeat > 0) st.heat = wantHeat;

    source.subscribe(onChange);

    bind();
    render();
    // 첫 그림의 순위를 기준선으로 잡는다
    view.finishers.forEach(function (r) {
      prevPlaces[r.key] = r.overallPlace;
    });

    source.start();
    restartCycle();
    tickClock();
    setInterval(tickClock, 1000);
    // 순위 변동 화살표가 시간이 지나면 사라지도록
    setInterval(function () {
      var dirty = false;
      Object.keys(deltas).forEach(function (k) {
        if (deltas[k].until <= Date.now()) {
          delete deltas[k];
          dirty = true;
        }
      });
      if (dirty) render();
    }, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
