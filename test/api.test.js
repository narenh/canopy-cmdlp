// The API end to end, against a real server and a fake yt-dlp
// (fake-yt-dlp.js). Needs ffmpeg and ffprobe on PATH.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE = path.join(__dirname, 'fake-yt-dlp.js');
const TOKEN = 'test-token-0123456789abcdef';
const auth = { Authorization: `Bearer ${TOKEN}` };

const servers = [];

async function startServer(extraEnv = {}, { setup } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdlp-test-'));
  if (setup) setup(dataDir);
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      CMDLP_TOKEN: TOKEN,
      PORT: String(port),
      DATA_DIR: dataDir,
      YTDLP_STABLE: FAKE,
      YTDLP_AUTO_UPDATE: '0',
      PUBLIC_URL: 'https://cmdlp.example',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const s = { base, dataDir, child, output: () => output };
  servers.push(s);
  return s;
}

function post(s, body, headers = auth) {
  return fetch(`${s.base}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function waitFor(s, id, status) {
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${s.base}/tracks/${id}`, { headers: auth });
    if (r.status === 404 && status === 'gone') return null;
    const t = await r.json();
    if (t.status === status) return t;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`track ${id} never became ${status}`);
}

// The audioUrl, pointed at the test server.
const local = (s, audioUrl) => audioUrl.replace('https://cmdlp.example', s.base);

let s;
before(async () => {
  s = await startServer();
});
after(() => {
  for (const x of servers) {
    x.child.kill('SIGKILL');
    fs.rmSync(x.dataDir, { recursive: true, force: true });
  }
});

test('/health needs no token and says the yt-dlp version', async () => {
  const h = await (await fetch(`${s.base}/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.ytdlp.version, '2026.01.01');
});

test('everything else needs the token', async () => {
  assert.equal((await post(s, { url: 'https://soundcloud.com/a/b', zone: 'z' }, {})).status, 401);
  assert.equal((await post(s, { url: 'https://soundcloud.com/a/b', zone: 'z' }, { Authorization: 'Bearer nope' })).status, 401);
  assert.equal((await fetch(`${s.base}/tracks/aaaaaaaaaaaaaaaaaaaaaa`)).status, 401);
  assert.equal((await fetch(`${s.base}/zones/z`, { method: 'DELETE' })).status, 401);
});

test('bad input is a 400, and links that are not one track a 422', async () => {
  const cases = [
    [{ url: 'https://soundcloud.com/a/b', zone: 'no spaces' }, 400, 'bad_zone'],
    [{ url: 'https://soundcloud.com/a/b' }, 400, 'bad_zone'],
    [{ url: 'file:///etc/passwd', zone: 'z' }, 400, 'bad_url'],
    [{ url: 'not a link', zone: 'z' }, 400, 'bad_url'],
    [{ url: 'https://example.com/unsupported', zone: 'z' }, 422, 'unsupported_link'],
    [{ url: 'https://soundcloud.com/a/playlist', zone: 'z' }, 422, 'playlist'],
    [{ url: 'https://soundcloud.com/a/fail', zone: 'z' }, 502, 'lookup_failed'],
  ];
  for (const [body, status, reason] of cases) {
    const r = await post(s, body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal((await r.json()).reason, reason, JSON.stringify(body));
  }
});

test('a link resolves, downloads, and plays with Range', async () => {
  const r = await post(s, { url: 'https://soundcloud.com/a/song', zone: 'party1' });
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.equal(t.status, 'pending');
  assert.equal(t.title.startsWith('Track '), true);
  assert.equal(t.artist, 'Someone');
  assert.equal(t.artwork, 'https://example.com/a.jpg');
  assert.match(t.audioUrl, /^https:\/\/cmdlp\.example\/audio\/[\w-]{22}\.m4a\?sig=/);

  const ready = await waitFor(s, t.id, 'ready');
  assert.equal(ready.codec, 'aac');
  assert.equal(ready.transcoded, false);

  const full = await fetch(local(s, ready.audioUrl));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mp4');
  const bytes = Buffer.from(await full.arrayBuffer());
  assert.equal(bytes.length, ready.size);
  // The index (moov) comes before the audio (mdat).
  assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'));

  const part = await fetch(local(s, ready.audioUrl), { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${ready.size}`);

  const wrong = local(s, ready.audioUrl).replace(/sig=.*/, 'sig=wrong');
  assert.equal((await fetch(wrong)).status, 401);
  assert.equal((await fetch(wrong, { headers: auth })).status, 200);

  // The same link in the same zone is the same track; in another zone, another.
  assert.equal((await (await post(s, { url: 'https://soundcloud.com/a/song', zone: 'party1' })).json()).id, t.id);
  assert.notEqual((await (await post(s, { url: 'https://soundcloud.com/a/song', zone: 'party2' })).json()).id, t.id);
});

test('audio that is not AAC is re-encoded to AAC', async () => {
  const t = await (await post(s, { url: 'https://soundcloud.com/a/opus', zone: 'party1' })).json();
  const ready = await waitFor(s, t.id, 'ready');
  assert.equal(ready.codec, 'opus');
  assert.equal(ready.transcoded, true);
  const file = path.join(s.dataDir, 'zones', 'party1', `${t.id}.m4a`);
  const codec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).toString().trim();
  assert.equal(codec, 'aac');
});

