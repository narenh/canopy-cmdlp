// yt-dlp: which copy runs, keeping it on the latest nightly, and falling
// back to an older copy when a new nightly can't do what the last one
// could.
//
// Three copies, tried in this order:
//   DATA_DIR/bin/yt-dlp       the one that runs, updated to nightly on start
//                             and daily (on the volume, so updates survive
//                             a restart)
//   DATA_DIR/bin/yt-dlp.prev  the version before the last update
//   YTDLP_STABLE              the stable release baked into the image

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { run } = require('./run');

// The extractors yt-dlp may use. Each is a regex yt-dlp full-matches
// against extractor names, ignoring case. Never "generic": it fetches
// whatever URL it's given, internal addresses included.
//
// The playlist ones are here because YouTube hands any link with a list=
// in it (a video opened from a Mix, say) to youtube:tab, which, with
// --no-playlist, answers with just the video. A link that is only a
// playlist comes back as one, and /resolve says to send one track.
const EXTRACTORS = [
  'youtube', // youtube.com, music.youtube.com, and youtu.be
  'youtube:tab', // ...?v=<id>&list=<id>, and playlists and channels
  'youtube:playlist',
  'YoutubeYtBe', // youtu.be/<id>?list=<id>
  'soundcloud',
  'soundcloud:set',
  'soundcloud:playlist',
  'SoundcloudEmbed', // w.soundcloud.com/player
  'Bandcamp',
  'Bandcamp:album',
  'mixcloud',
  'mixcloud:playlist',
  'archive\\.org',
];

const DAY = 24 * 60 * 60 * 1000;

class YtDlpError extends Error {
  constructor(message, { reason = 'failed', stderr = '' } = {}) {
    super(message);
    this.reason = reason;
    this.stderr = stderr;
  }
}

// The line yt-dlp ends on when it gives up ("ERROR: [youtube] abc: ..."),
// without the "ERROR: " in front.
function errorLine(stderr) {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const e = lines.reverse().find((l) => l.startsWith('ERROR:'));
  return (e || lines[0] || 'yt-dlp failed').replace(/^ERROR:\s*/, '');
}

function classify(stderr) {
  if (/Unsupported URL|No suitable extractor|is not a valid URL/i.test(stderr)) return 'unsupported';
  if (/confirm you.re not a bot|Sign in to confirm/i.test(stderr)) return 'blocked';
  return 'failed';
}

