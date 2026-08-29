'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  findMaximumPowerMode,
  matchGpuArchitecture,
  readJetsonTelemetry
} = require('../lib/jetson-telemetry.cjs');

const NVPMODEL_CONF = [
  '< PM_CONFIG DEFAULT=2 >',
  '< POWER_MODEL ID=0 NAME=15W >',
  'CPU_ONLINE CORE_0 1',
  '< POWER_MODEL ID=1 NAME=25W >',
  '< POWER_MODEL ID=2 NAME=MAXN_SUPER >'
].join('\n');

/**
 * Minimal in-memory stand-in for a Jetson's sysfs/procfs tree, so the parsing
 * can be exercised on any host.
 */
function createFakeFs(files, directories = {}) {
  return {
    async readFile(filePath) {
      if (!(filePath in files)) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files[filePath];
    },
    async readdir(dirPath) {
      if (!(dirPath in directories)) {
        const error = new Error(`ENOENT: ${dirPath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return directories[dirPath];
    }
  };
}

// JetPack 6 / L4T 36 on an Orin Nano Super, as the board really presents it:
// the GPU node is "ga10b" (not "gpu") and lives under platform/bus@0, the
// device-tree model string is NUL-terminated, and thermal_zone0 is a populated
// CPU zone that the GPU-zone filter has to skip past.
function jetsonFixture(overrides = {}) {
  const files = {
    '/etc/nv_tegra_release': '# R36 (release), REVISION: 4.3, GCID: 12345, BOARD: generic',
    '/proc/device-tree/model': `NVIDIA Jetson Orin Nano Super Developer Kit${String.fromCharCode(0)}`,
    '/var/lib/nvpmodel/status': 'pmode:0002 fmode:fan_mode_quiet',
    '/etc/nvpmodel.conf': NVPMODEL_CONF,
    '/sys/devices/platform/bus@0/17000000.ga10b/load': '842',
    '/sys/class/devfreq/17000000.ga10b/cur_freq': '1020000000',
    '/sys/class/devfreq/17000000.ga10b/max_freq': '1020000000',
    '/sys/devices/virtual/thermal/thermal_zone0/type': 'cpu-thermal',
    '/sys/devices/virtual/thermal/thermal_zone0/temp': '92000',
    '/sys/devices/virtual/thermal/thermal_zone1/type': 'gpu-thermal',
    '/sys/devices/virtual/thermal/thermal_zone1/temp': '54500',
    ...overrides
  };
  const directories = {
    // The GPU node is discovered by scanning, as on a real board, rather than
    // by guessing one path.
    '/sys/devices': [],
    '/sys/devices/platform': ['bus@0'],
    '/sys/devices/platform/bus@0': ['17000000.ga10b', '3610000.usb'],
    '/sys/class/devfreq': ['17000000.ga10b'],
    '/sys/devices/virtual/thermal': ['thermal_zone0', 'thermal_zone1']
  };
  return { fsImpl: createFakeFs(files, directories) };
}

// Jetson Xavier NX: Volta GPU node (gv11b), L4T 35.x, and nvpmodel modes named
// by power budget and core count with no MAXN entry anywhere.
const XAVIER_NVPMODEL_CONF = [
  '< PM_CONFIG DEFAULT=2 >',
  '< POWER_MODEL ID=0 NAME=MODE_15W_2CORE >',
  '< POWER_MODEL ID=1 NAME=MODE_15W_4CORE >',
  '< POWER_MODEL ID=2 NAME=MODE_15W_6CORE >',
  '< POWER_MODEL ID=5 NAME=MODE_10W_DESKTOP >',
  '< POWER_MODEL ID=7 NAME=MODE_20W_4CORE >',
  '< POWER_MODEL ID=8 NAME=MODE_20W_6CORE >'
].join('\n');

function xavierFixture(overrides = {}, directoryOverrides = {}) {
  const files = {
    '/etc/nv_tegra_release': '# R35 (release), REVISION: 4.1, GCID: 33958178, BOARD: t186ref',
    '/proc/device-tree/model': 'NVIDIA Jetson Xavier NX Developer Kit',
    '/var/lib/nvpmodel/status': 'pmode:0002 fmode:fan_mode_quiet',
    '/etc/nvpmodel.conf': XAVIER_NVPMODEL_CONF,
    '/sys/devices/17000000.gv11b/load': '765',
    '/sys/class/devfreq/17000000.gv11b/cur_freq': '1109250000',
    '/sys/class/devfreq/17000000.gv11b/max_freq': '1109250000',
    '/sys/devices/virtual/thermal/thermal_zone2/type': 'GPU-therm',
    '/sys/devices/virtual/thermal/thermal_zone2/temp': '48000',
    ...overrides
  };
  const directories = {
    '/sys/devices': ['17000000.gv11b', 'platform'],
    '/sys/devices/platform': [],
    '/sys/class/devfreq': ['17000000.gv11b'],
    '/sys/devices/virtual/thermal': ['thermal_zone0', 'thermal_zone2'],
    ...directoryOverrides
  };
  return { fsImpl: createFakeFs(files, directories) };
}

describe('Jetson host telemetry', () => {
  it('probes POSIX sysfs paths whatever platform the test runs on', async () => {
    // sysfs paths are POSIX by definition. Building them with the platform
    // separator made the probe look for "\\etc\\nv_tegra_release" on Windows,
    // which matches nothing — caught by the Windows leg of the plugin CI.
    const probed = [];
    const fsImpl = {
      async readFile(filePath) {
        probed.push(filePath);
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      },
      async readdir() {
        return [];
      }
    };

    await readJetsonTelemetry({ fsImpl });

    assert.deepEqual(probed, ['/etc/nv_tegra_release']);
  });

  it('reports nothing at all on a host that is not a Jetson', async () => {
    const result = await readJetsonTelemetry({ fsImpl: createFakeFs({}) });

    assert.equal(result.present, false);
    assert.match(result.message, /not running on a Jetson/);
  });

  it('reads board, JetPack, power mode, clocks and temperature', async () => {
    const result = await readJetsonTelemetry(jetsonFixture());

    assert.equal(result.present, true);
    // Device-tree strings carry a trailing NUL, which String.trim() does not
    // remove - it would otherwise reach the panel and the JSON status payload.
    assert.equal(result.model, 'NVIDIA Jetson Orin Nano Super Developer Kit');
    assert.equal(result.model.includes('\u0000'), false);
    assert.equal(result.l4tVersion, '36.4.3');
    assert.equal(result.powerMode.id, 2);
    assert.equal(result.powerMode.name, 'MAXN_SUPER');
    assert.equal(result.powerMode.isMaximum, true);
    assert.equal(result.gpuLoadPercent, 84.2);
    assert.equal(result.gpuClockHz, 1020000000);
    // 54.5 from the gpu-thermal zone, not 92 from the hot CPU zone next to it:
    // reporting CPU Tj as GPU temperature would raise a thermal-throttling
    // warning for a GPU that is fine.
    assert.equal(result.gpuTemperatureC, 54.5);
    assert.deepEqual(result.warnings, []);
  });

  it('finds the Ampere GPU node, which is named ga10b and sits under bus@0', async () => {
    // The node is "gpu" only on some boards. Matching that alone is the exact
    // regression this module already shipped once, and it fails silently: load
    // and clock simply come back blank on every other generation.
    const result = await readJetsonTelemetry(jetsonFixture());

    assert.equal(result.gpuLoadPercent, 84.2);
    assert.equal(result.gpuClockHz, 1020000000);
  });

  it('warns when the board is held below its maximum power mode', async () => {
    const result = await readJetsonTelemetry(
      jetsonFixture({ '/var/lib/nvpmodel/status': 'pmode:0000 fmode:fan_mode_quiet' })
    );

    assert.equal(result.powerMode.isMaximum, false);
    assert.equal(result.powerMode.maximumId, 2);
    assert.match(result.warnings[0], /nvpmodel -m 2/);
  });

  it('warns when a busy GPU is running well below its maximum clock', async () => {
    const result = await readJetsonTelemetry(
      jetsonFixture({ '/sys/class/devfreq/17000000.ga10b/cur_freq': '400000000' })
    );

    assert.match(result.warnings.join(' '), /400 MHz of 1020 MHz/);
  });

  it('warns when the GPU is hot enough to be thermally limited', async () => {
    const result = await readJetsonTelemetry(
      jetsonFixture({ '/sys/devices/virtual/thermal/thermal_zone1/temp': '91000' })
    );

    assert.match(result.warnings.join(' '), /91 C/);
  });

  it('survives a partially populated sysfs tree', async () => {
    const files = {
      '/etc/nv_tegra_release': '# R36 (release), REVISION: 4.3'
    };
    const result = await readJetsonTelemetry({ fsImpl: createFakeFs(files) });

    assert.equal(result.present, true);
    assert.equal(result.l4tVersion, '36.4.3');
    assert.equal(result.powerMode, undefined);
    assert.equal(result.gpuLoadPercent, undefined);
    assert.deepEqual(result.warnings, []);
  });
});

describe('power-mode warnings', () => {
  it('stays quiet when the reported mode id is not declared in nvpmodel.conf', async () => {
    // pmode 7 is absent from the fixture's POWER_MODEL list, so the name cannot
    // be resolved and any "your mode caps the GPU" advice would be a guess.
    const result = await readJetsonTelemetry(
      jetsonFixture({ '/var/lib/nvpmodel/status': 'pmode:0007 fmode:fan_mode_quiet' })
    );

    assert.equal(result.powerMode.id, 7);
    assert.equal(result.powerMode.name, undefined);
    assert.deepEqual(result.warnings, []);
  });
});

describe('Jetson Xavier NX', () => {
  it('finds the Volta GPU node, which is not named "gpu"', async () => {
    const result = await readJetsonTelemetry(xavierFixture());

    assert.equal(result.present, true);
    assert.equal(result.model, 'NVIDIA Jetson Xavier NX Developer Kit');
    assert.equal(result.l4tVersion, '35.4.1');
    assert.equal(result.gpuLoadPercent, 76.5);
    assert.equal(result.gpuClockHz, 1109250000);
    assert.equal(result.gpuTemperatureC, 48);
  });

  it('ranks the highest power budget as the maximum when no MAXN mode exists', async () => {
    // Xavier NX names modes by watts and cores; nothing matches /maxn/.
    const result = await readJetsonTelemetry(xavierFixture());

    assert.equal(result.powerMode.id, 2);
    assert.equal(result.powerMode.name, 'MODE_15W_6CORE');
    assert.equal(result.powerMode.isMaximum, false);
    assert.equal(result.powerMode.maximumId, 8);
    assert.equal(result.powerMode.maximumName, 'MODE_20W_6CORE');
    assert.match(result.warnings[0], /nvpmodel -m 8/);
    assert.match(result.warnings[0], /MODE_20W_6CORE/);
  });

  it('breaks a wattage tie on core count', () => {
    const modes = new Map([
      [7, 'MODE_20W_4CORE'],
      [8, 'MODE_20W_6CORE'],
      [2, 'MODE_15W_6CORE']
    ]);

    assert.deepEqual(findMaximumPowerMode(modes), [8, 'MODE_20W_6CORE']);
  });

  it('stays quiet on the maximum mode', async () => {
    const result = await readJetsonTelemetry(
      xavierFixture({ '/var/lib/nvpmodel/status': 'pmode:0008 fmode:fan_mode_quiet' })
    );

    assert.equal(result.powerMode.isMaximum, true);
    assert.deepEqual(result.warnings, []);
  });

  it('still prefers MAXN_SUPER where a board exposes it', () => {
    const modes = new Map([
      [0, '15W'],
      [1, '25W'],
      [2, 'MAXN_SUPER']
    ]);

    assert.deepEqual(findMaximumPowerMode(modes), [2, 'MAXN_SUPER']);
  });

  it('reports no maximum when modes carry neither MAXN nor a wattage', () => {
    assert.equal(findMaximumPowerMode(new Map([[0, 'CUSTOM'], [1, 'OTHER']])), undefined);
    assert.equal(findMaximumPowerMode(new Map()), undefined);
  });
});

describe('Tegra GPU generation', () => {
  it('reads compute capability from the Xavier device-tree node', async () => {
    const result = await readJetsonTelemetry(xavierFixture());

    assert.deepEqual(result.gpu, { node: 'gv11b', architecture: 'Volta', computeCapability: 7.2 });
  });

  it('reads compute capability from the Orin device-tree node', async () => {
    const result = await readJetsonTelemetry(jetsonFixture());

    assert.deepEqual(result.gpu, { node: 'ga10b', architecture: 'Ampere', computeCapability: 8.7 });
  });

  it('matches the node however L4T decorates it', () => {
    assert.equal(matchGpuArchitecture('17000000.gv11b').architecture, 'Volta');
    assert.equal(matchGpuArchitecture('gv11b').computeCapability, 7.2);
    assert.equal(matchGpuArchitecture('ga10b.0').architecture, 'Ampere');
    assert.equal(matchGpuArchitecture('gp10b').computeCapability, 6.2);
  });

  // The generic alias some releases expose alongside the real node carries no
  // generation, and inventing one would be worse than reporting nothing.
  it('declines to name a generation for the bare gpu alias', () => {
    assert.equal(matchGpuArchitecture('gpu'), undefined);
    assert.equal(matchGpuArchitecture('gpu.0'), undefined);
    assert.equal(matchGpuArchitecture('3610000.usb'), undefined);
  });

  // /sys/devices carries both `gpu.0` and the generation-named node on a real
  // Xavier, and readdir order between them is not something to depend on.
  it('finds the generation even when the bare alias is listed first', async () => {
    const result = await readJetsonTelemetry(
      xavierFixture({}, { '/sys/devices': ['gpu.0', '17000000.gv11b', 'platform'] })
    );

    assert.equal(result.gpu.architecture, 'Volta');
  });
});
