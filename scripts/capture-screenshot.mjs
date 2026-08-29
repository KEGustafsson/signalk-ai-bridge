/**
 * Capture the App Store screenshot for the embedded panel.
 *
 * Runs the real panel against the real plugin routes (scripts/preview-host.mjs
 * with its stub inference backend), so the image shows the actual UI rather
 * than a mock-up.
 *
 * Playwright is not a dependency of this plugin — install it ad hoc:
 *   npm install --no-save playwright && npx playwright install chromium
 *   npm run screenshots
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const outputPath = path.join(projectRoot, 'assets', 'screenshots', 'ask-ai-panel.png');

const PREVIEW_PORT = 3177;
const DEV_PORT = 5177;
const DEV_URL = `http://127.0.0.1:${DEV_PORT}/`;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run:');
  console.error('  npm install --no-save playwright && npx playwright install chromium');
  console.error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to reuse a Chromium you already have.');
  process.exit(1);
}

function spawnChild(command, args, env) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${args[args.length - 1]}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${args[args.length - 1]}] ${chunk}`));
  return child;
}

async function waitForUrl(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 300) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const children = [];
const shutdown = () => children.forEach((child) => child.kill('SIGTERM'));

try {
  children.push(
    spawnChild(process.execPath, ['scripts/preview-host.mjs', '--stub'], {
      PREVIEW_PORT: String(PREVIEW_PORT)
    })
  );
  children.push(
    spawnChild('npx', ['vite', '--host', '127.0.0.1', '--port', String(DEV_PORT), '--strictPort'], {
      SIGNALK_AI_BRIDGE_DEV_TARGET: `http://127.0.0.1:${PREVIEW_PORT}`
    })
  );

  await waitForUrl(`http://127.0.0.1:${PREVIEW_PORT}/plugins/signalk-ai-bridge/ai/status`);
  await waitForUrl(DEV_URL);

  // Honour a preinstalled Chromium when the environment provides one, so the
  // capture works without downloading a browser bundle.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  // 1280 CSS px at 1x. The App Store scales the hero image down to its detail
  // page anyway, so a 2x capture only cost bytes: the same view was a 2560px,
  // 433 KB PNG, and every visitor to the plugin page downloaded it.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });

  await page.goto(DEV_URL, { waitUntil: 'networkidle' });
  await page.getByText('GPU accelerated').waitFor({ timeout: 30_000 });

  const askButton = page.getByRole('button', { name: /^Ask AI$/ });
  await askButton.click();
  await page.getByText('Generation speed').waitFor({ timeout: 30_000 });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await page.screenshot({ path: outputPath, fullPage: true });
  await browser.close();

  console.log(`Wrote ${path.relative(projectRoot, outputPath)}`);
} finally {
  shutdown();
}
