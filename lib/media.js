// Turning whatever yt-dlp downloaded into an .m4a that AVPlayer and Sonos
// both play: AAC (or ALAC) in an MP4 container, with the index at the
// front so playback can start before the whole file has arrived.

const fsp = require('node:fs').promises;
const { run } = require('./run');

async function probe(file, { signal } = {}) {
  const r = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name:format=duration',
    '-of', 'json',
    file,
  ], { timeoutMs: 60_000, signal });
  if (r.code !== 0) throw new Error(`ffprobe: ${r.stderr.trim() || 'failed'}`);
  const j = JSON.parse(r.stdout);
  const duration = Number(j.format && j.format.duration);
  return {
    codec: (j.streams && j.streams[0] && j.streams[0].codec_name) || null,
    duration: Number.isFinite(duration) ? duration : null,
  };
}

// AAC and ALAC are copied as they are (YouTube's format 140 is already
// AAC, so most tracks never re-encode). Anything else (Opus, Vorbis, MP3,
// FLAC) becomes 256k AAC: Sonos won't play Opus or Vorbis in an MP4.
async function toM4a(src, dest, { signal } = {}) {
  const { codec, duration } = await probe(src, { signal });
  if (!codec) throw new Error('the download has no audio');
  const copy = codec === 'aac' || codec === 'alac';
  const tmp = `${dest}.tmp`;
  const r = await run('ffmpeg', [
    '-nostdin', '-v', 'error', '-y',
    '-i', src,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k']),
    '-movflags', '+faststart',
    '-f', 'mp4',
    tmp,
  ], { timeoutMs: 30 * 60_000, signal });
  if (r.code !== 0) {
    await fsp.rm(tmp, { force: true });
    throw new Error(r.killed ? 'ffmpeg stopped' : `ffmpeg: ${r.stderr.trim().split('\n').pop() || 'failed'}`);
  }
  await fsp.rename(tmp, dest);
  return { codec, transcoded: !copy, duration };
}

module.exports = { probe, toM4a };
