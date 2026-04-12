import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

const targets = [
  'dist',
  'public'
];

await Promise.all(
  targets.map((target) =>
    rm(path.join(projectRoot, target), {
      recursive: true,
      force: true
    }))
);

console.log(`Removed: ${targets.join(', ')}`);
