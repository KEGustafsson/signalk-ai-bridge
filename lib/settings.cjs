'use strict';

const {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_KEEP_ALIVE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_NUM_BATCH,
  DEFAULT_NUM_CTX,
  DEFAULT_NUM_GPU,
  DEFAULT_NUM_THREAD,
  DEFAULT_SYSTEM_PROMPT,
  MAX_NUM_BATCH,
  MAX_NUM_CTX,
  MAX_NUM_GPU,
  MAX_NUM_THREAD,
  MIN_NUM_BATCH,
  MIN_NUM_CTX
} = require('./ai-service.cjs');
const {
  DEFAULT_HISTORY_DURATION,
  DEFAULT_HISTORY_SAMPLES,
  DEFAULT_HISTORY_TIMEOUT_MS,
  MAX_HISTORY_SAMPLES,
  MIN_HISTORY_SAMPLES
} = require('./history-service.cjs');

/**
 * The plugin's settings: the form the Signal K admin page shows, and the one
 * function that reads what that form stores.
 *
 * The form is grouped into sections (nested objects, which the admin page's
 * react-jsonschema-form renders as titled fieldsets). The rest of the plugin
 * - normalizeAiConfig, normalizeHistoryConfig, the path routes - reads one
 * flat object with the long-standing keys (`baseUrl`, `numCtx`,
 * `historyServerUrl`, ...), and readSettings() makes that object. Inside a
 * section the keys keep those names, so a key means the same thing wherever
 * it is written, and settings stored flat (as every version before the
 * sections did) still read.
 */

const DOCS_URL = 'https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/settings.md';

/** Which keys each section of the form holds, in the form's order. */
const SECTIONS = Object.freeze({
  aiModel: Object.freeze(['backend', 'baseUrl', 'model', 'apiKey', 'keepAlive', 'warmupOnStart']),
  answers: Object.freeze(['systemPrompt', 'temperature', 'topP', 'maxTokens', 'requestTimeoutMs']),
  history: Object.freeze([
    'historyEnabled',
    'historyDuration',
    'historyResolution',
    'historySamples',
    'historyServerUrl',
    'historyApiKey',
    'historyProvider',
    'historyTimeoutMs'
  ]),
  advanced: Object.freeze(['numCtx', 'numGpu', 'gpuAutoTune', 'numBatch', 'numThread'])
});

/**
 * Keys outside every section: the on/off switch, and the two path selections,
 * which the panel writes (POST /paths/selection, POST /paths/move) and the
 * form does not show.
 */
const TOP_LEVEL_KEYS = Object.freeze(['enabled', 'aiDataPaths', 'historyPaths']);

/**
 * What the form calls a setting, for a message that tells the operator which
 * one to change: the section, then the field. lib/ai-service.cjs and
 * lib/gpu-telemetry.cjs cannot require this module (it requires them), so
 * they write the same words out; test/settings.test.cjs holds them to these.
 */
const SETTING_LABELS = Object.freeze({
  enabled: 'Turn on AI Bridge',
  warmupOnStart: 'AI model → Load the model when the plugin starts',
  maxTokens: 'Answers → Longest answer (tokens)',
  historyServerUrl: 'History server address',
  historyApiKey: 'History API key',
  numCtx: 'Advanced → Context window (tokens)',
  numBatch: 'Advanced → Batch size'
});

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The flat settings the rest of the plugin reads, from the options Signal K
 * stored.
 *
 * Each key is read from its section, and from the top level when the section
 * does not have it (settings stored before the sections existed). A key given
 * nowhere is left out, so the normaliser's own default - or a
 * SIGNALK_AI_BRIDGE_* environment variable that stands in for a missing
 * setting - still applies. The options themselves are not changed.
 */
function readSettings(options) {
  const source = isPlainObject(options) ? options : {};
  const flat = {};
  for (const key of TOP_LEVEL_KEYS) {
    if (source[key] !== undefined) flat[key] = source[key];
  }
  for (const [section, keys] of Object.entries(SECTIONS)) {
    const nested = isPlainObject(source[section]) ? source[section] : {};
    for (const key of keys) {
      const value = nested[key] !== undefined ? nested[key] : source[key];
      if (value !== undefined) flat[key] = value;
    }
  }
  return flat;
}

/**
 * The options with every setting still stored flat moved into its section.
 *
 * The admin page shows only what the sections hold, so settings an earlier
 * version stored flat would appear as the defaults, and the first save of the
 * form would put those defaults over them. Moving them once, on start, makes
 * the form show the values the plugin runs on. Until then - and a plugin that
 * is off is not started - settingsSchema() shows them as its defaults.
 *
 * A value already in the section wins over the flat one (it is the newer: the
 * form wrote it), and the flat key goes either way. The switch, the path
 * selections and any key this plugin does not know are kept as they are. A
 * section stored as something other than an object is left alone, with its
 * flat keys, rather than overwritten. Nothing is changed in place.
 *
 * Returns { options, moved, kept }: `moved` lists the flat keys whose value
 * went into a section, `kept` the flat keys dropped because the section had a
 * value of its own. With nothing flat, `options` is the object given, so a
 * caller can tell "nothing to do" by identity.
 */
