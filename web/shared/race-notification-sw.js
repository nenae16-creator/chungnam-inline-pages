self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (!url) return;
  event.waitUntil((async () => {
    const tabs = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const tab = tabs.find((item) => item.url.split("#")[0] === url.split("#")[0]);
    if (tab) {
      await tab.navigate(url);
      return tab.focus();
    }
    return clients.openWindow(url);
  })());
});