test('deleting a zone drops its tracks and files', async () => {
  const t = await (await post(s, { url: 'https://soundcloud.com/a/doomed', zone: 'ending' })).json();
  await waitFor(s, t.id, 'ready');
  const other = await (await post(s, { url: 'https://soundcloud.com/a/kept', zone: 'staying' })).json();
  await waitFor(s, other.id, 'ready');

  const r = await fetch(`${s.base}/zones/ending`, { method: 'DELETE', headers: auth });
  assert.deepEqual(await r.json(), { zone: 'ending', deleted: 1 });
  assert.equal((await fetch(`${s.base}/tracks/${t.id}`, { headers: auth })).status, 404);
  assert.equal(fs.existsSync(path.join(s.dataDir, 'zones', 'ending')), false);
  assert.equal((await fetch(`${s.base}/tracks/${other.id}`, { headers: auth })).status, 200);
});

test('when the newest yt-dlp fails, an older one is tried', async () => {
  // A "nightly" on the volume that runs but can't download anything.
  const broken = await startServer({}, {
    setup(dir) {
      fs.mkdirSync(path.join(dir, 'bin'));
      const p = path.join(dir, 'bin', 'yt-dlp');
      fs.writeFileSync(p, '#!/bin/sh\nif [ "$1" = "--ignore-config" ] && [ "$2" = "--version" ]; then echo 2099.01.01; exit 0; fi\necho "ERROR: broken nightly" >&2\nexit 1\n');
      fs.chmodSync(p, 0o755);
    },
  });
  const h = await (await fetch(`${broken.base}/health`)).json();
  assert.equal(h.ytdlp.version, '2099.01.01');
  const t = await (await post(broken, { url: 'https://soundcloud.com/a/song', zone: 'z' })).json();
  assert.equal(t.status, 'pending');
  await waitFor(broken, t.id, 'ready');
  assert.match(broken.output(), /2099\.01\.01 failed, 2026\.01\.01 worked/);
});

test('the sweep deletes tracks older than MAX_AGE_HOURS', async () => {
  // Three seconds old is old enough; the sweep looks every 0.6 seconds.
  const sw = await startServer({ MAX_AGE_HOURS: String(3 / 3600), SWEEP_MINUTES: '0.01' });
  const t = await (await post(sw, { url: 'https://soundcloud.com/a/song', zone: 'z' })).json();
  await waitFor(sw, t.id, 'ready');
  fs.writeFileSync(path.join(sw.dataDir, 'zones', 'z', 'leftover.part'), '');
  await waitFor(sw, t.id, 'gone');
  assert.equal(fs.existsSync(path.join(sw.dataDir, 'zones', 'z')), false);
});
