/**
 * Parâmetros de carga llama.cpp (POST /models/load → extra_args).
 * Requer --models-allow-extra-args no llama-server router.
 */

const ollamaLoad = require('./ollamaLoadOptions');

const ARG_TO_OPTION = [
  [['-c', '--ctx-size', '-ctx'], 'num_ctx', Number],
  [['-ngl', '--n-gpu-layers', '--gpu-layers'], 'num_gpu', Number],
  [['-t', '--threads'], 'num_thread', Number],
  [['-b', '--batch-size'], 'num_batch', Number],
  [['--main-gpu'], 'main_gpu', Number],
  [['--temp'], 'temperature', Number],
  [['--top-k'], 'top_k', Number],
  [['--top-p'], 'top_p', Number],
  [['--repeat-penalty'], 'repeat_penalty', Number],
  [['-n', '--predict'], 'num_predict', Number],
  [['--mirostat'], 'mirostat', Number],
  [['--mirostat-eta'], 'mirostat_eta', Number],
  [['--mirostat-tau'], 'mirostat_tau', Number],
];

function parseArgsArray(args) {
  const out = {};
  if (!Array.isArray(args)) return out;

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token === '--no-mmap') {
      out.use_mmap = false;
      continue;
    }
    if (token === '--mmap') {
      out.use_mmap = true;
      continue;
    }
    if (token === '--numa' || token.startsWith('--numa=')) {
      out.numa = true;
      if (token.includes('=')) i += 0;
      else if (args[i + 1] && !String(args[i + 1]).startsWith('-')) i += 1;
      continue;
    }

    for (const [flags, key, coerce] of ARG_TO_OPTION) {
      if (!flags.includes(token)) continue;
      const next = args[i + 1];
      if (next == null || String(next).startsWith('-')) break;
      const val = coerce(next);
      if (Number.isFinite(val) || typeof val === 'number') out[key] = val;
      i += 1;
      break;
    }
  }

  return out;
}

function buildExtraArgs(options = {}) {
  const args = [];
  const opt = options || {};

  if (opt.num_ctx != null && opt.num_ctx !== '') args.push('-c', String(opt.num_ctx));
  if (opt.num_gpu != null && opt.num_gpu !== '') args.push('-ngl', String(opt.num_gpu));
  if (opt.num_thread != null && opt.num_thread !== '') args.push('-t', String(opt.num_thread));
  if (opt.num_batch != null && opt.num_batch !== '') args.push('-b', String(opt.num_batch));
  if (opt.main_gpu != null && opt.main_gpu !== '') args.push('--main-gpu', String(opt.main_gpu));

  if (opt.use_mmap === false) args.push('--no-mmap');
  if (opt.numa === true) args.push('--numa', 'distribute');

  if (opt.temperature != null && opt.temperature !== '') args.push('--temp', String(opt.temperature));
  if (opt.top_k != null && opt.top_k !== '') args.push('--top-k', String(opt.top_k));
  if (opt.top_p != null && opt.top_p !== '') args.push('--top-p', String(opt.top_p));
  if (opt.repeat_penalty != null && opt.repeat_penalty !== '') {
    args.push('--repeat-penalty', String(opt.repeat_penalty));
  }
  if (opt.num_predict != null && opt.num_predict !== '' && Number(opt.num_predict) >= 0) {
    args.push('-n', String(opt.num_predict));
  }
  if (opt.mirostat != null && opt.mirostat !== '' && Number(opt.mirostat) > 0) {
    args.push('--mirostat', String(opt.mirostat));
  }
  if (opt.mirostat_eta != null && opt.mirostat_eta !== '') {
    args.push('--mirostat-eta', String(opt.mirostat_eta));
  }
  if (opt.mirostat_tau != null && opt.mirostat_tau !== '') {
    args.push('--mirostat-tau', String(opt.mirostat_tau));
  }

  return args;
}

function parseLoadRequest(body = {}) {
  const path = (body.path || '').trim();
  const modelId = (body.modelId || body.model || '').trim();
  if (!path && !modelId) throw new Error('Caminho ou modelId é obrigatório.');

  const parsed = ollamaLoad.parseLoadRequest({
    model: modelId || 'gguf',
    options: body.options || {},
    system: body.system,
  });

  return {
    path,
    modelId,
    options: parsed.options || {},
  };
}

function getLoadOptionsSchema() {
  const base = ollamaLoad.getLoadOptionsSchema();
  return {
    ...base,
    backend: 'llamacpp',
    showKeepAlive: false,
    hint:
      'Enviados como extra_args ao llama.cpp na carga. O container llamacpp precisa de --models-allow-extra-args.',
  };
}

function summarizeLoadConfig(config) {
  const extra = buildExtraArgs(config.options || {});
  const base = ollamaLoad.summarizeLoadConfig({
    model: config.modelId,
    keepAlive: null,
    options: config.options,
  });
  if (extra.length) return `${base} · extra_args=[${extra.join(' ')}]`;
  return base || 'padrão do router';
}

function guessDefaultsFromSize(bytes) {
  const options = { num_ctx: 8192, num_gpu: -1 };
  if (bytes > 14 * 1024 ** 3) options.num_ctx = 4096;
  else if (bytes > 8 * 1024 ** 3) options.num_ctx = 8192;
  return options;
}

module.exports = {
  parseArgsArray,
  buildExtraArgs,
  parseLoadRequest,
  getLoadOptionsSchema,
  summarizeLoadConfig,
  guessDefaultsFromSize,
};
