import assert from 'node:assert/strict';
import fs from 'node:fs';

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
  'lib/gpu-telemetry.cjs',
  'lib/http-utils.cjs',
  'lib/tensorrt-service.cjs',
  'index.cjs',
  'README.md',
  'CHANGELOG.md',
  'docker-compose.gemma.yml',
  'docker-compose.jetson.yml',
  'docker-compose.tensorrt.yml',
  '.github/workflows/plugin-ci.yml'
];

for (const file of requiredFiles) {
  assert.equal(fs.existsSync(file), true, `Missing required file: ${file}`);
}

const bridgeRuntimeSource = fs.readFileSync('src/bridgeRuntime.ts', 'utf8');
assert.match(bridgeRuntimeSource, /DEFAULT_BRIDGE_ENDPOINT/);
assert.match(bridgeRuntimeSource, /export async function executeBridgeRequest/);
assert.match(bridgeRuntimeSource, /plugins\/signalk-ai-bridge\/bridge\/execute/);

const bridgeServiceSource = fs.readFileSync('lib/bridge-service.cjs', 'utf8');
assert.match(bridgeServiceSource, /function createBridgeService/);
assert.match(bridgeServiceSource, /app\.getSelfPath/);
assert.match(bridgeServiceSource, /case 'ask-vessel-ai'/);

const pluginSource = fs.readFileSync('index.cjs', 'utf8');
assert.match(pluginSource, /router\.post\('\/bridge\/execute'/);
assert.match(pluginSource, /router\.post\('\/ai\/query'/);
assert.match(pluginSource, /numCtx/);
assert.match(pluginSource, /keepAlive/);

// The registry and app store both read package.json metadata directly, so a
// missing field here is a silent score loss rather than a build failure.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.ok(pkg.keywords.includes('signalk-node-server-plugin'), 'Missing signalk-node-server-plugin keyword');
assert.ok(typeof pkg.repository?.url === 'string', 'package.json needs a repository URL');
assert.ok(typeof pkg.engines?.node === 'string', 'package.json needs engines.node');
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

// The plugin-ci caller must keep pointing at the canonical reusable workflow,
// otherwise the registry silently falls back to guessing build/test commands.
const pluginCi = fs.readFileSync('.github/workflows/plugin-ci.yml', 'utf8');
assert.match(pluginCi, /SignalK\/signalk-server\/\.github\/workflows\/plugin-ci\.yml@/);
assert.match(pluginCi, /build-command: npm run build/);
assert.match(pluginCi, /test-command: npm run test/);

console.log('smoke-ok');
