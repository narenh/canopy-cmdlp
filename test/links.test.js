// Which links yt-dlp may take (every extractor but generic and the few
// that take other hosts' links), short links followed here, and the
// guarded fetch they and the artwork checks go through. Tracks
// (lib/tracks.js) with the real YtDlp running the fake (fake-yt-dlp.js),
// and fake fetches and DNS, so nothing leaves the machine. Needs ffmpeg on
// PATH.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { YtDlp, EXTRACTORS } = require('../lib/ytdlp');
const { Tracks, stripTracking } = require('../lib/tracks');
const { followShortLink } = require('../lib/shortlinks');
const { createSafeFetch, isPublicAddress, guardedLookup } = require('../lib/safe-fetch');

const FAKE = path.join(__dirname, 'fake-yt-dlp.js');
const quiet = () => {};

const instances = [];
const dirs = [];

after(() => {
  for (const t of instances) t.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// A fake fetch from a table of redirects: { 'https://...': 'https://...' }
// (a 302 there), or a function of the request. Everything else is a 404.
// `calls` lists what was asked, as "METHOD url".
function fakeFetch(routes = {}) {
  const calls = [];
  const fn = async (url, { method = 'GET' } = {}) => {
    calls.push(`${method} ${url}`);
    const r = typeof routes === 'function' ? routes(url, method) : routes[url] && { status: 302, location: routes[url] };
    if (!r) return { status: 404, headers: new Headers() };
    return { status: r.status, headers: new Headers(r.location ? { location: r.location } : {}) };
  };
  fn.calls = calls;
  return fn;
}

// A Tracks with `fetch`. `lookups` lists the links yt-dlp was asked to
// look up (-J), in order.
async function make(fetchFn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdlp-links-'));
  dirs.push(dataDir);
  const ytdlp = new YtDlp({ dataDir, stable: FAKE, autoUpdate: false, log: quiet });
  await ytdlp.init();
  const lookups = [];
  const exec = ytdlp.exec.bind(ytdlp);
  ytdlp.exec = (args, opts) => {
    if (Array.isArray(args) && args.includes('-J')) lookups.push(args[args.length - 1]);
    return exec(args, opts);
  };
  const tracks = new Tracks({ dataDir, ytdlp, maxAgeMs: 60 * 60 * 1000, log: quiet, fetch: fetchFn });
  await tracks.init();
  instances.push(tracks);
  return { tracks, lookups, ytdlp };
}

async function settle(tracks, id, status) {
  for (let i = 0; i < 200; i++) {
    const t = tracks.get(id);
    if (t && t.status === status) return t;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`track ${id} never became ${status}`);
}

// What tracks.resolve throws, as { status, reason, error }.
async function refusal(promise) {
  try {
    await promise;
  } catch (e) {
    return { status: e.status, reason: e.reason, error: e.message };
  }
  throw new Error('it was not refused');
}

// ---- which extractors ----

const USE_EXTRACTORS = 'default,-generic,-mediasite.*,-globoarticle,-ign\\.com,-ignvideo,-ignarticle,-lemonde,-playtvak,-rts,-webcamerapl,-radio\\.de,-senate\\.gov';

test('yt-dlp gets every extractor but generic and the ones that take other hosts', async () => {
  assert.equal(EXTRACTORS.join(','), USE_EXTRACTORS);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdlp-links-'));
  dirs.push(dataDir);
  const args = new YtDlp({ dataDir, stable: FAKE, autoUpdate: false, log: quiet }).commonArgs();
  assert.equal(args.filter((a) => a === '--use-extractors').length, 1);
  assert.equal(args[args.indexOf('--use-extractors') + 1], USE_EXTRACTORS);
});

// yt-dlp's orderedSet_from_options (utils/_utils.py), as add_default_info_extractors
// calls it: items in order, "default" adds every enabled extractor
// (generic included), "-<regex>" takes the names it full-matches back out.
function ytdlpLoads(value, names) {
  let on = [];
  for (let item of value.split(',')) {
    const drop = item.startsWith('-');
    if (drop) item = item.slice(1);
    const re = new RegExp(`^(?:${item})$`, 'i');
    const hit = item === 'default' || item === 'all' ? names : names.filter((n) => re.test(n));
    on = drop ? on.filter((n) => !hit.includes(n)) : [...new Set([...on, ...hit])];
  }
  return on;
}

test('generic is never enabled', async () => {
  // Only "default" adds; everything after it takes away, so nothing can
  // bring generic back.
  assert.equal(EXTRACTORS[0], 'default');
  assert.ok(EXTRACTORS.slice(1).every((e) => e.startsWith('-')), EXTRACTORS.join(','));
  assert.ok(EXTRACTORS.includes('-generic'));
  const names = ['youtube', 'soundcloud', 'generic', 'Generic', 'mediasite', 'mediasitecatalog', 'ign.com', 'igncom', 'rts', 'rtsx', 'vimeo'];
  const loaded = ytdlpLoads(EXTRACTORS.join(','), names);
  assert.ok(!loaded.some((n) => /^generic$/i.test(n)), loaded.join(','));
  // The patterns are names, not looser: ign\.com isn't "igncom", rts isn't "rtsx".
  assert.deepEqual(loaded, ['youtube', 'soundcloud', 'igncom', 'rtsx', 'vimeo']);

  // The fake yt-dlp would hand an unknown host to generic if it were on...
  const intranet = 'https://intranet.example/feed.mp4';
  const withGeneric = JSON.parse(execFileSync(FAKE, ['--use-extractors', 'default', '-J', '--', intranet]).toString());
  assert.equal(withGeneric.extractor_key, 'Generic');
  // ...and with cmdlp's arguments, no extractor takes it: a 422.
  const { tracks, lookups } = await make(fakeFetch());
  assert.deepEqual(await refusal(tracks.resolve(intranet, 'z')), {
    status: 422, reason: 'unsupported_link', error: "That link isn't from a site yt-dlp can get a track from.",
  });
  assert.deepEqual(lookups, [intranet]);
  for (const u of ['http://127.0.0.1:8080/', 'http://169.254.169.254/latest/meta-data/', 'https://localhost/x']) {
    assert.equal((await refusal(tracks.resolve(u, 'z'))).reason, 'unsupported_link', u);
  }
});

test('a site outside the old five resolves', async () => {
  const { tracks, lookups } = await make(fakeFetch());
  const t = await tracks.resolve('https://vimeo.com/76979871', 'z');
  assert.equal(t.source, 'Vimeo');
  assert.equal(t.status, 'pending');
  assert.deepEqual(lookups, ['https://vimeo.com/76979871']);
  await settle(tracks, t.id, 'ready');
});

test("a site's playlist, multi-video page, or live stream is still turned down", async () => {
  const { tracks } = await make(fakeFetch());
  for (const [u, reason] of [
    ['https://vimeo.com/showcase/1/playlist', 'playlist'],
    ['https://vimeo.com/album/2/multi', 'playlist'],
    ['https://soundcloud.com/a/playlist', 'playlist'],
    ['https://vimeo.com/event/3/live', 'live'],
    ['https://soundcloud.com/a/live', 'live'],
  ]) {
    const r = await refusal(tracks.resolve(u, 'z'));
    assert.equal(r.status, 422, u);
    assert.equal(r.reason, reason, u);
  }
});

test('yt-dlp gets the link as Node writes it, host first', async () => {
  const { tracks, lookups } = await make(fakeFetch());
  // A site's name after ? or # is not its host.
  await refusal(tracks.resolve('https://intranet.example?.soundcloud.com/a/b', 'z'));
  await refusal(tracks.resolve('https://intranet.example#.soundcloud.com/a/b', 'z'));
  assert.deepEqual(lookups, ['https://intranet.example/?.soundcloud.com/a/b', 'https://intranet.example/#.soundcloud.com/a/b']);
  // A user name in a link is turned down before yt-dlp.
  assert.deepEqual(await refusal(tracks.resolve('https://soundcloud.com@intranet.example/a/b', 'z')), {
    status: 400, reason: 'bad_url', error: 'url has a user name in it.',
  });
  assert.equal(lookups.length, 2);
});

// ---- short links ----

const SHORT = 'https://on.soundcloud.com/gI9UFnzvw6v5WlFs7h';
const TRACKED = 'https://soundcloud.com/forss/flickermood?si=4b2d&utm_source=clipboard&utm_medium=text&utm_campaign=social_sharing';

test('a short link is followed to soundcloud.com, without its tracking', async () => {
  const fetchFn = fakeFetch((url, method) => {
    // HEAD isn't answered at the first hop; GET is. Then a relative
    // redirect to another short link, then to the track.
    if (url === SHORT) return method === 'HEAD' ? { status: 405 } : { status: 301, location: '/second' };
    if (url === 'https://on.soundcloud.com/second') return { status: 302, location: TRACKED };
    return null;
  });
  const { tracks, lookups } = await make(fetchFn);
  const t = await tracks.resolve(SHORT, 'z');
  assert.deepEqual(lookups, ['https://soundcloud.com/forss/flickermood']);
  assert.equal(t.url, SHORT);
  assert.equal(t.ytdlpUrl, 'https://soundcloud.com/forss/flickermood');
  assert.deepEqual(t.aliases, [SHORT, 'https://soundcloud.com/forss/flickermood']);
  // soundcloud.com itself was never asked: yt-dlp does that.
  assert.deepEqual(fetchFn.calls.filter((c) => !c.includes('art.invalid')), [
    `HEAD ${SHORT}`, `GET ${SHORT}`, 'HEAD https://on.soundcloud.com/second',
  ]);
  await settle(tracks, t.id, 'ready');

  // Pasted again (with other tracking): instant, nothing asked at all.
  const asked = fetchFn.calls.length;
  for (const u of [SHORT, `${SHORT}?si=other&utm_medium=text`, `${SHORT}/#share`]) {
    assert.equal((await tracks.resolve(u, 'z')).id, t.id, u);
  }
  assert.equal(fetchFn.calls.length, asked);
  assert.equal(lookups.length, 1);
  // So is the link it led to.
  assert.equal((await tracks.resolve(TRACKED, 'z')).id, t.id);
  assert.equal(lookups.length, 1);
});

test('a short link to a track the zone has is learned without yt-dlp', async () => {
  const fetchFn = fakeFetch({ [SHORT]: TRACKED });
  const { tracks, lookups } = await make(fetchFn);
  const t = await tracks.resolve('https://soundcloud.com/forss/flickermood', 'z');
  assert.equal((await tracks.resolve(SHORT, 'z')).id, t.id);
  assert.equal(lookups.length, 1);
  assert.ok(t.aliases.includes(SHORT));
  const asked = fetchFn.calls.length;
  assert.equal((await tracks.resolve(SHORT, 'z')).id, t.id);
  assert.equal(fetchFn.calls.length, asked);
  await settle(tracks, t.id, 'ready');
});

test('a short link that leads anywhere but SoundCloud, or over http, is refused', async () => {
  for (const [to, error] of [
    ['http://soundcloud.com/forss/flickermood', 'That short link redirects to a http link, not https.'],
    ['https://127.0.0.1/', 'That short link leads to 127.0.0.1, not SoundCloud.'],
    ['https://localhost/admin', 'That short link leads to localhost, not SoundCloud.'],
    ['https://169.254.169.254/latest/meta-data/', 'That short link leads to 169.254.169.254, not SoundCloud.'],
    ['https://[::1]/', 'That short link leads to [::1], not SoundCloud.'],
    ['https://intranet.example/', 'That short link leads to intranet.example, not SoundCloud.'],
    ['https://soundcloud.com.intranet.example/a/b', 'That short link leads to soundcloud.com.intranet.example, not SoundCloud.'],
    ['https://user@soundcloud.com/a/b', 'That short link redirects to a link with a user name in it.'],
    ['file:///etc/passwd', 'That short link redirects to a file link, not https.'],
  ]) {
    const fetchFn = fakeFetch({ [SHORT]: to });
    const { tracks, lookups } = await make(fetchFn);
    assert.deepEqual(await refusal(tracks.resolve(SHORT, 'z')), { status: 422, reason: 'unsupported_link', error }, to);
    // Only the short link was asked; where it led never was, nor yt-dlp.
    assert.deepEqual(fetchFn.calls, [`HEAD ${SHORT}`], to);
    assert.deepEqual(lookups, [], to);
  }
});

test('a short link that resolves to an address that is not public is refused before connecting', async () => {
  for (const addresses of [['10.0.0.7'], ['127.0.0.1'], ['169.254.169.254'], ['::1'], ['fd12:3456::1'], ['::ffff:127.0.0.1'], ['93.184.216.34', '192.168.1.1']]) {
    const asked = [];
    // The guarded fetch, with fake DNS: the lookup refuses, so no socket
    // ever connects.
    const fetchFn = createSafeFetch({ resolve: async (host) => { asked.push(host); return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); } });
    const { tracks, lookups } = await make(fetchFn);
    assert.deepEqual(await refusal(tracks.resolve(SHORT, 'z')), {
      status: 422, reason: 'unsupported_link', error: "That short link leads to an address that isn't public.",
    }, addresses.join());
    assert.deepEqual(asked, ['on.soundcloud.com']);
    assert.deepEqual(lookups, []);
  }
});

test('a short link that redirects too many times is refused', async () => {
  // Each short link leads to another, forever.
  const fetchFn = fakeFetch((url) => ({ status: 302, location: `${url}x` }));
  const { tracks, lookups } = await make(fetchFn);
  assert.deepEqual(await refusal(tracks.resolve(SHORT, 'z')), {
    status: 422, reason: 'unsupported_link', error: 'That short link redirects more than 5 times.',
  });
  assert.equal(fetchFn.calls.length, 5);
  assert.deepEqual(lookups, []);
});

test("a short link that doesn't lead anywhere, or can't be asked", async () => {
  const gone = await make(fakeFetch());
  assert.deepEqual(await refusal(gone.tracks.resolve(SHORT, 'z')), {
    status: 422, reason: 'unsupported_link', error: "That short link doesn't lead anywhere (it may have expired).",
  });
  const down = await make(fakeFetch(() => ({ status: 503 })));
  assert.deepEqual(await refusal(down.tracks.resolve(SHORT, 'z')), {
    status: 502, reason: 'lookup_failed', error: "Couldn't follow the short link: on.soundcloud.com answered 503.",
  });
  // Too slow: the 5 seconds are for the whole chain. (AbortSignal.timeout
  // doesn't keep the process alive, so something here must.)
  const never = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const alive = setTimeout(() => {}, 5000);
  await assert.rejects(followShortLink(SHORT, never, { timeoutMs: 100 }), { reason: 'timeout', message: 'Following the short link took too long.' });
  clearTimeout(alive);
});

test('only shortener hosts are followed', async () => {
  const fetchFn = fakeFetch(() => ({ status: 302, location: TRACKED }));
  const { tracks, lookups } = await make(fetchFn);
  // bit.ly isn't on the list: straight to yt-dlp, which has nothing for it.
  assert.equal((await refusal(tracks.resolve('https://bit.ly/3abcDEF', 'z'))).reason, 'unsupported_link');
  assert.deepEqual(lookups, ['https://bit.ly/3abcDEF']);
  // Nor is soundcloud.com: it's yt-dlp's to look up.
  const t = await tracks.resolve('https://soundcloud.com/a/song', 'z');
  assert.equal(t.ytdlpUrl, 'https://soundcloud.com/a/song');
  assert.ok(!fetchFn.calls.some((c) => c.startsWith('HEAD')), fetchFn.calls.join('\n'));
  assert.deepEqual(lookups, ['https://bit.ly/3abcDEF', 'https://soundcloud.com/a/song']);
  await settle(tracks, t.id, 'ready');
});

test('tracking comes off what a short link led to, and nothing else', () => {
  assert.equal(stripTracking(TRACKED), 'https://soundcloud.com/forss/flickermood');
  assert.equal(stripTracking('https://soundcloud.com/a/b/s-SeCrEt?si=1&in=a/sets/x&UTM_Source=y#t=1:00'), 'https://soundcloud.com/a/b/s-SeCrEt?in=a/sets/x');
  assert.equal(stripTracking('https://soundcloud.com/a/b'), 'https://soundcloud.com/a/b');
});

// ---- the guarded fetch ----

test('public addresses, and everything that is not', () => {
  for (const a of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e']) assert.equal(isPublicAddress(a), true, a);
  for (const a of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.8.8.8', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::a00:1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1',
    'localhost', '', 'not an address',
  ]) assert.equal(isPublicAddress(a), false, a);
});

test('the guarded fetch refuses http, addresses, and user names without looking anything up', async () => {
  const asked = [];
  const f = createSafeFetch({ resolve: async (h) => { asked.push(h); return [{ address: '93.184.216.34', family: 4 }]; } });
  for (const [u, code] of [
    ['http://i1.sndcdn.com/a.jpg', 'EUNSAFEURL'],
    ['https://127.0.0.1/a.jpg', 'EUNSAFEURL'],
    ['https://169.254.169.254/latest', 'EUNSAFEURL'],
    ['https://[::1]/a.jpg', 'EUNSAFEURL'],
    ['https://[::ffff:7f00:1]/a.jpg', 'EUNSAFEURL'],
    ['https://user:pw@i1.sndcdn.com/a.jpg', 'EUNSAFEURL'],
    ['ftp://i1.sndcdn.com/a.jpg', 'EUNSAFEURL'],
  ]) await assert.rejects(f(u), { code }, u);
  assert.deepEqual(asked, []);
});

test('the guarded lookup answers with every address, or refuses them all', async () => {
  const lookup = guardedLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
  const one = await new Promise((resolve, reject) => lookup('x.example', {}, (e, a, f) => (e ? reject(e) : resolve([a, f]))));
  assert.deepEqual(one, ['93.184.216.34', 4]);
  const all = await new Promise((resolve, reject) => lookup('x.example', { all: true }, (e, a) => (e ? reject(e) : resolve(a))));
  assert.equal(all.length, 2);
  const v6 = await new Promise((resolve, reject) => lookup('x.example', { family: 6 }, (e, a) => (e ? reject(e) : resolve(a))));
  assert.equal(v6, '2606:2800:220:1::1');
  const mixed = guardedLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  const err = await new Promise((resolve) => mixed('x.example', { all: true }, resolve));
  assert.equal(err.code, 'ENOTPUBLIC');
});

test('artwork on a host that resolves inside the network is never fetched', async () => {
  const { pickArtwork } = require('../lib/tracks');
  const f = createSafeFetch({ resolve: async () => [{ address: '10.0.0.9', family: 4 }] });
  const info = { extractor_key: 'Vimeo', id: '1', thumbnails: [{ url: 'https://i.vimeocdn.example/a.jpg' }] };
  // Not confirmed, so what yt-dlp listed is passed along, but nothing connected.
  assert.equal(await pickArtwork(info, f), 'https://i.vimeocdn.example/a.jpg');
});
