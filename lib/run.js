// Running a program (yt-dlp, ffmpeg, ffprobe) and collecting what it
// prints. Never through a shell: arguments go straight to the program,
// so a link can't be anything but a link.

const { spawn } = require('node:child_process');

// Resolves with { code, stdout, stderr } whatever the exit code; rejects
// only when the program can't be started at all. A timeout or
// `signal.abort()` stops it with SIGTERM (which lets yt-dlp's bootloader
// clean up its temporary files), then SIGKILL five seconds later, and the
// result has `killed: true`. `onLine` is called with each line of stdout
// as it comes (yt-dlp's progress).
function run(bin, args, { timeoutMs = 0, signal, env, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    const out = [];
    const err = [];
    let killed = false;
    let hardKill;
    const stop = () => {
      if (killed || child.exitCode !== null) return;
      killed = true;
      child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), 5000);
      hardKill.unref();
    };
    const timer = timeoutMs ? setTimeout(stop, timeoutMs) : null;
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    let partial = '';
    child.stdout.on('data', (d) => {
      out.push(d);
      if (!onLine) return;
      const lines = (partial + d.toString('utf8')).split('\n');
      partial = lines.pop();
      for (const l of lines) onLine(l);
    });
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      if (signal) signal.removeEventListener('abort', stop);
      resolve({
        code,
        killed,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

module.exports = { run };
