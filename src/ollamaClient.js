const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');

async function ollamaFetch(path, options = {}) {
  const url = `${OLLAMA_HOST}${path}`;
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
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.error || parsed.message || text;
    } catch {
      /* ignore */
    }
    throw Object.assign(new Error(message || `Ollama respondeu ${res.status}`), {
      status: res.status,
    });
  }

  return res;
}

async function checkConnection() {
  try {
    const res = await ollamaFetch('/api/version', { method: 'GET' });
    const data = await res.json();
    return { ok: true, version: data.version || null, host: OLLAMA_HOST };
  } catch (err) {
    return { ok: false, error: err.message, host: OLLAMA_HOST };
  }
}

async function listModels() {
  const res = await ollamaFetch('/api/tags', { method: 'GET' });
  const data = await res.json();
  return (data.models || []).map((m) => ({
    name: m.name || m.model,
    model: m.model || m.name,
    size: m.size || 0,
    modifiedAt: m.modified_at || null,
    digest: m.digest || null,
    details: m.details || null,
  }));
}

async function listRunning() {
  const res = await ollamaFetch('/api/ps', { method: 'GET' });
  const data = await res.json();
  return (data.models || []).map((m) => ({
    name: m.name || m.model,
    model: m.model || m.name,
    size: m.size_vram ?? m.size ?? 0,
    sizeVram: m.size_vram ?? null,
    digest: m.digest || null,
    expiresAt: m.expires_at || null,
    details: m.details || null,
  }));
}

async function showModel(name) {
  const res = await ollamaFetch('/api/show', {
    method: 'POST',
    body: JSON.stringify({ name, verbose: false }),
  });
  return res.json();
}

async function deleteModel(name) {
  await ollamaFetch('/api/delete', {
    method: 'DELETE',
    body: JSON.stringify({ name }),
  });
  return { ok: true };
}

function buildGenerateBody(name, config = {}) {
  const { keepAlive = '24h', options, system } = config;
  const body = {
    model: name,
    prompt: '',
    keep_alive: keepAlive === -1 || keepAlive === '-1' ? -1 : keepAlive,
  };
  if (options && Object.keys(options).length) body.options = options;
  if (system) body.system = system;
  return body;
}

async function runModel(name, config = {}) {
  const res = await ollamaFetch('/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      ...buildGenerateBody(name, config),
      stream: false,
    }),
  });
  return res.json();
}

async function runModelStream(name, config = {}, onProgress) {
  const res = await ollamaFetch('/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      ...buildGenerateBody(name, config),
      stream: true,
    }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        last = chunk;
        onProgress?.(chunk);
      } catch {
        /* ignore */
      }
    }
  }

  if (buffer.trim()) {
    try {
      last = JSON.parse(buffer);
      onProgress?.(last);
    } catch {
      /* ignore */
    }
  }

  if (last?.error) {
    throw new Error(last.error);
  }

  return last;
}

async function unloadModel(name) {
  const res = await ollamaFetch('/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: name,
      prompt: '',
      stream: false,
      keep_alive: 0,
    }),
  });
  return res.json();
}

async function pullModelStream(name, onProgress) {
  const res = await ollamaFetch('/api/pull', {
    method: 'POST',
    body: JSON.stringify({ name, stream: true }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        last = chunk;
        onProgress?.(chunk);
      } catch {
        /* ignore malformed line */
      }
    }
  }

  if (buffer.trim()) {
    try {
      last = JSON.parse(buffer);
      onProgress?.(last);
    } catch {
      /* ignore */
    }
  }

  if (last?.error) {
    throw new Error(last.error);
  }

  return last;
}

async function readCreateStream(res, onProgress) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        last = chunk;
        onProgress?.(chunk);
      } catch {
        /* ignore */
      }
    }
  }

  if (buffer.trim()) {
    try {
      last = JSON.parse(buffer);
      onProgress?.(last);
    } catch {
      /* ignore */
    }
  }

  if (last?.error) {
    throw new Error(last.error);
  }

  return last;
}

async function createModelStream(body, onProgress) {
  const res = await ollamaFetch('/api/create', {
    method: 'POST',
    body: JSON.stringify({ ...body, stream: body.stream ?? true }),
  });
  return readCreateStream(res, onProgress);
}

/** Ollama >= 0.5.5 — campo `from` com caminho absoluto ou nome de modelo. */
async function createFromGgufPath(modelName, fromPath, onProgress) {
  return createModelStream({ model: modelName, from: fromPath }, onProgress);
}

