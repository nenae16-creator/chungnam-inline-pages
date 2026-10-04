/* 대회 카탈로그 어댑터 — 여러 대회(현재+과거 기록) 중 하나를 골라 MEET_DATA 로 노출한다.
 * ?meet=<id> 로 선택하고, 없으면 첫 번째(현재 대회)를 쓴다. UI(대회 선택)는 React 에서 그린다.
 * 원본 catalog.js 의 #meet-select DOM 조작은 제거하고 데이터 노출만 담당한다. */
(function () {
  const catalog = window.MEET_CATALOG || [];
  if (!catalog.length) return;
  const params = new URLSearchParams(location.search);
  const selected = catalog.find((m) => m.meta.id === params.get("meet")) || catalog[0];
  window.MEET_DATA = selected;
  window.MEET_SELECTED_ID = selected.meta.id;
  // 대회 목록(선택 UI용): id·제목·날짜·현재여부.
  window.MEET_LIST = catalog.map((m, i) => ({
    id: m.meta.id,
    title: m.meta.title,
    date: m.meta.date,
    current: i === 0,
    athletes: m.athletes.length,
    events: m.events.length,
  }));
})();
