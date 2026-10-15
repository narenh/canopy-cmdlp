// openapi.yaml parses, and lists exactly the API's routes: server.js's,
// and the admin page's API in lib/admin.js (under /admin/api). The pages
// themselves (/, /admin, the logo) are HTML, not API, so they're left out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const PAGES = ['GET /', 'GET /admin', 'GET /canopy-logo.png'];

function routes(file, re, prefix = '') {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  return [...src.matchAll(re)].map(([, m, p]) => `${m.toUpperCase()} ${prefix}${p}`);
}

const norm = (r) => r.replace(/:\w+/g, ':x').replace(/\{\w+\}/g, ':x');

test('openapi.yaml matches the routes', () => {
  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8'));
  assert.equal(spec.openapi, '3.1.0');
  const documented = Object.entries(spec.paths)
    .flatMap(([p, ops]) => Object.keys(ops).map((m) => norm(`${m.toUpperCase()} ${p}`)))
    .sort();
  const actual = [
    ...routes('server.js', /app\.(get|post|delete)\('([^']+)'/g),
    ...routes('lib/admin.js', /router\.(get|post|delete)\('([^']+)'/g),
    ...routes('lib/admin.js', /api\.(get|post|delete)\('([^']+)'/g, '/admin/api'),
  ].filter((r) => !PAGES.includes(r)).map(norm).sort();
  assert.deepEqual(documented, actual);
});
