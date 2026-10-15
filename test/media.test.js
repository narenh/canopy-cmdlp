// The .m4a and its loudness, with real ffmpeg on tones it makes here. Needs
// ffmpeg and ffprobe on PATH.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toM4a, measureLoudness, loudnessTarget } = require('../lib/media');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdlp-media-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// A 6-second AAC tone at `volume` times ffmpeg's sine (which is at 1/8, about
// -22 LUFS).
function tone(name, volume) {
  const file = path.join(dir, name);
  execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=44100',
    '-af', `volume=${volume}`,
    '-c:a', 'aac', '-b:a', '128k', file,
  ]);
  return file;
}

test('a loud track is brought down to the target', async () => {
  const src = tone('loud.m4a', 6);
  const dest = path.join(dir, 'loud-out.m4a');
  const m = await toM4a(src, dest, { target: -16 });
  assert.ok(m.loudness.measured > -10, `measured ${m.loudness.measured}`);
  assert.strictEqual(m.loudness.adjusted, true);
  assert.strictEqual(m.transcoded, true);
  const after = await measureLoudness(dest);
  assert.ok(Math.abs(after.i - -16) <= 1, `after ${after.i}`);
});

test('a quiet track is turned up without clipping', async () => {
  const src = tone('quiet.m4a', 0.2);
  const dest = path.join(dir, 'quiet-out.m4a');
  const m = await toM4a(src, dest, { target: -16 });
  assert.ok(m.loudness.measured < -25, `measured ${m.loudness.measured}`);
  const after = await measureLoudness(dest);
  assert.ok(Math.abs(after.i - -16) <= 1, `after ${after.i}`);
  assert.ok(after.tp <= -1, `peak ${after.tp}`);
});

test('a quiet track with loud peaks is turned up under a limiter', async () => {
  // Quiet overall, with a click at full scale every second.
  const file = path.join(dir, 'peaky.m4a');
  execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=44100',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=6:sample_rate=44100',
    '-filter_complex', '[0]volume=0.3[a];[1]volume=7.5,volume=enable=\'lt(mod(t,1),0.97)\':volume=0[b];[a][b]amix=inputs=2:normalize=0',
    '-c:a', 'aac', '-b:a', '128k', file,
  ]);
  const before = await measureLoudness(file);
  assert.ok(before.tp > -6, `peak before ${before.tp}`);
  const dest = path.join(dir, 'peaky-out.m4a');
  const m = await toM4a(file, dest, { target: -16 });
  assert.strictEqual(m.loudness.adjusted, true);
  const after = await measureLoudness(dest);
  assert.ok(after.tp <= -1, `peak after ${after.tp}`);
});

test('a track already near the target is copied as it is', async () => {
  // Find the volume that lands near -16 from a measured tone.
  const probe = await measureLoudness(tone('probe.m4a', 1));
  const volume = 10 ** ((-16 - probe.i) / 20);
  const src = tone('near.m4a', volume);
  const m = await toM4a(src, path.join(dir, 'near-out.m4a'), { target: -16 });
  assert.strictEqual(m.loudness.adjusted, false);
  assert.strictEqual(m.transcoded, false);
});

test('progress goes from measuring through encoding, up to the end', async () => {
  const src = tone('progress.m4a', 6);
  const seen = [];
  await toM4a(src, path.join(dir, 'progress-out.m4a'), { target: -16, onProgress: (f) => seen.push(f) });
  assert.ok(seen.length >= 2, `${seen.length} updates`);
  assert.ok(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1] - 1e-9)), JSON.stringify(seen));
  assert.ok(seen.at(-1) > 0.95, `ended at ${seen.at(-1)}`);
  // The encoding's share starts after the measuring's.
  assert.ok(seen.some((f) => f > 0.3));
});

test('off leaves the track alone', async () => {
  const src = tone('off.m4a', 6);
  const m = await toM4a(src, path.join(dir, 'off-out.m4a'), { target: null });
  assert.strictEqual(m.loudness, null);
  assert.strictEqual(m.transcoded, false);
});

test('LOUDNESS_TARGET', () => {
  assert.strictEqual(loudnessTarget(undefined), -16);
  assert.strictEqual(loudnessTarget(''), -16);
  assert.strictEqual(loudnessTarget('-14'), -14);
  assert.strictEqual(loudnessTarget('off'), null);
  assert.strictEqual(loudnessTarget('OFF'), null);
  assert.strictEqual(loudnessTarget('loud'), -16);
  assert.strictEqual(loudnessTarget('3'), -16);
});
