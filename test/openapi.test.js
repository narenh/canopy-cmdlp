// openapi.yaml parses, and lists exactly the endpoints server.js has.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

test('openapi.yaml matches the routes in server.js', () => {
  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8'));
  assert.equal(spec.openapi, '3.1.0');
  const documented = Object.entries(spec.paths)
    .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ':x')}`))
    .sort();
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routes = [...src.matchAll(/app\.(get|post|delete)\('([^']+)'/g)]
    .map(([, m, p]) => `${m.toUpperCase()} ${p.replace(/:\w+/g, ':x')}`)
    .sort();
  assert.deepEqual(documented, routes);
});
