/* 2026 Chungnam Inline Meet App */
(function () {
  const DATA = window.MEET_DATA;
  const STORE_KEY = "chungnam_inline_2026_v1";
  const PHOTO_KEY = "chungnam_inline_2026_photos";
  const PIN_KEY = "chungnam_inline_2026_auth";
  const ROOM_KEY = "chungnam_inline_2026_room";
  const ROLE_KEY = "chungnam_inline_2026_role";
  const PEER_PREFIX = "chungnam2026-";
  const PIN_STORE = "chungnam_inline_2026_pin";
  const BC_ID = "bc-" + Math.random().toString(16).slice(2);
  let roomId = (new URLSearchParams(location.search).get("room") || localStorage.getItem(ROOM_KEY) || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  let syncRole = new URLSearchParams(location.search).get("role") || localStorage.getItem(ROLE_KEY) || "";
  let hostPeer = null;
  let guestPeer = null;
  let hostConns = [];
  let guestConn = null;
  let applyingRemote = false;
  let batching = false;
  let sharePhotos = true;
  let knownRemotePhotos = {};
  let syncMeta = { status: "off", peers: 0, last: "", error: "" };
  const MEET_ID = (window.CHUNGNAM_LIVE_CONFIG && window.CHUNGNAM_LIVE_CONFIG.meetId) || "chungnam-inline-2026";
  let bridge = null;         // ChungnamSyncBridge. 서버 설정이 없으면 끝까지 null 이다.
  let pendingRender = false; // 입력 중이라 미뤄 둔 원격 반영이 있는지

  function getJudgePin() {
    return localStorage.getItem(PIN_STORE) || DATA.meta.judgePin || "2026";
  }

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const state = loadState();
  const photos = loadPhotos();
  let selectedHeat = 1;
  const requestedView = new URLSearchParams(location.search).get("view");
  const allowedViews = ["board", "pair", "rank", "champ", "medals", "athletes", "operators", "gallery", "sync", "judge"];
  let view = allowedViews.includes(requestedView) ? requestedView : "board";
  let selectedEvent = 1;
  let judgeAuthed = sessionStorage.getItem(PIN_KEY) === "1";

  function defaultState() {
    const results = {};
    DATA.events.forEach((ev) => {
      results[ev.id] = {};
      (ev.heats || []).forEach((heat, hi) => {
        (heat || []).forEach((aid, li) => {
          if (!aid) return;
          results[ev.id][keyOf(hi + 1, aid)] = {
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
      results,
      currentEvent: 1,
      qualifyCount: DATA.meta.qualifyCount || 6,
      fitnessHeats: {},
      updatedAt: null,
      rev: 0,
    };
  }

  function keyOf(heat, aid) {
    return heat + ":" + aid;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      const base = defaultState();
      return {
        ...base,
        ...s,
        results: { ...base.results, ...(s.results || {}) },
        fitnessHeats: s.fitnessHeats || {},
      };
    } catch (e) {
      return defaultState();
    }
  }

  function saveState() {
    if (batching) {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      return;
    }
    if (!applyingRemote) state.rev = (state.rev || 0) + 1;
    state.updatedAt = new Date().toISOString();
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    updateShareUI();
  }

  function shareUrl() {
    const base = location.origin + location.pathname;
    if (!roomId) return base;
    return base + "?room=" + encodeURIComponent(roomId) + (syncRole === "host" ? "&role=host" : "");
  }

  function livePayload() {
    const out = {
      meet: "chungnam-inline-2026",
      rev: state.rev || 0,
      state: {
        results: state.results,
        currentEvent: state.currentEvent,
        qualifyCount: state.qualifyCount,
        fitnessHeats: state.fitnessHeats,
        updatedAt: state.updatedAt,
        rev: state.rev || 0,
      },
    };
    if (sharePhotos) {
      const compact = {};
      Object.keys(photos).forEach((id) => {
        const url = photos[id];
        if (!url) return;
        if (knownRemotePhotos["p:" + id] === url.length) return;
        if (url.length < 180000) compact[id] = url;
      });
      out.photos = compact;
      out.photoKeys = Object.keys(photos);
    }
    return out;
  }

  // 서버에서 온 셀 하나짜리 변경. sync.js 가 device_id / version / 충돌을 이미 걸러 낸 뒤다.
  function applyPatch(p) {
    applyingRemote = true;
    try {
      // 착지 지점은 web/shared/legacy-bridge.js 의 applyPatchToState 한 곳에만 있다.
      // 심판 콘솔·전광판과 같은 계약을 쓰기 위해서다 (조 마감이 어긋난 적이 있다).
      window.ChungnamSyncBridge.applyPatchToState(state, p);
      if (p.scope === "meet" && p.field === "currentEvent") selectedEvent = state.currentEvent;
      state.updatedAt = p.at || new Date().toISOString();
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } finally {
      applyingRemote = false;
    }
    // 심판이 칸에 커서를 두고 있으면 다시 그리지 않는다. 타이핑 중 DOM 을 날리면 입력이 사라진다.
    const ae = document.activeElement;
    if (ae && ae.dataset && (ae.dataset.ed || ae.dataset.fit)) {
      pendingRender = true;
      return;
    }
    render();
  }

  function applyRemote(payload) {
    if (!payload || !payload.state) return;
    const incomingRev = payload.rev || payload.state.rev || 0;
    if (incomingRev && state.rev && incomingRev <= state.rev && syncRole === "host") return;
    applyingRemote = true;
    state.results = payload.state.results || state.results;
    state.currentEvent = payload.state.currentEvent || state.currentEvent;
    state.qualifyCount = payload.state.qualifyCount || state.qualifyCount;
    state.fitnessHeats = payload.state.fitnessHeats || state.fitnessHeats;
    state.updatedAt = payload.state.updatedAt || state.updatedAt;
    state.rev = incomingRev || state.rev;
    if (payload.photos) Object.assign(photos, payload.photos);
    if (Array.isArray(payload.photoKeys)) {
      Object.keys(photos).forEach((id) => {
        if (payload.photoKeys.indexOf(id) < 0) delete photos[id];
      });
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    if (payload.photos || payload.photoKeys) savePhotos();
    applyingRemote = false;
    syncMeta.last = new Date().toLocaleTimeString("ko-KR");
    syncMeta.status = syncRole === "host" ? "host" : "live";
    render();
  }

  function peerName() {
    return PEER_PREFIX + roomId;
  }

  function makeRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function setRoom(code, role) {
    roomId = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    syncRole = role || syncRole;
    if (roomId) localStorage.setItem(ROOM_KEY, roomId);
    if (syncRole) localStorage.setItem(ROLE_KEY, syncRole);
    const url = new URL(location.href);
    if (roomId) url.searchParams.set("room", roomId);
    else url.searchParams.delete("room");
    if (syncRole === "host") url.searchParams.set("role", "host");
    else url.searchParams.delete("role");
    history.replaceState({}, "", url);
  }

  function broadcastLive() {
    const payload = livePayload();
    hostConns = hostConns.filter((c) => c && c.open);
    hostConns.forEach((c) => {
      try {
        c.send(payload);
      } catch (e) {}
    });
    syncMeta.peers = hostConns.length;
    if (syncRole === "host") syncMeta.status = hostPeer ? "host" : "wait";
    updateShareUI();
  }

  async function startHost() {
    if (bridge) return toast("서버 동기화를 쓰는 중입니다. 방 코드는 필요 없습니다");
    if (typeof Peer === "undefined") {
      toast("실시간 라이브러리를 불러오지 못했습니다. 인터넷을 확인하세요");
      return;
    }
    if (!judgeAuthed) {
      setView("judge");
      toast("심판실 입장 후 호스트를 시작하세요");
      return;
    }
    if (!roomId) setRoom(makeRoomCode(), "host");
    else setRoom(roomId, "host");
    syncMeta.status = "wait";
    syncMeta.error = "";
    try {
      if (hostPeer) {
        try {
          hostPeer.destroy();
        } catch (e) {}
      }
      hostPeer = new Peer(peerName(), { debug: 0 });
      hostPeer.on("open", () => {
        syncMeta.status = "host";
        toast("실시간 방 " + roomId + " 을 열었습니다");
        updateShareUI();
        render();
        copyShare();
      });
      hostPeer.on("connection", (conn) => {
        conn.on("open", () => {
          hostConns.push(conn);
          try {
            conn.send(livePayload());
          } catch (e) {}
          syncMeta.peers = hostConns.filter((c) => c.open).length;
          toast("관람 기기 연결 " + syncMeta.peers + "대");
          updateShareUI();
          render();
        });
        conn.on("data", (msg) => {
          if (msg && msg.type === "ping") {
            try {
              conn.send(livePayload());
            } catch (e) {}
          }
        });
        conn.on("close", () => {
          hostConns = hostConns.filter((c) => c !== conn && c.open);
          syncMeta.peers = hostConns.length;
          updateShareUI();
          render();
        });
      });
      hostPeer.on("error", (err) => {
        syncMeta.error = String(err && err.type ? err.type : err);
        if (err && err.type === "unavailable-id") {
          setRoom(makeRoomCode(), "host");
          startHost();
          return;
        }
        toast("호스트 연결 오류: " + syncMeta.error);
        updateShareUI();
      });
    } catch (e) {
      toast("호스트를 시작하지 못했습니다");
    }
    updateShareUI();
    render();
  }

  async function startGuest(code) {
    if (bridge) return toast("서버 동기화를 쓰는 중입니다. 방 코드는 필요 없습니다");
    if (typeof Peer === "undefined") {
      toast("실시간 라이브러리를 불러오지 못했습니다. 인터넷을 확인하세요");
      return;
    }
    setRoom(code || roomId, "guest");
    if (!roomId || roomId.length < 4) {
      toast("방 코드 6자리를 입력하세요");
      return;
    }
    syncMeta.status = "connecting";
    syncMeta.error = "";
    try {
      if (guestPeer) {
        try {
          guestPeer.destroy();
        } catch (e) {}
      }
      guestPeer = new Peer({ debug: 0 });
      guestPeer.on("open", () => {
        guestConn = guestPeer.connect(peerName(), { reliable: true });
        guestConn.on("open", () => {
          syncMeta.status = "live";
          try {
            guestConn.send({ type: "ping" });
          } catch (e) {}
          toast("방 " + roomId + " 에 연결했습니다");
          updateShareUI();
          render();
        });
        guestConn.on("data", (payload) => applyRemote(payload));
        guestConn.on("close", () => {
          syncMeta.status = "retry";
          updateShareUI();
          setTimeout(() => {
            if (syncRole === "guest") startGuest(roomId);
          }, 2000);
        });
      });
      guestPeer.on("error", (err) => {
        syncMeta.error = String(err && err.type ? err.type : err);
        syncMeta.status = "error";
        toast("연결 실패. 심판 호스트가 켜져 있는지 확인하세요");
        updateShareUI();
        render();
      });
    } catch (e) {
      toast("관람 연결을 시작하지 못했습니다");
    }
    updateShareUI();
    render();
  }

  function stopSync() {
    syncRole = "";
    localStorage.removeItem(ROLE_KEY);
    try {
      if (hostPeer) hostPeer.destroy();
    } catch (e) {}
    try {
      if (guestPeer) guestPeer.destroy();
    } catch (e) {}
    hostPeer = null;
    guestPeer = null;
    hostConns = [];
    guestConn = null;
    syncMeta = { status: "off", peers: 0, last: "", error: "" };
    updateShareUI();
    render();
  }

  async function startShare() {
    await startHost();
  }

  function fillDemo() {
    if (!judgeAuthed) return toast("심판실 입장 후 사용할 수 있습니다");
    if (!confirm("연습용 샘플 기록을 넣을까요? 이미 입력한 값은 덮어씁니다.")) return;
    batching = true;
    const demoChanges = [];
    DATA.events.forEach((ev) => {
      (effectiveHeats(ev) || []).forEach((heat, hi) => {
        (heat || []).forEach((aid, li) => {
          if (!aid) return;
          const base = ev.dist && ev.dist.indexOf("200") >= 0 ? 28 : ev.dist && ev.dist.indexOf("400") >= 0 ? 52 : ev.dist && ev.dist.indexOf("600") >= 0 ? 78 : 42;
          const t = (base + li * 0.73 + hi * 0.41 + (aid % 7) * 0.19).toFixed(2);
          writeResult(ev.id, hi + 1, aid, "time", t, demoChanges);
          writeResult(ev.id, hi + 1, aid, "status", "", demoChanges);
        });
      });
    });
    DATA.events.forEach((ev) => autoFillRanks(ev.id, demoChanges));
    batching = false;
    saveState();
    if (bridge) bridge.publishMany(demoChanges);
    toast("샘플 기록을 넣었습니다. 순위·메달·최강전을 확인하세요");
    render();
  }

  function downloadSnapshot() {
    const blob = new Blob(
      [
        "<!DOCTYPE html><html lang=ko><head><meta charset=UTF-8><title>기록 스냅샷</title></head><body>",
        "<p>이 파일은 저장 시점의 기록입니다. 기록 앱에서 다시 열려면 원래 폴더의 index.html 을 쓰세요.</p>",
        "<pre id=d></pre><script>",
        "var STATE=" + JSON.stringify({ results: state.results, currentEvent: state.currentEvent, qualifyCount: state.qualifyCount, fitnessHeats: state.fitnessHeats, updatedAt: state.updatedAt }) + ";",
        "document.getElementById('d').textContent=JSON.stringify(STATE,null,2);",
        "try{localStorage.setItem('chungnam_inline_2026_v1', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('chungnam_inline_2026_v1')||'{}'), STATE)));location.href='index.html';}catch(e){}",
        "</script></body></html>",
      ],
      { type: "text/html;charset=utf-8" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "경기기록_스냅샷.html";
    a.click();
    toast("저장한 파일을 기록 앱 폴더에 두고 열면 기록이 반영됩니다");
  }

  function copyShare() {
    const url = shareUrl();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => toast("링크를 복사했습니다")).catch(() => prompt("이 주소를 복사하세요", url));
    } else prompt("이 주소를 복사하세요", url);
  }

  function syncLabel() {
    if (syncMeta.status === "host") return "호스트 " + (roomId || "") + " · " + syncMeta.peers + "대";
    if (syncMeta.status === "live") return "관람 연결 " + (roomId || "");
    if (syncMeta.status === "connecting" || syncMeta.status === "wait") return "연결 중 " + (roomId || "");
    if (syncMeta.status === "retry") return "재연결 중";
    if (syncMeta.status === "error") return "연결 실패";
    return "동기화 꺼짐";
  }

  function updateShareUI() {
    const box = document.getElementById("share-box");
    if (!box) return;
    if (bridge) return bridge.renderStatusInto(box);
    box.innerHTML = `<button class="btn gold" id="start-share">실시간 공유</button>`;
    const s = document.getElementById("start-share");
    if (s) s.onclick = () => setView("sync");
  }

  function loadPhotos() {
    try {
      return JSON.parse(localStorage.getItem(PHOTO_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }
  function savePhotos() {
    localStorage.setItem(PHOTO_KEY, JSON.stringify(photos));
  }
  const athById = Object.fromEntries(DATA.athletes.map((a) => [a.id, a]));
  const evById = Object.fromEntries(DATA.events.map((e) => [e.id, e]));

  function clubShort(c) {
    return (c || "")
      .replace("인라인&스키클럽", "")
      .replace("롤러스포츠클럽", "롤러")
      .replace("체련인라인교실", "체련")
      .replace("소울", "소울")
      .trim();
  }

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

  function fmtTime(sec) {
    if (sec == null || !Number.isFinite(sec)) return "—";
    if (sec >= 60) {
      const m = Math.floor(sec / 60);
      const r = sec - m * 60;
      return m + ":" + r.toFixed(2).padStart(5, "0");
    }
    return sec.toFixed(2);
  }

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

  function effectiveHeats(ev) {
    if (ev.kind === "최강전") {
      const custom = state.fitnessHeats[ev.id];
      if (custom && custom.length) return custom;
      const auto = autoQualifiers(ev).slice(0, state.qualifyCount).map((x) => x.athleteId);
      return [auto];
    }
    return ev.heats && ev.heats.length ? ev.heats : [[]];
  }

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

  function cmpByTime(p, q) {
    if (p.t == null && q.t == null) return (p.athleteId || 0) - (q.athleteId || 0);
    if (p.t == null) return 1;
    if (q.t == null) return -1;
    if (p.t !== q.t) return p.t - q.t;
    return (p.athleteId || 0) - (q.athleteId || 0);
  }

  function cmpHeat(p, q) {
    if (p.manual && q.manual) return p.manual - q.manual;
    if (p.manual) return -1;
    if (q.manual) return 1;
    return cmpByTime(p, q);
  }

  function isFinished(x) {
    return (!x.st || x.st === "완주" || x.st === "OK") && (x.t != null || x.manual);
  }

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

  function heatPlaceOf(ev, aid) {
    const heats = rankedHeats(ev);
    for (const h of heats) {
      const hit = h.all.find((x) => x.athleteId === aid);
      if (hit) return hit;
    }
    return null;
  }

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

  function athleteResults(aid) {
    const out = [];
    DATA.events.forEach((ev) => {
      eventEntries(ev).forEach((row) => {
        if (row.athleteId === aid) {
          const rk = rankedEvent(ev);
          const found = rk.all.find((x) => x.athleteId === aid);
          out.push({
            ev,
            row,
            place: found ? found.heatPlace : "",
            overall: found ? found.overallPlace : "",
            t: found ? found.t : null,
          });
        }
      });
    });
    return out;
  }

  function avatarSvg(a) {
    const colors = ["#1ec8e6", "#5dffc2", "#f5c84c", "#7aa7ff", "#ff6b8a", "#c084fc"];
    const c = colors[(a.id || 0) % colors.length];
    const ini = (a.name || "?").slice(0, 1);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="#0b1c30"/>
      </linearGradient></defs>
      <rect width="80" height="80" fill="#0b1c30"/>
      <circle cx="40" cy="40" r="36" fill="url(#g)"/>
      <text x="40" y="48" text-anchor="middle" font-size="30" font-family="Pretendard, sans-serif" font-weight="800" fill="#041018">${ini}</text>
    </svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }

  function photoOf(a) {
    return photos[a.id] || avatarSvg(a);
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2200);
  }

  function setView(name, fromHistory = false) {
    if (!allowedViews.includes(name)) return;
    if (!fromHistory && name !== view) {
      const url = new URL(location.href);
      url.searchParams.set("view", name);
      history.pushState(null, "", url);
    }
    view = name;
    document.body.dataset.view = name;
    $$(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  window.addEventListener("popstate", () => {
    const name = new URLSearchParams(location.search).get("view");
    setView(allowedViews.includes(name) ? name : "board", true);
  });

  // 대회 시작 전에는 LIVE 대신 "예정"으로 표시한다.
  function meetStartMs() { const m = String((DATA.meta || {}).date || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3], 9, 0, 0).getTime() : NaN; }
  function meetStarted() { const s = meetStartMs(); return isFinite(s) ? Date.now() >= s : true; }
  function setHeaderMeta() {
    const meta = DATA.meta || {};
    const t = $("#meet-title"); if (t && meta.title) t.textContent = meta.title;
    const w = $("#meet-when");
    if (w) { const when = [meta.date, meta.start].filter(Boolean).join(" "); if (when) w.textContent = when; }
  }
  function headerClock() {
    const now = new Date();
    const t = now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const el = $("#clock");
    if (el) el.textContent = t;
    const opsClock = $("#ops-live-clock");
    if (opsClock) opsClock.textContent = t;
    const started = meetStarted();
    const label = $("#live-label");
    if (label) label.textContent = started ? "LIVE" : "예정";
    const pill = document.querySelector(".live-pill");
    if (pill) pill.classList.toggle("pre-meet", !started);
  }

  function render() {
    $("#updated").textContent = state.updatedAt
      ? "기록 갱신 " + new Date(state.updatedAt).toLocaleTimeString("ko-KR")
      : "기록 입력 전";
    const root = $("#view");
    if (view === "gallery" && root.querySelector(".event-gallery")) return;
    if (window.EventGallery) window.EventGallery.dispose();
    if (view === "board") root.innerHTML = viewBoard();
    if (view === "pair") root.innerHTML = viewPair();
    if (view === "rank") root.innerHTML = viewRank();
    if (view === "champ") root.innerHTML = viewChamp();
    if (view === "medals") root.innerHTML = viewMedals();
    if (view === "athletes") root.innerHTML = viewAthletes();
    if (view === "operators") root.innerHTML = viewOperators();
    if (view === "gallery") window.EventGallery.mount(root, String(DATA.meta.id || "chungnam-inline-2026"));
    if (view === "sync") root.innerHTML = viewSync();
    if (view === "judge") root.innerHTML = viewJudge();
    headerClock();
    bindView();
  }

  function statusBadge(st) {
    if (st === "완료") return '<span class="badge b-done">완료</span>';
    if (st === "진행") return '<span class="badge b-wait">진행중</span>';
    if (st === "최강전") return '<span class="badge b-champ">최강전</span>';
    return '<span class="badge b-heat">대기</span>';
  }

  function kindBadge(kind) {
    if (kind === "최강전") return '<span class="badge b-champ">최강전</span>';
    if (kind === "결승") return '<span class="badge b-final">결승</span>';
    return '<span class="badge b-heat">조별결승</span>';
  }

  function rankHtml(place) {
    if (place === 1) return '<span class="rank-pill r1">1</span>';
    if (place === 2) return '<span class="rank-pill r2">2</span>';
    if (place === 3) return '<span class="rank-pill r3">3</span>';
    if (typeof place === "number") return '<span class="rank-pill r0">' + place + "</span>";
    if (place) return '<span class="rank-pill r0">' + place + "</span>";
    return "";
  }

  function laneRow(row, ev) {
    const a = athById[row.athleteId];
    if (!a) return "";
    const rk = heatPlaceOf(ev, a.id);
    const place = rk ? rk.heatPlace : "";
    const time = row.time ? row.time : rk && rk.t != null ? fmtTime(rk.t) : "";
    return `<div class="lane" data-ath="${a.id}">
      <div class="lane-no">${row.lane || "-"}</div>
      <div class="bib">${String(a.id).padStart(2, "0")}</div>
      <div class="who">
        <img class="avatar" src="${photoOf(a)}" alt="${a.name}">
        <div>
          <strong>${a.name}</strong>
          <span>${clubShort(a.club)} · ${a.grade} ${a.gender}${a.note ? " · " + a.note : ""}</span>
        </div>
      </div>
      <div class="meta-right">
        <div class="time">${row.status && row.status !== "완주" ? row.status : time || "—"}</div>
        ${rankHtml(place)}
      </div>
    </div>`;
  }

  function medalStrip() {
    const { clubs, totals } = collectMedals();
    if (!clubs.length) return "";
    return `<div class="card" style="margin-top:14px">
      <div class="kicker">CLUB MEDALS</div>
      <h3 style="margin-top:6px">클럽 메달 <span class="muted" style="font-weight:600;font-size:13px">금 ${totals.gold} · 은 ${totals.silver} · 동 ${totals.bronze}</span></h3>
      <div class="medal-strip">
        ${clubs.map((c, i) => `<div class="medal-chip" data-go-medals="1">
          <b>${i + 1}. ${clubShort(c.club) || c.club}</b>
          <span class="medal gold">${c.gold}</span>
          <span class="medal silver">${c.silver}</span>
          <span class="medal bronze">${c.bronze}</span>
        </div>`).join("")}
      </div>
    </div>`;
  }

  const OPS_ICON_PATHS = {
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 20h8M12 17v3"/>',
    clipboard: '<rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 4h6v2H9z"/><path d="M9 10h6M9 14h6"/>',
    display: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
    wifi: '<path d="M2 8.5a16 16 0 0 1 20 0M5.5 12a11 11 0 0 1 13 0M9 15.5a6 6 0 0 1 6 0"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    trophy: '<path d="M8 4h8v4a4 4 0 0 1-8 0V4Z"/><path d="M5 5H3v2a3 3 0 0 0 3 3M19 5h2v2a3 3 0 0 1-3 3"/><path d="M12 12v4M9 20h6M9 20v-2a3 3 0 0 1 3-3 3 3 0 0 1 3 3v2"/>',
    medal: '<circle cx="12" cy="15" r="5"/><path d="M9 10 6 3M15 10l3-7M9 15l2 2 4-4"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M2 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/><circle cx="18" cy="9" r="2.5"/><path d="M16.5 14.2A4.8 4.8 0 0 1 22 19v1"/>',
    shield: '<path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3Z"/><path d="m9 12 2 2 4-4"/>',
    sync: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M21 3v5h-5M3 21v-5h5"/>',
    flag: '<path d="M5 3v18M5 4h13l-3 4 3 4H5"/>',
    play: '<path d="M8 4l12 8-12 8z"/>',
    pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    doc: '<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v3h3M9 12h6M9 16h6"/>',
    sliders: '<path d="M4 6h8M16 6h4M4 12h4M12 12h8M4 18h11M19 18h1"/><circle cx="14" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
    "chevron-left": '<path d="M15 6l-6 6 6 6"/>',
    "chevron-right": '<path d="M9 6l6 6-6 6"/>',
  };
  function opsIcon(name, cls) {
    return `<svg class="${cls || "ops-icon"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${OPS_ICON_PATHS[name] || ""}</svg>`;
  }

  function metaDateLong() {
    const m = /([0-9]+)\s*년\s*([0-9]+)\s*월\s*([0-9]+)\s*일\s*(\([^)]+\))/.exec(DATA.meta.date || "");
    if (!m) return DATA.meta.date || "";
    return `${m[1]}. ${m[2]}. ${m[3]}. ${m[4]}`;
  }

  const OPS_NAV_GRID = [
    { view: "board", icon: "chart", title: "운영 현황", desc: "대회 실시간 현황 확인" },
    { view: "pair", icon: "calendar", title: "경기 편성", desc: "경기 일정 및 조 편성" },
    { view: "rank", icon: "list", title: "기록·순위", desc: "기록 조회 및 순위 관리" },
    { view: "champ", icon: "trophy", title: "최강전", desc: "최강전 진출 현황" },
    { view: "medals", icon: "medal", title: "클럽 메달", desc: "클럽별 메달 집계" },
    { view: "athletes", icon: "users", title: "선수 명단", desc: "선수 정보 조회" },
    { view: "operators", icon: "shield", title: "심판 계정", desc: "심판 아이디 및 권한" },
    { view: "gallery", icon: "users", title: "대회 사진", desc: "단체·수상·경기 사진" },
    { view: "sync", icon: "sync", title: "실시간 동기화", desc: "모든 데이터 동기화" },
  ];

  function recentResults(n) {
    return DATA.events
      .slice()
      .sort((a, b) => b.id - a.id)
      .filter((e) => eventProgress(e).status === "완료")
      .slice(0, n)
      .map((e) => {
        const win = rankedEvent(e).finished[0];
        return {
          ev: e,
          winner: win && win.a ? win.a : null,
          winnerClub: win && win.a ? clubShort(win.a.club) : "",
          time: win ? win.time || (win.t != null ? fmtTime(win.t) : "—") : "—",
        };
      });
  }

  function viewBoard() {
    const cur = evById[state.currentEvent] || DATA.events[0];
    const nxt = DATA.events.find((e) => e.id > cur.id) || null;
    const doneN = DATA.events.filter((e) => eventProgress(e).status === "완료").length;
    const heats = effectiveHeats(cur);
    const prog = eventProgress(cur);
    const percent = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
    const recent = recentResults(5);
    return `
      <div class="ops-hero">
        <div class="ops-hero-copy">
          <h1>대회 운영</h1>
          <p>정확한 운영이<br>더 멋진 대회를 만듭니다.</p>
        </div>
        <div class="ops-hero-sign" aria-hidden="true">
          <span class="ops-hand">더 빠르게<br>더 높이<br>하나로!</span>
          <span class="ops-watermark">CHUNGNAM<br>INLINE<br>2026</span>
        </div>
      </div>

      <div class="ops-switch" role="tablist" aria-label="관리자 화면 전환">
        <button type="button" class="ops-switch-btn ops-go active" data-view="board">${opsIcon("monitor")}<span>운영 현황</span></button>
        <a class="ops-switch-btn ops-go" href="../judge/">${opsIcon("clipboard")}<span>심판 기록</span></a>
      </div>

      <div class="ops-status-row" aria-label="대회 운영 상태">
        <div class="ops-status-cell is-ok">${opsIcon("wifi")}<div><b>시스템 정상 연결</b><small>모든 시스템이 정상 작동 중입니다.</small></div></div>
        <div class="ops-status-cell ops-status-clock">${opsIcon("clock")}<div><b>${metaDateLong()}</b><strong id="ops-live-clock">--:--:--</strong></div></div>
        <div class=${"ops-status-cell " + (meetStarted() ? "is-live" : "is-pending")}><span class="ops-live-chip">${meetStarted() ? "LIVE" : "예정"}</span><div><b>${meetStarted() ? "대회 진행 중" : "대회 예정"}</b><small>${DATA.meta.place || ""} · No.${String(cur.id).padStart(2, "0")} ${cur.name}</small></div></div>
      </div>

      <div class="ops-current-card">
        <div class="ops-current-main">
          <span class="thm-badge is-current">현재 경기</span>
          <div class="ops-current-no"><span>제</span> <b>${cur.id}</b> <span>경기</span></div>
          <div class="ops-current-name"><strong>${cur.name}</strong><span>${cur.dist ? cur.dist + " · " : ""}${cur.kind}${cur.gender ? " (" + cur.gender + ")" : ""}</span></div>
          <div class="ops-progress"><div class="ops-progress-track"><div class="ops-progress-fill" style="width:${percent}%"></div></div><b>${percent}%</b></div>
          <div class="muted">${prog.done} / ${prog.total || 0} 명 완료</div>
        </div>
        <div class="ops-current-side">
          <div class="ops-next-block">
            <span class="kicker">다음 경기</span>
            ${nxt ? `<b>제 ${nxt.id} 경기</b><span>${nxt.name}</span>` : `<span>마지막 경기입니다</span>`}
          </div>
          <div class="ops-done-block">
            <span class="kicker">종료된 경기</span>
            <b>${opsIcon("flag")}${doneN} 경기</b>
          </div>
        </div>
      </div>

      <div class="ops-nav-grid">
        ${OPS_NAV_GRID.map(
          (item) => `<button type="button" class="ops-nav-card ops-go" data-view="${item.view}">
          <span class="ops-nav-icon">${opsIcon(item.icon)}</span>
          <span class="ops-nav-arrow">${opsIcon("arrow-right")}</span>
          <b>${item.title}</b>
          <span>${item.desc}</span>
        </button>`
        ).join("")}
      </div>


      <div class="card ops-results-card">
        <div class="ops-control-head">
          <h3>${opsIcon("doc")} 최근 경기 결과</h3>
          <button type="button" class="ops-link-btn ops-go" data-view="rank">전체보기 ${opsIcon("arrow-right")}</button>
        </div>
        <div class="table-scroll">
          <table class="table ops-results-table">
            <thead><tr><th>No.</th><th>시간</th><th>종목 / 부문</th><th>경기명</th><th>우승자</th><th>기록</th><th>상태</th></tr></thead>
            <tbody>
              ${
                recent.length
                  ? recent
                      .map(
                        (r) => `<tr data-goto-rank="${r.ev.id}">
                <td>${r.ev.id}</td>
                <td>${r.ev.day || ""}</td>
                <td>${r.ev.cat || r.ev.dist || ""}</td>
                <td>${r.ev.name}</td>
                <td>${r.winner ? `<b>${r.winner.name}</b> <span class="muted">(${r.winnerClub})</span>` : "—"}</td>
                <td>${r.time}</td>
                <td><span class="thm-badge is-confirmed">종료</span></td>
              </tr>`
                      )
                      .join("")
                  : `<tr><td colspan="7" class="empty">아직 종료된 경기가 없습니다.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="card ops-heat-card">
        <div class="kicker">LIVE HEAT</div>
        <h2>${cur.name} ${kindBadge(cur.kind)} ${statusBadge(prog.status)}</h2>
        ${heats
          .map(
            (heat, i) => `
          <div class="heat">
            <div class="heat-hd"><b>${heats.length > 1 ? i + 1 + "조" : "결승 조"}</b><span class="muted">${(heat || []).filter(Boolean).length}명 · 이 조에서 1·2·3등</span></div>
            ${(heat || [])
              .map((aid, li) => {
                if (!aid) return "";
                const row = (state.results[cur.id] || {})[keyOf(i + 1, aid)] || { athleteId: aid, lane: li + 1, time: "", status: "" };
                return laneRow({ ...row, lane: li + 1, athleteId: aid }, cur);
              })
              .join("")}
          </div>`
          )
          .join("")}
      </div>`;
  }

  function viewPair() {
    const ev = evById[selectedEvent];
    const list = DATA.events
      .map((e) => {
        const p = eventProgress(e);
        return `<div class="event-item ${e.id === selectedEvent ? "on" : ""}" data-sel="${e.id}">
          <div class="eno">${String(e.id).padStart(2, "0")}</div>
          <div style="flex:1;min-width:0">
            <b>${e.name}</b>
            <div class="muted" style="font-size:12px">${e.dist} · ${e.kind} · ${effectiveHeats(e).length}개조</div>
          </div>
          ${statusBadge(p.status)}
        </div>`;
      })
      .join("");
    const heats = effectiveHeats(ev);
    return `<div class="two">
      <div class="card scroll-list"><div class="kicker">경기 목록</div><h3>페어링</h3>${list}</div>
      <div>
        <div class="card">
          <div class="kicker">EVENT ${String(ev.id).padStart(2, "0")}</div>
          <h2>${ev.name} ${kindBadge(ev.kind)}</h2>
          <p class="muted">${ev.dist} · ${ev.gender} · ${ev.kind}${ev.qualifyFrom ? " · 예선 " + ev.qualifyFrom.join(",") + " 상위 진출" : ""}</p>
          ${heats
            .map(
              (heat, i) => `
            <div class="heat">
              <div class="heat-hd"><b>${i + 1}조</b><span class="muted">${(heat || []).filter(Boolean).length}명</span></div>
              ${(heat || [])
                .map((aid, li) => {
                  if (!aid) return `<div class="lane"><div class="lane-no">${li + 1}</div><div class="muted">미배정</div></div>`;
                  const row = (state.results[ev.id] || {})[keyOf(i + 1, aid)] || { athleteId: aid, lane: li + 1 };
                  return laneRow({ ...row, lane: li + 1, athleteId: aid }, ev);
                })
                .join("")}
            </div>`
            )
            .join("")}
        </div>
      </div>
    </div>`;
  }

  function resultRow(x, place) {
    if (!x.a) return "";
    return `<tr data-ath="${x.athleteId}">
        <td>${rankHtml(place)}</td>
        <td class="bib">${String(x.athleteId).padStart(2, "0")}</td>
        <td><div class="who"><img class="avatar" src="${photoOf(x.a)}" alt=""><div><strong>${x.a.name}</strong><span>${clubShort(x.a.club)} · ${x.a.grade}</span></div></div></td>
        <td>${x.heat}조</td>
        <td class="time">${x.status && x.status !== "완주" ? x.status : x.time || (x.t != null ? fmtTime(x.t) : "—")}</td>
      </tr>`;
  }

  function viewRank() {
    const ev = evById[selectedEvent];
    const pack = rankedEvent(ev);
    const list = DATA.events
      .map((e) => `<div class="event-item ${e.id === selectedEvent ? "on" : ""}" data-sel="${e.id}">
        <div class="eno">${String(e.id).padStart(2, "0")}</div>
        <div><b>${e.name}</b><div class="muted" style="font-size:12px">${e.kind} · ${effectiveHeats(e).length}개조</div></div>
      </div>`)
      .join("");
    const heatBlocks = pack.heats
      .map((h) => {
        const rows = h.finished.map((x) => resultRow(x, x.heatPlace)).join("");
        const extra = h.others.map((x) => resultRow(x, x.st)).join("");
        const first = h.finished[0];
        return `<div class="heat">
          <div class="heat-hd">
            <b>${h.heat}조 순위</b>
            <span class="muted">${first && first.a ? "1등 " + first.a.name : "기록 대기"} · ${h.all.length}명</span>
          </div>
          <table class="table rank-table">
            <colgroup><col class="col-place"><col class="col-bib"><col class="col-athlete"><col class="col-heat"><col class="col-time"></colgroup>
            <thead><tr><th>조순위</th><th>번호</th><th>선수</th><th>조</th><th>기록</th></tr></thead>
            <tbody>${rows || extra ? rows + extra : `<tr><td colspan="5" class="empty">이 조 기록이 아직 없습니다.</td></tr>`}</tbody>
          </table>
        </div>`;
      })
      .join("");
    const overallRows = pack.finished.map((x) => resultRow(x, x.overallPlace)).join("");
    const overallExtra = pack.others.map((x) => resultRow(x, x.st)).join("");
    const q = ev.qualifyTo ? evById[ev.qualifyTo] : null;
    const adv = q ? autoQualifiers(q).slice(0, state.qualifyCount) : [];
    return `<div class="two rank-layout">
      <div class="card scroll-list"><div class="kicker">학년·부별</div><h3>순위</h3>${list}</div>
      <div class="card rank-panel">
        <div class="kicker">HEAT RESULT</div>
        <h2>${ev.name}</h2>
        <p class="muted">조별결승이므로 <b style="color:var(--gold2)">각 조에서 1·2·3등</b>을 따로 매깁니다. 아래 전체 순위는 참고용 기록순입니다.</p>
        ${heatBlocks || `<div class="empty">편성된 조가 없습니다.</div>`}
        <div style="margin-top:18px">
          <div class="kicker">CATEGORY</div>
          <h3>학년·부별 전체 순위 (기록순)</h3>
          <table class="table rank-table">
            <colgroup><col class="col-place"><col class="col-bib"><col class="col-athlete"><col class="col-heat"><col class="col-time"></colgroup>
            <thead><tr><th>전체</th><th>번호</th><th>선수</th><th>조</th><th>기록</th></tr></thead>
            <tbody>${overallRows || overallExtra ? overallRows + overallExtra : `<tr><td colspan="5" class="empty">아직 기록이 없습니다.</td></tr>`}</tbody>
          </table>
        </div>
        ${
          q
            ? `<div style="margin-top:16px"><div class="kicker">최강전 진출 예상</div><h3>${q.name}</h3>
          <p class="muted">각 조 1등 → 각 조 2등 → 기록순으로 채웁니다.</p>
          ${
            adv.length
              ? adv
                  .map(
                    (x, i) => `<div class="q-card yes" data-ath="${x.athleteId}">
              ${rankHtml(i + 1)}
              <img class="avatar" src="${photoOf(x.a)}" alt="">
              <div style="flex:1"><b>${x.a.name}</b><div class="muted">No.${x.athleteId} · ${x.heat}조 ${x.fromPlace}등 · ${x.time || fmtTime(x.t)}</div></div>
              <span class="badge b-champ">진출</span>
            </div>`
                  )
                  .join("")
              : `<div class="empty">예선 기록이 들어오면 진출자가 표시됩니다.</div>`
          }</div>`
            : ""
        }
      </div>
    </div>`;
  }

  function viewChamp() {
    const champs = DATA.events.filter((e) => e.kind === "최강전");
    return `<div class="card" style="margin-bottom:14px">
      <div class="kicker">CHAMPIONSHIP</div>
      <h2>피트니스 최강전 진출 보드</h2>
      <p class="muted">각 조 1등을 먼저 넣고, 이어서 각 조 2등·3등 순으로 상위 ${state.qualifyCount}명을 배정합니다. 심판실에서 인원 수와 명단을 수정할 수 있습니다.</p>
      <div class="toolbar">
        <label class="muted">진출 인원
          <input id="qcount" type="number" min="1" max="12" value="${state.qualifyCount}" style="width:64px;margin-left:6px;padding:6px;border-radius:8px;border:1px solid var(--line);background:#071525;color:#fff">
        </label>
      </div>
    </div>
    <div class="grid cards-3">
      ${champs
        .map((ev) => {
          const pool = autoQualifiers(ev);
          const take = pool.slice(0, state.qualifyCount);
          const wait = pool.slice(state.qualifyCount);
          const prog = eventProgress(ev);
          const sources = (ev.qualifyFrom || []).map((id) => evById[id]?.name.replace("초등부 ", "")).join(" / ");
          return `<div class="card">
            <div class="kicker">No.${String(ev.id).padStart(2,"0")} ${statusBadge(prog.status)}</div>
            <h3>${ev.name.replace("피트니스 ","")}</h3>
            <p class="muted" style="font-size:12px">예선: ${sources || "-"}</p>
            ${
              take.length
                ? take
                    .map(
                      (x, i) => `<div class="q-card yes" data-ath="${x.athleteId}">
                  ${rankHtml(i + 1)}
                  <img class="avatar" src="${photoOf(x.a)}" alt="">
                  <div><b>${x.a.name}</b><div class="muted">No.${x.athleteId} · ${x.heat ? x.heat + "조 " + x.fromPlace + "등" : ""} · ${x.time || fmtTime(x.t)}</div></div>
                </div>`
                    )
                    .join("")
                : `<div class="empty">예선 기록 대기</div>`
            }
            ${
              wait.length
                ? `<div class="muted" style="margin:8px 0 4px">예비</div>` +
                  wait
                    .slice(0, 4)
                    .map(
                      (x) => `<div class="q-card no" data-ath="${x.athleteId}"><span class="muted">대기</span><b>${x.a.name}</b></div>`
                    )
                    .join("")
                : ""
            }
          </div>`;
        })
        .join("")}
    </div>`;
  }


  function medalKind(place) {
    if (place === 1) return "gold";
    if (place === 2) return "silver";
    if (place === 3) return "bronze";
    return null;
  }

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

  function viewMedals() {
    const { clubs, totals } = collectMedals();
    const top = clubs[0];
    return `
      <div class="grid cards-3">
        <div class="card"><div class="kicker">GOLD</div><div class="stat">${totals.gold}</div><div class="muted">각 조 1등</div></div>
        <div class="card"><div class="kicker">SILVER</div><div class="stat">${totals.silver}</div><div class="muted">각 조 2등</div></div>
        <div class="card"><div class="kicker">BRONZE</div><div class="stat">${totals.bronze}</div><div class="muted">각 조 3등</div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="kicker">CLUB STANDINGS</div>
        <h2>클럽별 메달</h2>
        <p class="muted">조별 1·2·3등만 집계합니다. 최강전 기록도 포함됩니다. 인원이 2명인 조는 금·은만 나갑니다.</p>
        ${!clubs.length ? `<div class="empty">기록이 입력되면 클럽 메달이 쌓입니다.</div>` : `
        <table class="table">
          <thead><tr><th>순위</th><th>클럽</th><th>금</th><th>은</th><th>동</th><th>합계</th></tr></thead>
          <tbody>
            ${clubs.map((c, i) => `
              <tr class="club-row" data-club="${encodeURIComponent(c.club)}">
                <td>${rankHtml(i + 1)}</td>
                <td><b>${c.club}</b>${top && top.club === c.club ? ' <span class="badge b-champ">1위</span>' : ""}</td>
                <td><span class="medal gold">${c.gold}</span></td>
                <td><span class="medal silver">${c.silver}</span></td>
                <td><span class="medal bronze">${c.bronze}</span></td>
                <td><b>${c.total}</b></td>
              </tr>
              <tr class="club-detail" id="club-${i}">
                <td colspan="6">
                  ${c.items.map((it) => `
                    <div class="q-card yes" data-ath="${it.athleteId}">
                      <span class="medal ${it.kind}">${it.place}</span>
                      <div style="flex:1"><b>${it.name}</b>
                        <div class="muted">No.${it.athleteId} · ${it.evName} · ${it.heat}조${it.champ ? " · 최강전" : ""} · ${it.time || ""}</div>
                      </div>
                    </div>`).join("")}
                </td>
              </tr>`).join("")}
          </tbody>
        </table>`}
      </div>`;
  }

  function viewAthletes() {
    return `<div class="card">
      <div class="kicker">ATHLETES</div>
      <h2>선수 명단</h2>
      <input class="search" id="ath-q" placeholder="이름, 번호, 클럽, 학년 검색">
      <div class="photo-grid" id="ath-grid">
        ${DATA.athletes
          .map(
            (a) => `<div class="photo-card" data-ath="${a.id}" data-q="${a.id} ${a.name} ${a.club} ${a.grade} ${a.gender} ${a.note}">
            <img src="${photoOf(a)}" alt="${a.name}">
            <div class="cap"><b>${String(a.id).padStart(2,"0")} ${a.name}</b><div class="muted">${a.grade} ${a.gender} · ${clubShort(a.club)}</div></div>
          </div>`
          )
          .join("")}
      </div>
    </div>`;
  }

  function viewOperators() {
    const config = window.CHUNGNAM_LIVE_CONFIG || {};
    const accounts = Array.isArray(config.operatorAccounts) ? config.operatorAccounts : [];
    const judges = accounts.filter((account) => account && account.role === "judge");
    return `<section class="operator-page" aria-labelledby="operator-title">
      <div class="operator-head">
        <div>
          <div class="kicker">OPERATOR ACCOUNTS</div>
          <h2 id="operator-title">운영 계정</h2>
          <p>계정 종류와 사용할 수 있는 기능을 구분해 확인할 수 있습니다.</p>
        </div>
        <a class="btn primary" href="../judge/">심판 화면 열기</a>
      </div>

      <div class="operator-groups">
        <section class="operator-group" aria-labelledby="manager-group-title">
          <div class="operator-group-head">
            <span class="operator-group-icon is-manager">${opsIcon("shield")}</span>
            <div><h3 id="manager-group-title">대회 관리자</h3><p>전체 설정과 계정 권한을 관리합니다.</p></div>
            <span class="operator-count">1명</span>
          </div>
          <article class="operator-account">
            <span class="operator-avatar is-manager">관</span>
            <div class="operator-identity"><strong>대회 관리자</strong><span>개인 계정 정보 비공개</span></div>
            <span class="operator-role is-manager">관리자</span>
          </article>
        </section>

        <section class="operator-group" aria-labelledby="judge-group-title">
          <div class="operator-group-head">
            <span class="operator-group-icon is-judge">${opsIcon("clipboard")}</span>
            <div><h3 id="judge-group-title">심판</h3><p>경기 기록 입력·수정과 조 마감을 담당합니다.</p></div>
            <span class="operator-count">${judges.length}명</span>
          </div>
          ${judges.length ? judges.map((account) => `<article class="operator-account">
            <span class="operator-avatar is-judge">심</span>
            <div class="operator-identity"><strong>${account.name || "공용 심판"}</strong><span>로그인 아이디 <code>${account.id || "admin"}</code></span></div>
            <span class="operator-role is-judge">심판</span>
          </article>`).join("") : `<div class="operator-empty">등록된 심판 계정이 없습니다.</div>`}
          <p class="operator-note">보안을 위해 비밀번호와 개인 이메일은 목록에 표시하지 않습니다.</p>
        </section>
      </div>
    </section>`;
  }

  function viewSync() {
    if (bridge) return viewSyncServer();
    // PeerJS 를 걷어냈으므로 방 코드 화면을 띄우지 않는다. 눌러도 안 되는 버튼을 보여주는 것보다 낫다.
    if (typeof Peer === "undefined") return viewSyncOff();
    return `
      <div class="grid cards-3">
        <div class="card"><div class="kicker">STATUS</div><div class="stat" style="font-size:20px">${syncLabel()}</div><div class="muted">${syncMeta.last ? "마지막 수신 " + syncMeta.last : "아직 수신 없음"}</div></div>
        <div class="card"><div class="kicker">ROOM</div><div class="stat">${roomId || "------"}</div><div class="muted">6자리 방 코드</div></div>
        <div class="card"><div class="kicker">DEVICES</div><div class="stat">${syncMeta.peers}</div><div class="muted">지금 붙어 있는 관람 기기</div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="kicker">REALTIME SYNC</div>
        <h2>실시간 데이터 동기화</h2>
        <p class="muted">심판 노트북이 <b>호스트</b>가 되고, 학부모·코치 휴대폰이 같은 방 코드로 붙습니다. 기록·순위·메달·최강전·선수 사진이 입력 즉시 전송됩니다. 호스트 탭은 켜 두세요.</p>
        <div class="toolbar">
          <button class="btn gold" id="sync-host">심판 호스트 시작</button>
          <button class="btn primary" id="sync-copy">방 링크 복사</button>
          <button class="btn danger" id="sync-stop">연결 끊기</button>
        </div>
        <div class="toolbar">
          <input class="search" id="sync-code" placeholder="방 코드 6자리" value="${roomId || ""}" style="max-width:220px;margin:0">
          <button class="btn" id="sync-join">관람으로 입장</button>
          <label class="muted" style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="sync-photos" ${sharePhotos ? "checked" : ""}> 프로필 사진도 전송
          </label>
        </div>
        ${syncMeta.error ? `<p class="muted">오류: ${syncMeta.error}</p>` : ""}
      </div>
      <div class="card" style="margin-top:14px">
        <div class="kicker">HOW</div>
        <h3>현장 운영 순서</h3>
        <ol class="muted" style="line-height:1.7">
          <li>심판 노트북에서 심판실 암호 2026 입장</li>
          <li>이 화면에서 <b>심판 호스트 시작</b></li>
          <li>생긴 6자리 코드 또는 링크를 카톡으로 보냄</li>
          <li>다른 사람은 같은 앱에서 코드를 넣고 <b>관람으로 입장</b></li>
          <li>심판이 입력한 기록을 연결된 관중 앱에 반영</li>
        </ol>
      </div>`;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function viewSyncOff() {
    return `<div class="card" style="max-width:560px;margin:40px auto">
      <div class="kicker">REALTIME SYNC</div>
      <h2>동기화를 껐습니다</h2>
      <p class="muted">주소에 <code>?sync=off</code> 가 있습니다. 기록은 이 창에만 저장되고 다른 창·탭과 맞춰지지 않습니다.</p>
      <p class="muted">문제를 가려낼 때만 쓰는 모드입니다. <code>?sync=off</code> 를 빼고 다시 열면 창끼리 실시간으로 맞춰집니다.</p>
    </div>`;
  }

  function viewSyncServer() {
    const s = bridge.status() || {};
    const last = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleTimeString("ko-KR") : "아직 없음";
    const conn = !s.online ? "오프라인" : s.connected ? "연결됨" : "재연결 중";
    return `${conflictPanel()}
      <div class="grid cards-3">
        <div class="card"><div class="kicker">STATUS</div><div class="stat" style="font-size:20px">${conn}</div><div class="muted">마지막 동기화 ${last}</div></div>
        <div class="card"><div class="kicker">대기 중</div><div class="stat">${s.pending || 0}</div><div class="muted">아직 못 보낸 입력</div></div>
        <div class="card"><div class="kicker">확인 필요</div><div class="stat">${s.conflicts || 0}</div><div class="muted">값이 엇갈린 칸</div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="kicker">REALTIME SYNC</div>
        <h2>${bridge.adapterName === "broadcast" ? "이 기기 안에서 실시간 동기화" : "서버 동기화"}</h2>
        ${bridge.adapterName === "broadcast"
          ? `<p class="muted">이 노트북에서 연 <b>모든 창과 탭</b>이 실시간으로 맞춰집니다. 한쪽에 심판 콘솔, 다른 쪽에 관중용 기록 화면을 띄우면 입력한 기록이 반영됩니다.</p>
             <p class="muted"><b>서버는 아직 없습니다.</b> 기록은 이 기기에 저장되고 다른 기기와는 합쳐지지 않습니다. 서버 주소를 넣으면 같은 화면 그대로 여러 기기로 넓어집니다.</p>`
          : `<p class="muted">기기마다 서버에 직접 붙습니다. <b>방 코드도, 호스트 노트북도 없습니다.</b> 어느 기기를 꺼도 나머지는 그대로 돕니다.</p>`}
        <p class="muted">회선이 끊겨도 입력은 계속 됩니다. 이 기기에 쌓아 두었다가 연결되면 순서대로 보냅니다. 위 <b>대기 중</b> 숫자가 0이면 전부 저장됐습니다.</p>
        <div class="toolbar">
          <button class="btn primary" id="sync-flush">지금 전송</button>
          <button class="btn" id="sync-pull">서버에서 다시 받기</button>
        </div>
        <p class="muted" style="margin-top:12px;font-size:12px">이 기기 ${bridge.deviceId() || "준비 중"}${bridge.isPrimaryTab() ? "" : " (보조 창)"} · 방식 ${bridge.adapterName}${s.lastError ? " · 마지막 오류: " + s.lastError : ""}</p>
      </div>`;
  }

  // 다른 기기와 값이 엇갈려 사용자 판단을 기다리는 칸 목록.
  // 심판이 커서를 두고 있던 칸만 여기로 온다 — 그 외에는 서버값으로 자동 정렬된다.
  function conflictPanel() {
    if (!bridge) return "";
    const list = bridge.listConflicts();
    if (!list.length) return "";
    const rows = list
      .map((c) => {
        const who = c.scope === "result" ? `${c.eid}경기 ${c.heat}조 ${String(c.athleteId).padStart(2, "0")}번` : c.field;
        const mine = c.local.value === "" || c.local.value == null ? "(빈칸)" : c.local.value;
        const theirs = c.server.value === "" || c.server.value == null ? "(빈칸)" : c.server.value;
        return `<div class="conflict-row">
          <div class="conflict-who"><b>${who}</b> <span class="muted">${fieldLabel(c.field)}</span></div>
          <div class="conflict-vals">
            <button class="btn" data-conflict="local|${c.cell}">내 값 <b>${mine}</b></button>
            <button class="btn primary" data-conflict="server|${c.cell}">다른 기기 <b>${theirs}</b></button>
          </div>
        </div>`;
      })
      .join("");
    return `<div class="card conflict-card">
      <div class="kicker">확인 필요</div>
      <h2>값이 엇갈린 칸 ${list.length}개</h2>
      <p class="muted">같은 칸을 다른 심판이 먼저 고쳤습니다. 어느 값을 쓸지 고르세요. 고르기 전까지 화면의 값은 그대로 둡니다.</p>
      ${rows}
    </div>`;
  }

  function fieldLabel(f) {
    return { time: "기록", rank: "순위", status: "상태", note: "비고", currentEvent: "현재 경기", qualifyCount: "진출 인원", fitnessHeats: "최강전 조편성" }[f] || f;
  }

  function viewJudge() {
    if (!judgeAuthed) {
      return `<div class="card" style="max-width:420px;margin:40px auto">
        <div class="kicker">JUDGE ROOM</div>
        <h2>심판실 입장</h2>
        <p class="muted">기록 입력·엑셀 업로드는 심판만 가능합니다. 기본 암호는 2026이며 입장 후 바꿀 수 있습니다.</p>
        <input class="search" id="pin" type="password" placeholder="암호 (기본 2026)">
        <button class="btn primary" id="pin-go">입장</button>
      </div>`;
    }
    const ev = evById[selectedEvent];
    const heats = effectiveHeats(ev);
    const list = DATA.events
      .map((e) => {
        const p = eventProgress(e);
        return `<div class="event-item ${e.id === selectedEvent ? "on" : ""}" data-sel="${e.id}">
          <div class="eno">${String(e.id).padStart(2,"0")}</div>
          <div style="flex:1"><b>${e.name}</b><div class="muted">${p.done}/${p.total} 입력</div></div>
        </div>`;
      })
      .join("");
    let body = "";
    heats.forEach((heat, hi) => {
      body += `<div class="heat"><div class="heat-hd"><b>${hi + 1}조</b></div>
        <table class="table judge-grid"><thead><tr><th>레인</th><th>번호</th><th>이름</th><th>기록</th><th>순위</th><th>상태</th></tr></thead><tbody>`;
      const rows = heat && heat.length ? heat : [null, null, null, null];
      rows.forEach((aid, li) => {
        const a = aid ? athById[aid] : null;
        const row = aid ? (state.results[ev.id] || {})[keyOf(hi + 1, aid)] || {} : {};
        body += `<tr>
          <td class="j-lane">${li + 1}</td>
          <td class="j-bib">${
            ev.kind === "최강전"
              ? `<input data-fit="${ev.id}:${hi + 1}:${li}" value="${aid || ""}" placeholder="번호">`
              : a
              ? a.id
              : ""
          }</td>
          <td class="j-name">${a ? a.name : '<span class="muted">미배정</span>'}</td>
          <td class="j-time">${a ? `<input data-ed="time:${ev.id}:${hi + 1}:${a.id}" value="${row.time || ""}" placeholder="45.23">` : ""}</td>
          <td class="j-rank">${a ? `<input data-ed="rank:${ev.id}:${hi + 1}:${a.id}" value="${row.rank || ""}" placeholder="자동">` : ""}</td>
          <td class="j-status">${
            a
              ? `<select data-ed="status:${ev.id}:${hi + 1}:${a.id}">
            <option value="">완주</option>
            <option ${row.status === "DNS" ? "selected" : ""}>DNS</option>
            <option ${row.status === "DNF" ? "selected" : ""}>DNF</option>
            <option ${row.status === "DQ" ? "selected" : ""}>DQ</option>
            <option ${row.status === "REL" ? "selected" : ""}>REL</option>
          </select>`
              : ""
          }</td>
        </tr>`;
      });
      body += "</tbody></table></div>";
    });
    return `${conflictPanel()}<div class="toolbar">
        <button class="btn primary" id="dl-xlsx">입력양식 엑셀 받기</button>
        <label class="btn">엑셀 업로드<input type="file" id="up-xlsx" accept=".xlsx,.xls,.csv" hidden></label>
        <button class="btn" id="export-xlsx">현재 기록 엑셀 저장</button>
        <button class="btn gold" id="snap-html">공개용 HTML 저장</button>
        <button class="btn" id="demo-fill">샘플 기록 넣기</button>
        <button class="btn" id="auto-rank">조별 1·2·3등 자동</button>
        <button class="btn" id="reset-res">이 기기 화면 다시 받기</button>
        <input id="new-pin" placeholder="새 암호" style="width:110px;padding:8px;border-radius:10px;border:1px solid var(--line);background:#071525;color:#fff">
        <button class="btn" id="set-pin">암호 변경</button>
      </div>
      <div class="drop" id="drop">엑셀 파일을 이곳에 놓아도 됩니다. 노란 칸(기록/순위/상태/번호)만 읽습니다.</div>
      <div class="two" style="margin-top:14px">
        <div class="card scroll-list">${list}</div>
        <div class="card">
          <div class="kicker">INPUT</div>
          <h2>No.${String(ev.id).padStart(2,"0")} ${ev.name}</h2>
          <p class="muted">기록 예: 28.41 / 1:05.87 · 순위는 <b>그 조의 1·2·3등</b>입니다. 비우면 조별 기록순으로 자동 계산합니다.</p>
          ${body}
        </div>
      </div>`;
  }

  function bindView() {
    $$(".lane[data-ath], .photo-card[data-ath], .q-card[data-ath], tr[data-ath]").forEach((el) => {
      el.addEventListener("click", () => openAthlete(+el.dataset.ath));
    });
    $$("[data-go-medals]").forEach((el) => el.addEventListener("click", () => setView("medals")));
    $$("[data-sel]").forEach((el) =>
      el.addEventListener("click", () => {
        selectedEvent = +el.dataset.sel;
        render();
      })
    );
    $$(".ops-go[data-view]").forEach((b) =>
      b.addEventListener("click", () => setView(b.dataset.view))
    );
    $$("[data-goto-rank]").forEach((el) =>
      el.addEventListener("click", () => {
        selectedEvent = +el.dataset.gotoRank;
        setView("rank");
      })
    );
    const q = $("#ath-q");
    if (q)
      q.addEventListener("input", () => {
        const s = q.value.trim().toLowerCase();
        $$("#ath-grid .photo-card").forEach((c) => {
          c.style.display = !s || c.dataset.q.toLowerCase().includes(s) ? "" : "none";
        });
      });
    const qc = $("#qcount");
    if (qc)
      qc.addEventListener("change", () => {
        const beforeQc = state.qualifyCount;
        state.qualifyCount = Math.max(1, Math.min(12, +qc.value || 6));
        saveState();
        if (bridge) bridge.publishMeet("qualifyCount", state.qualifyCount, beforeQc);
        render();
      });
    const pinGo = $("#pin-go");
    if (pinGo)
      pinGo.addEventListener("click", () => {
        const v = $("#pin").value.trim();
        if (v === getJudgePin()) {
          judgeAuthed = true;
          sessionStorage.setItem(PIN_KEY, "1");
          render();
        } else toast("암호가 올바르지 않습니다");
      });
    const sf = $("#sync-flush");
    if (sf)
      sf.addEventListener("click", () => {
        if (!bridge) return;
        bridge.flush().then(() => {
          toast("전송했습니다");
          render();
        });
      });
    const sp2 = $("#sync-pull");
    if (sp2)
      sp2.addEventListener("click", () => {
        if (!bridge) return;
        bridge.resync().then(() => {
          toast("서버에서 다시 받았습니다");
          render();
        });
      });
    $$("[data-conflict]").forEach((b) =>
      b.addEventListener("click", () => {
        if (!bridge) return;
        const raw = b.dataset.conflict;
        const cut = raw.indexOf("|");
        const choice = raw.slice(0, cut);
        const cell = raw.slice(cut + 1);
        bridge.resolveConflict(cell, choice).then(() => {
          toast(choice === "local" ? "내 값으로 다시 보냈습니다" : "다른 기기 값으로 맞췄습니다");
          render();
        });
      })
    );
    $$("[data-ed]").forEach((inp) => {
      const ed = () => inp.dataset.ed.split(":");
      inp.addEventListener("focus", () => {
        if (!bridge) return;
        const [field, eid, heat, aid] = ed();
        bridge.markEditing(+eid, +heat, +aid, field);
      });
      inp.addEventListener("change", () => {
        const [field, eid, heat, aid] = ed();
        writeResult(+eid, +heat, +aid, field, inp.value);
        toast("저장됨");
      });
      inp.addEventListener("blur", () => {
        if (bridge) {
          const [field, eid, heat, aid] = ed();
          bridge.clearEditing(+eid, +heat, +aid, field);
        }
        if (pendingRender) {
          pendingRender = false;
          render();
        }
      });
    });
    $$("[data-fit]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const [eid, heat, lane] = inp.dataset.fit.split(":").map(Number);
        const heats = effectiveHeats(evById[eid]).map((h) => h.slice());
        if (!heats[heat - 1]) heats[heat - 1] = [];
        const aid = parseInt(inp.value, 10);
        heats[heat - 1][lane] = Number.isFinite(aid) ? aid : null;
        const beforeFit = state.fitnessHeats[eid] || null;
        state.fitnessHeats[eid] = heats;
        saveState();
        if (bridge) bridge.publishFitness(eid, heats, beforeFit);
        render();
      });
    });
    const up = $("#up-xlsx");
    if (up) up.addEventListener("change", (e) => e.target.files[0] && importExcel(e.target.files[0]));
    const drop = $("#drop");
    if (drop) {
      drop.addEventListener("dragover", (e) => {
        e.preventDefault();
        drop.classList.add("hot");
      });
      drop.addEventListener("dragleave", () => drop.classList.remove("hot"));
      drop.addEventListener("drop", (e) => {
        e.preventDefault();
        drop.classList.remove("hot");
        const f = e.dataTransfer.files[0];
        if (f) importExcel(f);
      });
    }
    const dl = $("#dl-xlsx");
    if (dl)
      dl.addEventListener("click", () => {
        window.location.href = "심판_기록입력양식.xlsx";
      });
    const ex = $("#export-xlsx");
    if (ex) ex.addEventListener("click", exportExcel);
    const snap = $("#snap-html");
    if (snap) snap.addEventListener("click", downloadSnapshot);
    const demo = $("#demo-fill");
    if (demo) demo.addEventListener("click", fillDemo);
    const ar = $("#auto-rank");
    if (ar)
      ar.addEventListener("click", () => {
        autoFillRanks(selectedEvent);
        toast("기록순으로 순위를 채웠습니다");
        render();
      });
    const rs = $("#reset-res");
    if (rs)
      rs.addEventListener("click", () => {
        if (!confirm(bridge
          ? "이 기기 화면만 비우고 서버에서 기록을 다시 받습니다. 서버 기록은 지워지지 않습니다. 계속할까요?"
          : "이 기기의 기록을 지우겠습니까? (서버 동기화가 꺼져 있어 되돌릴 수 없습니다)")) return;
        const keepCur = state.currentEvent;
        const fresh = defaultState();
        Object.assign(state, fresh);
        state.currentEvent = keepCur;
        saveState();
        render();
        if (bridge) bridge.resync().then(() => { toast("서버 기록을 다시 받았습니다"); render(); });
      });
    const sh = $("#sync-host");
    if (sh) sh.addEventListener("click", () => startHost());
    const sj = $("#sync-join");
    if (sj)
      sj.addEventListener("click", () => {
        const code = ($("#sync-code") && $("#sync-code").value) || roomId;
        startGuest(code);
      });
    const sc = $("#sync-copy");
    if (sc) sc.addEventListener("click", copyShare);
    const ss = $("#sync-stop");
    if (ss) ss.addEventListener("click", stopSync);
    const sp = $("#sync-photos");
    if (sp)
      sp.addEventListener("change", () => {
        sharePhotos = !!sp.checked;
        if (syncRole === "host") broadcastLive();
      });
    const setPin = $("#set-pin");
    if (setPin)
      setPin.addEventListener("click", () => {
        const v = ($("#new-pin") && $("#new-pin").value.trim()) || "";
        if (v.length < 4) return toast("암호는 4자 이상으로 하세요");
        localStorage.setItem(PIN_STORE, v);
        toast("심판 암호를 바꿨습니다");
      });
    $$("[data-go-judge]").forEach((b) => b.addEventListener("click", () => setView("judge")));
    $$("[data-heat]").forEach((b) =>
      b.addEventListener("click", () => {
        selectedHeat = +b.dataset.heat;
        render();
      })
    );
  }

  // collect 를 주면 발행하지 않고 배열에 모은다 (엑셀 일괄 반영·샘플 채우기용)
  function writeResult(eid, heat, aid, field, value, collect) {
    if (!state.results[eid]) state.results[eid] = {};
    const k = keyOf(heat, aid);
    const prev = state.results[eid][k];
    const oldValue = prev && prev[field] != null ? prev[field] : "";
    state.results[eid][k] = Object.assign(
      { athleteId: aid, heat, lane: 1, time: "", rank: "", status: "", note: "" },
      prev,
      { [field]: value }
    );
    if (!applyingRemote && oldValue !== value) {
      const change = { scope: "result", eid: +eid, heat: +heat, athleteId: +aid, field, value, oldValue };
      if (collect) collect.push(change);
      else if (bridge) bridge.publishResult(eid, heat, aid, field, value, oldValue);
    }
    saveState();
  }

  function autoFillRanks(eid, collect) {
    const ev = evById[eid];
    rankedHeats(ev).forEach((h) => {
      h.finished.forEach((x, i) => {
        writeResult(eid, x.heat, x.athleteId, "rank", String(i + 1), collect);
      });
    });
  }

  function compressDataUrl(url, max) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * s);
        c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL("image/jpeg", 0.82));
      };
      img.src = url;
    });
  }

  function openAthlete(id) {
    const a = athById[id];
    if (!a) return;
    const res = athleteResults(id);
    $("#modal").classList.add("show");
    $("#modal").innerHTML = `<div class="modal">
      <img class="hero" src="${photoOf(a)}" alt="${a.name}">
      <div class="body">
        <div class="kicker">BIB ${String(a.id).padStart(2,"0")}</div>
        <h2 style="margin:4px 0 8px">${a.name}</h2>
        <div class="chips">
          <span class="chip">${a.club}</span>
          <span class="chip">${a.grade} ${a.gender}</span>
          ${a.note ? `<span class="chip">그룹 ${a.note}</span>` : ""}
          <span class="chip">${a.group}</span>
        </div>
        <table class="table">
          <thead><tr><th>경기</th><th>조</th><th>기록</th><th>순위</th></tr></thead>
          <tbody>
            ${
              res.length
                ? res
                    .map((x) => `<tr><td>${x.ev.name}</td><td>${x.row.heat}조</td><td>${x.row.time || (x.t != null ? fmtTime(x.t) : "—")}</td><td>조 ${x.place || "—"}등${x.overall ? " · 전체 " + x.overall + "위" : ""}</td></tr>`)
                    .join("")
                : `<tr><td colspan="4" class="muted">배정 경기 없음</td></tr>`
            }
          </tbody>
        </table>
        <div class="toolbar"><button class="btn" id="close-m">닫기</button></div>
      </div>
    </div>`;
    $("#close-m").onclick = () => $("#modal").classList.remove("show");
    $("#modal").onclick = (e) => {
      if (e.target.id === "modal") $("#modal").classList.remove("show");
    };
  }

  function colVal(row, names) {
    for (const n of names) {
      for (const k of Object.keys(row)) {
        if (String(k).replace(/\s/g, "") === n.replace(/\s/g, "")) return row[k];
      }
    }
    return "";
  }

  function importExcel(file) {
    if (typeof XLSX === "undefined") {
      toast("엑셀 라이브러리 로딩 중. 잠시 후 다시 시도하세요");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target.result, { type: "array" });
      let n = 0;
      const xlsxChanges = [];
      batching = true;
      wb.SheetNames.forEach((name) => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
        rows.forEach((row) => {
          const eid = parseInt(colVal(row, ["경기번호", "경기", "event", "EventId"]), 10);
          let ev = Number.isFinite(eid) ? evById[eid] : null;
          if (!ev) {
            const nm = String(colVal(row, ["경기명", "경기이름"]) || "");
            ev = DATA.events.find((x) => nm && (x.name === nm || nm.includes(x.name) || x.name.includes(nm)));
          }
          if (!ev && /^\d{2}_/.test(name)) ev = evById[parseInt(name, 10)];
          const aid = parseInt(colVal(row, ["번호", "선수번호", "Bib", "bib"]), 10);
          const time = String(colVal(row, ["기록", "타임", "Time"]) || "").trim();
          const rank = String(colVal(row, ["순위", "Rank"]) || "").trim();
          const status = String(colVal(row, ["상태", "비고상태", "Status"]) || "").trim();
          const heat = parseInt(colVal(row, ["조", "Heat"]) || "1", 10) || 1;
          if (!ev || !Number.isFinite(aid)) return;
          if (!time && !rank && !status) return;
          if (time) writeResult(ev.id, heat, aid, "time", time, xlsxChanges);
          if (rank) writeResult(ev.id, heat, aid, "rank", rank, xlsxChanges);
          if (status) writeResult(ev.id, heat, aid, "status", status === "완주" ? "" : status, xlsxChanges);
          n++;
        });
      });
      batching = false;
      saveState();
      if (bridge) bridge.publishMany(xlsxChanges);
      toast(n ? n + "개 기록을 반영했습니다" : "반영할 기록 칸이 없습니다");
      render();
    };
    reader.readAsArrayBuffer(file);
  }

  function exportExcel() {
    if (typeof XLSX === "undefined") return toast("엑셀 라이브러리를 불러오지 못했습니다");
    const rows = [];
    DATA.events.forEach((ev) => {
      rankedEvent(ev).all.forEach((x) => {
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
          상태: x.st || "완주",
        });
      });
    });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "전체기록");
    XLSX.writeFile(wb, "2026_충남체육회장기_인라인_경기기록.xlsx");
  }

  // 어댑터를 고른다. 설정이 없으면 null 을 돌려주고, 그러면 앱은 예전 그대로 로컬로만 돈다.
  function makeSyncAdapter() {
    const forced = new URLSearchParams(location.search).get("sync");
    if (forced === "off") return null;
    // 리허설·시연용: 같은 브라우저의 창들이 인메모리 서버 하나를 공유한다
    if (forced === "memory" && window.ChungnamSyncMemoryAdapter) {
      const g = window.top || window;
      if (!g.__chungnamMemoryServer) g.__chungnamMemoryServer = window.ChungnamSyncMemoryAdapter.createMemoryServer();
      return window.ChungnamSyncMemoryAdapter.createMemoryAdapter(g.__chungnamMemoryServer);
    }
    // 서버가 설정돼 있으면 서버가 이긴다. ?sync=broadcast 로 기기 안 동기화를 강제할 수 있다.
    if (forced !== "broadcast" && window.SUPABASE_URL && window.SUPABASE_ANON_KEY &&
        typeof supabase !== "undefined" && window.ChungnamSyncSupabaseAdapter) {
      return window.ChungnamSyncSupabaseAdapter.createSupabaseAdapter({
        client: supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY),
        meetId: MEET_ID,
      });
    }
    // 기본값 — 서버 0. 이 기기의 창·탭끼리 localStorage + BroadcastChannel 로 맞춘다.
    if (window.ChungnamSyncBroadcastAdapter) {
      return window.ChungnamSyncBroadcastAdapter.createBroadcastAdapter({ meetId: MEET_ID });
    }
    return null;
  }

  function startSync() {
    try {
      if (!window.ChungnamSyncBridge) return;
      const adapter = makeSyncAdapter();
      if (!adapter) return;
      bridge = window.ChungnamSyncBridge.attach({
        meetId: MEET_ID,
        adapter,
        applyPatch,
        toast,
        onStatus: updateShareUI,
        onConflict: () => {
          if (view === "judge" || view === "sync") render();
        },
      });
      // 현장 진단용 손잡이. 대회 당일 콘솔에서 __sync.status() / __sync.listConflicts() 로 상태를 본다.
      window.__sync = bridge;
    } catch (e) {
      bridge = null;
      console.warn("[sync] 시작하지 못했습니다. 로컬로만 동작합니다.", e);
    }
  }

  function init() {
    const params = new URLSearchParams(location.search);
    document.body.classList.toggle("is-embedded", params.get("embedded") === "1");
    document.body.dataset.view = view;
    $$(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    if (location.protocol === "file:") {
      const banner = document.createElement("div");
      banner.setAttribute("style", "position:fixed;top:0;left:0;right:0;z-index:99999;background:#dc2626;color:#fff;padding:10px 14px;font-size:13px;font-weight:700;text-align:center");
      banner.innerHTML = '로컬 파일로 열면 실시간 동기화가 막힐 수 있습니다. Netlify Drop 또는 Live Server로 여세요. <button id="file-ban-x" style="margin-left:8px">닫기</button>';
      document.body.prepend(banner);
      const x = document.getElementById("file-ban-x");
      if (x) x.onclick = () => banner.remove();
    }
    window.addEventListener("beforeunload", (e) => {
      if (syncRole !== "host" || !hostPeer) return;
      e.preventDefault();
      e.returnValue = "호스트를 닫으면 모든 관람 화면의 실시간 중계가 멈춥니다.";
    });
    const menuToggle = $("#menu-toggle");
    const menu = $("#main-menu");
    function closeMenu(restoreFocus) {
      menu.hidden = true;
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute("aria-label", "메뉴 열기");
      if (restoreFocus) menuToggle.focus();
    }
    menuToggle.addEventListener("click", () => {
      const open = menu.hidden;
      menu.hidden = !open;
      menuToggle.setAttribute("aria-expanded", String(open));
      menuToggle.setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기");
    });
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !menuToggle.contains(e.target)) closeMenu(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) closeMenu(true);
    });
    $$(".nav button").forEach((b) => b.addEventListener("click", () => {
      closeMenu(true);
      setView(b.dataset.view);
    }));
    try {
      const ch = new BroadcastChannel("chungnam-inline");
      ch.onmessage = (m) => {
        if (m.data && m.data.from === BC_ID) return;
        if (syncRole === "host") return;
        if (m.data && m.data.type === "sync") {
          Object.assign(state, loadState());
          render();
        }
      };
    } catch (e) {}
    window.addEventListener("storage", (e) => {
      // 서버 동기화가 켜져 있으면 무시한다. 이건 상태 전체를 통째로 갈아끼우는 경로라
      // 한 기기에서 탭을 두 개 열면 나중 탭이 앞 탭의 입력을 덮는다 — P2 에서 BroadcastChannel 을
      // 끊은 것과 같은 이유다. 탭 사이 정렬은 이제 서버가 맡는다.
      if (bridge) return;
      if (e.key === STORE_KEY) {
        Object.assign(state, loadState());
        render();
      }
    });
    setHeaderMeta();
    setInterval(headerClock, 1000);
    headerClock();
    render();
    updateShareUI();
    startSync();
    document.addEventListener("click", (e) => {
      if (e.target && e.target.id === "copy-link") copyShare();
      if (e.target && e.target.id === "start-share") setView("sync");
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
