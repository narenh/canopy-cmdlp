// Turning whatever yt-dlp downloaded into an .m4a that AVPlayer and Sonos
// both play: AAC (or ALAC) in an MP4 container, with the index at the
// front so playback can start before the whole file has arrived, at about
// the loudness Apple Music plays at.

const fsp = require('node:fs').promises;
const { run } = require('./run');

// The loudness every track is brought to, in LUFS: about where Apple Music
// plays with Sound Check, so a link isn't much louder (or quieter) than the
// songs around it. LOUDNESS_TARGET changes it ("off" leaves tracks as they
// came). A download is usually its master, far louder than a site plays it:
// YouTube turns loud videos down in its own player, not in the file.
const DEFAULT_TARGET = -16;
// Within this of the target, a track is left as it is (and AAC copied).
const CLOSE_ENOUGH = 1;
// The loudest peak allowed after the change, in dBTP, so a quiet track
// turned up doesn't clip: a limiter holds peaks there when the gain would
// push them past it.
const TRUE_PEAK = -1.5;

function loudnessTarget(value = process.env.LOUDNESS_TARGET) {
  if (value == null || value === '') return DEFAULT_TARGET;
  if (String(value).toLowerCase() === 'off') return null;
  const n = Number(value);
  return Number.isFinite(n) && n < 0 && n >= -70 ? n : DEFAULT_TARGET;
}

// ffmpeg's -progress: a block of key=value lines on stdout about twice a
// second, out_time_us among them (how far into the audio it is).
function progressArgs(onProgress) {
  return onProgress ? ['-progress', 'pipe:1'] : [];
}

// Turns those lines into onProgress(0 to 1) calls, given the length.
function progressLines(duration, onProgress) {
  if (!onProgress || !(duration > 0)) return undefined;
  return (line) => {
    const m = /^out_time_us=(\d+)/.exec(line);
    if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
  };
}

// How the conversion's progress is shared out when the loudness is
// measured first: the measuring pass only decodes, so it's much the
// quicker (0.2 s against 2.7 s for a 4-minute song on an M-series Mac).
const MEASURE_SHARE = 0.1;

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

// The track's integrated loudness (LUFS) and sample peak (dBFS), from
// ffmpeg's EBU R128 meter: { i, peak }. null when it can't tell (silence).
// ebur128 rather than loudnorm's first pass, which works at 192 kHz and took
// five times as long; and the sample peak rather than the true peak, which
// oversamples and took four times as long again. A true peak can be up to
// about 1 dB over the sample peak, which toM4a allows for.
async function measureLoudness(file, { signal, duration, onProgress } = {}) {
  const r = await run('ffmpeg', [
    '-nostdin', '-hide_banner', '-nostats', '-v', 'info',
    ...progressArgs(onProgress),
    '-i', file,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    // framelog=verbose: only the summary at the end, not a line every 100 ms.
    '-af', 'ebur128=peak=sample:framelog=verbose',
    '-f', 'null', '-',
  ], { timeoutMs: 30 * 60_000, signal, onLine: progressLines(duration, onProgress) });
  if (r.code !== 0) throw new Error(r.killed ? 'ffmpeg stopped' : `ffmpeg: ${r.stderr.trim().split('\n').pop() || 'failed'}`);
  // The summary at the end: "I: -19.6 LUFS" and, under Sample peak, "Peak: -7.1 dBFS".
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const i = Number((summary.match(/\bI:\s*(-?[\d.]+|-inf)\s*LUFS/) || [])[1]);
  const peak = Number((summary.match(/\bPeak:\s*(-?[\d.]+|-inf)\s*dBFS/) || [])[1]);
  // -70 LUFS is the meter's floor: silence, or as good as.
  if (!Number.isFinite(i) || !Number.isFinite(peak) || i <= -70) return null;
  return { i, peak };
}

// AAC and ALAC are copied as they are when the loudness is already close to
// the target (or the target is off). Otherwise the track is brought to the
// target and re-encoded as 256k AAC, as is anything that isn't AAC or ALAC
// (Opus, Vorbis, MP3, FLAC): Sonos won't play Opus or Vorbis in an MP4.
// `onProgress`, if given, is called with how far along it is (0 to 1),
// across the measuring and the encoding.
async function toM4a(src, dest, { signal, target = loudnessTarget(), onProgress } = {}) {
  const { codec, duration } = await probe(src, { signal });
  if (!codec) throw new Error('the download has no audio');
  const measureShare = target == null ? 0 : MEASURE_SHARE;
  const report = (from, share) => onProgress && ((f) => onProgress(from + f * share));
  const measureStart = Date.now();
  const measured = target == null ? null
    : await measureLoudness(src, { signal, duration, onProgress: report(0, measureShare) });
  const adjust = measured != null && Math.abs(measured.i - target) > CLOSE_ENOUGH;
  const copy = !adjust && (codec === 'aac' || codec === 'alac');
  // One gain for the whole track, which keeps its dynamics as they were; a
  // limiter only when that gain would push its peaks past TRUE_PEAK.
  const gain = adjust ? Math.round((target - measured.i) * 100) / 100 : 0;
  // The peak measured is the samples', up to about 1 dB under the true peak
  // between them, and AAC encoding lifts peaks a little more (seen +0.7 dB):
  // so the limiter comes in 1 dB early and holds samples 2 dB under TRUE_PEAK.
  const limit = adjust && measured.peak + 1 + gain > TRUE_PEAK
    ? `,alimiter=limit=${(10 ** ((TRUE_PEAK - 2) / 20)).toFixed(4)}:level=false` : '';
  const filter = adjust ? ['-af', `volume=${gain}dB${limit}`] : [];
  const tmp = `${dest}.tmp`;
  const measureMs = Date.now() - measureStart;
  const encodeStart = Date.now();
  const encoding = report(measureShare, 1 - measureShare);
  const r = await run('ffmpeg', [
    '-nostdin', '-v', 'error', '-y',
    ...progressArgs(encoding),
    '-i', src,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    ...filter,
    ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k']),
    '-movflags', '+faststart',
    '-f', 'mp4',
    tmp,
  ], { timeoutMs: 30 * 60_000, signal, onLine: progressLines(duration, encoding) });
  if (r.code !== 0) {
    await fsp.rm(tmp, { force: true });
    throw new Error(r.killed ? 'ffmpeg stopped' : `ffmpeg: ${r.stderr.trim().split('\n').pop() || 'failed'}`);
  }
  await fsp.rename(tmp, dest);
  return {
    codec,
    transcoded: !copy,
    duration,
    // How long measuring and encoding (or copying) took, for the log.
    measureMs,
    encodeMs: Date.now() - encodeStart,
    // What it measured, and whether it was changed to the target.
    loudness: measured == null ? null : { measured: Math.round(measured.i * 10) / 10, target, adjusted: adjust },
  };
}

module.exports = { probe, toM4a, measureLoudness, loudnessTarget };
