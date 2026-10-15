// The API end to end, against a real server and a fake yt-dlp
// (fake-yt-dlp.js). Needs ffmpeg and ffprobe on PATH.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, stopServers, auth } = require('./helpers');

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
after(stopServers);

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
    [{ url: 'https://soundcloud.com@example.com/a/b', zone: 'z' }, 400, 'bad_url'],
    [{ url: 'https://example.com/unsupported', zone: 'z' }, 422, 'unsupported_link'],
    // Only generic would take these, and it's never on.
    [{ url: 'https://intranet.example/feed.mp4', zone: 'z' }, 422, 'unsupported_link'],
    [{ url: 'http://169.254.169.254/latest/meta-data/', zone: 'z' }, 422, 'unsupported_link'],
    [{ url: 'https://soundcloud.com/a/playlist', zone: 'z' }, 422, 'playlist'],
    [{ url: 'https://vimeo.com/showcase/1/playlist', zone: 'z' }, 422, 'playlist'],
    [{ url: 'https://vimeo.com/album/1/multi', zone: 'z' }, 422, 'playlist'],
    [{ url: 'https://soundcloud.com/a/live', zone: 'z' }, 422, 'live'],
    [{ url: 'https://vimeo.com/event/1/live', zone: 'z' }, 422, 'live'],
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
  // The fake's artwork (on .invalid) never loads, so a SoundCloud track
  // gets the SoundCloud logo, served here with no token.
  assert.equal(t.artwork, 'https://cmdlp.example/artwork/soundcloud.jpg');
  const art = await fetch(`${s.base}/artwork/soundcloud.jpg`);
  assert.equal(art.status, 200);
  assert.equal(art.headers.get('content-type'), 'image/jpeg');
  // Its SVG source is in the same folder, but isn't served.
  assert.equal((await fetch(`${s.base}/artwork/soundcloud.svg`)).status, 404);
  assert.match(t.audioUrl, /^https:\/\/cmdlp\.example\/audio\/[\w-]{22}\.m4a\?sig=/);

  const ready = await waitFor(s, t.id, 'ready');
  assert.equal(ready.codec, 'aac');
  assert.equal(ready.transcoded, false);
  // Measured, and already near the target (fake-yt-dlp.js makes it so).
  assert.equal(ready.loudness.target, -16);
  assert.equal(ready.loudness.adjusted, false);

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

