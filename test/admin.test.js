// The homepage, the admin gate, and API tokens, against a fake Canopy
// Accounts that knows a few visitors by their canopy_session cookie.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, stopServers, TOKEN } = require('./helpers');

const KEY = 'cnp_test_site_key';
const ADMIN_EMAIL = 'Admin@Example.com';

const cookie = (c) => `canopy_session=${c.repeat(43)}`;
const base = { id: 'p', firstName: 'Ana', lastName: 'Lima', shortName: 'Ana L', photoUrl: null, findable: false };
const SESSIONS = {
  [cookie('A').split('=')[1]]: { person: { ...base, email: 'admin@example.com', emailVerified: true } },
  [cookie('B').split('=')[1]]: { person: { ...base, email: 'someone@example.com', emailVerified: true } },
  [cookie('C').split('=')[1]]: { person: { ...base, email: 'admin@example.com', emailVerified: false } },
  [cookie('D').split('=')[1]]: { person: { ...base, emailVerified: true } }, // no email grant
  [cookie('E').split('=')[1]]: { person: null, unverified: true },
};

let accounts;
let accountsUrl;
let s;

before(async () => {
  accounts = http.createServer((req, res) => {
    if (req.url !== '/api/session' || req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(SESSIONS[req.headers['x-canopy-session']] || { person: null }));
  });
  await new Promise((r) => accounts.listen(0, '127.0.0.1', r));
  accountsUrl = `http://127.0.0.1:${accounts.address().port}`;
  s = await startServer({ CANOPY_ACCOUNT_URL: accountsUrl, CANOPY_ACCOUNT_KEY: KEY, ADMIN_EMAIL });
});

after(() => {
  stopServers();
  accounts.close();
});

const page = (srv, c) => fetch(`${srv.base}/admin`, { headers: c ? { cookie: cookie(c) } : {}, redirect: 'manual' });

function api(method, p, { c = 'A', origin = s.base, body } = {}) {
  const headers = { cookie: cookie(c) };
  if (origin) headers.origin = origin;
  if (body) headers['content-type'] = 'application/json';
  return fetch(`${s.base}/admin/api${p}`, { method, headers, body: body && JSON.stringify(body) });
}

const tryToken = (t) => fetch(`${s.base}/tracks/${'x'.repeat(22)}`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.status);

