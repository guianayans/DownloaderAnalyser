/** Parâmetros Ollama (Modelfile + API options) — docs.ollama.com/modelfile */

const KEEP_ALIVE_CHOICES = [
  { value: '5m', label: '5 minutos' },
  { value: '30m', label: '30 minutos' },
  { value: '1h', label: '1 hora' },
  { value: '24h', label: '24 horas' },
  { value: '-1', label: 'Indefinido (sempre na VRAM)' },
];

const OPTION_GROUPS = [
  { id: 'memory', label: 'Memória e GPU', hint: 'VRAM (GPU) + RAM (CPU) — use Camadas na GPU' },
  { id: 'sampling', label: 'Amostragem', hint: 'Temperatura, top-k/p, penalidades' },
  { id: 'performance', label: 'Performance', hint: 'Threads, mmap, NUMA' },
  { id: 'prompt', label: 'Prompt', hint: 'System message (sobrescreve Modelfile)' },
  { id: 'advanced', label: 'Avançado', hint: 'Mirostat, stop sequences, etc.' },
];

const OPTION_DEFS = [
  {
    key: 'num_ctx',
    group: 'memory',
    type: 'number',
    label: 'Janela de contexto (tokens)',
    default: 4096,
    min: 512,
    max: 262144,
    step: 1,
    snapStep: 512,
    hint: 'Quanto o modelo “lembra”. Maior = mais VRAM. Ajustado para múltiplos de 512.',
  },
  {
    key: 'num_gpu',
    group: 'memory',
    type: 'number',
    label: 'Camadas na GPU (VRAM)',
    default: -1,
    min: -1,
    max: 999,
    step: 1,
    hint: '-1 = máximo na VRAM · 0 = só RAM/CPU · N = N camadas na GPU, resto na RAM',
  },
  {
    key: 'num_batch',
    group: 'memory',
    type: 'number',
    label: 'Batch size',
    default: null,
    min: 1,
    max: 4096,
    step: 1,
    hint: 'Tokens processados por lote (prompt)',
  },
  {
    key: 'temperature',
    group: 'sampling',
    type: 'number',
    label: 'Temperatura',
    default: 0.8,
    min: 0,
    max: 2,
    step: 0.05,
    hint: 'Menor = mais determinístico; maior = mais criativo',
  },
  {
    key: 'top_k',
    group: 'sampling',
    type: 'number',
    label: 'Top K',
    default: 40,
    min: 0,
    max: 200,
    step: 1,
  },
  {
    key: 'top_p',
    group: 'sampling',
    type: 'number',
    label: 'Top P',
    default: 0.9,
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'min_p',
    group: 'sampling',
    type: 'number',
    label: 'Min P',
    default: 0,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'typical_p',
    group: 'sampling',
    type: 'number',
    label: 'Typical P',
    default: 1,
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'repeat_penalty',
    group: 'sampling',
    type: 'number',
    label: 'Penalidade de repetição',
    default: 1.1,
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    key: 'repeat_last_n',
    group: 'sampling',
    type: 'number',
    label: 'Repetir últimos N tokens',
    default: 64,
    min: -1,
    max: 4096,
    step: 1,
  },
  {
    key: 'presence_penalty',
    group: 'sampling',
    type: 'number',
    label: 'Presence penalty',
    default: 0,
    min: -2,
    max: 2,
    step: 0.1,
  },
  {
    key: 'frequency_penalty',
    group: 'sampling',
    type: 'number',
    label: 'Frequency penalty',
    default: 0,
    min: -2,
    max: 2,
    step: 0.1,
  },
  {
    key: 'num_predict',
    group: 'sampling',
    type: 'number',
    label: 'Máx. tokens de resposta',
    default: -1,
    min: -1,
    max: 131072,
    step: 1,
    hint: '-1 = sem limite prático',
  },
  {
    key: 'seed',
    group: 'sampling',
    type: 'number',
    label: 'Seed',
    default: null,
    min: 0,
    max: 2147483647,
    step: 1,
    hint: 'Fixa aleatoriedade para reproduzir saídas',
  },
  {
    key: 'num_thread',
    group: 'performance',
    type: 'number',
    label: 'Threads CPU',
    default: null,
    min: 1,
    max: 128,
    step: 1,
  },
  {
    key: 'main_gpu',
    group: 'performance',
    type: 'number',
    label: 'GPU principal',
    default: 0,
    min: 0,
    max: 16,
    step: 1,
  },
  {
    key: 'use_mmap',
    group: 'performance',
    type: 'boolean',
    label: 'Memory-map (mmap)',
    default: true,
  },
  {
    key: 'numa',
    group: 'performance',
    type: 'boolean',
    label: 'NUMA',
    default: false,
  },
  {
    key: 'system',
    group: 'prompt',
    type: 'textarea',
    label: 'System prompt',
    default: '',
    hint: 'Instruções do assistente; vazio = usa o Modelfile',
  },
  {
    key: 'stop',
    group: 'advanced',
    type: 'stop_list',
    label: 'Sequências de parada',
    default: [],
    hint: 'Uma por linha — para a geração ao encontrar o texto',
  },
  {
    key: 'mirostat',
    group: 'advanced',
    type: 'number',
    label: 'Mirostat',
    default: 0,
    min: 0,
    max: 2,
    step: 1,
    hint: '0 = desligado; 1 ou 2 = modos Mirostat',
  },
  {
    key: 'mirostat_tau',
    group: 'advanced',
    type: 'number',
    label: 'Mirostat tau',
    default: 5,
    min: 0,
    max: 10,
    step: 0.1,
  },
  {
    key: 'mirostat_eta',
    group: 'advanced',
    type: 'number',
    label: 'Mirostat eta',
    default: 0.1,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'penalize_newline',
    group: 'advanced',
    type: 'boolean',
    label: 'Penalizar quebras de linha',
    default: true,
  },
  {
    key: 'num_keep',
    group: 'advanced',
    type: 'number',
    label: 'Num keep',
    default: null,
    min: 0,
    max: 4096,
    step: 1,
  },
];

