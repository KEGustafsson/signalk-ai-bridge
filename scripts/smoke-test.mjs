import assert from 'node:assert/strict';
import fs from 'node:fs';

const requiredFiles = [
  'src/AppPanel.tsx',
  'src/api.ts',
  'src/policy.ts',
  'src/audit.ts',
  'src/index.ts',
  'README.md'
];

for (const file of requiredFiles) {
  assert.equal(fs.existsSync(file), true, `Missing required file: ${file}`);
}

const apiSource = fs.readFileSync('src/api.ts', 'utf8');
assert.match(apiSource, /export async function getVesselSnapshot/);
assert.match(apiSource, /export async function getActiveAlarms/);
assert.match(apiSource, /export async function getRecentDeltas/);
assert.match(apiSource, /export async function createWaypointDraft/);

const policySource = fs.readFileSync('src/policy.ts', 'utf8');
assert.match(policySource, /export async function authorizeTool/);
assert.match(policySource, /viewer/);
assert.match(policySource, /operator/);
assert.match(policySource, /admin/);

console.log('smoke-ok');
