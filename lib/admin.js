// The admin page (/admin) and its API (/admin/api/tokens), for making,
// regenerating, and revoking API tokens. Only for the one admin: someone
// signed in with Canopy Accounts whose proven email is ADMIN_EMAIL.
//
// Who's signed in comes from /api/session on the account service (lib/
// canopy-account.js), with the "cmdlp" site's key. That site has to be
// granted the visitor's `email` in the account admin's Sites tab, and
// nothing else: without the grant, /api/session leaves `email` out, and
// nobody can be told apart from the admin. Quick (unverified) accounts
// aren't allowed on it either.
//
// The API is the cookie's, so every change (POST, DELETE) must come from
// a Canopy page by its Origin header, as on the other Canopy sites (the
// account service's README, "The Origin check").

const express = require('express');
const pages = require('./pages');
const { isCanopyOrigin } = require('./domain');
const { TokenError } = require('./tokens');

// { ok: true, person } or { ok: false, status, reason, title, text, actions,
// redirect }: what the gate says about this visitor.
async function check(req, res, { canopy, adminEmail }) {
  if (!canopy) {
    return {
      ok: false, status: 503, reason: 'not_set_up',
      title: 'Sign-in isn\'t set up',
      text: 'CANOPY_ACCOUNT_URL and CANOPY_ACCOUNT_KEY aren\'t set, so nobody can sign in here.',
    };
  }
  let who;
  try {
    who = await canopy.whoIs(req, res);
  } catch (err) {
    if (!err.canopyUnreachable) throw err;
    console.error(`[canopy-account] ${err.message}`);
    return {
      ok: false, status: 503, reason: 'accounts_unreachable',
      title: 'Canopy Accounts can\'t be reached',
      text: 'Signing in goes through Canopy Accounts, which didn\'t answer. Try again in a minute.',
    };
  }
  const signOut = { href: canopy.signOutUrl(req, `${req.protocol}://${req.get('host')}/admin`), text: 'Sign in as someone else', secondary: true };
  if (!who.person) {
    if (who.unverified) {
      return {
        ok: false, status: 403, reason: 'email_unverified',
        title: 'Not allowed',
        text: 'Your Canopy Account\'s email isn\'t confirmed yet, and only a confirmed admin can manage tokens.',
        actions: [{ href: canopy.verifyUrl(req), text: 'Confirm your email' }, signOut],
      };
    }
    return { ok: false, status: 401, reason: 'signed_out', redirect: canopy.signInUrl(req) };
  }
  const p = who.person;
  if (!adminEmail) {
    return {
      ok: false, status: 403, reason: 'admin_email_not_set',
      title: 'Not allowed',
      text: 'ADMIN_EMAIL isn\'t set, so nobody is the admin. Set it to the admin\'s Canopy Account email and redeploy.',
      actions: [signOut],
    };
  }
  if (!('email' in p)) {
    return {
      ok: false, status: 403, reason: 'email_not_granted',
      title: 'Not allowed',
      text: 'Canopy Accounts didn\'t say who you are by email: the "cmdlp" site needs the email field granted in the account admin\'s Sites tab.',
      actions: [signOut],
    };
  }
  if (!p.emailVerified || String(p.email || '').toLowerCase() !== adminEmail.toLowerCase()) {
    return {
      ok: false, status: 403, reason: 'not_admin',
      title: 'Not allowed',
      text: 'Only the admin can manage API tokens, and this Canopy Account isn\'t theirs.',
      actions: [signOut],
    };
  }
  return { ok: true, person: p };
}

module.exports = function adminRouter({ tokens, canopy, adminEmail }) {
  const router = express.Router();
  const opts = { canopy, adminEmail: (adminEmail || '').trim() };

  router.get('/admin', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const g = await check(req, res, opts);
      if (g.redirect) return res.redirect(g.redirect);
      if (!g.ok) return res.status(g.status).send(pages.message(g.title, g.text, g.actions));
      res.send(pages.admin({
        person: g.person,
        tokens: tokens.list(),
        signOutUrl: canopy.signOutUrl(req, `${req.protocol}://${req.get('host')}/`),
      }));
    } catch (e) {
      next(e);
    }
  });

  // The API: the same gate, answered as JSON, and the Origin check.
  const api = express.Router();
  api.use(express.json({ limit: '4kb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (isCanopyOrigin(req.get('origin'))) return next();
    res.status(403).json({ error: 'Changes must come from a Canopy page.', reason: 'bad_origin' });
  });
  api.use(async (req, res, next) => {
    try {
      const g = await check(req, res, opts);
      if (g.ok) return next();
      const body = { error: g.text || 'Sign in with your Canopy Account first.', reason: g.reason };
      if (g.redirect) body.signIn = g.redirect;
      res.status(g.status).json(body);
    } catch (e) {
      next(e);
    }
  });

  const handle = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof TokenError) return res.status(e.status).json({ error: e.message, reason: e.reason });
      next(e);
    }
  };

  api.get('/tokens', handle(async (req, res) => {
    res.json({ tokens: tokens.list() });
  }));
  api.post('/tokens', handle(async (req, res) => {
    res.status(201).json(await tokens.create((req.body || {}).label));
  }));
  api.post('/tokens/:id/regenerate', handle(async (req, res) => {
    res.json(await tokens.regenerate(req.params.id));
  }));
  api.delete('/tokens/:id', handle(async (req, res) => {
    await tokens.revoke(req.params.id);
    res.status(204).end();
  }));

  router.use('/admin/api', api);
  return router;
};
