// Fake gh for upstream tests: answers `release list`, the GraphQL ref comparison and the project's open pull requests from world.json, a synthetic
// commit graph, like GitHub does. Usage: node upstream-gh.cjs DIR ...gh arguments. Any other call fails.
const { readFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'gh-calls'), `${args.join(' ')}\n`);
const world = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
const fail = message => { process.stderr.write(`${message}\n`); process.exit(1); };

if (args[0] === 'release' && args[1] === 'list') {
  const repo = args[args.indexOf('--repo') + 1];
  if (world.broken.includes(repo)) fail('HTTP 404: Not Found');
  const releases = (world.releases[repo] ?? world.releases['*']).filter(r => !(r.pre && args.includes('--exclude-pre-releases')));
  process.stdout.write(JSON.stringify(releases.map(({ tagName, publishedAt }) => ({ tagName, publishedAt }))));
} else if (args[0] === 'api' && args[1] === 'graphql') {
  const vars = {};
  for (let i = 2; i < args.length; i += 2) { if (args[i] !== '-f') fail(`unexpected argument ${args[i]}`); const at = args[i + 1].indexOf('='); vars[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1); }
  const repo = `${vars.owner}/${vars.name}`;
  if (world.broken.includes(repo)) fail(`gh: Could not resolve to a Repository with the name '${repo}'.`);
  // A ref is a tag, by full or short name, or a commit ID; each commit lists its parents.
  const commit = ref => world.tags[ref.replace(/^refs\/tags\//, '')] ?? (ref in world.parents ? ref : undefined);
  const ancestors = id => { const seen = new Set(), stack = [id]; while (stack.length) { const next = stack.pop(); if (!seen.has(next)) { seen.add(next); stack.push(...world.parents[next]); } } return seen; };
  const head = commit(vars.base);
  if (!head) fail(`gh: Could not resolve head ref '${vars.base}'.`);
  const repository = {};
  for (const key of Object.keys(vars).filter(key => /^c\d+$/.test(key))) {
    const base = commit(vars[key]);
    if (!base) { repository[key] = null; continue; }
    // GitHub's status says where the head ref (the watermark) stands relative to this base ref (the release).
    const status = base === head ? 'IDENTICAL' : ancestors(base).has(head) ? 'BEHIND' : ancestors(head).has(base) ? 'AHEAD' : 'DIVERGED';
    repository[key] = { compare: { status, baseTarget: { oid: base }, headTarget: { oid: head } } };
  }
  process.stdout.write(JSON.stringify({ data: { repository } }));
} else if (args[0] === 'pr' && args[1] === 'list' && args[args.indexOf('--repo') + 1] === 'fixture/app') process.stdout.write('[]'); // the project has no open pull requests
else fail(`unexpected gh call: ${args.join(' ')}`);
