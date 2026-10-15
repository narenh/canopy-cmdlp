// A link that's already a track in the zone answers at once, without
// yt-dlp: by its YouTube video id, or by a link that led to the track
// before. Tracks (lib/tracks.js) with the real YtDlp running the fake
// (fake-yt-dlp.js), and a stub fetch for the artwork checks and the short
// links, so nothing leaves the machine. Needs ffmpeg on PATH.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { YtDlp } = require('../lib/ytdlp');
const { Tracks, normalizeUrl, youtubeId, trackId } = require('../lib/tracks');

const FAKE = path.join(__dirname, 'fake-yt-dlp.js');
const quiet = () => {};
// No request goes out. on.soundcloud.com/<x> redirects to
// soundcloud.com/a/<x>, with the tracking SoundCloud adds; everything else
// (the artwork checks) is a 404, so the fallbacks win.
const noFetch = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'on.soundcloud.com') {
    const to = `https://soundcloud.com/a${u.pathname}?si=abc&utm_source=clipboard&utm_medium=text&utm_campaign=social_sharing`;
    return { status: 302, headers: new Headers({ location: to }) };
  }
  return { status: 404, headers: new Headers() };
};

const instances = [];
const dirs = [];

// A Tracks on `dataDir` (a new one if not given). `lookups` lists the
// links yt-dlp was asked to look up (-J), in order.
async function make({ dataDir, maxAgeMs = 60 * 60 * 1000 } = {}) {
  if (!dataDir) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdlp-aliases-'));
    dirs.push(dataDir);
  }
  const ytdlp = new YtDlp({ dataDir, stable: FAKE, autoUpdate: false, log: quiet });
  await ytdlp.init();
  const lookups = [];
  const exec = ytdlp.exec.bind(ytdlp);
  ytdlp.exec = (args, opts) => {
    if (Array.isArray(args) && args.includes('-J')) lookups.push(args[args.length - 1]);
    return exec(args, opts);
  };
  const tracks = new Tracks({ dataDir, ytdlp, maxAgeMs, log: quiet, fetch: noFetch });
  await tracks.init();
  instances.push(tracks);
  return { tracks, lookups, dataDir };
}

async function settle(tracks, id, status) {
  for (let i = 0; i < 200; i++) {
    const t = tracks.get(id);
    if (t && t.status === status) return t;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`track ${id} never became ${status}`);
}

// Ready on disk too, with nothing still being written: what a restart reads.
async function saved(tracks, id) {
  const t = await settle(tracks, id, 'ready');
  for (let i = 0; i < 200; i++) {
    let disk = null;
    try {
      disk = JSON.parse(fs.readFileSync(tracks.file(t, '.track.json'), 'utf8'));
    } catch {}
    if (disk && disk.status === 'ready' && !tracks.saving.has(id)) return disk;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`track ${id} never saved as ready`);
}

