'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SYSTEM_PROMPT, normalizeAiConfig } = require('../lib/ai-service.cjs');
const { normalizeHistoryConfig } = require('../lib/history-service.cjs');
const {
  DOCS_URL,
  SECTIONS,
  SETTING_LABELS,
  TOP_LEVEL_KEYS,
  migrateSettings,
  readSettings,
  settingsSchema,
  settingsUiSchema
} = require('../lib/settings.cjs');

/** Options as the admin page stores them once the form is saved with everything changed. */
const NESTED = Object.freeze({
  enabled: false,
  aiModel: {
    backend: 'tensorrt-llm',
    baseUrl: 'http://gpu.local:8000',
    model: 'gemma4:e4b',
    apiKey: 'k1',
    keepAlive: '1h',
    warmupOnStart: false
  },
  answers: {
    systemPrompt: 'Be brief.',
    temperature: 0.5,
    topP: 0.8,
    maxTokens: 512,
    requestTimeoutMs: 180000
  },
  history: {
    historyEnabled: true,
    historyDuration: 'PT6H',
    historyResolution: '5m',
    historySamples: 24,
    historyServerUrl: 'http://nas.local:3000',
    historyApiKey: 'k2',
    historyProvider: 'signalk-parquet',
    historyTimeoutMs: 8000
  },
  advanced: { numCtx: 4096, numGpu: 999, gpuAutoTune: false, numBatch: 256, numThread: 4 },
  aiDataPaths: ['navigation.*', 'notifications.*'],
  historyPaths: ['environment.wind.speedApparent']
});

/** The same settings as every version before the sections stored them. */
const FLAT = Object.freeze({
  enabled: false,
  aiDataPaths: ['navigation.*', 'notifications.*'],
  historyPaths: ['environment.wind.speedApparent'],
  backend: 'tensorrt-llm',
  baseUrl: 'http://gpu.local:8000',
  model: 'gemma4:e4b',
  apiKey: 'k1',
  keepAlive: '1h',
  warmupOnStart: false,
  systemPrompt: 'Be brief.',
  temperature: 0.5,
  topP: 0.8,
  maxTokens: 512,
  requestTimeoutMs: 180000,
  historyEnabled: true,
  historyDuration: 'PT6H',
  historyResolution: '5m',
  historySamples: 24,
  historyServerUrl: 'http://nas.local:3000',
  historyApiKey: 'k2',
  historyProvider: 'signalk-parquet',
  historyTimeoutMs: 8000,
  numCtx: 4096,
  numGpu: 999,
  gpuAutoTune: false,
  numBatch: 256,
  numThread: 4
});

/**
 * Every setting's default, and its bounds, as the flat form before the
 * sections had them. The sections must not change any of them: a form saved
 * untouched stores these values, and the plugin's behaviour follows them.
 */
const PREVIOUS_FORM = Object.freeze({
  enabled: { type: 'boolean', default: true },
  baseUrl: { type: 'string', default: 'http://localhost:11434' },
  model: { type: 'string', default: 'gemma4' },
  systemPrompt: { type: 'string', default: DEFAULT_SYSTEM_PROMPT },
  requestTimeoutMs: { type: 'integer', default: 120000, minimum: 0, maximum: 300000 },
  temperature: { type: 'number', default: 0.2, minimum: 0, maximum: 2 },
  topP: { type: 'number', default: 0.95, minimum: 0, maximum: 1 },
  maxTokens: { type: 'integer', default: 2048, minimum: 64, maximum: 131072 },
  numCtx: { type: 'integer', default: 8192, minimum: 512, maximum: 131072 },
  numGpu: { type: 'integer', default: -1, minimum: -1, maximum: 999 },
  gpuAutoTune: { type: 'boolean', default: true },
  numBatch: { type: 'integer', default: 512, minimum: 32, maximum: 4096 },
  numThread: { type: 'integer', default: 0, minimum: 0, maximum: 64 },
  keepAlive: { type: 'string', default: '30m' },
  warmupOnStart: { type: 'boolean', default: true },
  backend: { type: 'string', default: 'ollama' },
  apiKey: { type: 'string', default: '' },
  historyEnabled: { type: 'boolean', default: false },
  historyDuration: { type: 'string', default: 'PT1H' },
  historyResolution: { type: 'string', default: '' },
  historySamples: { type: 'integer', default: 12, minimum: 2, maximum: 200 },
  historyApiKey: { type: 'string', default: '' },
  historyProvider: { type: 'string', default: '' },
  historyServerUrl: { type: 'string', default: '' },
  historyTimeoutMs: { type: 'integer', default: 5000, minimum: 0, maximum: 120000 }
});

