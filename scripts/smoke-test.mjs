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
  'index.cjs',
  'README.md'
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

console.log('smoke-ok');
