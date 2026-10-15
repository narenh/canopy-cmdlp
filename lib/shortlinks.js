// Short links (on.soundcloud.com/<code>), followed here because yt-dlp
// can't: no extractor of its own takes them, and only the generic one,
// which is never allowed, would follow the redirect.
//
// Only hosts on SHORTENERS are followed, and each may only lead to its own
// site: on.soundcloud.com to soundcloud.com, say. Every request goes
// through the guarded fetch (lib/safe-fetch.js): https, a public address,
// headers only. The site itself is never asked here; its link goes to
// yt-dlp as for any pasted link.

// Shortener host -> the hosts its links may lead to.
const SHORTENERS = {
  'on.soundcloud.com': { site: 'SoundCloud', hosts: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'] },
};

const MAX_HOPS = 5;
const TIMEOUT_MS = 5000;

class ShortLinkError extends Error {
  // reason: 'refused' (it doesn't lead somewhere allowed), 'timeout', or
  // 'failed' (the shortener couldn't be asked).
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

function shortener(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? SHORTENERS[u.hostname.toLowerCase()] || null : null;
  } catch {
    return null;
  }
}

const isRedirect = (s) => [301, 302, 303, 307, 308].includes(s);

// HEAD, or a GET (headers only) when HEAD isn't answered properly: a
// redirect, or a page that's there, or one that isn't (404, 410), counts as
// answered; anything else (405, 501, a 403, a 5xx) is asked again with GET.
async function ask(url, fetchFn, signal) {
  const head = await fetchFn(url, { method: 'HEAD', signal });
  const s = head.status;
  if ((isRedirect(s) && head.headers.get('location')) || (s >= 200 && s < 300) || s === 404 || s === 410) return head;
  return fetchFn(url, { method: 'GET', signal });
}

// The link `url` (on a shortener's host) leads to, without asking that
// link's own site. Throws a ShortLinkError.
async function followShortLink(url, fetchFn, { maxHops = MAX_HOPS, timeoutMs = TIMEOUT_MS } = {}) {
  const first = shortener(url);
  if (!first) throw new ShortLinkError('refused', 'Not a short link.');
  const landing = new Set(first.hosts);
  const signal = AbortSignal.timeout(timeoutMs);
  let current = new URL(url);
  // Pasted as http, still asked over https: nothing goes out in the clear.
  current.protocol = 'https:';
  current.hash = '';
  for (let hop = 0; hop < maxHops; hop++) {
    let r;
    try {
      r = await ask(current.href, fetchFn, signal);
    } catch (e) {
      if (signal.aborted) throw new ShortLinkError('timeout', 'Following the short link took too long.');
      if (e && e.code === 'ENOTPUBLIC') throw new ShortLinkError('refused', "That short link leads to an address that isn't public.");
      if (e && e.code === 'EUNSAFEURL') throw new ShortLinkError('refused', `That short link can't be followed: ${e.message}.`);
      throw new ShortLinkError('failed', `Couldn't follow the short link: ${(e && e.message) || e}`);
    }
    const location = r.headers.get('location');
    if (isRedirect(r.status) && location) {
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new ShortLinkError('refused', 'That short link redirects to something that is not a link.');
      }
      if (next.protocol !== 'https:') throw new ShortLinkError('refused', `That short link redirects to a ${next.protocol.replace(':', '')} link, not https.`);
      if (next.username || next.password) throw new ShortLinkError('refused', 'That short link redirects to a link with a user name in it.');
      const host = next.hostname.toLowerCase();
      if (landing.has(host)) return next.href;
      if (SHORTENERS[host]) {
        current = next;
        current.hash = '';
        continue;
      }
      throw new ShortLinkError('refused', `That short link leads to ${host}, not ${first.site}.`);
    }
    if (r.status === 404 || r.status === 410) throw new ShortLinkError('refused', "That short link doesn't lead anywhere (it may have expired).");
    if (r.status >= 200 && r.status < 300) throw new ShortLinkError('refused', "That short link doesn't redirect anywhere.");
    throw new ShortLinkError('failed', `Couldn't follow the short link: ${current.hostname} answered ${r.status}.`);
  }
  throw new ShortLinkError('refused', `That short link redirects more than ${maxHops} times.`);
}

module.exports = { SHORTENERS, MAX_HOPS, TIMEOUT_MS, ShortLinkError, shortener, followShortLink };