/**
 * A section's fields, wherever they are: its properties or a dependency
 * branch. The value is the field's schema and `shown`: 'always', or the
 * switch value that shows it.
 */
function fieldsOf(section) {
  const fields = {};
  for (const [name, field] of Object.entries(section.properties)) fields[name] = { field, shown: 'always' };
  for (const [switchKey, dependency] of Object.entries(section.dependencies || {})) {
    for (const branch of dependency.oneOf || []) {
      const [when] = branch.properties[switchKey].enum;
      for (const [name, field] of Object.entries(branch.properties)) {
        if (name !== switchKey) {
          assert.ok(!(name in fields), `${name} is in one place only`);
          fields[name] = { field, shown: { [switchKey]: when } };
        }
      }
    }
  }
  return fields;
}

/** Every field of the form by key, with its section. */
function allFields(schema) {
  const fields = { enabled: { field: schema.properties.enabled, shown: 'always', section: undefined } };
  for (const section of Object.keys(SECTIONS)) {
    for (const [name, entry] of Object.entries(fieldsOf(schema.properties[section]))) {
      fields[name] = { ...entry, section };
    }
  }
  return fields;
}

describe('readSettings', () => {
  it('flattens the sections into the keys the plugin reads', () => {
    assert.deepEqual(readSettings(NESTED), FLAT);
  });

  it('reads settings stored flat, from before the sections, unchanged', () => {
    assert.deepEqual(readSettings(FLAT), FLAT);
  });

  it('takes a section over a flat key, and a flat key where the section has none', () => {
    const settings = readSettings({
      ...FLAT,
      aiModel: { model: 'qwen3:4b' },
      history: { historyServerUrl: '' },
      advanced: { numCtx: 16384 }
    });
    assert.equal(settings.model, 'qwen3:4b');
    // Blank in the section is a setting, not a gap: the flat URL is not used.
    assert.equal(settings.historyServerUrl, '');
    assert.equal(settings.numCtx, 16384);
    // Not in the section: the flat key still counts.
    assert.equal(settings.baseUrl, 'http://gpu.local:8000');
    assert.equal(settings.numBatch, 256);
    assert.equal(settings.historyProvider, 'signalk-parquet');
    assert.equal(settings.systemPrompt, 'Be brief.');
  });

  it('keeps the switch and the path selections at the top level only', () => {
    // A switch or a selection put inside a section is not read from there.
    const settings = readSettings({ aiModel: { enabled: false, aiDataPaths: ['x'] }, history: { historyPaths: ['y'] } });
    assert.deepEqual(settings, {});
  });

  it('leaves out what is set nowhere, so the defaults and environment variables still apply', () => {
    assert.deepEqual(readSettings({}), {});
    assert.deepEqual(readSettings(undefined), {});
    assert.deepEqual(readSettings(null), {});
    assert.deepEqual(readSettings({ aiModel: 'not a section', answers: null, history: [], advanced: 3 }), {});
    const env = {
      SIGNALK_AI_BRIDGE_NUM_CTX: '4096',
      SIGNALK_AI_BRIDGE_MODEL: 'qwen3:4b',
      SIGNALK_AI_BRIDGE_BACKEND: 'tensorrt-llm',
      SIGNALK_AI_BRIDGE_HISTORY_TIMEOUT_MS: '9000',
      SIGNALK_AI_BRIDGE_HISTORY_ENABLED: 'true'
    };
    const ai = normalizeAiConfig(readSettings({ aiModel: {}, advanced: {} }), env);
    assert.equal(ai.numCtx, 4096);
    assert.equal(ai.model, 'qwen3:4b');
    assert.equal(ai.backend, 'tensorrt-llm');
    const history = normalizeHistoryConfig(readSettings({ history: {} }), env);
    assert.equal(history.historyTimeoutMs, 9000);
    assert.equal(history.historyEnabled, true);
    // With nothing set and no environment, the defaults the form shows.
    assert.deepEqual(normalizeAiConfig(readSettings({}), {}), normalizeAiConfig({}, {}));
    assert.equal(normalizeAiConfig(readSettings({}), {}).enabled, true);
  });

  it('gives the AI and history clients what the flat settings gave them', () => {
    assert.deepEqual(normalizeAiConfig(readSettings(NESTED), {}), normalizeAiConfig(FLAT, {}));
    assert.deepEqual(normalizeHistoryConfig(readSettings(NESTED), {}), normalizeHistoryConfig(FLAT, {}));
    const ai = normalizeAiConfig(readSettings(NESTED), {});
    assert.equal(ai.backend, 'tensorrt-llm');
    assert.equal(ai.apiKey, 'k1');
    assert.equal(ai.numCtx, 4096);
    assert.equal(ai.enabled, false);
    // Read twice, the same: the plugin may hand flat settings on.
    assert.deepEqual(readSettings(readSettings(NESTED)), readSettings(NESTED));
  });

  it('does not change the options it reads', () => {
    const options = JSON.parse(JSON.stringify(NESTED));
    readSettings(options);
    assert.deepEqual(options, NESTED);
  });
});

