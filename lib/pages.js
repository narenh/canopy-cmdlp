// The two pages people see: the homepage (/) and the admin page (/admin),
// plus the message pages the admin gate shows. Plain HTML strings; every
// value that came from someone (a name, a label) goes through esc().
// The stylesheet and the admin page's script are inlined, read once at
// startup.

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const CSS = fs.readFileSync(path.join(PUBLIC, 'cmdlp.css'), 'utf8');
const ADMIN_JS = fs.readFileSync(path.join(PUBLIC, 'admin.js'), 'utf8');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// JSON inside <script type="application/json">, which can't contain "</".
function jsonForScript(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="12" cy="12" r="3"/>'
  + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  + '</svg>';

const LOGO = '<a href="/"><img src="/canopy-logo.png" alt="Canopy Music" class="site-logo"></a>';

function layout(title, body, { script = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="theme-color" content="#03120c">
<meta name="robots" content="noindex, nofollow">
<style>${CSS}</style>
</head>
<body class="mesh-bg">
${body}
${script}
</body>
</html>`;
}

function home() {
  return layout('Canopy Music links', `<main class="wrap">
  <header class="top">${LOGO}<div class="end"><a class="gear" href="/admin" aria-label="Settings" title="Settings">${GEAR}</a></div></header>
  <section class="card">
    <h1>Songs from anywhere, at a Canopy Music party</h1>
    <p>Guests at a Canopy Music party queue songs from their phones. Most come from Apple Music or Spotify. This is for the rest: a guest pastes a link from <span class="sites">YouTube, SoundCloud, Bandcamp, Mixcloud, or archive.org</span>, and the song plays like any other.</p>
    <p>As soon as a song is queued, this fetches its audio, so it's ready by the time it plays. Each party keeps its own, and it's deleted when the party ends (or after a day, if that comes first).</p>
    <p>Only the party's Canopy Music hub (an iPad, Apple TV, or Mac) talks to it, with a token made on the settings page.</p>
  </section>
</main>`);
}

// A page that's only a message. `actions` are links: [{ href, text, secondary }].
function message(title, text, actions = []) {
  const links = actions.map((a) => `<a class="button${a.secondary ? ' secondary' : ''}" href="${esc(a.href)}">${esc(a.text)}</a>`).join('');
  return layout(title, `<main class="card message">
  ${LOGO}
  <h1>${esc(title)}</h1>
  <p>${esc(text)}</p>
  ${links ? `<div class="actions">${links}</div>` : ''}
</main>`);
}

function admin({ person, tokens, signOutUrl }) {
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email;
  return layout('API tokens', `<main class="wrap">
  <header class="top">${LOGO}<div class="end"><span>${esc(name)}</span><a href="${esc(signOutUrl)}">Sign out</a></div></header>
  <section class="card reveal hidden" id="reveal" aria-live="polite">
    <h2 id="revealTitle">Your new token</h2>
    <p>Copy it into the hub now. It's shown this once; if it's lost, regenerate it.</p>
    <code id="revealToken"></code>
    <div class="row"><button type="button" id="copy">Copy</button><button type="button" class="secondary" id="done">Done</button></div>
  </section>
  <section class="card">
    <h1>API tokens</h1>
    <p>Each Canopy Music hub has its own token, which it sends with every request. Regenerating a token or revoking it stops the old one working straight away.</p>
    <form class="new-token" id="newToken">
      <input type="text" id="label" name="label" maxlength="60" placeholder="Living Room iPad" autocomplete="off" aria-label="Label for the new token">
      <button type="submit">Make token</button>
    </form>
    <div class="error" id="error" role="alert"></div>
  </section>
  <section class="card">
    <ul class="tokens" id="tokens"></ul>
    <p class="empty hidden" id="empty">No tokens yet, so no hub can use this.</p>
  </section>
</main>
<script type="application/json" id="pageData">${jsonForScript({ tokens })}</script>`, { script: `<script>${ADMIN_JS}</script>` });
}

module.exports = { home, message, admin, esc };
