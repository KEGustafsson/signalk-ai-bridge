'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readJetsonTelemetry } = require('../lib/jetson-telemetry.cjs');

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

function jetsonFixture(overrides = {}) {
  const files = {
    '/etc/nv_tegra_release': '# R36 (release), REVISION: 4.3, GCID: 12345, BOARD: generic',
    '/proc/device-tree/model': 'NVIDIA Jetson Orin Nano Super Developer Kit ',
    '/var/lib/nvpmodel/status': 'pmode:0002 fmode:fan_mode_quiet',
    '/etc/nvpmodel.conf': NVPMODEL_CONF,
    '/sys/devices/platform/gpu.0/load': '842',
    '/sys/class/devfreq/17000000.gpu/cur_freq': '1020000000',
    '/sys/class/devfreq/17000000.gpu/max_freq': '1020000000',
    '/sys/devices/virtual/thermal/thermal_zone1/type': 'gpu-thermal',
    '/sys/devices/virtual/thermal/thermal_zone1/temp': '54500',
    ...overrides
  };
  const directories = {
    '/sys/class/devfreq': ['17000000.gpu'],
    '/sys/devices/virtual/thermal': ['thermal_zone0', 'thermal_zone1']
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
    assert.equal(result.model, 'NVIDIA Jetson Orin Nano Super Developer Kit');
    assert.equal(result.l4tVersion, '36.4.3');
    assert.equal(result.powerMode.id, 2);
    assert.equal(result.powerMode.name, 'MAXN_SUPER');
    assert.equal(result.powerMode.isMaximum, true);
    assert.equal(result.gpuLoadPercent, 84.2);
    assert.equal(result.gpuClockHz, 1020000000);
    assert.equal(result.gpuTemperatureC, 54.5);
    assert.deepEqual(result.warnings, []);
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
      jetsonFixture({ '/sys/class/devfreq/17000000.gpu/cur_freq': '400000000' })
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
