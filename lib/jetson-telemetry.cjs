'use strict';

const fsPromises = require('node:fs/promises');
// sysfs and procfs paths are POSIX by definition — these files exist only on a
// Linux Tegra host. Joining them with the platform separator would build
// "\\etc\\nv_tegra_release" on Windows, which matches nothing and, worse, makes
// the probe's behaviour depend on where the test runs rather than on what it
// reads. path.posix keeps the paths identical on every platform; a non-Linux
// host simply fails the first stat and reports `present: false`.
const path = require('node:path').posix;

/**
 * Host-side Jetson telemetry, read straight from sysfs/procfs.
 *
 * GPU residency (gpu-telemetry.cjs) answers "are the weights on the GPU". This
 * answers the other half: "is that GPU allowed to run at full speed". An Orin
 * Nano Super held in a 15 W power mode, or clock-capped by temperature, is
 * still fully GPU-resident — it is just delivering a fraction of the
 * throughput, and nothing in the inference API says so.
 *
 * Everything here is best-effort: the Signal K server may not be running on the
 * Jetson at all (the inference host can be a different machine), so a missing
 * file is an ordinary answer, never an error. When /etc/nv_tegra_release is
 * absent the whole probe short-circuits and costs one failed stat.
 */

// Below this the GPU is clock-limited rather than compute-limited.
const CLOCK_HEADROOM_RATIO = 0.8;
// Orin starts throttling in the high 80s; warn before the cliff.
const HOT_CELSIUS = 85;

async function readText(fsImpl, filePath) {
  try {
    const raw = await fsImpl.readFile(filePath, 'utf8');
    // Device-tree strings are NUL-terminated.
    return raw.replace(/\0/g, '').trim();
  } catch {
    return undefined;
  }
}

