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
// instead of wrapping. Desktop always shares the title row.
export async function checkPageHead() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const head = document.querySelector('.page-head'), r = el => el.getBoundingClientRect();
  const title = head?.querySelector('h1'), tools = head?.querySelector('.page-tools'), strip = head?.querySelector('.page-actions');
  const search = head?.querySelector('button[aria-label="Search"]');
  assert(title && search, 'the head has a title and a Search button');
  const buttons = [...head.querySelectorAll('button')].filter(el => el.getClientRects().length);
  const t = r(title), h = r(head);
  if (innerWidth <= 900) {
    assert(r(search).top < t.bottom && r(search).bottom > t.top, 'Search shares the title row');
    assert(tools && strip, 'the head has a tools group and an actions strip');
    const s = r(strip), toolRow = r(tools);
    for (const button of tools.querySelectorAll('button')) assert(r(button).top < t.bottom && r(button).bottom > t.top, 'tools share the title row');
    assert(toolRow.right >= h.right - 1 || s.top < toolRow.bottom, 'tools sit at the right edge of the title row when the strip is below');
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
    assert(wrapped ? Math.abs(h.bottom - s.bottom) <= 1 && s.top - h.top <= 56 : h.height <= 44.5, 'the head is the title row plus at most one strip row');
  } else {
    assert(tools && strip, 'the head has a tools group and an actions strip');
    assert(buttons.every(button => r(button).top >= h.top - 1 && r(button).bottom <= h.bottom + 1) && h.height <= 44.5, 'the title and every control share one row');
  }
  assert(document.documentElement.scrollWidth <= innerWidth, 'the head fits the viewport');
  if (matchMedia('(pointer: coarse)').matches) assert(buttons.every(button => r(button).width >= 44 && r(button).height >= 44), 'head controls keep 44px touch targets');
  return { passed: true, viewport: [innerWidth, innerHeight], height: Math.round(h.height), rows: innerWidth <= 900 && r(strip).top >= r(tools).bottom - 1 ? 2 : 1, coarse: matchMedia('(pointer: coarse)').matches };
}
