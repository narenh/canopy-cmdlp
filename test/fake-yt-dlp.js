#!/usr/bin/env node
// Stands in for yt-dlp in the tests. The link says what to do:
//   .../unsupported  "Unsupported URL", as for a site not allowed
//   .../playlist     a playlist
//   .../multi        a multi_video (several videos on one page)
//   .../live         a live stream
//   .../fail         an error
//   .../opus         Opus audio, which has to be re-encoded
//   .../dlfail       looks up fine, but the download fails
//   anything else    a two-second AAC track
// Downloads are made with ffmpeg, so they're real audio files.
//
// The host says which extractor takes the link (SITES below), and
// --use-extractors is honored as yt-dlp does: "default" is every one of
// them, generic included, and "-<regex>" takes names back out. A host no
// site has goes to generic if it's still in, as with the real yt-dlp, or
// else is "No suitable extractor found". So on.soundcloud.com (a short
// link, which only generic would follow) and any other host are
// unsupported unless generic is on.
//
// The query and fragment don't change which track a link is. A YouTube
// link (youtu.be/<id>, watch?v=<id>, /shorts/<id>...) is the video <id>,
// from the Youtube extractor, as with the real yt-dlp. Its artwork check
// would ask i.ytimg.com, so use YouTube links only with a stub fetch (as
// test/aliases.test.js does), never through the test server.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

if (args.includes('--version')) {
  console.log(process.env.FAKE_YTDLP_VERSION || '2026.01.01');
  process.exit(0);
}
if (args.includes('--update-to')) process.exit(0);

let url = args[args.indexOf('--') + 1];
const infoFile = opt('--load-info-json');
if (infoFile) url = JSON.parse(fs.readFileSync(infoFile, 'utf8')).webpage_url;

const youtube = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/))([A-Za-z0-9_-]{11})/.exec(url);
const page = youtube
  ? `https://www.youtube.com/watch?v=${youtube[1]}`
  : url.split(/[?#]/)[0].replace(/:\/\/(?:m|www)\.soundcloud\.com\//, '://soundcloud.com/');

if (page.endsWith('/unsupported')) {
  console.error(`ERROR: Unsupported URL: ${url}`);
  process.exit(1);
}

// [host pattern, extractor name (what --use-extractors matches), its key]
const SITES = [
  [/^(?:www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/, 'youtube', 'Youtube'],
  [/^(?:www\.|m\.)?soundcloud\.com$/, 'soundcloud', 'Soundcloud'],
  [/\.bandcamp\.com$/, 'bandcamp', 'Bandcamp'],
  [/^(?:www\.)?mixcloud\.com$/, 'mixcloud', 'Mixcloud'],
  [/^archive\.org$/, 'archive.org', 'ArchiveOrg'],
  [/^(?:www\.)?vimeo\.com$/, 'vimeo', 'Vimeo'],
];
const NAMES = [...SITES.map((s) => s[1]), 'mediasite', 'generic'];

// yt-dlp's orderedSet_from_options, for these names.
function enabled() {
  const i = args.indexOf('--use-extractors');
  const items = i === -1 ? ['default'] : args[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
  let on = [];
  for (let item of items) {
    const drop = item.startsWith('-');
    if (drop) item = item.slice(1);
    const re = new RegExp(`^(?:${item})$`, 'i');
    const names = item === 'default' || item === 'all' ? NAMES : NAMES.filter((n) => re.test(n));
    on = drop ? on.filter((n) => !names.includes(n)) : [...new Set([...on, ...names])];
  }
  return on;
}

let host = '';
try {
  host = new URL(url).hostname.toLowerCase();
} catch {}
const site = SITES.find(([re, name]) => re.test(host) && enabled().includes(name));
if (!site && !enabled().includes('generic')) {
  console.error(`ERROR: No suitable extractor found for URL ${url}`);
  process.exit(1);
}
const extractorKey = site ? site[2] : 'Generic';
if (page.endsWith('/fail')) {
  console.error('ERROR: [fake] boom');
  process.exit(1);
}

const id = youtube ? youtube[1] : crypto.createHash('md5').update(page).digest('hex').slice(0, 11);

if (args.includes('-J')) {
  if (page.endsWith('/playlist')) {
    console.log(JSON.stringify({ _type: 'playlist', id, title: 'A playlist', extractor_key: extractorKey, entries: [] }));
    process.exit(0);
  }
  if (page.endsWith('/multi')) {
    console.log(JSON.stringify({ _type: 'multi_video', id, title: 'Several videos', extractor_key: extractorKey, entries: [] }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    id,
    title: `Track ${id}`,
    uploader: 'Someone',
    duration: 2,
    extractor_key: extractorKey,
    ...(page.endsWith('/live') ? { is_live: true, live_status: 'is_live' } : {}),
    webpage_url: page,
    // .invalid never resolves, so checking the artwork never leaves the
    // machine (and fails, leaving the best JPEG listed).
    thumbnail: 'https://art.invalid/a.webp',
    thumbnails: [{ url: 'https://art.invalid/a.jpg' }, { url: 'https://art.invalid/a.webp' }],
  }));
  process.exit(0);
}

if (page.endsWith('/dlfail')) {
  console.error('ERROR: [fake] download failed');
  process.exit(1);
}

const opus = page.endsWith('/opus');
const out = opt('-o').replace('%(ext)s', opus ? 'webm' : 'm4a');

// Progress, as the --progress-template in lib/tracks.js asks for it: a
// "/slow" link takes three seconds, with a known size; a "/hls" one has
// no total, only pieces.
// Written straight to fd 1: console.log to a pipe is asynchronous on
// macOS, and the sleeps below would hold the lines back.
const say = (line) => fs.writeSync(1, `${line}\n`);
if (page.endsWith('/slow')) {
  for (let i = 1; i <= 6; i++) {
    say(`[cmdlp] downloading ${i * 1000} 6000 NA 2000.5 ${6 - i} NA NA`);
    execFileSync('sleep', ['0.5']);
  }
}
if (page.endsWith('/hls')) {
  say('[cmdlp] downloading 761 NA 16742.0 0 NA 0 22');
  say('[cmdlp] downloading 1785 NA NA 0 NA NA NA');
  execFileSync('sleep', ['1.5']);
}
say('[cmdlp] finished 6000 6000 NA NA NA NA NA');
execFileSync('ffmpeg', [
  '-nostdin', '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:a', opus ? 'libopus' : 'aac',
  out,
]);
console.log(out);
