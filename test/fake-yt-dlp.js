#!/usr/bin/env node
// Stands in for yt-dlp in the tests. The link says what to do:
//   .../unsupported  "Unsupported URL", as for a site not allowed
//   .../playlist     a playlist
//   .../fail         an error
//   .../opus         Opus audio, which has to be re-encoded
//   anything else    a two-second AAC track
// Downloads are made with ffmpeg, so they're real audio files.

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

if (url.endsWith('/unsupported')) {
  console.error(`ERROR: Unsupported URL: ${url}`);
  process.exit(1);
}
if (url.endsWith('/fail')) {
  console.error('ERROR: [fake] boom');
  process.exit(1);
}

const id = crypto.createHash('md5').update(url).digest('hex').slice(0, 11);

if (args.includes('-J')) {
  if (url.endsWith('/playlist')) {
    console.log(JSON.stringify({ _type: 'playlist', id, title: 'A playlist', entries: [] }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    id,
    title: `Track ${id}`,
    uploader: 'Someone',
    duration: 2,
    extractor_key: 'Soundcloud',
    webpage_url: url,
    thumbnail: 'https://example.com/a.webp',
    thumbnails: [{ url: 'https://example.com/a.jpg' }, { url: 'https://example.com/a.webp' }],
  }));
  process.exit(0);
}

const opus = url.endsWith('/opus');
const out = opt('-o').replace('%(ext)s', opus ? 'webm' : 'm4a');
execFileSync('ffmpeg', [
  '-nostdin', '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:a', opus ? 'libopus' : 'aac',
  out,
]);
console.log(out);
