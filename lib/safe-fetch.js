// Asking another server for its headers (artwork checks, short links)
// without a link ever reaching this server's own network: https only, a
// name for a host (never an address), and every address that name has
// must be public. The check is in the socket's own DNS lookup, so the
// address checked is the address connected to: a name that answers
// "public" to the check and "internal" to the connection (DNS rebinding)
// can't slip between them. The connected address is checked again before
// anything is sent.
//
// Only the status and headers come back; the body is never read.

const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');

// Everything that isn't the public internet. Two lists, because one
// BlockList matches an IPv4 address against IPv4-mapped IPv6 rules too:
// ::ffff:0:0/96 alongside would block every IPv4 address there is.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, and cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private (Docker's networks among them)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
]) BLOCKED_V4.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 96], // unspecified, loopback (::1), and IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped (::ffff:127.0.0.1)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (Teredo among them)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
]) BLOCKED_V6.addSubnet(a, p, 'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  try {
    return family === 4 ? !BLOCKED_V4.check(address, 'ipv4') : !BLOCKED_V6.check(address, 'ipv6');
  } catch {
    return false;
  }
}

class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.code = 'EUNSAFEURL';
  }
}

class NotPublicError extends Error {
  constructor(host, address) {
    super(`${host} is at ${address}, which isn't a public address`);
    this.code = 'ENOTPUBLIC';
    this.host = host;
    this.address = address;
  }
}

const defaultResolve = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

// A lookup for net.connect: the name's addresses, all of them public, or
// an error. One internal address among public ones refuses the lot.
function guardedLookup(resolve) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const want = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0;
    Promise.resolve()
      .then(() => resolve(hostname))
      .then((found) => {
        const all = (found || []).map((a) => (typeof a === 'string' ? { address: a, family: net.isIP(a) } : a));
        if (!all.length) throw Object.assign(new Error(`${hostname} has no address`), { code: 'ENOTFOUND' });
        const bad = all.find((a) => !isPublicAddress(a.address));
        if (bad) throw new NotPublicError(hostname, bad.address);
        const list = want ? all.filter((a) => a.family === want) : all;
        if (!list.length) throw Object.assign(new Error(`${hostname} has no IPv${want} address`), { code: 'ENOTFOUND' });
        if (options.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      })
      .catch((e) => callback(e));
  };
}

// fetch(), cut down: `fetch(url, { method, headers, signal })` answers with
// { status, url, headers (a Headers), body: { cancel() } } and never
// follows a redirect. `resolve` is the DNS lookup (the tests fake it).
function createSafeFetch({ resolve = defaultResolve, timeoutMs = 10_000 } = {}) {
  const lookup = guardedLookup(resolve);
  return function safeFetch(url, { method = 'GET', headers = {}, signal } = {}) {
    return new Promise((done, fail) => {
      let u;
      try {
        u = new URL(url);
      } catch {
        return fail(new UnsafeUrlError('not a link'));
      }
      if (u.protocol !== 'https:') return fail(new UnsafeUrlError(`${u.protocol} isn't https`));
      if (u.username || u.password) return fail(new UnsafeUrlError('a link with a user name'));
      // net.connect skips the lookup for an address, so none are allowed.
      if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) return fail(new UnsafeUrlError('an address, not a host name'));
      const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      if (sig.aborted) return fail(sig.reason);
      const req = https.request(u, {
        method,
        headers: { 'user-agent': 'canopy-cmdlp', ...headers },
        lookup,
        agent: false,
        signal: sig,
      });
      // The address really connected to, before the request goes out.
      req.on('socket', (socket) => {
        const check = () => {
          const a = socket.remoteAddress;
          if (a && !isPublicAddress(a)) socket.destroy(new NotPublicError(u.hostname, a));
        };
        socket.once('connect', check);
        socket.once('secureConnect', check);
      });
      req.on('error', fail);
      req.on('response', (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          for (const x of Array.isArray(v) ? v : [v]) {
            try {
              h.append(k, x);
            } catch {}
          }
        }
        // Headers only: the body is never read.
        res.destroy();
        done({ status: res.statusCode, url: u.href, headers: h, body: { cancel: async () => {} } });
      });
      req.end();
    });
  };
}

const safeFetch = createSafeFetch();

module.exports = { safeFetch, createSafeFetch, isPublicAddress, guardedLookup, NotPublicError, UnsafeUrlError };
