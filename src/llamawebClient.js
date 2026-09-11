const LLAMAWEB_URL = (process.env.LLAMAWEB_URL || 'http://host.docker.internal:8090').replace(/\/$/, '');

async function llamawebFetch(path, options = {}) {
  const url = `${LLAMAWEB_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: options.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(text || `LlamaWeb respondeu ${res.status}`), {
      status: res.status,
    });
  }

  return res;
}

async function checkConnection() {
  try {
    await llamawebFetch('/health', { method: 'GET' });
    return { ok: true, url: LLAMAWEB_URL };
  } catch (err) {
    return { ok: false, error: err.message, url: LLAMAWEB_URL };
  }
}

async function listModels(reload = false) {
  const res = await llamawebFetch(`/models${reload ? '?reload=1' : ''}`, { method: 'GET' });
  const data = await res.json();
  return data.data || [];
}

function modelIdFromGgufPath(relPath) {
  const base = require('path').basename(relPath);
  return base.replace(/\.gguf$/i, '');
}

async function loadModel(modelId, extraArgs = []) {
  const body = { model: modelId };
  if (Array.isArray(extraArgs) && extraArgs.length) {
    body.extra_args = extraArgs;
  }
  await llamawebFetch('/models/load', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { ok: true, model: modelId, extraArgs: body.extra_args || [] };
}

async function getServerProps() {
  const res = await llamawebFetch('/props', { method: 'GET' });
  return res.json();
}

async function unloadModel(modelId) {
  await llamawebFetch('/models/unload', {
    method: 'POST',
    body: JSON.stringify({ model: modelId }),
  });
  return { ok: true, model: modelId };
}

async function waitForModelStatus(modelId, expected, timeoutMs = 600000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const models = await listModels(false);
    const entry = models.find((m) => m.id === modelId);
    const status = entry?.status?.value;
    if (status === expected) return entry;
    if (expected === 'loaded' && status === 'sleeping') return entry;
    if (entry?.status?.failed) {
      throw new Error(`Falha ao carregar ${modelId} (exit ${entry.status.exit_code ?? '?'})`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Timeout aguardando ${modelId} ficar ${expected}`);
}

module.exports = {
  LLAMAWEB_URL,
  checkConnection,
  listModels,
  modelIdFromGgufPath,
  loadModel,
  unloadModel,
  waitForModelStatus,
  getServerProps,
};
