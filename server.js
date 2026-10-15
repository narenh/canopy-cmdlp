// canopy-cmdlp: links from YouTube, SoundCloud, Bandcamp, Mixcloud, and
// archive.org, as audio a Canopy Music hub can play. README.md says how
// it works; openapi.yaml is the API.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { YtDlp } = require('./lib/ytdlp');
const { Tracks, HttpError, ID_RE, serviceName } = require('./lib/tracks');
const { Tokens } = require('./lib/tokens');
const { run } = require('./lib/run');
const pages = require('./lib/pages');
const adminRouter = require('./lib/admin');
const createCanopyAccount = require('./lib/canopy-account');
const { BASE: CANOPY_BASE, PRODUCTION } = require('./lib/domain');

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const DATA_DIR = path.resolve(env.DATA_DIR || './data');
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/+$/, '');
const MAX_AGE_HOURS = Number(env.MAX_AGE_HOURS) || 24;
const SWEEP_MINUTES = Number(env.SWEEP_MINUTES) || 15;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// The admin page's sign-in. Without both, the admin page says it isn't
// set up; the API works the same either way.
const canopy = env.CANOPY_ACCOUNT_URL && env.CANOPY_ACCOUNT_KEY
  ? createCanopyAccount({ url: env.CANOPY_ACCOUNT_URL, key: env.CANOPY_ACCOUNT_KEY })
  : null;

const tokens = new Tokens({ dataDir: DATA_DIR });

// What audio URLs are signed with (below): 32 random bytes, made on the
// first start and kept on the volume, so audioUrls survive a restart.
// Nothing to do with the API tokens, so regenerating one doesn't break a
// queue in progress.
function audioKey() {
  const p = path.join(DATA_DIR, 'audio-key');
  try {
    return fs.readFileSync(p);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(p, key, { mode: 0o600 });
    return key;
  }
}
const AUDIO_KEY = audioKey();

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

// An API token from the admin page (lib/tokens.js).
function bearerOk(req) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  return !!m && !!tokens.verify(m[1]);
}

// Sonos fetches a URL with no way to add a header, so an audio URL carries
// its own key: an HMAC of the track id under AUDIO_KEY. It opens that one
// file and nothing else.
function audioSig(id) {
  return crypto.createHmac('sha256', AUDIO_KEY).update(`audio:${id}`).digest('base64url').slice(0, 32);
}

function requireToken(req, res, next) {
  if (bearerOk(req)) return next();
  next(new HttpError(401, 'unauthorized', 'Send Authorization: Bearer <token>, with a token from the admin page.'));
}

// ---- answers ----

// Where this service is, for the URLs in answers (audioUrl, and artwork of
// its own): PUBLIC_URL, or in production https://cmdlp.<CANOPY_DOMAIN>,
// or else the address the request came to (local development).
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  if (PRODUCTION) return `https://cmdlp.${CANOPY_BASE}`;
  return `${req.protocol}://${req.get('host')}`;
}

function trackJson(req, t) {
  const out = {
    id: t.id,
    zone: t.zone,
    status: t.status,
    title: t.title,
    artist: t.artist,
    duration: t.duration,
    // A path is artwork this service has (public/artwork/), made absolute.
    artwork: t.artwork && t.artwork.startsWith('/') ? baseUrl(req) + t.artwork : t.artwork,
    source: t.source,
    service: serviceName(t.source),
    webpageUrl: t.webpageUrl,
    url: t.url,
    audioUrl: `${baseUrl(req)}/audio/${t.id}.m4a?sig=${audioSig(t.id)}`,
    createdAt: t.createdAt,
  };
  if (t.status === 'pending') Object.assign(out, { stage: t.stage || 'queued', progress: t.progress || null });
  if (t.status === 'ready') Object.assign(out, { readyAt: t.readyAt, size: t.size, codec: t.codec, transcoded: t.transcoded });
  if (t.status === 'failed') out.error = t.error;
  return out;
}

// ---- app ----

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // Coolify's proxy says who asked and over what
// No framing (a page in someone else's frame is how a click gets stolen),
// no MIME sniffing, and no full URLs in Referer.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.get('/', (req, res) => {
  res.send(pages.home());
});

app.get('/canopy-logo.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'canopy-logo.png'), { maxAge: '1d' });
});

// Fallback artwork (lib/tracks.js, pickArtwork). No token: Sonos and the
// hubs fetch artwork with no headers.
app.use('/artwork', express.static(path.join(__dirname, 'public', 'artwork'), { maxAge: '1d', index: false }));

app.use(adminRouter({ tokens, tracks, trackJson, canopy, adminEmail: env.ADMIN_EMAIL }));

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
  if (!sigOk && !bearerOk(req)) return next(new HttpError(401, 'unauthorized', 'Send the audioUrl as given, or Authorization: Bearer <token>.'));
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
  await tokens.init();
  if (!tokens.tokens.length) log('no API tokens yet: make one at /admin');
  if (!canopy) log('CANOPY_ACCOUNT_URL and CANOPY_ACCOUNT_KEY are not set: nobody can sign in to /admin');
  else if (!env.ADMIN_EMAIL) log('ADMIN_EMAIL is not set: nobody can get into /admin');
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
