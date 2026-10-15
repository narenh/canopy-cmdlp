// Tracks: looking a link up, downloading its audio in the background, and
// the cache, one folder per zone.
//
// DATA_DIR/zones/<zone>/
//   <id>.track.json  the track: what /tracks/{id} answers
//   <id>.info.json   what `yt-dlp -J` said, until the download is done
//   <id>.src.<ext>   yt-dlp's download, until it's an .m4a
//   <id>.m4a         the audio
//
// A track's id is a hash of its zone and its source's own id, so the same
// song pasted twice in a zone is one track, downloaded once.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { YtDlpError } = require('./ytdlp');
const { toM4a } = require('./media');

// YouTube's 140 is AAC at 128k: no re-encoding. Then the best AAC anything
// else has (SoundCloud and Mixcloud usually do), then the best audio of
// any kind, which media.js turns into AAC.
const FORMAT = '140/bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio/best';

const ZONE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

class HttpError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

function trackId(zone, info) {
  return crypto.createHash('sha256')
    .update(`${zone}\n${info.extractor_key || info.extractor}\n${info.id}`)
    .digest('base64url')
    .slice(0, 22);
}

// yt-dlp lists thumbnails worst first. A JPEG if there is one: not
// everything that shows artwork reads WebP.
function artwork(info) {
  const thumbs = (info.thumbnails || []).filter((t) => t && t.url);
  const jpeg = thumbs.filter((t) => !/\.webp(\?|$)/i.test(t.url)).pop();
  return (jpeg && jpeg.url) || info.thumbnail || (thumbs.length ? thumbs[thumbs.length - 1].url : null);
}

function metadata(info) {
  const artists = Array.isArray(info.artists) ? info.artists.join(', ') : null;
  return {
    title: info.track || info.title || null,
    artist: info.artist || artists || info.creator || info.uploader || info.channel || null,
    duration: typeof info.duration === 'number' ? info.duration : null,
    artwork: artwork(info),
    source: info.extractor_key || info.extractor || null,
    webpageUrl: info.webpage_url || null,
  };
}

class Tracks {
  constructor({ dataDir, ytdlp, maxAgeMs, concurrency = 2, log = console.log }) {
    this.zonesDir = path.join(dataDir, 'zones');
    this.ytdlp = ytdlp;
    this.maxAgeMs = maxAgeMs;
    this.concurrency = concurrency;
    this.log = log;
    this.tracks = new Map(); // id -> track
    this.jobs = new Map(); // id -> AbortController, while downloading
    this.queue = [];
    this.active = 0;
  }

  zoneDir(zone) {
    return path.join(this.zonesDir, zone);
  }

  file(track, suffix) {
    return path.join(this.zoneDir(track.zone), `${track.id}${suffix}`);
  }

  get(id) {
    return ID_RE.test(id) ? this.tracks.get(id) || null : null;
  }