/**
 * What the admin page's form does with stored options before they are
 * saved: fill each field it shows and that has no value with its default
 * (react-jsonschema-form's getDefaultFormState, for this schema's shape).
 * Fields a switch hides are not filled; keys it does not know are kept.
 */
function fillFormDefaults(schema, options) {
  const filled = { ...options };
  for (const [key, field] of Object.entries(schema.properties)) {
    if (field.type !== 'object') {
      if (filled[key] === undefined) filled[key] = field.default;
      continue;
    }
    const section = { ...(filled[key] || {}) };
    for (const [name, sub] of Object.entries(field.properties)) {
      if (section[name] === undefined) section[name] = sub.default;
    }
    for (const [switchKey, dependency] of Object.entries(field.dependencies || {})) {
      const branch = dependency.oneOf.find((item) => item.properties[switchKey].enum.includes(section[switchKey]));
      for (const [name, sub] of Object.entries(branch ? branch.properties : {})) {
        if (name !== switchKey && section[name] === undefined) section[name] = sub.default;
      }
    }
    filled[key] = section;
  }
  return filled;
}

describe('migrateSettings', () => {
  const FORM_KEYS = Object.values(SECTIONS).flat();

  it('moves every setting stored flat into its section, with the same value, and drops the flat key', () => {
    const { options, moved, kept } = migrateSettings(FLAT);
    assert.deepEqual(options, NESTED);
    assert.deepEqual([...moved].sort(), [...FORM_KEYS].sort());
    assert.deepEqual(kept, []);
    for (const key of FORM_KEYS) assert.equal(key in options, false, key);
    assert.deepEqual(readSettings(options), readSettings(FLAT));
    assert.deepEqual(normalizeAiConfig(readSettings(options), {}), normalizeAiConfig(FLAT, {}));
    assert.deepEqual(normalizeHistoryConfig(readSettings(options), {}), normalizeHistoryConfig(FLAT, {}));
  });

  it('keeps a value already in the section over the flat one', () => {
    const { options, moved, kept } = migrateSettings({
      model: 'old-flat',
      numCtx: 2048,
      historyEnabled: true,
      aiModel: { model: 'from-the-form' },
      advanced: { numBatch: 128 }
    });
    assert.deepEqual(options, {
      aiModel: { model: 'from-the-form' },
      advanced: { numBatch: 128, numCtx: 2048 },
      history: { historyEnabled: true }
    });
    // In the form's order: section by section.
    assert.deepEqual(moved, ['historyEnabled', 'numCtx']);
    assert.deepEqual(kept, ['model']);
  });

  it('changes nothing, and gives the same object back, when nothing is flat', () => {
    for (const stored of [NESTED, {}, { enabled: false, aiDataPaths: ['a'] }, { aiModel: {}, somethingElse: 1 }]) {
      const result = migrateSettings(stored);
      assert.equal(result.options, stored);
      assert.deepEqual(result.moved, []);
    }
    // Idempotent: a second pass has nothing to do.
    const once = migrateSettings(FLAT).options;
    assert.equal(migrateSettings(once).options, once);
  });

  it('keeps the switch, the path selections and keys it does not know where they are', () => {
    const { options } = migrateSettings({ enabled: false, aiDataPaths: ['a'], historyPaths: ['b'], futureKey: { x: 1 }, model: 'm' });
    assert.deepEqual(options, { enabled: false, aiDataPaths: ['a'], historyPaths: ['b'], futureKey: { x: 1 }, aiModel: { model: 'm' } });
  });

  it('loses no value: a section stored as something else is left alone, with its flat keys', () => {
    const stored = { aiModel: 'not a section', model: 'm', numCtx: 4096 };
    const { options, moved } = migrateSettings(stored);
    assert.deepEqual(options, { aiModel: 'not a section', model: 'm', advanced: { numCtx: 4096 } });
    assert.deepEqual(moved, ['numCtx']);
    assert.equal(readSettings(options).model, 'm');
  });

  it('does not change the options it is given', () => {
    const stored = JSON.parse(JSON.stringify({ ...FLAT, aiModel: { model: 'x' } }));
    const copy = JSON.parse(JSON.stringify(stored));
    migrateSettings(stored);
    assert.deepEqual(stored, copy);
  });

  it('leaves nothing for the form to fill over a stored value on its first save', () => {
    const schema = settingsSchema();
    // Flat options, as an earlier version stored them: the form's defaults
    // would have replaced every one of them.
    const before = fillFormDefaults(schema, FLAT);
    assert.notDeepEqual(readSettings(before), readSettings(FLAT));
    // Moved into the sections first, the form keeps every stored value.
    const after = fillFormDefaults(schema, migrateSettings(FLAT).options);
    for (const [key, value] of Object.entries(readSettings(FLAT))) {
      assert.deepEqual(readSettings(after)[key], value, key);
    }
  });
});