test('the homepage explains it and links to the admin page', async () => {
  const r = await fetch(`${s.base}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Canopy Music party/);
  assert.match(html, /YouTube, SoundCloud, Bandcamp, Mixcloud, or archive\.org/);
  assert.match(html, /<a class="gear" href="\/admin"/);
  assert.equal((await fetch(`${s.base}/canopy-logo.png`)).headers.get('content-type'), 'image/png');
});

test('signed out, /admin sends you to sign in and back', async () => {
  const r = await page(s);
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('location'));
  assert.equal(to.origin, accountsUrl);
  assert.equal(to.searchParams.get('return'), `${s.base}/admin`);
});

test('only the admin, with a confirmed email, gets in', async () => {
  const admin = await page(s, 'A');
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /API tokens/);

  const cases = [
    ['B', /isn&#39;t theirs/], // someone else
    ['C', /isn&#39;t theirs/], // the admin's email, not confirmed
    ['D', /email field granted/], // the site has no email grant
    ['E', /isn&#39;t confirmed yet/], // a quick account
  ];
  for (const [c, text] of cases) {
    const r = await page(s, c);
    assert.equal(r.status, 403, c);
    assert.match(await r.text(), text, c);
  }
});

test('without ADMIN_EMAIL, nobody gets in', async () => {
  const none = await startServer({ CANOPY_ACCOUNT_URL: accountsUrl, CANOPY_ACCOUNT_KEY: KEY, ADMIN_EMAIL: '' });
  const r = await page(none, 'A');
  assert.equal(r.status, 403);
  assert.match(await r.text(), /ADMIN_EMAIL isn&#39;t set/);
});

test('without the account settings, the admin page says so', async () => {
  const none = await startServer({ CANOPY_ACCOUNT_URL: '', CANOPY_ACCOUNT_KEY: '', ADMIN_EMAIL });
  const r = await page(none, 'A');
  assert.equal(r.status, 503);
  assert.match(await r.text(), /CANOPY_ACCOUNT_URL and CANOPY_ACCOUNT_KEY/);
});

test('the token API needs the admin, and a Canopy Origin for changes', async () => {
  assert.equal((await api('GET', '/tokens', { c: 'B' })).status, 403);
  assert.equal((await api('GET', '/tokens', { c: 'Z' })).status, 401);
  const noOrigin = await api('POST', '/tokens', { origin: null, body: { label: 'x' } });
  assert.equal(noOrigin.status, 403);
  assert.equal((await noOrigin.json()).reason, 'bad_origin');
  assert.equal((await api('POST', '/tokens', { origin: 'https://evil.example', body: { label: 'x' } })).status, 403);
  assert.equal((await api('POST', '/tokens', { body: { label: '  ' } })).status, 400);
});

test('make, regenerate, and revoke a token', async () => {
  const made = await api('POST', '/tokens', { body: { label: 'Living Room iPad' } });
  assert.equal(made.status, 201);
  const { token, record } = await made.json();
  assert.match(token, /^cmdlp_[A-Za-z0-9_-]{43}$/);
  assert.equal(record.label, 'Living Room iPad');
  assert.equal(record.hint, token.slice(-4));
  assert.equal(record.hash, undefined);
  assert.equal(await tryToken(token), 404); // let in; no such track

  // Only its hash is kept.
  const file = fs.readFileSync(path.join(s.dataDir, 'tokens.json'), 'utf8');
  assert.equal(file.includes(token), false);

  const list = await (await api('GET', '/tokens')).json();
  assert.deepEqual(list.tokens.map((t) => t.label).sort(), ['Living Room iPad', 'Test hub']);

  const regen = await (await api('POST', `/tokens/${record.id}/regenerate`)).json();
  assert.notEqual(regen.token, token);
  assert.equal(regen.record.label, 'Living Room iPad');
  assert.equal(await tryToken(token), 401);
  assert.equal(await tryToken(regen.token), 404);

  assert.equal((await api('DELETE', `/tokens/${record.id}`)).status, 204);
  assert.equal(await tryToken(regen.token), 401);
  assert.equal((await api('DELETE', `/tokens/${record.id}`)).status, 404);

  // The others are untouched.
  assert.equal(await tryToken(TOKEN), 404);
});

test('test a link: no API token, the admin-test zone, and clearing it', async () => {
  assert.equal((await api('POST', '/test', { origin: null, body: { url: 'https://soundcloud.com/a/song' } })).status, 403);
  assert.equal((await api('POST', '/test', { c: 'B', body: { url: 'https://soundcloud.com/a/song' } })).status, 403);

  const bad = await api('POST', '/test', { body: { url: 'https://example.com/unsupported' } });
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).error, /not from YouTube, SoundCloud/);

  const t = await (await api('POST', '/test', { body: { url: 'https://soundcloud.com/a/song' } })).json();
  assert.equal(t.zone, 'admin-test');
  assert.equal(t.service, 'SoundCloud');
  let now = t;
  for (let i = 0; i < 100 && now.status === 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    now = await (await api('GET', `/test/${t.id}`)).json();
  }
  assert.equal(now.status, 'ready');
  const audio = await fetch(now.audioUrl.replace('https://cmdlp.example', s.base), { headers: { Range: 'bytes=0-9' } });
  assert.equal(audio.status, 206);

  // A hub's track isn't the admin's to see here.
  const hub = await (await fetch(`${s.base}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ url: 'https://soundcloud.com/a/song', zone: 'party' }),
  })).json();
  assert.equal((await api('GET', `/test/${hub.id}`)).status, 404);

  assert.deepEqual(await (await api('DELETE', '/test')).json(), { deleted: 1 });
  assert.equal((await api('GET', `/test/${t.id}`)).status, 404);
  assert.equal(fs.existsSync(path.join(s.dataDir, 'zones', 'admin-test')), false);
});
