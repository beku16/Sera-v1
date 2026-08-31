const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function findScriptPath() {
  const candidates = [
    // 1. Unpacked ASAR location (for packaged NSIS and portable apps)
    path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'local-speech.ps1'),
    // 2. Extra resources directory
    process.resourcesPath ? path.join(process.resourcesPath, 'electron', 'local-speech.ps1') : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'local-speech.ps1') : '',
    // 3. Local __dirname (dev mode or unpacked build)
    path.join(__dirname, 'local-speech.ps1'),
    // 4. Current working directory fallback
    path.join(process.cwd(), 'electron', 'local-speech.ps1'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return path.join(__dirname, 'local-speech.ps1');
}

const scriptPath = findScriptPath();
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
