// canopy-cmdlp: links from YouTube, SoundCloud, Bandcamp, Mixcloud, and
// archive.org, as audio a Canopy Music hub can play. README.md says how
// it works; openapi.yaml is the API.

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { YtDlp } = require('./lib/ytdlp');
const { Tracks, HttpError, ID_RE } = require('./lib/tracks');
const { run } = require('./lib/run');

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const DATA_DIR = path.resolve(env.DATA_DIR || './data');
const TOKEN = env.CMDLP_TOKEN || '';
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/+$/, '');
const MAX_AGE_HOURS = Number(env.MAX_AGE_HOURS) || 24;
const SWEEP_MINUTES = Number(env.SWEEP_MINUTES) || 15;

if (TOKEN.length < 16) {
  console.error('CMDLP_TOKEN is missing or shorter than 16 characters. Make one with: openssl rand -base64 32');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

const ytdlp = new YtDlp({
  dataDir: DATA_DIR,
  stable: env.YTDLP_STABLE || '/usr/local/lib/yt-dlp/yt-dlp',
  autoUpdate: env.YTDLP_AUTO_UPDATE !== '0',
  cookies: env.YTDLP_COOKIES || null,
  log,
});
const tracks = new Tracks({
  dataDir: DATA_DIR,
  ytdlp,
  maxAgeMs: MAX_AGE_HOURS * 60 * 60 * 1000,
  concurrency: Number(env.DOWNLOAD_CONCURRENCY) || 2,
  log,
});

// ---- auth ----

function sha(s) {
  return crypto.createHash('sha256').update(s).digest();
}

function bearerOk(req) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  return !!m && crypto.timingSafeEqual(sha(m[1]), sha(TOKEN));
}

// Sonos fetches a URL with no way to add a header, so an audio URL carries
// its own key: an HMAC of the track id under the token. It opens that one
// file and nothing else, and stops working if the token changes.
function audioSig(id) {
  return crypto.createHmac('sha256', TOKEN).update(`audio:${id}`).digest('base64url').slice(0, 32);
}

function requireToken(req, res, next) {
  if (bearerOk(req)) return next();
  next(new HttpError(401, 'unauthorized', 'Send Authorization: Bearer <CMDLP_TOKEN>.'));
}

// ---- answers ----

function baseUrl(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function trackJson(req, t) {
  const out = {
    id: t.id,
    zone: t.zone,
    status: t.status,
    title: t.title,
    artist: t.artist,
    duration: t.duration,
    artwork: t.artwork,
    source: t.source,
    webpageUrl: t.webpageUrl,
    url: t.url,
    audioUrl: `${baseUrl(req)}/audio/${t.id}.m4a?sig=${audioSig(t.id)}`,
    createdAt: t.createdAt,
  };
  if (t.status === 'ready') Object.assign(out, { readyAt: t.readyAt, size: t.size, codec: t.codec, transcoded: t.transcoded });
  if (t.status === 'failed') out.error = t.error;
  return out;
}

// ---- app ----

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // Coolify's proxy says who asked and over what
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/health', async (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    ytdlp: {
      version: ytdlp.versions.current,
      previous: ytdlp.versions.previous,
      stable: ytdlp.versions.stable,
      updating: !!ytdlp.updating,
      lastUpdate: ytdlp.lastUpdate,
    },
    deno: denoVersion,
    tracks: tracks.tracks.size,
    downloading: tracks.active,
    queued: tracks.queue.length,
  });
});

app.get('/audio/:file', (req, res, next) => {
  const id = req.params.file.replace(/\.m4a$/, '');
  if (!ID_RE.test(id)) return next(new HttpError(404, 'not_found', 'No such track.'));
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  const sigOk = sig.length > 0 && crypto.timingSafeEqual(sha(sig), sha(audioSig(id)));
  if (!sigOk && !bearerOk(req)) return next(new HttpError(401, 'unauthorized', 'Send the audioUrl as given, or Authorization: Bearer <CMDLP_TOKEN>.'));
  const t = tracks.get(id);
  if (!t) return next(new HttpError(404, 'not_found', 'No such track.'));
  if (t.status === 'failed') return next(new HttpError(410, 'failed', `The download failed: ${t.error}`));
  if (t.status !== 'ready') return next(new HttpError(409, 'not_ready', 'Still downloading; GET /tracks/{id} says when it is ready.'));
  // send() answers Range requests (206) and HEAD itself.
  res.sendFile(tracks.file(t, '.m4a'), {
    headers: { 'Content-Type': 'audio/mp4', 'Cache-Control': 'private, max-age=86400' },
    acceptRanges: true,
    lastModified: true,
    etag: true,
  }, (err) => {
    if (err && !res.headersSent) next(err);
  });
});

app.use(express.json({ limit: '16kb' }));

app.post('/resolve', requireToken, async (req, res, next) => {
  try {
    const { url, zone } = req.body || {};
    if (typeof url !== 'string') throw new HttpError(400, 'bad_url', 'url is required.');
    if (typeof zone !== 'string') throw new HttpError(400, 'bad_zone', 'zone is required.');
    const t = await tracks.resolve(url.trim(), zone);
    res.set('Cache-Control', 'no-store').json(trackJson(req, t));
  } catch (e) {
    next(e);
  }
});

app.get('/tracks/:id', requireToken, (req, res, next) => {
  const t = tracks.get(req.params.id);
  if (!t) return next(new HttpError(404, 'not_found', 'No such track (or its zone was deleted).'));
  res.set('Cache-Control', 'no-store').json(trackJson(req, t));
});

app.delete('/zones/:zone', requireToken, async (req, res, next) => {
  try {
    const deleted = await tracks.deleteZone(req.params.zone);
    res.json({ zone: req.params.zone, deleted });
  } catch (e) {
    next(e);
  }
});

app.use((req, res, next) => next(new HttpError(404, 'not_found', 'No such endpoint.')));

// Every error is {"error": "<a sentence>", "reason": "<snake_case>"}.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'bad_json', 'The body is not JSON.');
  if (err.type === 'entity.too.large') err = new HttpError(413, 'too_large', 'The body is too big.');
  if (!(err instanceof HttpError)) {
    log('error:', err.stack || err);
    err = new HttpError(500, 'internal', 'Something went wrong.');
  }
  res.status(err.status).set('Cache-Control', 'no-store').json({ error: err.message, reason: err.reason });
});

// ---- start ----

let denoVersion = null;

async function start() {
  try {
    const r = await run('deno', ['--version'], { timeoutMs: 30_000 });
    denoVersion = r.code === 0 ? r.stdout.split(/\s+/)[1] || null : null; // "deno 2.9.7 (stable, ...)"
  } catch {
    log('deno is not installed: YouTube links will fail');
  }
  await ytdlp.init();
  await tracks.init();
  setInterval(() => tracks.sweep().catch((e) => log('sweep failed:', e.message)), SWEEP_MINUTES * 60_000).unref();
  tracks.sweep().catch((e) => log('sweep failed:', e.message));
  const server = app.listen(PORT, () => log(`canopy-cmdlp on :${PORT}, data in ${DATA_DIR}`));
  const stop = () => {
    log('stopping');
    tracks.stop();
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
