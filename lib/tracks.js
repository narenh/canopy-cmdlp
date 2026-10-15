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
//
// Each track also keeps the links that led to it (`aliases`, normalized),
// so pasting one again answers at once, without asking yt-dlp. A YouTube
// link needs no alias: its video id says which track it is. A short link
// (on.soundcloud.com) is followed here first (lib/shortlinks.js), since
// yt-dlp can't, and both it and where it led become aliases.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { YtDlpError } = require('./ytdlp');
const { toM4a } = require('./media');
const { safeFetch } = require('./safe-fetch');
const { shortener, followShortLink, ShortLinkError } = require('./shortlinks');

// YouTube's 140 is AAC at 128k: no re-encoding. Then the best AAC anything
// else has (SoundCloud and Mixcloud usually do), then the best audio of
// any kind, which media.js turns into AAC.
const FORMAT = '140/bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio/best';

// yt-dlp prints a line like this as it downloads (NA for what it doesn't
// know): status, bytes so far, total bytes, its estimate of the total,
// bytes per second, seconds left, and for a stream in pieces (HLS), which
// piece of how many.
const PROGRESS_MARK = '[cmdlp] ';
const PROGRESS_TEMPLATE = `download:${PROGRESS_MARK}%(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s `
  + '%(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s %(progress.fragment_index)s %(progress.fragment_count)s';

const num = (s) => (s === undefined || s === 'NA' || s === 'None' || !Number.isFinite(Number(s)) ? null : Number(s));

// A progress line as { percent, downloadedBytes, totalBytes, speed, eta },
// or null if it isn't one. percent comes from the exact size, or else from
// how many of the stream's pieces are in; when neither is known (some HLS
// streams) it's null, not a guess from the estimate.
function parseProgress(line) {
  if (!line.startsWith(PROGRESS_MARK)) return null;
  const [status, done, total, estimate, speed, eta, fragIndex, fragCount] = line.slice(PROGRESS_MARK.length).trim().split(/\s+/);
  const p = {
    downloadedBytes: num(done),
    totalBytes: num(total),
    totalBytesEstimate: num(estimate),
    speed: num(speed),
    eta: num(eta),
    percent: null,
  };
  if (status === 'finished') p.percent = 100;
  else if (p.totalBytes && p.downloadedBytes != null) p.percent = (100 * p.downloadedBytes) / p.totalBytes;
  else if (num(fragCount) && num(fragIndex) != null) p.percent = (100 * num(fragIndex)) / num(fragCount);
  if (p.percent != null) p.percent = Math.min(100, Math.round(p.percent * 10) / 10);
  return p;
}

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

// ---- links already seen ----

// Query parameters that say who shared a link or where from, not what it
// is. Anything else is kept (YouTube's v and list, say). t is a timestamp:
// the same track.
const TRACKING_PARAMS = new Set([
  'si', 'is', 'feature', 'pp', 't', 'ab_channel',
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid',
  'igshid', 'igsh', 'mc_cid', 'mc_eid', 'ref_src',
]);
const isTracking = (k) => TRACKING_PARAMS.has(k.toLowerCase()) || /^utm_/i.test(k);

