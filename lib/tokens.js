// API tokens: what the Canopy Music hubs send as `Authorization: Bearer`.
// Made, regenerated, and revoked on the admin page (lib/admin.js), and kept
// in DATA_DIR/tokens.json:
//
//   { "tokens": [ { id, label, hash, hint, createdAt, regeneratedAt, lastUsedAt } ] }
//
// Only a token's SHA-256 is kept, never the token: it's shown once, when
// it's made (or regenerated), and can't be shown again. A token is 32
// random bytes, so a plain hash is enough; nothing to slow down guessing.
// `hint` is its last four characters, so the admin can tell which is
// which.

const crypto = require('node:crypto');
const fsp = require('node:fs').promises;
const path = require('node:path');

const PREFIX = 'cmdlp_';
const TOKEN_RE = /^cmdlp_[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{12}$/;
const LABEL_MAX = 60;

// lastUsedAt is written at most this often, not on every request.
const LAST_USED_SAVE_MS = 60_000;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function newToken() {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: hash(token), hint: token.slice(-4) };
}

class TokenError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

function cleanLabel(label) {
  const l = typeof label === 'string' ? label.trim().replace(/\s+/g, ' ') : '';
  if (!l) throw new TokenError(400, 'bad_label', 'Give the token a label, like "Living Room iPad".');
  if (l.length > LABEL_MAX) throw new TokenError(400, 'bad_label', `A label is at most ${LABEL_MAX} characters.`);
  return l;
}

class Tokens {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'tokens.json');
    this.tokens = [];
    this.byHash = new Map();
    this.writing = Promise.resolve();
    this.lastUsedTimer = null;
  }

  async init() {
    try {
      this.tokens = JSON.parse(await fsp.readFile(this.file, 'utf8')).tokens || [];
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.tokens = [];
    }
    this.reindex();
  }

  reindex() {
    this.byHash = new Map(this.tokens.map((t) => [t.hash, t]));
  }

  // One write at a time, each to a temporary file renamed into place.
  save() {
    const body = JSON.stringify({ tokens: this.tokens }, null, 2);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, body, { mode: 0o600 });
      await fsp.rename(tmp, this.file);
    });
    return this.writing;
  }

  // What the admin page shows: everything but the hash.
  list() {
    return this.tokens.map(({ hash: _, ...t }) => t);
  }

  // The token's record if `raw` is a live token, else null.
  verify(raw) {
    if (typeof raw !== 'string' || !TOKEN_RE.test(raw)) return null;
    const t = this.byHash.get(hash(raw));
    if (!t) return null;
    t.lastUsedAt = new Date().toISOString();
    if (!this.lastUsedTimer) {
      this.lastUsedTimer = setTimeout(() => {
        this.lastUsedTimer = null;
        this.save().catch((e) => console.error('tokens: saving lastUsedAt failed:', e.message));
      }, LAST_USED_SAVE_MS);
      this.lastUsedTimer.unref();
    }
    return t;
  }

  find(id) {
    const t = ID_RE.test(id || '') && this.tokens.find((x) => x.id === id);
    if (!t) throw new TokenError(404, 'not_found', 'No such token.');
    return t;
  }

  // { token, record }: the only time the token itself is ever seen.
  async create(label) {
    const l = cleanLabel(label);
    const { token, hash: h, hint } = newToken();
    const t = {
      id: crypto.randomBytes(9).toString('base64url'),
      label: l,
      hash: h,
      hint,
      createdAt: new Date().toISOString(),
      regeneratedAt: null,
      lastUsedAt: null,
    };
    this.tokens.push(t);
    this.reindex();
    await this.save();
    const { hash: _, ...record } = t;
    return { token, record };
  }

  // A new token under the same label; the old one stops working now.
  async regenerate(id) {
    const t = this.find(id);
    const { token, hash: h, hint } = newToken();
    Object.assign(t, { hash: h, hint, regeneratedAt: new Date().toISOString(), lastUsedAt: null });
    this.reindex();
    await this.save();
    const { hash: _, ...record } = t;
    return { token, record };
  }

  async revoke(id) {
    const t = this.find(id);
    this.tokens = this.tokens.filter((x) => x !== t);
    this.reindex();
    await this.save();
  }
}

module.exports = { Tokens, TokenError, TOKEN_RE, hash };
