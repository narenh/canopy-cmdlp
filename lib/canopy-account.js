// Canopy Accounts: who's signed in, for the admin page only. Adapted from
// canopy-events' lib/canopy-account.js (itself the account service's
// client/canopy-account.js), cut down to what cmdlp uses:
//
//   const canopy = require('./lib/canopy-account')({
//     url: process.env.CANOPY_ACCOUNT_URL,   // https://account.canopysf.com
//     key: process.env.CANOPY_ACCOUNT_KEY    // the "cmdlp" site's, from the Sites tab
//   });
//   const { person, unverified } = await canopy.whoIs(req, res);
//
// One change from the original: the visitor's session only ever comes
// from their canopy_session cookie. Here `Authorization: Bearer` is an
// API token (lib/tokens.js), never a Canopy session, so it's ignored.
//
// person is { id, emailVerified, firstName, lastName, shortName,
// photoUrl, findable }, plus whichever of the visitor's own contact
// fields the account admin granted this site in the Sites tab. cmdlp
// needs `email` (to know the admin) and nothing else. A field that
// wasn't granted isn't there at all.
//
// The "cmdlp" site doesn't allow quick (unverified) accounts, so someone
// whose email isn't proven gets { person: null, unverified: true }.
//
// Answers are cached for a minute per visitor, so a sign-out can take
// that long to show here. If the account service can't be reached, a
// cached answer up to 15 minutes old stands in; past that, whoIs throws
// an error with `canopyUnreachable: true`.

const crypto = require('node:crypto');

const COOKIE = 'canopy_session';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

module.exports = function createCanopyAccount({ url, key, cacheMs = 60 * 1000 } = {}) {
  if (!url || !key) throw new Error('canopy-account: url and key are both required');
  const base = String(url).replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${key}` };

  // token hash -> { answer: { person, unverified }, at }
  const cache = new Map();
  const STALE_OK_MS = 15 * 60 * 1000;

  function readCookie(req) {
    const pair = String(req.headers.cookie || '')
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(COOKIE + '='));
    const token = pair && pair.slice(COOKIE.length + 1);
    return token && TOKEN_RE.test(token) ? token : null;
  }

  const NOBODY = { person: null, unverified: false };

  async function whoIs(req, res) {
    const token = readCookie(req);
    if (!token) return NOBODY;
    const id = crypto.createHash('sha256').update(token).digest('hex');
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < cacheMs) return hit.answer;
    let body;
    try {
      const r = await fetch(`${base}/api/session`, {
        headers: { ...headers, 'X-Canopy-Session': token, 'X-Canopy-Site-Host': req.hostname || '' },
      });
      if (!r.ok) throw new Error(`account service answered ${r.status}`);
      body = await r.json();
    } catch (err) {
      if (hit && Date.now() - hit.at < STALE_OK_MS) return hit.answer;
      err.canopyUnreachable = true;
      throw err;
    }
    // The cookie's year is renewed from here as well as from the account
    // service itself.
    if (body.renewCookie) res.append('Set-Cookie', body.renewCookie);
    const answer = { person: body.person || null, unverified: !body.person && !!body.unverified };
    if (cache.size > 5000) cache.clear();
    cache.set(id, { answer, at: Date.now() });
    return answer;
  }

  function hereUrl(req) {
    return `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  }

  // Sign in, and back to `returnTo` (this page, by default).
  function signInUrl(req, returnTo) {
    return `${base}/?return=${encodeURIComponent(returnTo || hereUrl(req))}`;
  }

  // Prove the email (a code), and back.
  function verifyUrl(req, returnTo) {
    return `${base}/profile?verify=1&return=${encodeURIComponent(returnTo || hereUrl(req))}`;
  }

  // Sign out of every Canopy site, and back.
  function signOutUrl(req, returnTo) {
    return `${base}/signout?return=${encodeURIComponent(returnTo || `${req.protocol}://${req.get('host')}/`)}`;
  }

  return { whoIs, signInUrl, verifyUrl, signOutUrl, base };
};
