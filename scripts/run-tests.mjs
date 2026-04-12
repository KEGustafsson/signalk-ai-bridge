import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const tmpTestsDir = path.join(projectRoot, '.tmp-tests');
const tscBin = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: 'inherit'
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal === null
            ? `Command failed with exit code ${code ?? 'unknown'}`
            : `Command terminated with signal ${signal}`
        )
      );
    });
  });
}

async function findCompiledTests() {
  const entries = await readdir(tmpTestsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.join(tmpTestsDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function findStandaloneTests() {
  const standaloneTestDir = path.join(projectRoot, 'test');

  try {
    const entries = await readdir(standaloneTestDir, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.cjs'))
      .map((entry) => path.join(standaloneTestDir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function main() {
  await rm(tmpTestsDir, { recursive: true, force: true });

  try {
    await runNode([tscBin, '-p', 'tsconfig.test.json']);

    const [compiledTests, standaloneTests] = await Promise.all([
      findCompiledTests(),
      findStandaloneTests()
    ]);
    const testFiles = [...compiledTests, ...standaloneTests];

    if (testFiles.length === 0) {
      throw new Error(`No test files found in ${tmpTestsDir} or ${path.join(projectRoot, 'test')}`);
    }

    await runNode(['--experimental-specifier-resolution=node', '--test', ...testFiles]);
  } finally {
    await rm(tmpTestsDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
