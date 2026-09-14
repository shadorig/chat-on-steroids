const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/** Re-executes a verification script under the repository Electron binary, once. */
function ensureElectron(script) {
  if (process.versions.electron) return;
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [script], {
    env,
    encoding: 'utf8',
    windowsHide: true
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

/** Production renderer shell with executable resources removed and production CSS inlined. */
function productionRendererHtml() {
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
  return fs
    .readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace('</head>', `<style>${css}</style></head>`);
}

/** Creates one deterministic Chromium renderer using the real production markup/CSS. */
async function createRendererWindow({ width, height, offscreen = false }) {
  const { app, BrowserWindow } = require('electron');
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { sandbox: true, backgroundThrottling: false, ...(offscreen ? { offscreen: true } : {}) }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(productionRendererHtml()));
  return win;
}

/** Screenshots are opt-in diagnostics, not successful-run build artifacts. */
async function captureVisual(win, relativePath) {
  if (process.env.COS_CAPTURE_VISUALS !== '1') return;
  const target = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, (await win.webContents.capturePage()).toPNG());
}

function finishElectron(win, code = 0) {
  const { app } = require('electron');
  if (win && !win.isDestroyed()) win.destroy();
  if (code === 0) app.quit();
  else app.exit(code);
}

module.exports = {
  ROOT,
  ensureElectron,
  createRendererWindow,
  captureVisual,
  finishElectron
};