function migrateSettings(options) {
  const source = isPlainObject(options) ? options : {};
  const moved = [];
  const kept = [];
  let result;
  for (const [section, keys] of Object.entries(SECTIONS)) {
    const flatKeys = keys.filter((key) => source[key] !== undefined);
    if (flatKeys.length === 0) continue;
    if (source[section] !== undefined && !isPlainObject(source[section])) continue;
    result = result || { ...source };
    const nested = { ...(isPlainObject(source[section]) ? source[section] : {}) };
    for (const key of flatKeys) {
      if (nested[key] === undefined) {
        nested[key] = source[key];
        moved.push(key);
      } else {
        kept.push(key);
      }
      delete result[key];
    }
    result[section] = nested;
  }
  return { options: result || options, moved, kept };
}

/**
 * The values the form should show for settings still stored flat: for each
 * section, what migrateSettings() would put there that the stored section
 * does not hold yet. Empty when nothing is flat.
 */
function storedValues(options) {
  if (!isPlainObject(options)) return {};
  const migrated = migrateSettings(options).options;
  if (migrated === options) return {};
  const values = {};
  for (const [section, keys] of Object.entries(SECTIONS)) {
    if (!isPlainObject(migrated[section])) continue;
    const before = isPlainObject(options[section]) ? options[section] : {};
    for (const key of keys) {
      if (migrated[section][key] !== undefined && before[key] === undefined) {
        values[section] = values[section] || {};
        values[section][key] = migrated[section][key];
      }
    }
  }
  return values;
}

/**
 * Whether the form can take `value` as the field's default: the field's type,
 * and its choices or range where it has them. A default the form rejects
 * would stop it from being saved at all.
 */
function fitsField(field, value) {
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') return false;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return false;
      break;
    case 'integer':
      if (!Number.isInteger(value)) return false;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      break;
    case 'array':
      if (!Array.isArray(value) || !value.every((item) => fitsField(field.items || {}, item))) return false;
      break;
    default:
      return false;
  }
  if (Array.isArray(field.enum) && !field.enum.includes(value)) return false;
  if (Array.isArray(field.oneOf) && !field.oneOf.some((option) => option.const === value)) return false;
  if (typeof field.minimum === 'number' && value < field.minimum) return false;
  if (typeof field.maximum === 'number' && value > field.maximum) return false;
  return true;
}

/** Added to a field whose flat value the form cannot take. */
const STORED_VALUE_NOT_SHOWN =
  'The value an earlier version saved here is not one this field takes, so the default is shown instead.';

/**
 * The settings form, as JSON Schema (draft-07) for the admin page.
 *
 * Given the options Signal K stored, the form also shows the settings an
 * earlier version stored flat. The admin page fills each field the stored
 * sections leave empty with the field's default, and a save stores what it
 * filled in - over the flat value, since readSettings() prefers the section.
 * start() moves flat settings into their sections, but a plugin that is off
 * is never started. So each such setting becomes its field's default here,
 * and the form shows it, and a save stores it, while the plugin is off too.
 * A value the field does not take (outside its range or choices, or of the
 * wrong type) keeps the field's own default, with a note saying so. Without
 * options, or with nothing flat, the form is the same as always.
 */
function settingsSchema(stored) {
  const schema = formSchema();
  for (const [section, values] of Object.entries(storedValues(stored))) {
    const sectionSchema = schema.properties[section];
    const branches = Object.values(sectionSchema.dependencies || {}).flatMap((dependency) => dependency.oneOf || []);
    for (const properties of [sectionSchema.properties, ...branches.map((branch) => branch.properties || {})]) {
      for (const [key, value] of Object.entries(values)) {
        const field = properties[key];
        if (!field || !('default' in field)) continue;
        if (fitsField(field, value)) {
          field.default = JSON.parse(JSON.stringify(value));
        } else {
          field.description = `${field.description} ${STORED_VALUE_NOT_SHOWN}`;
        }
      }
    }
  }
  return schema;
}

