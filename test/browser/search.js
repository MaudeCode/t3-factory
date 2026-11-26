import { options } from "../../web/vendor/preact.js";
import { clock } from "../../web/lib/store.js";

// Wait for the browser or component to publish the state the next interaction needs.
export async function until(predicate, message = "Fixture did not settle") {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// Moves the clock on by `ms` and returns the names of the components that rendered for it. Preact renders every
// component a signal change marked in one pass, so once anything has rendered, a page or row that read the clock has too.
export async function tickRenders(ms = 1000) {
  const names = new Set(), previous = options.diffed;
  options.diffed = (vnode) => { if (typeof vnode.type === "function") names.add(vnode.type.name); previous?.(vnode); };
  try {
    clock.value += ms;
    for (let n = 0; n < 100 && !names.size; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally { options.diffed = previous; }
  return [...names];
}
// A tick renders `RelativeTime` alone, or beside the page's own time components named in `also`; `where` names the page in the failure.
export async function checkTickRendersTimesOnly(where, also = []) {
  const rendered = await tickRenders();
  if (!rendered.length || rendered.some((name) => name !== "RelativeTime" && !also.includes(name))) throw new Error(`a clock tick on ${where} renders only time components: ${rendered}`);
}
// The tick check, then an hour on the clock must change `read()`, a time's text or tooltip. The clock is set back after.
export async function checkTimesFollowClock(where, read, also) {
  await checkTickRendersTimesOnly(where, also);
  const before = read();
  await tickRenders(60 * 60_000);
  const after = read();
  await tickRenders(Date.now() - clock.value);
  if (after === before) throw new Error(`a time on ${where} follows the clock: ${before}`);
}

// Open the shared list search before driving a page's ordinary filtering checks.
export async function openSearch() {
  const button = document.querySelector('button[aria-label="Search"]');
  if (button.getAttribute('aria-expanded') !== 'true') button.click();
  await new Promise(resolve => setTimeout(resolve, 60));
  const input = document.querySelector('input.search');
  if (!input) throw new Error('Search did not open');
  return input;
}

// The list pages share one head: the title with its tools on the right, and the controls as one strip
// that stays beside the title while it fits and otherwise takes a row of its own, scrolling sideways
// instead of wrapping. Desktop always shares the title row. The phone layout is `@container page (max-width: 900px)`,
// so the check follows the head's page container: inside the app shell the sidebar narrows it below the window.
export async function checkPageHead() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const head = document.querySelector('.page-head'), r = el => el.getBoundingClientRect();
  const title = head?.querySelector('h1'), tools = head?.querySelector('.page-tools'), strip = head?.querySelector('.page-actions');
  const search = head?.querySelector('button[aria-label="Search"]');
  assert(title && search, 'the head has a title and a Search button');
  const buttons = [...head.querySelectorAll('button')].filter(el => el.getClientRects().length);
  // One row is a control plus the segmented group's border, 34px for a mouse and 46px with touch targets, inside the sticky head's own padding.
  const style = getComputedStyle(head), padTop = parseFloat(style.paddingTop), padBottom = parseFloat(style.paddingBottom);
  const t = r(title), h = r(head), oneRow = parseFloat(style.getPropertyValue('--control')) + 2.5 + padTop + padBottom;
  let page = head.parentElement;
  while (page && !getComputedStyle(page).containerName.split(' ').includes('page')) page = page.parentElement;
  assert(page, 'the head sits in a page container');
  const box = getComputedStyle(page), narrow = page.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight) <= 900;
  // A strip beside the title must not squeeze the title block below its own words.
  const block = r(title.parentElement), words = document.createRange();
  words.selectNodeContents(title);
  assert([...words.getClientRects()].every(line => line.left >= block.left - 1 && line.right <= block.right + 1), 'the title reads in full inside its block');
  if (narrow) {
    assert(r(search).top < t.bottom && r(search).bottom > t.top, 'Search shares the title row');
    assert(tools, 'the head has a tools group');
    const visible = el => el.getClientRects().length > 0;
    for (const button of [...tools.querySelectorAll('button')].filter(visible)) assert(r(button).top < t.bottom && r(button).bottom > t.top, 'tools share the title row');
    // A page whose only controls are tools has no strip: the head is the title row alone.
    if (!strip) { assert(h.height <= oneRow, 'a head without a strip is one row'); return done(1); }
    const s = r(strip), toolRow = r(tools);
    assert(toolRow.right >= h.right - parseFloat(style.paddingRight) - 1 || s.top < toolRow.bottom, 'tools sit at the right edge of the title row when the strip is below');
    const tops = [...strip.children].map(el => Math.round(r(el).top));
    assert(tops.every(top => top === tops[0]), 'the controls strip never wraps');
    strip.scrollLeft = strip.scrollWidth;
    assert(r(strip.lastElementChild).right <= s.right + 1, 'scrolling the strip reveals its last control');
    strip.scrollLeft = 0;
    if (strip.scrollWidth > strip.clientWidth + 1 && CSS.supports('animation-timeline: scroll()')) {
      // The scroll timeline settles on the next frame.
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const fade = () => [getComputedStyle(strip).getPropertyValue('--strip-fade-start'), getComputedStyle(strip).getPropertyValue('--strip-fade-end')];
      assert(fade()[0] === '0px' && fade()[1] !== '0px', 'an overflowing strip fades its trailing edge at rest instead of slicing a control');
      strip.scrollLeft = strip.scrollWidth; await frame();
      assert(fade()[0] !== '0px' && fade()[1] === '0px', 'a strip scrolled to its end fades its leading edge only');
      strip.scrollLeft = 0; await frame();
    }
    const wrapped = s.top >= toolRow.bottom - 1;
    assert(wrapped ? Math.abs(h.bottom - padBottom - s.bottom) <= 1 && s.top - h.top <= 56 + padTop : h.height <= oneRow, 'the head is the title row plus at most one strip row');
  } else {
    assert(tools, 'the head has a tools group');
    assert(buttons.every(button => r(button).top >= h.top - 1 && r(button).bottom <= h.bottom + 1) && h.height <= oneRow, 'the title and every control share one row');
  }
  return done(narrow && strip && r(strip).top >= r(tools).bottom - 1 ? 2 : 1);
  function done(rows) {
    assert(document.documentElement.scrollWidth <= innerWidth, 'the head fits the viewport');
    if (matchMedia('(pointer: coarse)').matches) assert(buttons.every(button => r(button).width >= 44 && r(button).height >= 44), 'head controls keep 44px touch targets');
    return { passed: true, viewport: [innerWidth, innerHeight], narrow, height: Math.round(h.height), rows, coarse: matchMedia('(pointer: coarse)').matches };
  }
}