  // What was here before a restart: ready tracks stay ready, unfinished
  // downloads start again.
  async init() {
    await fsp.mkdir(this.zonesDir, { recursive: true });
    for (const zone of await fsp.readdir(this.zonesDir)) {
      if (!ZONE_RE.test(zone)) continue;
      const dir = this.zoneDir(zone);
      let names;
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.filter((n) => n.endsWith('.track.json'))) {
        let t;
        try {
          t = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
        } catch {
          continue;
        }
        if (!ID_RE.test(t.id) || t.zone !== zone) continue;
        if (t.status === 'ready' && !fs.existsSync(this.file(t, '.m4a'))) continue;
        this.tracks.set(t.id, t);
        if (t.status === 'pending') {
          if (fs.existsSync(this.file(t, '.info.json'))) this.enqueue(t);
          else await this.fail(t, 'the download was interrupted');
        }
      }
    }
    this.log(`tracks: ${this.tracks.size} from before`);
  }

  async save(track) {
    if (track.deleted) return;
    const p = this.file(track, '.track.json');
    const tmp = `${p}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(track));
      await fsp.rename(tmp, p);
    } catch (e) {
      // The zone was deleted while this was being written.
      if (e.code !== 'ENOENT') throw e;
    }
  }

  async fail(track, message) {
    track.status = 'failed';
    track.error = message;
    await this.save(track);
  }

  // POST /resolve: what the link is, and its download started (or the
  // track it already is in this zone).
  async resolve(url, zone) {
    if (!ZONE_RE.test(zone || '')) throw new HttpError(400, 'bad_zone', 'zone is 1 to 64 letters, digits, - or _.');
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new HttpError(400, 'bad_url', 'url is not a link.');
    }
    if (!/^https?:$/.test(u.protocol) || url.length > 2048) throw new HttpError(400, 'bad_url', 'url is not an http(s) link.');

    let r;
    try {
      r = await this.ytdlp.exec(['-J', '--flat-playlist', '-f', FORMAT, '--', url], { timeoutMs: 90_000 });
    } catch (e) {
      throw lookupError(e);
    }
    const info = JSON.parse(r.stdout);
    if (info._type === 'playlist' || info._type === 'multi_video') {
      throw new HttpError(422, 'playlist', 'That link is a playlist; send one track.');
    }
    if (info.is_live || ['is_live', 'is_upcoming', 'post_live'].includes(info.live_status)) {
      throw new HttpError(422, 'live', "That's a live stream; it can be queued once it's over.");
    }

    const id = trackId(zone, info);
    const existing = this.tracks.get(id);
    if (existing && existing.status !== 'failed') return existing;

    const track = {
      id,
      zone,
      status: 'pending',
      ...metadata(info),
      url,
      createdAt: new Date().toISOString(),
    };
    // In the map first, so a sweep meanwhile doesn't take its files for
    // leftovers.
    this.tracks.set(id, track);
    await fsp.mkdir(this.zoneDir(zone), { recursive: true });
    await fsp.writeFile(this.file(track, '.info.json'), r.stdout);
    await this.save(track);
    this.enqueue(track);
    return track;
  }

  enqueue(track) {
    this.queue.push(track);
    this.pump();
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const track = this.queue.shift();
      if (track.deleted) continue;
      this.active++;
      this.download(track).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  async download(track) {
    const ac = new AbortController();
    this.jobs.set(track.id, ac);
    const src = this.file(track, '.src');
    try {
      // The first try reuses what -J found; a fallback copy of yt-dlp
      // looks the link up again itself, in case -J was what broke.
      const r = await this.ytdlp.exec((attempt) => [
        ...(attempt === 0 ? ['--load-info-json', this.file(track, '.info.json')] : []),
        '-f', FORMAT,
        '--no-mtime',
        '-o', `${src}.%(ext)s`,
        '--print', 'after_move:filepath',
        '--no-simulate',
        ...(attempt === 0 ? [] : ['--', track.url]),
      ], { timeoutMs: 30 * 60_000, signal: ac.signal });
      if (track.deleted) return;
      const downloaded = r.stdout.trim().split('\n').pop();
      const m = await toM4a(downloaded, this.file(track, '.m4a'), { signal: ac.signal });
      if (track.deleted) return;
      await fsp.rm(downloaded, { force: true });
      await fsp.rm(this.file(track, '.info.json'), { force: true });
      track.status = 'ready';
      track.codec = m.codec;
      track.transcoded = m.transcoded;
      if (track.duration == null && m.duration != null) track.duration = m.duration;
      track.size = (await fsp.stat(this.file(track, '.m4a'))).size;
      track.readyAt = new Date().toISOString();
      delete track.error;
      await this.save(track);
      this.log(`ready ${track.zone}/${track.id} (${m.codec}${m.transcoded ? ', re-encoded' : ''}): ${track.title}`);
    } catch (e) {
      // Stopping for a restart leaves it pending, to start again after.
      if (track.deleted || this.stopping) return;
      this.log(`failed ${track.zone}/${track.id}: ${e.message}`);
      await this.fail(track, e.message);
    } finally {
      this.jobs.delete(track.id);
    }
  }

  // Stops a track's download and forgets it; its files go with its zone
  // folder, or one by one from the sweep.
  forget(track) {
    track.deleted = true;
    this.tracks.delete(track.id);
    const job = this.jobs.get(track.id);
    if (job) job.abort();
  }

  stop() {
    this.stopping = true;
    this.queue = [];
    for (const job of this.jobs.values()) job.abort();
  }

  // DELETE /zones/{zone}
  async deleteZone(zone) {
    if (!ZONE_RE.test(zone || '')) throw new HttpError(400, 'bad_zone', 'zone is 1 to 64 letters, digits, - or _.');
    let n = 0;
    for (const t of [...this.tracks.values()]) {
      if (t.zone === zone) {
        this.forget(t);
        n++;
      }
    }
    await fsp.rm(this.zoneDir(zone), { recursive: true, force: true });
    if (n) this.log(`zone ${zone}: deleted ${n} tracks`);
    return n;
  }

  // Everything older than maxAgeMs goes: tracks by when they were
  // resolved, and any other file (left by a crash, say) by its own age.
  async sweep() {
    const cutoff = Date.now() - this.maxAgeMs;
    let n = 0;
    for (const t of [...this.tracks.values()]) {
      if (Date.parse(t.createdAt) < cutoff) {
        this.forget(t);
        n++;
      }
    }
    for (const zone of await fsp.readdir(this.zonesDir)) {
      const dir = this.zoneDir(zone);
      let names;
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      let left = names.length;
      for (const name of names) {
        const id = name.split('.')[0];
        if (this.tracks.has(id)) continue;
        const p = path.join(dir, name);
        try {
          if ((await fsp.stat(p)).mtimeMs < cutoff || !this.jobs.has(id)) {
            await fsp.rm(p, { recursive: true, force: true });
            left--;
          }
        } catch {
          left--;
        }
      }
      if (!left) await fsp.rm(dir, { recursive: true, force: true });
    }
    if (n) this.log(`sweep: deleted ${n} tracks`);
    return n;
  }
}

function lookupError(e) {
  if (!(e instanceof YtDlpError)) return e;
  switch (e.reason) {
    case 'unsupported':
      return new HttpError(422, 'unsupported_link', 'That link is not from YouTube, SoundCloud, Bandcamp, Mixcloud, or archive.org.');
    case 'blocked':
      return new HttpError(502, 'blocked', `YouTube asked to confirm this isn't a bot: ${e.message}`);
    case 'timeout':
      return new HttpError(504, 'timeout', 'Looking the link up took too long.');
    default:
      return new HttpError(502, 'lookup_failed', e.message);
  }
}

module.exports = { Tracks, HttpError, FORMAT, ZONE_RE, ID_RE };