function formSchema() {
  return {
    type: 'object',
    title: 'AI Bridge',
    description:
      "AI Bridge lets you ask questions about your boat's live and recent data, answered by a language model running on board. " +
      'It needs a model server: Ollama by default, which is not included and is installed separately, or an NVIDIA TensorRT-LLM or NIM server. ' +
      'Usually only the switch and the AI model section need attention; everything else has working defaults. ' +
      `Every setting in detail: ${DOCS_URL}`,
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Turn on AI Bridge',
        description: 'Answer questions asked in the AI Bridge panel. Off, the panel still opens but nothing is sent to a model.',
        default: true
      },
      aiModel: {
        type: 'object',
        title: 'AI model',
        description: 'Which model server answers, where it runs, and which model it uses.',
        properties: {
          backend: {
            type: 'string',
            title: 'Model server type',
            description: 'Ollama is the usual choice. TensorRT-LLM or NIM is for an NVIDIA engine built for this GPU.',
            oneOf: [
              { const: 'ollama', title: 'Ollama' },
              { const: 'tensorrt-llm', title: 'TensorRT-LLM or NIM (NVIDIA)' }
            ],
            default: 'ollama'
          },
          baseUrl: {
            type: 'string',
            title: 'Model server address',
            description: 'Where the model server runs. The default is Ollama on this machine.',
            default: DEFAULT_AI_BASE_URL
          },
          model: {
            type: 'string',
            title: 'Model name',
            description:
              'A model installed on that server, such as gemma4:e2b-it-qat. Plain gemma4 uses whichever Gemma 4 is installed.',
            default: DEFAULT_AI_MODEL
          },
          keepAlive: {
            type: 'string',
            title: 'Keep the model loaded for',
            description: 'How long the model stays in memory after a question, such as 30m or 1h; -1 keeps it loaded. Loading it again takes several seconds.',
            default: DEFAULT_KEEP_ALIVE
          },
          warmupOnStart: {
            type: 'boolean',
            title: 'Load the model when the plugin starts',
            description: 'So the first question does not wait for the model to load.',
            default: true
          }
        },
        dependencies: {
          backend: {
            oneOf: [
              { properties: { backend: { enum: ['ollama'] } } },
              {
                properties: {
                  backend: { enum: ['tensorrt-llm'] },
                  apiKey: {
                    type: 'string',
                    title: 'API key',
                    description: 'Only if your TensorRT-LLM or NIM server asks for one. Leave blank otherwise.',
                    default: ''
                  }
                }
              }
            ]
          }
        }
      },
      answers: {
        type: 'object',
        title: 'Answers',
        description: 'How the model writes its answers. Safe to leave as they are.',
        properties: {
          systemPrompt: {
            type: 'string',
            title: 'Instructions to the model',
            description:
              'Sent before every question. The default is tuned on real mistakes, so add to it rather than replace it.',
            default: DEFAULT_SYSTEM_PROMPT
          },
          temperature: {
            type: 'number',
            title: 'Creativity (temperature)',
            description: 'Lower gives steadier, more literal answers; higher gives more varied ones.',
            default: 0.2,
            minimum: 0,
            maximum: 2
          },
          topP: {
            type: 'number',
            title: 'Word choice (top-p)',
            description: 'Another control on how varied the answers are. Best left as it is.',
            default: 0.95,
            minimum: 0,
            maximum: 1
          },
          maxTokens: {
            type: 'integer',
            title: 'Longest answer (tokens)',
            description: 'An upper limit on answer length; a token is about three quarters of a word. It is held to half the context window.',
            default: DEFAULT_MAX_TOKENS,
            minimum: 64,
            maximum: MAX_NUM_CTX
          },
          requestTimeoutMs: {
            type: 'integer',
            title: 'Wait for an answer (ms)',
            description: 'How long to wait before giving up, including loading the model, which can take a minute on a Jetson. 0 waits forever.',
            default: 120000,
            minimum: 0,
            maximum: 300000
          }
        }
      },
      history: {
        type: 'object',
        title: 'History in answers – optional',
        description:
          'Also send recent history, so the model can answer questions such as "has the wind been building?". Needs a history plugin such as signalk-parquet or signalk-to-influxdb2.',
        properties: {
          historyEnabled: {
            type: 'boolean',
            title: 'Include recent history',
            description: 'Choose the paths in the AI Bridge panel, under History Context. Without a history plugin, answers use live data only.',
            default: false
          }
        },
        dependencies: {
          historyEnabled: {
            oneOf: [
              { properties: { historyEnabled: { enum: [false] } } },
              {
                properties: {
                  historyEnabled: { enum: [true] },
                  historyDuration: {
                    type: 'string',
                    title: 'How far back',
                    description: 'Such as PT1H, 2h, 30m or P1D. At most 31 days.',
                    default: DEFAULT_HISTORY_DURATION
                  },
                  historyResolution: {
                    type: 'string',
                    title: 'Time step',
                    description: 'The length of each averaged step, such as 1m, or 300 for seconds. Blank picks one to fit the points per path.',
                    default: ''
                  },
                  historySamples: {
                    type: 'integer',
                    title: 'Points per path',
                    description: 'How many points of each path the model sees, spread evenly from start to end.',
                    default: DEFAULT_HISTORY_SAMPLES,
                    minimum: MIN_HISTORY_SAMPLES,
                    maximum: MAX_HISTORY_SAMPLES
                  },
                  historyServerUrl: {
                    type: 'string',
                    title: 'History server address',
                    description: 'Leave blank to use this Signal K server. Set it only for history kept on another one.',
                    default: ''
                  },
                  historyApiKey: {
                    type: 'string',
                    title: 'History API key',
                    description: 'Only for a history server other than this one. Leave blank otherwise.',
                    default: ''
                  },
                  historyProvider: {
                    type: 'string',
                    title: 'History provider',
                    description: 'The plugin id of one provider, such as signalk-parquet. Blank uses the server default.',
                    default: ''
                  },
                  historyTimeoutMs: {
                    type: 'integer',
                    title: 'Wait for history (ms)',
                    description: 'How long to wait before answering from live data alone. 0 waits forever.',
                    default: DEFAULT_HISTORY_TIMEOUT_MS,
                    minimum: 0,
                    maximum: 120000
                  }
                }
              }
            ]
          }
        }
      },
      advanced: {
        type: 'object',
        title: 'Advanced – GPU and memory',
        description: 'Leave these unless you know your GPU: the defaults and the automatic fitting suit most boards.',
        properties: {
          numCtx: {
            type: 'integer',
            title: 'Context window (tokens)',
            description:
              'How much the model holds at once: it decides whether the model fits on the GPU and how much boat data is sent. On an 8 GB board keep it at 16384 or below.',
            default: DEFAULT_NUM_CTX,
            minimum: MIN_NUM_CTX,
            maximum: MAX_NUM_CTX
          },
          numGpu: {
            type: 'integer',
            title: 'GPU layers',
            description: '-1 decides automatically, 0 runs on the CPU only, and 999 puts every layer on the GPU.',
            default: DEFAULT_NUM_GPU,
            minimum: -1,
            maximum: MAX_NUM_GPU
          },
          gpuAutoTune: {
            type: 'boolean',
            title: 'Fit the model on the GPU automatically',
            description: 'On start, puts every layer on the GPU and shrinks the context window until the model fits.',
            default: true
          },
          numBatch: {
            type: 'integer',
            title: 'Batch size',
            description: 'The first thing to lower after an out-of-memory error. A Xavier NX needs 256.',
            default: DEFAULT_NUM_BATCH,
            minimum: MIN_NUM_BATCH,
            maximum: MAX_NUM_BATCH
          },
          numThread: {
            type: 'integer',
            title: 'CPU threads',
            description: 'For the work not done on the GPU. 0 lets the system choose.',
            default: DEFAULT_NUM_THREAD,
            minimum: 0,
            maximum: MAX_NUM_THREAD
          }
        }
      }
    }
  };
}

