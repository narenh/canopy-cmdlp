// A real server for each test file, on its own port and data folder,
// with a fake yt-dlp (fake-yt-dlp.js) and one API token already made.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE = path.join(__dirname, 'fake-yt-dlp.js');
const TOKEN = 'cmdlp_' + 'T'.repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };

const servers = [];

async function startServer(extraEnv = {}, { setup } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdlp-test-'));
  fs.writeFileSync(path.join(dataDir, 'tokens.json'), JSON.stringify({
    tokens: [{
      id: 'testtoken000',
      label: 'Test hub',
      hash: crypto.createHash('sha256').update(TOKEN).digest('hex'),
      hint: TOKEN.slice(-4),
      createdAt: new Date().toISOString(),
      regeneratedAt: null,
      lastUsedAt: null,
    }],
  }));
  if (setup) setup(dataDir);
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      YTDLP_STABLE: FAKE,
      YTDLP_AUTO_UPDATE: '0',
      PUBLIC_URL: 'https://cmdlp.example',
      NODE_ENV: 'test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const s = { base, port, dataDir, child, output: () => output };
  servers.push(s);
  return s;
}

function stopServers() {
  for (const x of servers.splice(0)) {
    x.child.kill('SIGKILL');
    fs.rmSync(x.dataDir, { recursive: true, force: true });
  }
}

module.exports = { startServer, stopServers, TOKEN, auth };