after(() => {
  for (const t of instances) t.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('links are normalized: no tracking, no fragment, no trailing slash', () => {
  assert.equal(normalizeUrl('https://SoundCloud.com/a/song/?si=1&utm_source=clipboard&utm_medium=text#x'), 'https://soundcloud.com/a/song');
  assert.equal(normalizeUrl('https://www.youtube.com/watch?v=hqyRlTOBvmk&pp=abc&t=42&feature=shared&list=PL1'),
    'https://www.youtube.com/watch?list=PL1&v=hqyRlTOBvmk');
  assert.equal(normalizeUrl('https://example.bandcamp.com/track/x?fbclid=1&gclid=2&igshid=3'), 'https://example.bandcamp.com/track/x');
  assert.equal(normalizeUrl('https://archive.org/'), 'https://archive.org');
});

test('the video id comes from every form of YouTube link', () => {
  const ID = 'hqyRlTOBvmk';
  for (const u of [
    'https://youtu.be/hqyRlTOBvmk?is=cUrf5BsItT4uUciz',
    'https://youtube.com/watch?v=hqyRlTOBvmk',
    'https://www.youtube.com/watch?v=hqyRlTOBvmk&list=PL1&index=2',
    'https://m.youtube.com/watch?v=hqyRlTOBvmk',
    'https://music.youtube.com/watch?v=hqyRlTOBvmk&si=x',
    'https://www.youtube.com/shorts/hqyRlTOBvmk',
    'https://youtube.com/live/hqyRlTOBvmk?feature=share',
    'https://www.youtube.com/embed/hqyRlTOBvmk/',
    'http://WWW.YouTube.com/watch?v=hqyRlTOBvmk',
  ]) assert.equal(youtubeId(u), ID, u);
  for (const u of [
    'https://www.youtube.com/playlist?list=PL1',
    'https://www.youtube.com/watch?v=short',
    'https://youtu.be/hqyRlTOBvmk/extra',
    'https://notyoutube.com/watch?v=hqyRlTOBvmk',
    'https://soundcloud.com/a/hqyRlTOBvmk',
  ]) assert.equal(youtubeId(u), null, u);
});

test('the same link, or its share variants, skips yt-dlp', async () => {
  const { tracks, lookups } = await make();
  const t = await tracks.resolve('https://soundcloud.com/a/song?si=aaa&utm_source=clipboard', 'z');
  assert.equal(lookups.length, 1);
  assert.deepEqual(t.aliases, ['https://soundcloud.com/a/song']);
  for (const u of [
    'https://soundcloud.com/a/song?si=aaa&utm_source=clipboard',
    'https://soundcloud.com/a/song?si=bbb',
    'https://soundcloud.com/a/song?is=ccc',
    'https://SOUNDCLOUD.com/a/song/#comments',
  ]) assert.equal((await tracks.resolve(u, 'z')).id, t.id, u);
  assert.equal(lookups.length, 1);
  await settle(tracks, t.id, 'ready');
  // Ready, it's still the same.
  assert.equal((await tracks.resolve('https://soundcloud.com/a/song?si=ddd', 'z')).status, 'ready');
  assert.equal(lookups.length, 1);
});

test('any form of a YouTube video already resolved skips yt-dlp', async () => {
  const { tracks, lookups } = await make();
  const t = await tracks.resolve('https://youtu.be/hqyRlTOBvmk?is=cUrf5BsItT4uUciz', 'z');
  assert.equal(lookups.length, 1);
  assert.equal(t.source, 'Youtube');
  // The id yt-dlp's answer made is the one worked out from the link alone.
  assert.equal(t.id, trackId('z', { extractor_key: 'Youtube', id: 'hqyRlTOBvmk' }));
  for (const u of [
    'https://youtu.be/hqyRlTOBvmk?is=cUrf5BsItT4uUciz',
    'https://youtu.be/hqyRlTOBvmk?si=somethingElse',
    'https://www.youtube.com/watch?v=hqyRlTOBvmk&pp=x',
    'https://music.youtube.com/watch?v=hqyRlTOBvmk',
    'https://m.youtube.com/shorts/hqyRlTOBvmk',
    'https://youtube.com/live/hqyRlTOBvmk?feature=share',
    'https://www.youtube.com/embed/hqyRlTOBvmk',
    'https://www.youtube.com/watch?v=hqyRlTOBvmk&list=PL1&index=2',
  ]) assert.equal((await tracks.resolve(u, 'z')).id, t.id, u);
  assert.equal(lookups.length, 1);
  await settle(tracks, t.id, 'ready');
});

test('a new link to a known track is learned, and skips yt-dlp after', async () => {
  const { tracks, lookups } = await make();
  const t = await tracks.resolve('https://soundcloud.com/a/aliased', 'z');
  // Another form of the same track: yt-dlp is asked once, and it's the
  // same track.
  const again = await tracks.resolve('https://m.soundcloud.com/a/aliased', 'z');
  assert.equal(again.id, t.id);
  assert.equal(lookups.length, 2);
  // A short link to it: followed, and it's known without yt-dlp.
  assert.equal((await tracks.resolve('https://on.soundcloud.com/aliased?si=1', 'z')).id, t.id);
  assert.equal(lookups.length, 2);
  assert.deepEqual(t.aliases, ['https://soundcloud.com/a/aliased', 'https://m.soundcloud.com/a/aliased', 'https://on.soundcloud.com/aliased']);
  assert.equal((await tracks.resolve('https://on.soundcloud.com/aliased?si=2&utm_medium=text', 'z')).id, t.id);
  assert.equal((await tracks.resolve('https://m.soundcloud.com/a/aliased?si=3', 'z')).id, t.id);
  assert.equal(lookups.length, 2);
  // Saved with the track.
  assert.deepEqual((await saved(tracks, t.id)).aliases, t.aliases);
});

test('a failed track is tried again, with yt-dlp', async () => {
  const { tracks, lookups } = await make();
  const t = await tracks.resolve('https://soundcloud.com/a/dlfail', 'z');
  await settle(tracks, t.id, 'failed');
  const retry = await tracks.resolve('https://soundcloud.com/a/dlfail?si=x', 'z');
  assert.equal(lookups.length, 2);
  assert.equal(retry.id, t.id);
  assert.equal(retry.status, 'pending');
  await settle(tracks, t.id, 'failed');

  // A YouTube one too: its id doesn't bring back a failed track.
  const y = await tracks.resolve('https://youtu.be/hqyRlTOBvmk', 'z');
  await settle(tracks, y.id, 'ready');
  y.status = 'failed';
  const y2 = await tracks.resolve('https://www.youtube.com/watch?v=hqyRlTOBvmk', 'z');
  assert.equal(lookups.length, 4);
  assert.equal(y2.id, y.id);
  assert.notEqual(y2, y);
  await settle(tracks, y.id, 'ready');
});

test('zones do not share', async () => {
  const { tracks, lookups } = await make();
  const a = await tracks.resolve('https://youtu.be/hqyRlTOBvmk', 'one');
  const b = await tracks.resolve('https://youtu.be/hqyRlTOBvmk', 'two');
  assert.equal(lookups.length, 2);
  assert.notEqual(a.id, b.id);
  const c = await tracks.resolve('https://soundcloud.com/a/shared', 'one');
  const d = await tracks.resolve('https://soundcloud.com/a/shared', 'two');
  assert.equal(lookups.length, 4);
  assert.notEqual(c.id, d.id);
  for (const t of [a, b, c, d]) await settle(tracks, t.id, 'ready');
});

test('aliases survive a restart', async () => {
  const first = await make();
  const t = await first.tracks.resolve('https://soundcloud.com/a/kept', 'z');
  await first.tracks.resolve('https://on.soundcloud.com/kept', 'z');
  const y = await first.tracks.resolve('https://youtu.be/hqyRlTOBvmk', 'z');
  await saved(first.tracks, t.id);
  await saved(first.tracks, y.id);
  first.tracks.stop();

  const second = await make({ dataDir: first.dataDir });
  assert.equal((await second.tracks.resolve('https://on.soundcloud.com/kept?si=3', 'z')).id, t.id);
  assert.equal((await second.tracks.resolve('https://soundcloud.com/a/kept/', 'z')).id, t.id);
  assert.equal((await second.tracks.resolve('https://music.youtube.com/watch?v=hqyRlTOBvmk', 'z')).id, y.id);
  assert.equal(second.lookups.length, 0);
  assert.equal(second.tracks.get(t.id).status, 'ready');
});

test('a track saved before aliases existed is found by its link', async () => {
  const first = await make();
  const t = await first.tracks.resolve('https://soundcloud.com/a/old', 'z');
  await saved(first.tracks, t.id);
  first.tracks.stop();
  const p = first.tracks.file(t, '.track.json');
  const old = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete old.aliases;
  fs.writeFileSync(p, JSON.stringify(old));

  const second = await make({ dataDir: first.dataDir });
  assert.equal((await second.tracks.resolve('https://soundcloud.com/a/old?si=1', 'z')).id, t.id);
  assert.equal(second.lookups.length, 0);
});

test('deleting the zone forgets its aliases', async () => {
  const { tracks, lookups } = await make();
  const t = await tracks.resolve('https://on.soundcloud.com/gone', 'z');
  await tracks.resolve('https://soundcloud.com/a/kept', 'other');
  await settle(tracks, t.id, 'ready');
  await tracks.deleteZone('z');
  assert.equal([...tracks.aliases.keys()].filter((k) => k.startsWith('z\n')).length, 0);
  assert.equal([...tracks.aliases.keys()].filter((k) => k.startsWith('other\n')).length, 1);
  const again = await tracks.resolve('https://on.soundcloud.com/gone', 'z');
  assert.equal(lookups.length, 3);
  assert.equal(again.status, 'pending');
  await settle(tracks, again.id, 'ready');
});

test('the sweep forgets the aliases of what it deletes', async () => {
  const { tracks, lookups } = await make();
  const t = await tracks.resolve('https://on.soundcloud.com/old', 'z');
  const y = await tracks.resolve('https://youtu.be/hqyRlTOBvmk', 'z');
  await settle(tracks, t.id, 'ready');
  await settle(tracks, y.id, 'ready');
  t.createdAt = y.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  assert.equal(await tracks.sweep(), 2);
  assert.equal(tracks.aliases.size, 0);
  await tracks.resolve('https://on.soundcloud.com/old', 'z');
  await tracks.resolve('https://youtu.be/hqyRlTOBvmk', 'z');
  assert.equal(lookups.length, 4);
  await settle(tracks, t.id, 'ready');
  await settle(tracks, y.id, 'ready');
});
