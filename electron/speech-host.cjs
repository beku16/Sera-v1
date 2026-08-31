const { spawn } = require('node:child_process');
const path = require('node:path');

const scriptPath = path.join(__dirname, 'local-speech.ps1');
const worker = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', scriptPath,
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

worker.stdout.pipe(process.stdout);
worker.stderr.pipe(process.stderr);
worker.on('error', (error) => {
  process.stderr.write(`[SPEECH_HOST_ERROR] ${error.message}\n`);
  process.exit(0);
});
worker.on('exit', (code, signal) => {
  process.stdout.write(JSON.stringify({ type: 'host', event: 'POWERSHELL_EXIT', code, signal }) + '\n');
  process.exit(0);
});

process.on('SIGTERM', () => {
  try { worker.kill(); } catch {}
  process.exit(0);
});
process.on('SIGINT', () => {
  try { worker.kill(); } catch {}
  process.exit(0);
});
