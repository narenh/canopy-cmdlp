#!/usr/bin/env node
// Stands in for yt-dlp in the tests. The link says what to do:
//   .../unsupported  "Unsupported URL", as for a site not allowed
//   .../playlist     a playlist
//   .../fail         an error
//   .../opus         Opus audio, which has to be re-encoded
//   .../dlfail       looks up fine, but the download fails
//   anything else    a two-second AAC track
// Downloads are made with ffmpeg, so they're real audio files.
//
// The query and fragment don't change which track a link is.
// on.soundcloud.com/<x> is a short link to soundcloud.com/a/<x>. A YouTube
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
  : url.split(/[?#]/)[0].replace('://on.soundcloud.com/', '://soundcloud.com/a/');

if (page.endsWith('/unsupported')) {
  console.error(`ERROR: Unsupported URL: ${url}`);
  process.exit(1);
}
if (page.endsWith('/fail')) {
  console.error('ERROR: [fake] boom');
  process.exit(1);
}

const id = youtube ? youtube[1] : crypto.createHash('md5').update(page).digest('hex').slice(0, 11);

if (args.includes('-J')) {
  if (page.endsWith('/playlist')) {
    console.log(JSON.stringify({ _type: 'playlist', id, title: 'A playlist', entries: [] }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    id,
    title: `Track ${id}`,
    uploader: 'Someone',
    duration: 2,
    extractor_key: youtube ? 'Youtube' : 'Soundcloud',
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