test('a site beyond the first five resolves and downloads', async () => {
  const r = await post(s, { url: 'https://vimeo.com/76979871', zone: 'party1' });
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.equal(t.source, 'Vimeo');
  assert.equal(t.service, 'Vimeo');
  const ready = await waitFor(s, t.id, 'ready');
  assert.equal(ready.codec, 'aac');
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

test('progress: a percentage from the size, or the pieces, or none at all', () => {
  const { parseProgress } = require('../lib/tracks');
  assert.equal(parseProgress('[download] 5%'), null);
  assert.deepEqual(parseProgress('[cmdlp] downloading 1500 6000 NA 2000.5 2 NA NA'), {
    downloadedBytes: 1500, totalBytes: 6000, totalBytesEstimate: null, speed: 2000.5, eta: 2, percent: 25,
  });
  // HLS: no exact total, so the pieces say how far, not the estimate.
  assert.equal(parseProgress('[cmdlp] downloading 761 NA 16742.0 0 NA 11 22').percent, 50);
  assert.equal(parseProgress('[cmdlp] downloading 1785 NA 99999 0 NA NA NA').percent, null);
  assert.equal(parseProgress('[cmdlp] finished 6000 6000 NA NA NA NA NA').percent, 100);
});

test('a downloading track says how far along it is', async () => {
  const t = await (await post(s, { url: 'https://soundcloud.com/a/slow', zone: 'progress' })).json();
  assert.equal(t.status, 'pending');
  assert.ok(['queued', 'downloading'].includes(t.stage));
  let seen = null;
  for (let i = 0; i < 60 && !seen; i++) {
    const now = await (await fetch(`${s.base}/tracks/${t.id}`, { headers: auth })).json();
    if (now.stage === 'downloading' && now.progress && now.progress.percent > 0 && now.progress.percent < 100) seen = now;
    else await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(seen, 'never saw a partial percentage');
  // One figure for the whole: the download is its first 20%.
  assert.ok(seen.progress.percent <= 20, `${seen.progress.percent}`);
  assert.equal(seen.progress.totalBytes, 6000);
  assert.equal(seen.service, 'SoundCloud');
  const ready = await waitFor(s, t.id, 'ready');
  assert.equal(ready.progress, undefined);
  assert.equal(ready.stage, undefined);
});

test('one percentage across downloading and converting, never going back', async () => {
  const t = await (await post(s, { url: 'https://soundcloud.com/b/slow', zone: 'progress' })).json();
  const percents = [];
  for (let i = 0; i < 100; i++) {
    const now = await (await fetch(`${s.base}/tracks/${t.id}`, { headers: auth })).json();
    if (now.status === 'ready') break;
    if (now.progress && now.progress.percent != null) percents.push(now.progress.percent);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(percents.length > 0);
  assert.ok(percents.every((p, i) => p >= 0 && p <= 100 && (i === 0 || p >= percents[i - 1])), JSON.stringify(percents));
});

test('a stream with no total shows bytes but no percentage', async () => {
  const t = await (await post(s, { url: 'https://soundcloud.com/a/hls', zone: 'progress' })).json();
  let seen = null;
  for (let i = 0; i < 40 && !seen; i++) {
    const now = await (await fetch(`${s.base}/tracks/${t.id}`, { headers: auth })).json();
    if (now.progress && now.progress.downloadedBytes === 1785) seen = now;
    else await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(seen, 'never saw the second progress line');
  assert.equal(seen.progress.percent, null);
  assert.equal(seen.progress.totalBytes, null);
  await waitFor(s, t.id, 'ready');
});

test('artwork: the best thumbnail that really exists', async () => {
  const { pickArtwork, artworkCandidates } = require('../lib/tracks');
  const yt = (id, names) => ({
    extractor_key: 'Youtube',
    id,
    // yt-dlp's order: worst first.
    thumbnails: names.map((n) => ({ url: `https://i.ytimg.com/vi/${id}/${n}` })),
  });
  const LIST = ['default.jpg', 'mqdefault.jpg', 'hqdefault.jpg', 'hqdefault.jpg?sqp=abc', 'sddefault.jpg', 'hq720.jpg', 'maxresdefault.jpg', 'maxresdefault.webp'];
  // A fake fetch: these exist, as JPEGs; everything else is a 404.
  const stub = (existing, seen = []) => async (url) => {
    seen.push(url);
    const ok = existing.some((e) => url.endsWith(e));
    return { status: ok ? 206 : 404, headers: new Headers({ 'content-type': 'image/jpeg' }) };
  };

  // Best first, down to hqdefault (the floor), no WebP, no resized copies.
  assert.deepEqual(artworkCandidates(yt('old', LIST)).map((u) => u.split('/').pop()),
    ['maxresdefault.jpg', 'hq720.jpg', 'sddefault.jpg', 'hqdefault.jpg']);

  // An old upload with nothing above hqdefault (VoAfb3f04mo).
  assert.equal(await pickArtwork(yt('old', LIST), stub(['hqdefault.jpg'])), 'https://i.ytimg.com/vi/old/hqdefault.jpg');
  // A new one has them all, and gets the biggest.
  assert.equal(await pickArtwork(yt('new', LIST), stub(LIST)), 'https://i.ytimg.com/vi/new/maxresdefault.jpg');
  // Something that answers 200 but isn't an image doesn't count.
  const html = async (url) => ({ status: 200, headers: new Headers({ 'content-type': url.includes('maxres') ? 'text/html' : 'image/jpeg' }) });
  assert.equal(await pickArtwork(yt('x', LIST), html), 'https://i.ytimg.com/vi/x/hq720.jpg');
  // Nothing answers (YouTube unreachable): hqdefault, which always exists.
  const down = async () => { throw new Error('offline'); };
  assert.equal(await pickArtwork(yt('x', LIST), down), 'https://i.ytimg.com/vi/x/hqdefault.jpg');

  // SoundCloud: its logo when nothing loads, when there's nothing listed,
  // or when all there is is the grey default avatar.
  const sc = { extractor_key: 'Soundcloud', id: '1', thumbnails: [{ url: 'https://i1.sndcdn.com/a-t500x500.jpg' }, { url: 'https://i1.sndcdn.com/a-original.jpg' }] };
  assert.equal(await pickArtwork(sc, stub(['t500x500.jpg'])), 'https://i1.sndcdn.com/a-t500x500.jpg');
  assert.equal(await pickArtwork(sc, down), '/artwork/soundcloud.jpg');
  assert.equal(await pickArtwork({ extractor_key: 'Soundcloud', id: '2', thumbnails: [] }, down), '/artwork/soundcloud.jpg');
  const noAvatar = { extractor_key: 'Soundcloud', id: '3', thumbnails: [{ url: 'https://a1.sndcdn.com/images/default_avatar_large.png' }] };
  assert.equal(await pickArtwork(noAvatar, stub(['default_avatar_large.png'])), '/artwork/soundcloud.jpg');

  // Elsewhere, with nothing confirmed, what yt-dlp listed as best; no
  // fallback of our own.
  const mix = { extractor_key: 'Mixcloud', id: '1', thumbnails: [{ url: 'https://thumbnailer.mixcloud.com/a.jpg' }] };
  assert.equal(await pickArtwork(mix, down), 'https://thumbnailer.mixcloud.com/a.jpg');
  assert.equal(await pickArtwork({ extractor_key: 'Bandcamp', id: '1', thumbnails: [] }, down), null);

  // Never fetched: plain http, or an address instead of a name.
  const seen = [];
  const odd = { extractor_key: 'Bandcamp', id: '1', thumbnails: [{ url: 'http://f4.bcbits.com/a.jpg' }, { url: 'https://169.254.169.254/a.jpg' }] };
  await pickArtwork(odd, stub(['a.jpg'], seen));
  assert.deepEqual(seen, []);
});