const LOAD_PRESETS = {
  model: {
    label: 'Padrão do modelo',
    description: 'Usa parâmetros do Modelfile / Ollama',
    keepAlive: '24h',
    options: {},
  },
  code: {
    label: 'Código',
    description: 'Determinístico, contexto amplo',
    keepAlive: '24h',
    options: { temperature: 0.3, top_p: 0.9, num_ctx: 8192, repeat_penalty: 1.05 },
  },
  creative: {
    label: 'Criativo',
    description: 'Respostas mais variadas',
    keepAlive: '24h',
    options: { temperature: 1.0, top_p: 0.95, repeat_penalty: 1.15 },
  },
  'low-vram': {
    label: 'Economizar VRAM',
    description: 'Contexto menor, menos camadas na GPU',
    keepAlive: '1h',
    options: { num_ctx: 4096, num_gpu: 35 },
  },
  hybrid: {
    label: 'VRAM + RAM',
    description: 'Parte na GPU, resto na RAM — ajuste Camadas na GPU',
    keepAlive: '24h',
    options: { num_gpu: 28, num_ctx: 8192 },
  },
  'cpu-only': {
    label: 'Só RAM (CPU)',
    description: 'Sem camadas na GPU — lento, mas não usa VRAM',
    keepAlive: '1h',
    options: { num_gpu: 0, num_ctx: 4096 },
  },
  chat: {
    label: 'Chat',
    description: 'Equilíbrio para conversa',
    keepAlive: '24h',
    options: { temperature: 0.7, num_ctx: 8192, top_p: 0.9 },
  },
};

const OPTION_KEYS = new Set(OPTION_DEFS.map((d) => d.key).filter((k) => k !== 'system'));
const DEF_BY_KEY = Object.fromEntries(OPTION_DEFS.map((d) => [d.key, d]));

