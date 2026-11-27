// Installed at document end on the configured Factory origin. Reuse the live
// router and store so switching native tabs keeps one page and one event stream.
(async () => {
  const router = await import(new URL("/lib/router.js", location.origin).href);
  const { authenticated, jobs, issues } = await import(new URL("/lib/store.js", location.origin).href);
  const { theme } = await import(new URL("/lib/theme.js", location.origin).href);
  const tabs = router.TABS.map(([path, name]) => ({ path, name }));
  const more = router.NAV.flatMap(([, rows]) => rows)
    .filter(([path]) => !tabs.some(tab => tab.path === path))
    .map(([path, name]) => ({ path, name }));
  const controls = tabs.find(tab => tab.path === "/controls");
  if (controls) document.documentElement.classList.add("factory-rail");
  const send = window.webkit.messageHandlers.factoryRail;
  const style = new CSSStyleSheet();
  style.replaceSync(`
    .shell.phone { padding-bottom: 0 }
    .shell .tabbar, .shell .side nav, .shell .side-head > button { display: none }
    .shell:not(.phone) { display: flex; flex-direction: column }
    .shell:not(.phone) > .side {
      position: static; flex-direction: row; align-items: center; height: auto;
      padding: var(--space-2) var(--gutter-left); border: 0; overflow: visible
    }
    .shell .side-run, .shell.rail .side-run, .shell.rail .auto { flex-direction: row }
    .shell .side-foot { position: static; padding: 0; margin: 0 0 0 auto }
    .shell > .content { flex: 1 }
  `);
  const accountButton = () => document.querySelector('.tabbar button, .side-foot button[aria-label="More"]');
  let queued = false;
  function refresh() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const path = router.route.value.path;
      const selected = tabs.find(tab => tab.path === path || (tab.path !== "/" && path.startsWith(tab.path + "/")));
      const ticket = router.ticketPanel.value, epic = router.epicPanel.value;
      send.postMessage({ signedIn: authenticated.value === true, tabs, more,
        tab: selected?.path ?? (path === "/start" ? "/" : controls?.path ?? "/"),
        waiting: jobs.value.filter(job => job.state === "waiting").length, issues: issues.value.length, title: ticket || (epic ? "Epic" : ""),
        appearance: theme.value.appearance, hasOptions: Boolean(accountButton()),
        back: Boolean(ticket || epic || router.route.value.page === "/runs/:id" || (!selected && path !== "/")),
      });
    });
  }
  window.factoryRail = {
    navigate(path) {
      if ([...tabs, ...more].some(item => item.path === path)) router.navigate(path);
    },
    account() { accountButton()?.click(); },
    back() {
      // A direct detail link has no parent entry. Close to its own page.
      if (router.ticketPanel.value || router.epicPanel.value) {
        const ticket = Boolean(router.ticketPanel.value);
        if (history.state?.[ticket ? "ticketPanel" : "epicPanel"]) history.back();
        else (ticket ? router.closeTicket : router.closeEpic)();
      } else if (router.route.value.page === "/runs/:id") {
        if (router.backFromRun) router.backFromRun();
        else router.navigate("/runs");
      }
      else router.navigate(controls && more.some(item => router.route.value.path.startsWith(item.path)) ? controls.path : "/");
    }
  };
  // Keep the web navigation available if the deployed router cannot be loaded.
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
  addEventListener("resize", refresh);
  const root = document.getElementById("root");
  if (root) new MutationObserver(refresh).observe(root, { childList: true });
  for (const signal of [theme, authenticated, jobs, issues, router.route, router.ticketPanel, router.epicPanel]) signal.subscribe(refresh);
})();
