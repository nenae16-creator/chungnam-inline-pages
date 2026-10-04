/*!
 * chungnam-inline — web/judge/time.js
 *
 * 심판 입력칸 전용 검사기.
 *
 * ★ parseTime / fmtTime 사본은 여기 없다. 공용 `web/shared/calc.js` 가 정본이다.
 *   (calc.js 는 legacy/app.js 에서 줄 단위로 추출한 생성물이고 원본 sha256 이 박혀 있다.)
 *   같은 "1:05.87" 이 심판 콘솔과 전광판에서 다르게 읽히면 대회가 끝난다.
 *   사본이 셋이 되면 반드시 갈라지므로, 이 파일은 parseTime 을 **인자로 받아 쓴다.**
 *
 * 여기 있는 것은 legacy 에 없는 것뿐이다 — 심판이 급하게 칠 때의 오타를 잡는 안전장치.
 *
 * UMD: 브라우저에서는 window.JudgeTime.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JudgeTime = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STATUSES = ["DNS", "DNF", "DQ", "REL"];

  /** 상태 문자열을 legacy 표기로 정규화한다. 완주는 빈 문자열이다. */
  function normStatus(v) {
    var s = String(v == null ? "" : v).trim().toUpperCase();
    if (!s || s === "완주" || s === "OK") return "";
    return s;
  }

  /**
   * 심판이 친 기록을 검사만 한다. **값은 절대 바꾸지 않는다.**
   * 자동 교정은 하지 않는다 — 심판이 적은 원문이 곧 기록이고, 조용한 수정이 제일 위험하다.
   *
   * @param {string} raw        입력칸에 있는 그대로
   * @param {function} parseTime  공용 calc.parseTime 을 넘긴다
   * @returns {{ok:boolean, sec:number|null, hint:string}}
   */
  function checkTime(raw, parseTime) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return { ok: true, sec: null, hint: "" };
    if (/^(dns|dnf|dq|rel)$/i.test(s)) {
      return { ok: false, sec: null, hint: "상태는 아래 버튼으로 고르세요" };
    }
    if (!/^[0-9:.,]+$/.test(s)) {
      return { ok: false, sec: null, hint: "숫자와 : . 만 씁니다" };
    }
    // parseTime 은 빈 칸을 0 으로 읽는다. "1:" 은 60초가 되어 조용히 통과한다 — 사람 눈엔 미완성이다.
    if (s.indexOf(":") >= 0) {
      var parts = s.split(":");
      if (parts.length > 3 || parts.some(function (p) { return p === ""; })) {
        return { ok: false, sec: null, hint: "45.23 또는 1:05.87 형식" };
      }
    }
    var sec = parseTime(s);
    if (sec == null || !isFinite(sec)) {
      return { ok: false, sec: null, hint: "45.23 또는 1:05.87 형식" };
    }
    if (sec < 0) return { ok: false, sec: sec, hint: "음수입니다" };
    // 콜론 뒤 초가 60 을 넘으면 parseTime 은 조용히 통과시킨다. 사람 눈에는 오타다.
    if (s.indexOf(":") >= 0 && Number(s.split(":").pop()) >= 60) {
      return { ok: false, sec: sec, hint: "초가 60을 넘습니다" };
    }
    return { ok: true, sec: sec, hint: "" };
  }

  return { normStatus: normStatus, checkTime: checkTime, STATUSES: STATUSES.slice() };
});