describe('the settings form', () => {
  const schema = settingsSchema();

  it('starts with the switch, then the sections in order', () => {
    assert.deepEqual(Object.keys(schema.properties), ['enabled', 'aiModel', 'answers', 'history', 'advanced']);
    assert.deepEqual(Object.keys(SECTIONS), ['aiModel', 'answers', 'history', 'advanced']);
    assert.equal(schema.properties.enabled.title, 'Turn on AI Bridge');
    assert.deepEqual(
      Object.keys(SECTIONS).map((key) => schema.properties[key].title),
      ['AI model', 'Answers', 'History in answers – optional', 'Advanced – GPU and memory']
    );
    assert.match(schema.description, /Ollama/);
    assert.match(schema.description, /not included/);
    assert.match(schema.description, /only the switch and the AI model section/);
    assert.ok(schema.description.includes(DOCS_URL));
    assert.equal(schema.description.split(DOCS_URL).length, 2, 'the docs are linked once');
    assert.match(schema.properties.answers.description, /Safe to leave/);
    assert.match(schema.properties.advanced.description, /Leave these unless you know your GPU/);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'docs', path.basename(DOCS_URL))), true);
  });

  it('holds every setting it held before, in its section, with a title, a short description and the same default', () => {
    const fields = allFields(schema);
    assert.deepEqual(Object.keys(fields).sort(), Object.keys(PREVIOUS_FORM).sort());
    for (const [name, previous] of Object.entries(PREVIOUS_FORM)) {
      const { field } = fields[name];
      assert.ok(field.title, `${name} has a title`);
      assert.ok(field.description, `${name} has a description`);
      const sentences = field.description.split(/[.!?](?:\s|$)/).filter((part) => part.trim());
      assert.ok(sentences.length <= 2, `${name}: at most two sentences`);
      for (const [key, value] of Object.entries(previous)) {
        assert.deepEqual(field[key], value, `${name}.${key}`);
      }
      for (const key of ['minimum', 'maximum']) {
        assert.equal(key in field, key in previous, `${name} ${key}`);
      }
    }
    for (const [section, keys] of Object.entries(SECTIONS)) {
      const section_ = schema.properties[section];
      assert.equal(section_.type, 'object', section);
      assert.ok(section_.description, `${section} has a description`);
      // The order is the uiSchema's, since a field shown by a switch comes
      // after the others in the schema.
      assert.deepEqual(Object.keys(fieldsOf(section_)).sort(), [...keys].sort(), `${section} holds its keys`);
    }
    // Everything readSettings reads is in the form, or is written by the panel.
    const read = [...TOP_LEVEL_KEYS, ...Object.values(SECTIONS).flat()];
    assert.deepEqual([...read].sort(), [...Object.keys(fields), 'aiDataPaths', 'historyPaths'].sort());
    assert.deepEqual(TOP_LEVEL_KEYS, ['enabled', 'aiDataPaths', 'historyPaths']);
  });

  it('offers the model servers by friendly names, keeping the stored values', () => {
    const backend = schema.properties.aiModel.properties.backend;
    assert.equal(backend.enum, undefined);
    assert.deepEqual(
      backend.oneOf.map((option) => [option.const, option.title]),
      [
        ['ollama', 'Ollama'],
        ['tensorrt-llm', 'TensorRT-LLM or NIM (NVIDIA)']
      ]
    );
    assert.equal(backend.default, 'ollama');
  });

  it('shows the API key only for a TensorRT-LLM or NIM server', () => {
    const fields = allFields(schema);
    assert.deepEqual(fields.apiKey.shown, { backend: 'tensorrt-llm' });
    const [ollama, tensorrt] = schema.properties.aiModel.dependencies.backend.oneOf;
    assert.deepEqual(ollama, { properties: { backend: { enum: ['ollama'] } } });
    assert.deepEqual(Object.keys(tensorrt.properties), ['backend', 'apiKey']);
    // The branches name exactly the values the field offers.
    assert.deepEqual(
      schema.properties.aiModel.dependencies.backend.oneOf.map((branch) => branch.properties.backend.enum[0]),
      schema.properties.aiModel.properties.backend.oneOf.map((option) => option.const)
    );
  });

  it('shows the history settings only once history is switched on', () => {
    const section = schema.properties.history;
    assert.deepEqual(Object.keys(section.properties), ['historyEnabled']);
    assert.equal(section.properties.historyEnabled.default, false);
    const [off, on] = section.dependencies.historyEnabled.oneOf;
    assert.deepEqual(off, { properties: { historyEnabled: { enum: [false] } } });
    assert.deepEqual(on.properties.historyEnabled, { enum: [true] });
    assert.deepEqual(Object.keys(on.properties).slice(1), SECTIONS.history.slice(1));
    const fields = allFields(schema);
    for (const key of SECTIONS.history.slice(1)) {
      assert.deepEqual(fields[key].shown, { historyEnabled: true }, key);
    }
    // Nothing else in the form is conditional.
    const conditional = Object.entries(fields).filter(([, entry]) => entry.shown !== 'always').map(([name]) => name);
    assert.deepEqual(conditional.sort(), ['apiKey', ...SECTIONS.history.slice(1)].sort());
  });

  it('is plain JSON, as the server stores it and plugin-ci checks it', () => {
    const problems = [];
    const walk = (node, at) => {
      if (node === null) return;
      if (typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') problems.push(`${at} is a ${typeof node}`);
      if (typeof node === 'number' && !Number.isFinite(node)) problems.push(`${at} is ${node}`);
      if (typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (value === undefined) problems.push(`${at}.${key} is undefined`);
        else walk(value, `${at}.${key}`);
      }
    };
    walk(schema, 'schema');
    walk(settingsUiSchema(), 'uiSchema');
    assert.deepEqual(problems, []);
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
    assert.deepEqual(JSON.parse(JSON.stringify(settingsUiSchema())), settingsUiSchema());
  });

  it('orders and dresses only properties the form has, masks both API keys and shows what blank means', () => {
    const ui = settingsUiSchema();
    assert.deepEqual(ui['ui:order'], ['enabled', 'aiModel', 'answers', 'history', 'advanced', '*']);
    for (const name of ui['ui:order'].filter((item) => item !== '*')) {
      assert.ok(name in schema.properties, `${name} is in the form`);
    }
    for (const [section, entries] of Object.entries(ui).filter(([key]) => !key.startsWith('ui:'))) {
      assert.ok(section in SECTIONS, `${section} is a section`);
      const fields = fieldsOf(schema.properties[section]);
      for (const name of Object.keys(entries).filter((key) => !key.startsWith('ui:'))) {
        assert.ok(name in fields, `${section}.${name} is in the form`);
      }
      const order = entries['ui:order'];
      assert.ok(Array.isArray(order), `${section} has an order`);
      assert.deepEqual(order.filter((item) => item !== '*'), [...SECTIONS[section]], `${section} order`);
      assert.equal(order.at(-1), '*', `${section}: anything else goes last`);
    }
    assert.equal(ui.aiModel.apiKey['ui:widget'], 'password');
    assert.equal(ui.history.historyApiKey['ui:widget'], 'password');
    assert.equal(ui.answers.systemPrompt['ui:widget'], 'textarea');
    assert.equal(ui.aiModel.baseUrl['ui:placeholder'], 'http://localhost:11434');
    assert.ok(ui.history.historyServerUrl['ui:placeholder']);
    assert.ok(ui.history.historyResolution['ui:placeholder']);
    assert.ok(ui.history.historyProvider['ui:placeholder']);
  });

  it('names settings in messages by their place in the form', () => {
    const fields = allFields(schema);
    for (const [key, label] of Object.entries(SETTING_LABELS)) {
      const title = label.split(' → ').at(-1);
      assert.equal(fields[key].field.title, title, key);
      if (label.includes(' → ')) {
        const sectionTitle = schema.properties[fields[key].section].title;
        assert.ok(sectionTitle.startsWith(label.split(' → ')[0]), `${key}: ${sectionTitle}`);
      }
    }
    // lib/ai-service.cjs and lib/gpu-telemetry.cjs write the labels out,
    // since they cannot require lib/settings.cjs: they must stay the same.
    const lib = (file) => fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
    const quoted = (text) => [...text.matchAll(/"([^"]*(?:→|Turn on AI Bridge)[^"]*)"/g)].map((match) => match[1]);
    const labels = new Set(Object.values(SETTING_LABELS));
    for (const file of ['ai-service.cjs', 'gpu-telemetry.cjs', 'history-service.cjs']) {
      for (const label of quoted(lib(file))) assert.ok(labels.has(label), `${file}: "${label}" is a setting's label`);
    }
    assert.ok(lib('ai-service.cjs').includes(`"${SETTING_LABELS.numCtx}"`));
    assert.ok(lib('ai-service.cjs').includes(`"${SETTING_LABELS.numBatch}"`));
    assert.ok(lib('ai-service.cjs').includes(`"${SETTING_LABELS.maxTokens}"`));
    assert.ok(lib('ai-service.cjs').includes(`"${SETTING_LABELS.enabled}"`));
    assert.ok(lib('gpu-telemetry.cjs').includes(`"${SETTING_LABELS.warmupOnStart}"`));
    assert.ok(lib('history-service.cjs').includes(`"${SETTING_LABELS.historyServerUrl}"`));
    assert.ok(lib('history-service.cjs').includes(`"${SETTING_LABELS.historyApiKey}"`));
  });
});