// A link as an alias: host lowercased, no fragment, no tracking
// parameters, the rest sorted, and no trailing slash. Only ever compared,
// never fetched.
function normalizeUrl(url) {
  const u = new URL(url);
  const kept = [...u.searchParams].filter(([k]) => !isTracking(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const q = new URLSearchParams(kept).toString();
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${q ? `?${q}` : ''}`;
}

// A link without its tracking parameters and fragment, otherwise exactly
// as it was (the rest of the query isn't re-encoded): what a short link
// led to, before it goes to yt-dlp.
function stripTracking(url) {
  const u = new URL(url);
  const key = (pair) => {
    try {
      return decodeURIComponent(pair.split('=')[0].replace(/\+/g, ' '));
    } catch {
      return pair.split('=')[0];
    }
  };
  u.search = u.search.slice(1).split('&').filter((p) => p && !isTracking(key(p))).join('&');
  u.hash = '';
  return u.href;
}

// The video id in a YouTube link (youtu.be/<id>, watch?v=<id> on
// www., m., or music.youtube.com, /shorts/, /live/, or /embed/), or null.
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOST_RE = /^(?:(?:www|m|music)\.)?youtube\.com$/;

function youtubeId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    if (parts.length === 1) id = parts[0];
  } else if (YOUTUBE_HOST_RE.test(host)) {
    if (parts.length === 1 && parts[0] === 'watch') id = u.searchParams.get('v');
    else if (parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1];
  }
  return id && YOUTUBE_ID_RE.test(id) ? id : null;
}

// yt-dlp's name for its YouTube video extractor (YoutubeIE), which every
// YouTube video comes back from, whatever form the link took.
const YOUTUBE_EXTRACTOR_KEY = 'Youtube';

const aliasKey = (zone, alias) => `${zone}\n${alias}`;

// yt-dlp lists thumbnails worst first. A JPEG if there is one: not
// everything that shows artwork reads WebP.
function artwork(info) {
  const thumbs = (info.thumbnails || []).filter((t) => t && t.url);
  const jpeg = thumbs.filter((t) => !/\.webp(\?|$)/i.test(t.url)).pop();
  const found = (jpeg && jpeg.url) || info.thumbnail || (thumbs.length ? thumbs[thumbs.length - 1].url : null);
  // yt-dlp finds none for archive.org, which has an image for every item.
  if (!found && info.extractor_key === 'ArchiveOrg' && info.id) {
    return `https://archive.org/services/img/${encodeURIComponent(String(info.id).split('/')[0])}`;
  }
  return found;
}

// yt-dlp lists thumbnails without checking they exist, and YouTube's best
// (maxresdefault, hq720, sddefault) are often missing for older and
// low-resolution uploads. So the best few are checked, all at once, and
// the best that's really an image wins. YouTube's hqdefault.jpg always
// exists, so it's the floor there and nothing below it is tried.
const ARTWORK_CHECKS = 4;
const ARTWORK_TIMEOUT_MS = 3000;
const WEBP_RE = /\.webp(\?|$)/i;

function isYoutube(info) {
  return /^youtube/i.test(info.extractor_key || '');
}

function youtubeFloor(info) {
  return isYoutube(info) && info.id ? `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg` : null;
}

// Best first: JPEGs (not WebP), without the resized "?sqp=" copies of an
// image already listed bare, at most ARTWORK_CHECKS of them.
function artworkCandidates(info) {
  const urls = (info.thumbnails || []).filter((t) => t && typeof t.url === 'string' && !WEBP_RE.test(t.url)).map((t) => t.url).reverse();
  const bare = new Set(urls.filter((u) => !u.includes('?')));
  let list = [...new Set(urls.filter((u) => !u.includes('?') || !bare.has(u.split('?')[0])))];
  const floor = youtubeFloor(info);
  if (floor) {
    const i = list.indexOf(floor);
    list = [...(i === -1 ? list : list.slice(0, i)).slice(0, ARTWORK_CHECKS - 1), floor];
  }
  return list.slice(0, ARTWORK_CHECKS);
}

// Whether `url` answers with an image: one byte of it, asked for with a
// GET and a Range (some servers don't do HEAD). Only https with a name for
// a host, never an address, since these URLs come from the sites; and the
// guarded fetch (lib/safe-fetch.js) only connects when every address that
// name has is public, so a site's thumbnail can't point inside the network.
async function imageExists(url, fetchFn) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || /^[\d.]+$|^\[/.test(u.hostname)) return false;
  try {
    const r = await fetchFn(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(ARTWORK_TIMEOUT_MS) });
    if (r.body && r.body.cancel) r.body.cancel().catch(() => {});
    return (r.status === 200 || r.status === 206) && /^image\//i.test(r.headers.get('content-type') || '');
  } catch {
    return false;
  }
}

// SoundCloud's own fallback, served from public/artwork/ (server.js makes
// the path absolute). A track with no artwork of its own gets its
// uploader's avatar from yt-dlp, as on SoundCloud itself; one whose
// uploader has none gets SoundCloud's grey default avatar, which counts as
// no artwork here.
const SOUNDCLOUD_FALLBACK = '/artwork/soundcloud.jpg';
const SC_DEFAULT_AVATAR_RE = /default_avatar/i;

function isSoundcloud(info) {
  return /^soundcloud/i.test(info.extractor_key || '');
}

// The artwork to use: the best candidate that exists; failing all of
// them, YouTube's hqdefault.jpg, SoundCloud's logo, or else what yt-dlp
// listed as best.
async function pickArtwork(info, fetchFn = safeFetch) {
  const sc = isSoundcloud(info);
  const candidates = artworkCandidates(info).filter((u) => !(sc && SC_DEFAULT_AVATAR_RE.test(u)));
  const ok = await Promise.all(candidates.map((u) => imageExists(u, fetchFn)));
  const i = ok.indexOf(true);
  if (i !== -1) return candidates[i];
  if (sc) return SOUNDCLOUD_FALLBACK;
  return youtubeFloor(info) || artwork(info);
}

