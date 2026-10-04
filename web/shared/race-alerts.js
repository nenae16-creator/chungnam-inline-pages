(function (global) {
  "use strict";

  const LEAD = 5;

  function due(events, currentEventId, watched, notified, containsAthlete) {
    const current = events.findIndex((event) => event.id === currentEventId);
    if (current < 0) return [];
    const alerts = [];
    for (const athleteId of watched) {
      for (let i = current; i < Math.min(events.length, current + LEAD + 1); i++) {
        const event = events[i];
        const key = `${athleteId}:${event.id}`;
        if (!notified.has(key) && containsAthlete(event.id, athleteId)) {
          alerts.push({ athleteId, event, remaining: i - current, key });
        }
      }
    }
    return alerts;
  }

  function distance(events, currentEventId, eventId) {
    const current = events.findIndex((event) => event.id === currentEventId);
    const target = events.findIndex((event) => event.id === eventId);
    return current < 0 || target < 0 ? null : target - current;
  }

  function message(name, event, remaining) {
    return `${name} 선수 · 제${Number(event.no || event.id)}경기 ${event.name} · ${remaining ? `${remaining}경기 후 시합입니다` : "지금 시합입니다"}`;
  }

  async function notify(title, body, key, url, workerUrl) {
    if (!global.Notification || global.Notification.permission !== "granted") return;
    try {
      if (global.navigator?.serviceWorker) {
        const registration = await global.navigator.serviceWorker.register(workerUrl);
        await registration.showNotification(title, { body, tag: key, data: { url } });
        return;
      }
    } catch (_) { /* 브라우저 알림 실패 시 앱 내부 배너는 유지한다. */ }
    try { new global.Notification(title, { body, tag: key }); } catch (_) {}
  }

  global.RaceAlerts = { due, distance, message, notify };
})(typeof window === "undefined" ? globalThis : window);