/**
 * How the admin page shows the form: the sections in order, examples in the
 * fields where blank means a default, a text area for the instructions, and
 * the API keys masked - an ordinary text input would show a token in
 * cleartext on every page load.
 */
function settingsUiSchema() {
  return {
    'ui:order': ['enabled', ...Object.keys(SECTIONS), '*'],
    aiModel: {
      'ui:order': [...SECTIONS.aiModel, '*'],
      baseUrl: { 'ui:placeholder': DEFAULT_AI_BASE_URL },
      model: { 'ui:placeholder': DEFAULT_AI_MODEL },
      apiKey: { 'ui:widget': 'password', 'ui:placeholder': 'Blank: no key' },
      keepAlive: { 'ui:placeholder': DEFAULT_KEEP_ALIVE }
    },
    answers: {
      'ui:order': [...SECTIONS.answers, '*'],
      systemPrompt: { 'ui:widget': 'textarea', 'ui:options': { rows: 8 } }
    },
    history: {
      'ui:order': [...SECTIONS.history, '*'],
      historyDuration: { 'ui:placeholder': DEFAULT_HISTORY_DURATION },
      historyResolution: { 'ui:placeholder': 'Blank: chosen to fit' },
      historyServerUrl: { 'ui:placeholder': 'Blank: this Signal K server' },
      historyApiKey: { 'ui:widget': 'password', 'ui:placeholder': 'Only for another server' },
      historyProvider: { 'ui:placeholder': "Blank: the server's default" }
    },
    advanced: {
      'ui:order': [...SECTIONS.advanced, '*']
    }
  };
}

module.exports = {
  DOCS_URL,
  SECTIONS,
  SETTING_LABELS,
  STORED_VALUE_NOT_SHOWN,
  TOP_LEVEL_KEYS,
  migrateSettings,
  readSettings,
  settingsSchema,
  settingsUiSchema
};