function metadata(info) {
  const artists = Array.isArray(info.artists) ? info.artists.join(', ') : null;
  // A Mixcloud upload is a DJ's set; its "artist" is everyone in the
  // tracklist.
  const mix = (info.extractor_key || '').toLowerCase() === 'mixcloud';
  return {
    title: info.track || info.title || null,
    artist: (mix && info.uploader) || info.artist || artists || info.creator || info.uploader || info.channel || null,
    duration: typeof info.duration === 'number' ? info.duration : null,
    artwork: artwork(info),
    source: info.extractor_key || info.extractor || null,
    webpageUrl: info.webpage_url || null,
  };
}

// The site's name as people write it, from yt-dlp's name for its extractor
// (Youtube, Soundcloud, ArchiveOrg...).
function serviceName(source) {
  const s = String(source || '').toLowerCase();
  if (s.startsWith('youtube')) return 'YouTube';
  if (s.startsWith('soundcloud')) return 'SoundCloud';
  if (s.startsWith('bandcamp')) return 'Bandcamp';
  if (s.startsWith('mixcloud')) return 'Mixcloud';
  if (s.startsWith('archive')) return 'archive.org';
  return source || null;
}

class Tracks {
  constructor({ dataDir, ytdlp, maxAgeMs, concurrency = 2, log = console.log, fetch: fetchFn = safeFetch }) {
    this.fetch = fetchFn; // checking artwork exists, and following short links
    this.zonesDir = path.join(dataDir, 'zones');
    this.ytdlp = ytdlp;
    this.maxAgeMs = maxAgeMs;
    this.concurrency = concurrency;
    this.log = log;
    this.tracks = new Map(); // id -> track
    this.aliases = new Map(); // "<zone>\n<normalized link>" -> track id
    this.saving = new Map(); // id -> the save in progress, so saves go in order
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
        // Saved before tracks had aliases: the link it was resolved from.
        if (!Array.isArray(t.aliases)) {
          try {
            t.aliases = [normalizeUrl(t.url)];
          } catch {
            t.aliases = [];
          }
        }
        this.tracks.set(t.id, t);
        this.index(t);
        if (t.status === 'pending') {
          if (fs.existsSync(this.file(t, '.info.json'))) this.enqueue(t);
          else await this.fail(t, 'the download was interrupted');
        }
      }
    }
    this.log(`tracks: ${this.tracks.size} from before`);
  }

  // One save at a time per track (a new alias can be saved while the
  // download saves), each writing the track as it is by then.
  save(track) {
    const prev = this.saving.get(track.id) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.write(track));
    this.saving.set(track.id, next);
    const done = () => {
      if (this.saving.get(track.id) === next) this.saving.delete(track.id);
    };
    next.then(done, done);
    return next;
  }

  async write(track) {
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

  index(track) {
    for (const a of track.aliases || []) this.aliases.set(aliasKey(track.zone, a), track.id);
  }

  unindex(track) {
    for (const a of track.aliases || []) {
      const k = aliasKey(track.zone, a);
      if (this.aliases.get(k) === track.id) this.aliases.delete(k);
    }
  }

  // The track a link already is in this zone, without asking yt-dlp: by
  // its YouTube video id, or else by a link that led to it before. Never
  // a failed one: that's tried again.
  cached(url, zone) {
    const usable = (t) => (t && t.zone === zone && !t.deleted && t.status !== 'failed' ? t : null);
    const yt = youtubeId(url);
    if (yt) {
      const t = usable(this.tracks.get(trackId(zone, { extractor_key: YOUTUBE_EXTRACTOR_KEY, id: yt })));
      if (t) return t;
    }
    const id = this.aliases.get(aliasKey(zone, normalizeUrl(url)));
    return usable(id && this.tracks.get(id));
  }

  async addAlias(track, alias) {
    if (!Array.isArray(track.aliases)) track.aliases = [];
    if (track.aliases.includes(alias)) return;
    track.aliases.push(alias);
    this.aliases.set(aliasKey(track.zone, alias), track.id);
    await this.save(track);
  }

  async fail(track, message) {
    track.status = 'failed';
    track.error = message;
    delete track.stage;
    delete track.progress;
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
    if (u.username || u.password) throw new HttpError(400, 'bad_url', 'url has a user name in it.');

    const hit = this.cached(url, zone);
    if (hit) return hit;

    // yt-dlp gets the link as Node's URL writes it, always with a / after
    // the host, so the host yt-dlp's patterns see is the host it is
    // (https://a.example?.site.com/ can't pass for site.com's).
    let link = u.href;
    const short = !!shortener(url);
    if (short) {
      try {
        link = stripTracking(await followShortLink(link, this.fetch));
      } catch (e) {
        throw shortLinkError(e);
      }
      // Where it leads is already a track: learn the short link, no yt-dlp.
      const known = this.cached(link, zone);
      if (known) {
        await this.addAlias(known, normalizeUrl(url));
        return known;
      }
    }
    // The links that lead to this track: what was sent, and where a short
    // link led.
    const aliases = [...new Set([normalizeUrl(url), ...(short ? [normalizeUrl(link)] : [])])];

    let r;
    try {
      r = await this.ytdlp.exec(['-J', '--no-progress', '--flat-playlist', '-f', FORMAT, '--', link], { timeoutMs: 90_000 });
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
    if (existing && existing.status !== 'failed') {
      // Another link to the same track: next time, it's known.
      for (const a of aliases) await this.addAlias(existing, a);
      return existing;
    }

    const track = {
      id,
      zone,
      status: 'pending',
      stage: 'queued',
      ...metadata(info),
      artwork: await pickArtwork(info, this.fetch),
      url,
      // What yt-dlp was given (where a short link led), for a fallback
      // copy of yt-dlp to look up again.
      ytdlpUrl: link,
      aliases: [...new Set([...((existing && existing.aliases) || []), ...aliases])],
      createdAt: new Date().toISOString(),
    };
    // In the map first, so a sweep meanwhile doesn't take its files for
    // leftovers.
    this.tracks.set(id, track);
    this.index(track);
    await fsp.mkdir(this.zoneDir(zone), { recursive: true });
    await fsp.writeFile(this.file(track, '.info.json'), r.stdout);
    await this.save(track);
    this.enqueue(track);
    return track;
  }

  enqueue(track) {
    track.stage = 'queued';
    track.progress = null;
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
    track.stage = 'downloading';
    track.progress = null;
    try {
      // The first try reuses what -J found; a fallback copy of yt-dlp
      // looks the link up again itself, in case -J was what broke.
      const r = await this.ytdlp.exec((attempt) => {
        track.progress = null;
        return [
          ...(attempt === 0 ? ['--load-info-json', this.file(track, '.info.json')] : []),
          '-f', FORMAT,
          '--no-mtime',
          '-o', `${src}.%(ext)s`,
          '--print', 'after_move:filepath',
          '--no-simulate',
          // --print implies --quiet; --progress brings the progress back,
          // one line at a time on stdout, as PROGRESS_TEMPLATE says.
          '--progress', '--newline', '--progress-template', PROGRESS_TEMPLATE,
          ...(attempt === 0 ? [] : ['--', track.ytdlpUrl || track.url]),
        ];
      }, {
        timeoutMs: 30 * 60_000,
        signal: ac.signal,
        onLine: (line) => {
          const p = parseProgress(line);
          if (p) track.progress = p;
        },
      });
      if (track.deleted) return;
      const downloaded = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith(PROGRESS_MARK)).pop();
      track.stage = 'converting';
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
      delete track.stage;
      delete track.progress;
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
    this.unindex(track);
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
      return new HttpError(422, 'unsupported_link', "That link isn't from a site yt-dlp can get a track from.");
    case 'blocked':
      return new HttpError(502, 'blocked', `YouTube asked to confirm this isn't a bot: ${e.message}`);
    case 'timeout':
      return new HttpError(504, 'timeout', 'Looking the link up took too long.');
    default:
      return new HttpError(502, 'lookup_failed', e.message);
  }
}

// A short link that can't be followed, or leads somewhere it may not, is
// unsupported_link, like any other link yt-dlp won't take.
function shortLinkError(e) {
  if (!(e instanceof ShortLinkError)) return e;
  switch (e.reason) {
    case 'refused':
      return new HttpError(422, 'unsupported_link', e.message);
    case 'timeout':
      return new HttpError(504, 'timeout', e.message);
    default:
      return new HttpError(502, 'lookup_failed', e.message);
  }
}

module.exports = {
  Tracks, HttpError, FORMAT, ZONE_RE, ID_RE, parseProgress, serviceName, pickArtwork, artworkCandidates,
  normalizeUrl, stripTracking, youtubeId, trackId,
};
