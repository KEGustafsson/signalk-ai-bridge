import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';

const requiredFiles = [
  'src/AppPanel.tsx',
  'src/bridgeRuntime.ts',
  'src/contracts.ts',
  'src/panelTypes.ts',
  'src/types.ts',
  'src/index.ts',
  'lib/bridge-service.cjs',
  'lib/ai-service.cjs',
  'lib/accel-config.cjs',
  'lib/gpu-offload.cjs',
  'lib/gpu-telemetry.cjs',
  'lib/jetson-telemetry.cjs',
  'lib/kv-cache.cjs',
  'lib/http-utils.cjs',
  'lib/tensorrt-service.cjs',
  'index.cjs',
  'README.md',
  'docs/jetson.md',
  'docs/how-it-works.md',
  'docs/history.md',
  'docs/settings.md',
  'docs/development.md',
  'CHANGELOG.md',
  'LICENSE',
  'docker-compose.gemma.yml',
  'docker-compose.nano-super.yml',
  'docker-compose.tensorrt.yml',
  'docker-compose.xavier.yml',
  'scripts/build-trtllm-engine.sh',
  '.github/workflows/plugin-ci.yml'
];

for (const file of requiredFiles) {
  assert.equal(fs.existsSync(file), true, `Missing required file: ${file}`);
}

const bridgeRuntimeSource = fs.readFileSync('src/bridgeRuntime.ts', 'utf8');
assert.match(bridgeRuntimeSource, /DEFAULT_BRIDGE_ENDPOINT/);
assert.match(bridgeRuntimeSource, /export async function executeBridgeRequest/);
assert.match(bridgeRuntimeSource, /export async function streamBridgeRequest/);
assert.match(bridgeRuntimeSource, /plugins\/signalk-ai-bridge\/bridge\/execute/);

const bridgeServiceSource = fs.readFileSync('lib/bridge-service.cjs', 'utf8');
assert.match(bridgeServiceSource, /function createBridgeService/);
assert.match(bridgeServiceSource, /app\.getSelfPath/);
assert.match(bridgeServiceSource, /case 'ask-vessel-ai'/);

const pluginSource = fs.readFileSync('index.cjs', 'utf8');
assert.match(pluginSource, /router\.post\('\/bridge\/execute'/);
assert.match(pluginSource, /router\.post\('\/bridge\/stream'/);
assert.match(pluginSource, /router\.post\('\/ai\/query'/);
assert.match(pluginSource, /numCtx/);
assert.match(pluginSource, /keepAlive/);
assert.match(pluginSource, /gpuAutoTune/);

// The registry and app store both read package.json metadata directly, so a
// missing field here is a silent score loss rather than a build failure.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.ok(pkg.keywords.includes('signalk-node-server-plugin'), 'Missing signalk-node-server-plugin keyword');
assert.ok(typeof pkg.repository?.url === 'string', 'package.json needs a repository URL');
assert.ok(typeof pkg.engines?.node === 'string', 'package.json needs engines.node');
assert.equal(pkg.license, 'EUPL-1.2', 'package.json license must be the SPDX id EUPL-1.2, matching LICENSE');
assert.ok(
  Array.isArray(pkg.signalk?.screenshots) && pkg.signalk.screenshots.length > 0,
  'package.json needs at least one signalk.screenshots entry'
);
for (const asset of [pkg.signalk.appIcon, ...pkg.signalk.screenshots]) {
  const relative = String(asset).replace(/^\.?\//, '');
  assert.equal(fs.existsSync(relative), true, `Declared Signal K asset is missing: ${asset}`);
  assert.ok(
    pkg.files.some((entry) => relative === entry || relative.startsWith(`${entry}/`)),
    `Declared Signal K asset is not published: ${asset}`
  );
}

// tests_runnable in the Signal K plugin registry score is measured against the
// published tarball, not against this checkout: the suite has to be shipped and
// has to run there. Everything `npm test` reads therefore has to be covered by
// "files", and scripts/run-tests.mjs has to tolerate an App Store install,
// where devDependencies - TypeScript among them - are absent.
for (const entry of ['scripts/run-tests.mjs', 'test', 'src', 'tsconfig.json', 'tsconfig.test.json']) {
  assert.equal(fs.existsSync(entry), true, `Missing test-suite path: ${entry}`);
  assert.ok(
    pkg.files.some((published) => entry === published || entry.startsWith(`${published}/`)),
    `"${entry}" is read by "npm test" but is not in package.json "files"`
  );
}
assert.match(
  fs.readFileSync('scripts/run-tests.mjs', 'utf8'),
  /resolveTscBin/,
  'scripts/run-tests.mjs must degrade to the node:test suites when typescript is not installed'
);

// signalk-server picks the container script tag from package.json's "type":
// with "module" it emits <script type="module" src=".../remoteEntry.js">, so
// remoteEntry.js must be the ESM container. Shipping the `var` IIFE under that
// name makes the admin UI report "Module ... is not available" and the panel
// never mounts - a failure no unit test sees, because the panel is only ever
// loaded directly in tests and in scripts/preview-host.mjs.
if (fs.existsSync('public/remoteEntry.js')) {
  const remoteEntry = fs.readFileSync('public/remoteEntry.js', 'utf8');
  if (pkg.type === 'module') {
    assert.match(
      remoteEntry,
      /export\s*\{[^}]*\bas get\b[^}]*\}/,
      'public/remoteEntry.js must export `get` for an ESM ("type": "module") webapp'
    );
    assert.match(remoteEntry, /\binit\b/, 'public/remoteEntry.js must export `init`');
  } else {
    assert.match(
      remoteEntry,
      new RegExp(`var\\s+${pkg.name.replace(/[-@/]/g, '_')}\\b`),
      'a non-module webapp needs the global `var` container in public/remoteEntry.js'
    );
  }
}

// The plugin-ci caller must keep pointing at the canonical reusable workflow,
// otherwise the registry silently falls back to guessing build/test commands.
const pluginCi = fs.readFileSync('.github/workflows/plugin-ci.yml', 'utf8');
assert.match(pluginCi, /SignalK\/signalk-server\/\.github\/workflows\/plugin-ci\.yml@/);
assert.match(pluginCi, /build-command: npm run build/);
assert.match(pluginCi, /test-command: npm run test/);
// The registry takes 10 points off unless plugin-ci ran on the exact commit a
// release was published from, so it runs on every pushed branch and tag:
// on.push lists '**' for both, with no exclusions and no path filter.
{
  const workflow = parseYaml(pluginCi);
  const push = workflow && workflow.on && workflow.on.push;
  assert.ok(push && typeof push === 'object', 'plugin-ci must run on push');
  const runsOnEvery = (key) =>
    Array.isArray(push[key]) && push[key].includes('**') && !push[key].some((item) => String(item).startsWith('!'));
  assert.ok(runsOnEvery('branches'), 'plugin-ci must run on every pushed branch');
  assert.ok(runsOnEvery('tags'), 'plugin-ci must run on every pushed tag');
  assert.ok(!('paths' in push) && !('paths-ignore' in push), 'plugin-ci must not filter pushes by path');
}

console.log('smoke-ok');
