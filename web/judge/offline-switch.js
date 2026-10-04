/*!
 * chungnam-inline — web/judge/offline-switch.js
 *
 * 리허설용 "회선 끊기" 스위치. 어댑터를 감싸기만 한다.
 *
 * 서버 역할은 `web/shared/adapter-broadcast.js` 가 한다 — 여기에 사본을 두지 않는다.
 * (이전에는 이 파일에 자체 서버 구현이 있었으나, 판정 규칙이 두 벌이 되는 순간
 *  갈라질 위험이 생겨서 걷어냈다. calc.js 와 같은 이유다.)
 *
 * 왜 필요한가: 오프라인을 흉내내려면 나가는 커밋만 막아서는 부족하다.
 * 들어오는 밀어주기도 함께 막아야 진짜 끊긴 것과 같아진다.
 * `sync.setOnline(false)` 는 flush/pull 만 멈추므로 나머지를 이 껍데기가 맡는다.
 *
 * 운영 화면에서는 이 토글이 감춰져 있다(judge.js 에서 ?win / ?dev 일 때만 노출).
 *
 * UMD: 브라우저에서는 window.JudgeOfflineSwitch.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JudgeOfflineSwitch = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * @param {object} inner  connect/commit/pull/disconnect 를 가진 어댑터
   * @returns {object} 같은 인터페이스 + setOffline(boolean)
   */
  function wrap(inner) {
    var off = false;
    return {
      name: (inner.name || "adapter") + "+switch",
      get offline() {
        return off;
      },
      setOffline: function (v) {
        off = !!v;
        if (inner.setOffline) inner.setOffline(off);
      },
      connect: function (ctx) {
        var wrapped = Object.assign({}, ctx, {
          onRemote: function (changes) {
            if (off) return Promise.resolve(); // 끊긴 척 — 들어오는 것도 막는다
            return ctx.onRemote(changes);
          },
        });
        return Promise.resolve(inner.connect(wrapped));
      },
      commit: function (events) {
        if (off) return Promise.reject(new Error("오프라인 흉내 중"));
        return inner.commit(events);
      },
      pull: function (cursor) {
        if (off) return Promise.reject(new Error("오프라인 흉내 중"));
        return inner.pull(cursor);
      },
      disconnect: function () {
        return Promise.resolve(inner.disconnect ? inner.disconnect() : undefined);
      },
    };
  }

  return { wrap: wrap };
});
