// Which pages count as Canopy's, for the Origin check on the admin page's
// changes: https on canopysf.com or any subdomain of it. The same answer
// as canopy-events' lib/domain.js. CANOPY_DOMAIN overrides the domain.
// Outside production, http on localhost and 127.0.0.1 counts too, so it
// can be run and tested locally.

const BASE = (process.env.CANOPY_DOMAIN || 'canopysf.com').toLowerCase();
const PRODUCTION = process.env.NODE_ENV === 'production';

// A URL is a Canopy page: https on the domain or a subdomain of it, with
// no username/password part (https://canopysf.com@evil.example reads as
// canopysf.com to a person and evil.example to a browser).
function isCanopyUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!PRODUCTION && url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) return true;
  return url.protocol === 'https:' && (host === BASE || host.endsWith('.' + BASE));
}

// An Origin header value ("https://cmdlp.canopysf.com") is a Canopy page.
function isCanopyOrigin(origin) {
  return !!origin && origin !== 'null' && isCanopyUrl(origin);
}

module.exports = { BASE, PRODUCTION, isCanopyUrl, isCanopyOrigin };
