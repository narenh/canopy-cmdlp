// The admin page: list, make, regenerate, and revoke API tokens, through
// /admin/api/tokens (lib/admin.js). Inlined into the page by lib/pages.js.
(function () {
  var tokens = JSON.parse(document.getElementById('pageData').textContent).tokens;
  var list = document.getElementById('tokens');
  var empty = document.getElementById('empty');
  var error = document.getElementById('error');
  var reveal = document.getElementById('reveal');

  function when(iso) {
    if (!iso) return null;
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    list.textContent = '';
    empty.classList.toggle('hidden', tokens.length > 0);
    list.classList.toggle('hidden', tokens.length === 0);
    tokens.forEach(function (t) {
      var li = el('li');
      var what = el('div', 'what');
      what.appendChild(el('div', 'label', t.label));
      var meta = el('div', 'meta');
      meta.appendChild(el('span', 'hint', 'cmdlp_…' + t.hint));
      var made = t.regeneratedAt ? 'regenerated ' + when(t.regeneratedAt) : 'made ' + when(t.createdAt);
      var used = t.lastUsedAt ? 'last used ' + when(t.lastUsedAt) : 'never used';
      meta.appendChild(document.createTextNode(' · ' + made + ' · ' + used));
      what.appendChild(meta);
      li.appendChild(what);
      var actions = el('div', 'actions');
      var regen = el('button', 'secondary', 'Regenerate');
      regen.type = 'button';
      regen.onclick = function () {
        if (!confirm('Regenerate "' + t.label + '"? Its current token stops working now, and the hub will need the new one.')) return;
        call('POST', '/admin/api/tokens/' + t.id + '/regenerate').then(function (r) {
          replace(r.record);
          show('New token for ' + r.record.label, r.token);
        }, shown);
      };
      var revoke = el('button', 'danger', 'Revoke');
      revoke.type = 'button';
      revoke.onclick = function () {
        if (!confirm('Revoke "' + t.label + '"? It stops working now.')) return;
        call('DELETE', '/admin/api/tokens/' + t.id).then(function () {
          tokens = tokens.filter(function (x) { return x.id !== t.id; });
          render();
        }, shown);
      };
      actions.appendChild(regen);
      actions.appendChild(revoke);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  function replace(record) {
    tokens = tokens.map(function (x) { return x.id === record.id ? record : x; });
    render();
  }

  function show(title, token) {
    document.getElementById('revealTitle').textContent = title;
    document.getElementById('revealToken').textContent = token;
    document.getElementById('copy').textContent = 'Copy';
    reveal.classList.remove('hidden');
    reveal.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // A failed call's error is already on the page.
  function shown() {}

  // `errorEl`: where a failure's sentence goes (the tokens' by default).
  function call(method, url, body, errorEl) {
    var errBox = errorEl || error;
    errBox.textContent = '';
    return fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function (r) {
      if (r.status === 204) return null;
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Something went wrong.');
        return j;
      });
    }).catch(function (e) {
      errBox.textContent = e.message;
      throw e;
    });
  }

  document.getElementById('newToken').onsubmit = function (ev) {
    ev.preventDefault();
    var input = document.getElementById('label');
    call('POST', '/admin/api/tokens', { label: input.value }).then(function (r) {
      tokens.push(r.record);
      input.value = '';
      render();
      show('Token for ' + r.record.label, r.token);
    }, shown);
  };

  document.getElementById('copy').onclick = function () {
    var btn = this;
    navigator.clipboard.writeText(document.getElementById('revealToken').textContent).then(function () {
      btn.textContent = 'Copied';
    });
  };

  // Done: the token goes from the page for good.
  document.getElementById('done').onclick = function () {
    document.getElementById('revealToken').textContent = '';
    reveal.classList.add('hidden');
  };

  render();

  // ---- Test a link ----
  //
  // POST /admin/api/test looks the link up (a few seconds; the first
  // YouTube one after a restart, about 20), then GET /admin/api/test/<id>
  // once a second while it downloads, until it's ready or failed.

  var testForm = document.getElementById('testForm');
  var testUrl = document.getElementById('testUrl');
  var testBtn = document.getElementById('testBtn');
  var testError = document.getElementById('testError');
  var result = document.getElementById('testResult');
  var art = document.getElementById('testArt');
  var bar = document.getElementById('testBar');
  var status = document.getElementById('testStatus');
  var audio = document.getElementById('testAudio');
  // Each test bumps this, so an older one's polling stops.
  var current = 0;
  art.onerror = function () { art.classList.add('hidden'); };

  function mb(bytes) {
    return (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0) + ' MB';
  }

  function clock(s) {
    if (s == null) return '';
    s = Math.round(s);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = String(s % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + sec : m + ':' + sec;
  }

  // percent: a number, or null for "moving, but no idea how far".
  function setBar(percent) {
    bar.classList.toggle('indeterminate', percent == null);
    bar.firstElementChild.style.width = percent == null ? '' : percent + '%';
    if (percent == null) bar.removeAttribute('aria-valuenow');
    else bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  }

  function setStatus(text, failed) {
    status.textContent = text;
    status.classList.toggle('failed', !!failed);
  }

  function showTrack(t) {
    document.getElementById('testService').textContent = t.service || t.source || '';
    document.getElementById('testTitle').textContent = t.title || 'Untitled';
    document.getElementById('testArtist').textContent = t.artist || '';
    document.getElementById('testLength').textContent = clock(t.duration);
    if (t.artwork && art.getAttribute('src') !== t.artwork) art.src = t.artwork;
    art.classList.toggle('hidden', !t.artwork);

    if (t.status === 'pending') {
      var p = t.progress;
      bar.classList.remove('hidden');
      if (t.stage === 'queued' || (!p && t.stage === 'downloading')) {
        setBar(null);
        setStatus(t.stage === 'queued' ? 'Waiting its turn to download…' : 'Starting the download…');
      } else if (t.stage === 'converting') {
        setBar(100);
        setStatus('Downloaded; making the .m4a…');
      } else {
        setBar(p.percent);
        var parts = [];
        if (p.percent != null) parts.push(Math.floor(p.percent) + '%');
        if (p.downloadedBytes != null) parts.push(p.totalBytes ? mb(p.downloadedBytes) + ' of ' + mb(p.totalBytes) : mb(p.downloadedBytes) + ' so far');
        if (p.speed) parts.push(mb(p.speed) + '/s');
        setStatus('Downloading: ' + parts.join(' · '));
      }
      return;
    }
    if (t.status === 'ready') {
      setBar(100);
      bar.classList.add('hidden');
      var how = t.transcoded ? 're-encoded to AAC from ' + t.codec : (t.codec || '').toUpperCase() + ', copied as it was';
      setStatus('Ready · ' + mb(t.size) + ' · ' + how);
      if (audio.getAttribute('src') !== t.audioUrl) audio.src = t.audioUrl;
      audio.classList.remove('hidden');
      return;
    }
    bar.classList.add('hidden');
    setStatus('Failed: ' + (t.error || 'no reason given'), true);
  }

  function poll(id, n) {
    if (n !== current) return;
    call('GET', '/admin/api/test/' + id, null, testError).then(function (t) {
      if (n !== current) return;
      showTrack(t);
      if (t.status === 'pending') setTimeout(function () { poll(id, n); }, 1000);
    }, shown);
  }

  function reset() {
    current++;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio.classList.add('hidden');
    art.removeAttribute('src');
  }

  testForm.onsubmit = function (ev) {
    ev.preventDefault();
    reset();
    var n = current;
    result.classList.add('hidden');
    testBtn.disabled = true;
    testBtn.textContent = 'Looking it up…';
    call('POST', '/admin/api/test', { url: testUrl.value }, testError).then(function (t) {
      if (n !== current) return;
      result.classList.remove('hidden');
      showTrack(t);
      if (t.status === 'pending') setTimeout(function () { poll(t.id, n); }, 1000);
    }, shown).then(function () {
      testBtn.disabled = false;
      testBtn.textContent = 'Test';
    });
  };

  document.getElementById('testClear').onclick = function () {
    var btn = this;
    call('DELETE', '/admin/api/test', null, testError).then(function (r) {
      reset();
      result.classList.add('hidden');
      btn.textContent = r.deleted === 1 ? 'Cleared 1 test file' : 'Cleared ' + r.deleted + ' test files';
      setTimeout(function () { btn.textContent = 'Clear test files'; }, 2500);
    }, shown);
  };
})();
