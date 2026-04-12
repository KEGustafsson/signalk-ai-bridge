import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const iconSourcePath = path.join(projectRoot, 'assets', 'icons', 'icon-72x72.svg');
const iconTargetDir = path.join(projectRoot, 'public', 'assets', 'icons');
const iconTargetPath = path.join(iconTargetDir, 'icon-72x72.svg');

await mkdir(iconTargetDir, { recursive: true });
await cp(iconSourcePath, iconTargetPath);