async function exists(p) {
  try {
    await fsp.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

class YtDlp {
  constructor({ dataDir, stable, autoUpdate = true, cookies, log = console.log }) {
    this.binDir = path.join(dataDir, 'bin');
    this.cacheDir = path.join(dataDir, 'cache');
    this.current = path.join(this.binDir, 'yt-dlp');
    this.prev = path.join(this.binDir, 'yt-dlp.prev');
    this.stable = stable;
    this.autoUpdate = autoUpdate;
    this.cookies = cookies;
    this.log = log;
    this.versions = { current: null, previous: null, stable: null };
    this.lastUpdate = null; // { at, ok, from, to, error }
    this.updating = null;
  }

  async init() {
    await fsp.mkdir(this.binDir, { recursive: true });
    await fsp.mkdir(this.cacheDir, { recursive: true });
    if (!(await exists(this.current))) {
      // A fresh volume: start from the image's stable copy.
      await fsp.copyFile(this.stable, this.current);
      await fsp.chmod(this.current, 0o755);
      this.log(`yt-dlp: copied ${this.stable} to ${this.current}`);
    }
    await this.readVersions();
    this.log(`yt-dlp: ${this.versions.current} (previous ${this.versions.previous || 'none'}, stable ${this.versions.stable})`);
    if (this.autoUpdate) {
      // Not awaited: the server answers /health meanwhile, and every
      // yt-dlp run waits for the update to finish.
      this.update();
      setInterval(() => this.update(), DAY).unref();
    }
  }

  async version(bin) {
    try {
      const r = await run(bin, ['--ignore-config', '--version'], { timeoutMs: 60_000 });
      return r.code === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  async readVersions() {
    this.versions = {
      current: await this.version(this.current),
      previous: (await exists(this.prev)) ? await this.version(this.prev) : null,
      stable: await this.version(this.stable),
    };
  }

  // `yt-dlp --update-to nightly`, keeping what was there as yt-dlp.prev.
  // If the update leaves a copy that won't run, the old one goes back.
  update() {
    if (this.updating) return this.updating;
    this.updating = (async () => {
      const at = new Date().toISOString();
      const from = this.versions.current;
      const backup = `${this.current}.backup`;
      try {
        await fsp.copyFile(this.current, backup);
        const r = await run(this.current, ['--ignore-config', '--update-to', 'nightly'], { timeoutMs: 5 * 60_000 });
        const to = await this.version(this.current);
        if (!to) {
          await fsp.rename(backup, this.current);
          throw new Error(`the updated yt-dlp won't run; kept ${from}`);
        }
        if (to !== from) {
          await fsp.rename(backup, this.prev);
          this.log(`yt-dlp: updated ${from} -> ${to}`);
        } else {
          await fsp.rm(backup, { force: true });
          if (r.code !== 0) throw new Error(errorLine(r.stderr));
        }
        this.lastUpdate = { at, ok: true, from, to };
      } catch (e) {
        await fsp.rm(backup, { force: true });
        this.lastUpdate = { at, ok: false, from, error: e.message };
        this.log(`yt-dlp: update failed: ${e.message}`);
      } finally {
        await this.readVersions();
        this.updating = null;
      }
    })();
    return this.updating;
  }

  commonArgs() {
    return [
      '--ignore-config',
      '--use-extractors', EXTRACTORS.join(','),
      '--no-playlist',
      '--cache-dir', this.cacheDir,
      '--socket-timeout', '30',
      '--no-progress',
      ...(this.cookies ? ['--cookies', this.cookies] : []),
    ];
  }

  // The copies to try, newest first, each version once.
  candidates() {
    const list = [
      { bin: this.current, version: this.versions.current },
      { bin: this.prev, version: this.versions.previous },
      { bin: this.stable, version: this.versions.stable },
    ].filter((c) => c.version);
    const seen = new Set();
    return list.filter((c) => !seen.has(c.version) && seen.add(c.version));
  }

  // Runs yt-dlp with `args` (or `args(attempt)`, for arguments that change
  // when falling back), trying the older copies when the newest fails. A
  // link no extractor takes isn't retried: no copy will take it.
  async exec(args, { timeoutMs, signal } = {}) {
    if (this.updating) await this.updating;
    const candidates = this.candidates();
    if (!candidates.length) throw new YtDlpError('no working yt-dlp');
    let first;
    for (const [i, c] of candidates.entries()) {
      if (signal && signal.aborted) break;
      const a = typeof args === 'function' ? args(i) : args;
      const r = await run(c.bin, [...this.commonArgs(), ...a], { timeoutMs, signal });
      if (r.code === 0) {
        if (i > 0) this.log(`yt-dlp: ${candidates[0].version} failed, ${c.version} worked`);
        return { ...r, version: c.version };
      }
      const err = r.killed
        ? new YtDlpError(signal && signal.aborted ? 'cancelled' : 'yt-dlp took too long', { reason: signal && signal.aborted ? 'cancelled' : 'timeout' })
        : new YtDlpError(errorLine(r.stderr), { reason: classify(r.stderr), stderr: r.stderr });
      first = first || err;
      if (err.reason === 'unsupported' || err.reason === 'cancelled') break;
      if (i < candidates.length - 1) this.log(`yt-dlp ${c.version}: ${err.message}; trying ${candidates[i + 1].version}`);
    }
    throw first || new YtDlpError('cancelled', { reason: 'cancelled' });
  }
}

module.exports = { YtDlp, YtDlpError, EXTRACTORS };