async function readNumber(fsImpl, filePath) {
  const text = await readText(fsImpl, filePath);
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text.split(/\s+/)[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function listDir(fsImpl, dirPath) {
  try {
    return await fsImpl.readdir(dirPath);
  } catch {
    return [];
  }
}

// "# R36 (release), REVISION: 4.3, GCID: 12345, BOARD: generic, ..."
function parseTegraRelease(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  const release = /R(\d+)\s*\(release\)/i.exec(text);
  const revision = /REVISION:\s*([\d.]+)/i.exec(text);
  if (!release) {
    return undefined;
  }
  return revision ? `${release[1]}.${revision[1]}` : release[1];
}

// /var/lib/nvpmodel/status holds "pmode:0002 fmode:fan_mode_quiet".
function parsePowerModeId(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = /pmode:\s*(\d+)/i.exec(text);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

// /etc/nvpmodel.conf declares "< POWER_MODEL ID=2 NAME=MAXN_SUPER >".
function parsePowerModeNames(text) {
  const names = new Map();
  if (typeof text !== 'string') {
    return names;
  }
  const pattern = /<\s*POWER_MODEL\s+ID\s*=\s*(\d+)\s+NAME\s*=\s*([^\s>]+)/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    names.set(Number.parseInt(match[1], 10), match[2]);
  }
  return names;
}

function isMaximumPowerMode(name) {
  return typeof name === 'string' && /maxn/i.test(name);
}

// The GPU node moved between JetPack releases, so probe the known locations
// rather than hard-coding one.
const GPU_LOAD_CANDIDATES = [
  'sys/devices/platform/gpu.0/load',
  'sys/devices/gpu.0/load',
  'sys/devices/platform/bus@0/17000000.gpu/load',
  'sys/devices/platform/17000000.gpu/load'
];

async function readGpuLoadPermille(fsImpl, rootDir) {
  for (const candidate of GPU_LOAD_CANDIDATES) {
    const value = await readNumber(fsImpl, path.join(rootDir, candidate));
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

async function readGpuClocks(fsImpl, rootDir) {
  const devfreqDir = path.join(rootDir, 'sys/class/devfreq');
  for (const entry of await listDir(fsImpl, devfreqDir)) {
    if (!/gpu/i.test(entry)) {
      continue;
    }
    const currentHz = await readNumber(fsImpl, path.join(devfreqDir, entry, 'cur_freq'));
    const maxHz = await readNumber(fsImpl, path.join(devfreqDir, entry, 'max_freq'));
    if (currentHz !== undefined || maxHz !== undefined) {
      return { currentHz, maxHz };
    }
  }
  return {};
}

async function readGpuTemperature(fsImpl, rootDir) {
  const thermalDir = path.join(rootDir, 'sys/devices/virtual/thermal');
  for (const entry of await listDir(fsImpl, thermalDir)) {
    if (!/^thermal_zone\d+$/.test(entry)) {
      continue;
    }
    const type = await readText(fsImpl, path.join(thermalDir, entry, 'type'));
    if (!type || !/gpu/i.test(type)) {
      continue;
    }
    const milliCelsius = await readNumber(fsImpl, path.join(thermalDir, entry, 'temp'));
    if (milliCelsius !== undefined) {
      return Number((milliCelsius / 1000).toFixed(1));
    }
  }
  return undefined;
}

/**
 * Read what the local host can tell us about its Tegra GPU.
 *
 * `rootDir` and `fsImpl` exist so the parsing can be tested against a fixture
 * tree instead of a real Jetson.
 */
async function readJetsonTelemetry({ rootDir = '/', fsImpl = fsPromises } = {}) {
  const tegraRelease = await readText(fsImpl, path.join(rootDir, 'etc/nv_tegra_release'));
  if (tegraRelease === undefined) {
    return {
      present: false,
      message: 'Signal K is not running on a Jetson host, so board-level GPU telemetry is unavailable.'
    };
  }

  const [model, powerStatus, powerConfig, loadPermille, clocks, temperatureC] = await Promise.all([
    readText(fsImpl, path.join(rootDir, 'proc/device-tree/model')),
    readText(fsImpl, path.join(rootDir, 'var/lib/nvpmodel/status')),
    readText(fsImpl, path.join(rootDir, 'etc/nvpmodel.conf')),
    readGpuLoadPermille(fsImpl, rootDir),
    readGpuClocks(fsImpl, rootDir),
    readGpuTemperature(fsImpl, rootDir)
  ]);

  const modeNames = parsePowerModeNames(powerConfig);
  const modeId = parsePowerModeId(powerStatus);
  const modeName = modeId !== undefined ? modeNames.get(modeId) : undefined;
  const maximumMode = [...modeNames.entries()].find(([, name]) => isMaximumPowerMode(name));

  const warnings = [];
  if (modeId !== undefined && maximumMode && !isMaximumPowerMode(modeName)) {
    warnings.push(
      `Power mode ${modeId}${modeName ? ` (${modeName})` : ''} caps the GPU below its maximum. ` +
        `Run "sudo nvpmodel -m ${maximumMode[0]} && sudo jetson_clocks" for full ${maximumMode[1]} clocks.`
    );
  }

  if (
    typeof clocks.currentHz === 'number' &&
    typeof clocks.maxHz === 'number' &&
    clocks.maxHz > 0 &&
    typeof loadPermille === 'number' &&
    loadPermille > 500 &&
    clocks.currentHz < clocks.maxHz * CLOCK_HEADROOM_RATIO
  ) {
    warnings.push(
      `The GPU is busy but running at ${(clocks.currentHz / 1e6).toFixed(0)} MHz of ` +
        `${(clocks.maxHz / 1e6).toFixed(0)} MHz. Run "sudo jetson_clocks", or check cooling if it is thermal.`
    );
  }

  if (typeof temperatureC === 'number' && temperatureC >= HOT_CELSIUS) {
    warnings.push(`GPU temperature is ${temperatureC} C; sustained throughput will be thermally limited.`);
  }

  return {
    present: true,
    model: model || undefined,
    l4tVersion: parseTegraRelease(tegraRelease),
    powerMode:
      modeId === undefined
        ? undefined
        : {
            id: modeId,
            name: modeName,
            isMaximum: isMaximumPowerMode(modeName),
            maximumId: maximumMode ? maximumMode[0] : undefined,
            maximumName: maximumMode ? maximumMode[1] : undefined
          },
    gpuLoadPercent: typeof loadPermille === 'number' ? Number((loadPermille / 10).toFixed(1)) : undefined,
    gpuClockHz: clocks.currentHz,
    gpuMaxClockHz: clocks.maxHz,
    gpuTemperatureC: temperatureC,
    warnings
  };
}

module.exports = {
  CLOCK_HEADROOM_RATIO,
  HOT_CELSIUS,
  isMaximumPowerMode,
  parsePowerModeId,
  parsePowerModeNames,
  parseTegraRelease,
  readJetsonTelemetry
};