/** Ollama antigo — Modelfile em texto (fallback). */
async function createFromModelfile(modelName, modelfileContent, onProgress) {
  return createModelStream({ model: modelName, modelfile: modelfileContent }, onProgress);
}

function hashFileSha256(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
    stream.on('error', reject);
  });
}

async function blobExists(digest) {
  const url = `${OLLAMA_HOST}/api/blobs/${encodeURIComponent(digest)}`;
  const res = await fetch(url, { method: 'HEAD' });
  return res.ok;
}

async function pushBlob(absPath, digest, onProgress) {
  if (await blobExists(digest)) {
    onProgress?.({ status: 'Blob GGUF já existe no Ollama' });
    return;
  }

  const total = fs.statSync(absPath).size;
  let completed = 0;
  const stream = fs.createReadStream(absPath);
  stream.on('data', (chunk) => {
    completed += chunk.length;
    onProgress?.({
      status: `Enviando GGUF… ${Math.round((completed / total) * 100)}%`,
      completed,
      total,
    });
  });

  const url = `${OLLAMA_HOST}/api/blobs/${encodeURIComponent(digest)}`;
  const res = await fetch(url, {
    method: 'POST',
    body: stream,
    duplex: 'half',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.error || parsed.message || text;
    } catch {
      /* ignore */
    }
    throw new Error(message || `Falha ao enviar blob (${res.status})`);
  }
}

/** Import remoto via upload de blob + `files` (Ollama >= 0.5.5). */
async function createFromGgufBlob(modelName, absPath, onProgress) {
  onProgress?.({ status: 'Calculando SHA256…' });
  const digest = await hashFileSha256(absPath);
  await pushBlob(absPath, digest, onProgress);
  const fileName = path.basename(absPath);
  return createModelStream(
    {
      model: modelName,
      files: { [fileName]: digest },
    },
    onProgress
  );
}

function isLegacyCreateApiError(message) {
  const lower = (message || '').toLowerCase();
  return lower.includes("neither 'from' or 'files'") || lower.includes('neither "from" or "files"');
}

function isPathImportError(message) {
  const lower = (message || '').toLowerCase();
  return (
    isLegacyCreateApiError(message) ||
    lower.includes('invalid model name') ||
    lower.includes('invalid model reference') ||
    lower.includes('no such file') ||
    lower.includes('not found') ||
    lower.includes('permission denied') ||
    lower.includes('open ') ||
    lower.includes('stat ') ||
    lower.includes('read ') ||
    lower.includes('transferring model data') ||
    lower.includes('gathering model components')
  );
}

function isAuthImportError(message) {
  const lower = (message || '').toLowerCase();
  return (
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('401') ||
    lower.includes('403')
  );
}

async function importGgufModel(modelName, { fromPath, absPath }, onProgress) {
  let pathErr = null;

  try {
    return await createFromGgufPath(modelName, fromPath, onProgress);
  } catch (err) {
    pathErr = err;
    if (isAuthImportError(err.message) || !isPathImportError(err.message)) {
      throw err;
    }
  }

  try {
    onProgress?.({
      status: `Caminho indisponível (${pathErr?.message || 'erro'}) — enviando GGUF…`,
    });
    return await createFromGgufBlob(modelName, absPath, onProgress);
  } catch (blobErr) {
    try {
      onProgress?.({ status: 'Tentando API legada (modelfile)…' });
      return await createFromModelfile(modelName, `FROM ${fromPath}\n`, onProgress);
    } catch {
      throw blobErr;
    }
  }
}

async function createModelVariant(baseModel, variantName, parameters, onProgress) {
  const body = { model: variantName, from: baseModel };
  if (parameters && Object.keys(parameters).length) {
    body.parameters = parameters;
  }

  try {
    return await createModelStream(body, onProgress);
  } catch (err) {
    const lines = [`FROM ${baseModel}`];
    for (const [key, value] of Object.entries(parameters || {})) {
      if (value == null || value === '') continue;
      lines.push(`PARAMETER ${key} ${value}`);
    }
    return createFromModelfile(variantName, `${lines.join('\n')}\n`, onProgress);
  }
}

module.exports = {
  OLLAMA_HOST,
  checkConnection,
  listModels,
  listRunning,
  showModel,
  deleteModel,
  runModel,
  runModelStream,
  unloadModel,
  pullModelStream,
  createFromModelfile,
  createFromGgufPath,
  createFromGgufBlob,
  importGgufModel,
  createModelVariant,
};
