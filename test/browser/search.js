// Open the shared list search before driving a page's ordinary filtering checks.
export async function openSearch() {
  const button = document.querySelector('button[aria-label="Search"]');
  if (button.getAttribute('aria-expanded') !== 'true') button.click();
  await new Promise(resolve => setTimeout(resolve, 60));
  const input = document.querySelector('input.search');
  if (!input) throw new Error('Search did not open');
  return input;
}