function coerceOptionValue(key, raw) {
  const def = DEF_BY_KEY[key];
  if (!def) return raw;
  if (def.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }
  if (def.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (def.type === 'stop_list') {
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    if (typeof raw === 'string') {
      return raw
        .split(/\n|,/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }
  return raw;
}

function parseModelfileParameters(parametersText) {
  const out = {};
  if (!parametersText || typeof parametersText !== 'string') return out;

  for (const line of parametersText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const stopMatch = trimmed.match(/^stop\s+(.+)$/i);
    if (stopMatch) {
      let val = stopMatch[1].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!out.stop) out.stop = [];
      out.stop.push(val);
      continue;
    }

    const m = trimmed.match(/^([a-z_]+)\s+(.+)$/i);
    if (!m || !OPTION_KEYS.has(m[1])) continue;
    out[m[1]] = coerceOptionValue(m[1], m[2].trim());
  }

  return out;
}

function clampNumber(value, def) {
  if (value == null || !Number.isFinite(value)) return null;
  let n = value;
  if (def.snapStep != null && def.snapStep > 0) {
    n = Math.round(n / def.snapStep) * def.snapStep;
  }
  if (def.min != null) n = Math.max(def.min, n);
  if (def.max != null) n = Math.min(def.max, n);
  return n;
}

function normalizeKeepAlive(value) {
  if (value == null || value === '') return '24h';
  if (value === -1 || value === '-1') return -1;
  return String(value);
}

function buildOptionsFromForm(formOptions = {}) {
  const options = {};

  for (const def of OPTION_DEFS) {
    if (def.key === 'system') continue;
    const raw = formOptions[def.key];
    if (raw === undefined || raw === null || raw === '') continue;

    if (def.type === 'boolean') {
      options[def.key] = Boolean(raw);
      continue;
    }

    if (def.type === 'stop_list') {
      const stops = coerceOptionValue('stop', raw);
      if (stops.length) options.stop = stops;
      continue;
    }

    if (def.type === 'number') {
      const n = clampNumber(Number(raw), def);
      if (n != null) options[def.key] = n;
      continue;
    }
  }

  return options;
}

function parseLoadRequest(body = {}) {
  const model = (body.model || '').trim();
  if (!model) throw new Error('Modelo é obrigatório.');

  const keepAlive = normalizeKeepAlive(body.keepAlive ?? body.keep_alive ?? '24h');
  const options = buildOptionsFromForm(body.options || {});
  const system = typeof body.system === 'string' ? body.system.trim() : '';
  const aliasRaw = (body.alias || '').trim();

  const config = { model, keepAlive, options: { ...options } };
  if (system) config.system = system;
  if (aliasRaw) config.alias = sanitizeOllamaAlias(aliasRaw);

  return config;
}

function mergeDefaults(modelfileOptions = {}, modelInfo = {}) {
  const merged = { ...modelfileOptions };
  const details = modelInfo.details || {};
  const ctxFromCard = details.context_length || details.contextLength;
  if (ctxFromCard && merged.num_ctx == null) {
    merged.num_ctx = Math.min(Number(ctxFromCard) || 4096, 131072);
  }
  return merged;
}

function getLoadOptionsSchema() {
  return {
    keepAliveChoices: KEEP_ALIVE_CHOICES,
    groups: OPTION_GROUPS,
    options: OPTION_DEFS.filter((d) => d.key !== 'system'),
    systemField: OPTION_DEFS.find((d) => d.key === 'system'),
    presets: Object.entries(LOAD_PRESETS).map(([id, p]) => ({ id, ...p })),
  };
}

async function getModelLoadDefaults(ollama, modelName) {
  const info = await ollama.showModel(modelName);
  const fromFile = parseModelfileParameters(info.parameters || '');
  const mergedOptions = mergeDefaults(fromFile, info);
  const system = typeof info.system === 'string' ? info.system : '';

  const contextLength =
    info.details?.context_length ||
    info.details?.contextLength ||
    mergedOptions.num_ctx ||
    4096;

  return {
    model: modelName,
    keepAlive: '24h',
    options: mergedOptions,
    system,
    contextLength,
    modelfileSnippet: info.parameters || null,
    template: info.template || null,
  };
}

function summarizeLoadConfig(config) {
  const parts = [];
  if (config.alias) parts.push(`alias=${config.alias}`);
  if (config.keepAlive != null) {
    parts.push(`keep_alive=${config.keepAlive === -1 ? '∞' : config.keepAlive}`);
  }
  const opt = config.options || {};
  const keys = Object.keys(opt);
  if (keys.length) {
    const preview = keys.slice(0, 6).map((k) => {
      const v = opt[k];
      if (Array.isArray(v)) return `${k}=[${v.length}]`;
      return `${k}=${v}`;
    });
    parts.push(preview.join(', ') + (keys.length > 6 ? '…' : ''));
  }
  if (config.system) parts.push('system=custom');
  return parts.join(' · ') || 'padrão';
}

function contextVariantName(baseModel, numCtx) {
  const slug = String(baseModel)
    .trim()
    .toLowerCase()
    .replace(/^hf\.co\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `${slug || 'model'}-ctx${numCtx}`;
}

function sanitizeOllamaAlias(name) {
  const trimmed = String(name || '').trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9._-]+)?$/i.test(trimmed)) {
    throw new Error(
      'Alias inválido. Use letras, números, hífen ou ponto (ex: qwen-coder ou coder:latest).'
    );
  }
  return trimmed;
}

async function resolveLoadModelName(ollamaClient, baseModel, config) {
  const alias = config.alias ? sanitizeOllamaAlias(config.alias) : null;

  let defaultCtx = 4096;
  try {
    const info = await ollamaClient.showModel(baseModel);
    const fromFile = parseModelfileParameters(info.parameters || '');
    defaultCtx =
      info.details?.context_length ||
      info.details?.contextLength ||
      fromFile.num_ctx ||
      4096;
  } catch {
    /* keep default */
  }

  const requestedCtx = config.options?.num_ctx;
  const numCtx =
    requestedCtx != null && requestedCtx !== '' && Number.isFinite(Number(requestedCtx))
      ? Number(requestedCtx)
      : defaultCtx;

  let variantName = null;
  if (alias && alias !== baseModel.toLowerCase()) {
    variantName = alias;
  } else if (!alias && numCtx !== Number(defaultCtx)) {
    variantName = contextVariantName(baseModel, numCtx);
  }

  if (!variantName || variantName === baseModel) {
    return { loadName: baseModel, variantName: null, baseModel, alias, numCtx, defaultCtx };
  }

  const parameters = {};
  if (numCtx !== Number(defaultCtx)) {
    parameters.num_ctx = numCtx;
  }

  const models = await ollamaClient.listModels();
  const exists = models.some((m) => (m.name || m.model) === variantName);

  if (!exists) {
    await ollamaClient.createModelVariant(baseModel, variantName, parameters);
  }

  return {
    loadName: variantName,
    variantName,
    baseModel,
    alias,
    numCtx,
    defaultCtx,
    created: !exists,
  };
}

module.exports = {
  KEEP_ALIVE_CHOICES,
  OPTION_GROUPS,
  OPTION_DEFS,
  LOAD_PRESETS,
  getLoadOptionsSchema,
  getModelLoadDefaults,
  parseLoadRequest,
  parseModelfileParameters,
  summarizeLoadConfig,
  contextVariantName,
  sanitizeOllamaAlias,
  resolveLoadModelName,
};
