/**
 * Normaliza referências Ollama/Hugging Face para pull (ex: hf.co/user/repo:Q8_0).
 */

function stripOllamaCommand(text) {
  return String(text || '')
    .trim()
    .replace(/^ollama\s+(run|pull)\s+/i, '')
    .trim();
}

function sanitizeLibraryModelName(name) {
  const trimmed = String(name || '').trim().toLowerCase();
  if (!trimmed) throw new Error('Nome do modelo é obrigatório.');
  if (!/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9._-]+)?$/i.test(trimmed)) {
    throw new Error('Nome inválido. Use letras, números, hífen, ponto ou tag (ex: meu-modelo:latest).');
  }
  return trimmed;
}

function parseHfCoRef(text) {
  const raw = String(text || '').trim();
  const normalized = raw.replace(/^hf\.co\//i, '');
  const match = normalized.match(/^([^/\s]+\/[^:\s]+)(?::([^\s]+))?$/);
  if (!match) {
    throw new Error(
      'Referência Hugging Face inválida. Ex: hf.co/unsloth/gemma-4-E4B-it-GGUF:Q8_0'
    );
  }

  const repo = match[1];
  const tag = match[2] || null;
  if (!tag) {
    throw new Error('Informe a quantização na tag (ex: :Q8_0 ou :Q4_K_M).');
  }

  const ollamaName = `hf.co/${repo}:${tag}`;
  return {
    kind: 'hf',
    ollamaName,
    hfRepo: repo,
    hfTag: tag,
    ggufInclude: `*${tag}*.gguf`,
    runCommand: `ollama run ${ollamaName}`,
  };
}

function parseHuggingFaceUrl(text) {
  const url = String(text || '').trim();

  const resolveMatch = url.match(
    /^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+\.gguf)$/i
  );
  if (resolveMatch) {
    const repo = resolveMatch[1];
    const file = decodeURIComponent(resolveMatch[2]);
    const tagGuess = file.match(/(Q\d[_A-Z0-9-]+|IQ\d[_A-Z0-9-]+|F16|F32|BF16)/i)?.[0] || null;
    if (!tagGuess) {
      throw new Error('Não foi possível inferir a tag Ollama a partir do arquivo. Use hf.co/user/repo:TAG.');
    }
    return parseHfCoRef(`hf.co/${repo}:${tagGuess}`);
  }

  const repoMatch = url.match(/^https?:\/\/huggingface\.co\/([^/]+\/[^/?#]+)\/?(?:\?.*)?$/i);
  if (repoMatch) {
    throw new Error(
      'URL do repositório sem tag. Use hf.co/user/repo:QUANT (ex: hf.co/unsloth/gemma-4-E4B-it-GGUF:Q8_0).'
    );
  }

  throw new Error('URL Hugging Face não reconhecida.');
}

function parsePullInput(raw) {
  let text = stripOllamaCommand(raw);
  if (!text) throw new Error('Informe o nome ou link do modelo.');

  if (/^hf\.co\//i.test(text)) {
    return parseHfCoRef(text);
  }

  if (/^https?:\/\//i.test(text) || /huggingface\.co/i.test(text)) {
    return parseHuggingFaceUrl(text);
  }

  if (text.includes('/')) {
    return parseHfCoRef(text.startsWith('hf.co/') ? text : `hf.co/${text}`);
  }

  return {
    kind: 'library',
    ollamaName: sanitizeLibraryModelName(text),
    runCommand: `ollama run ${sanitizeLibraryModelName(text)}`,
  };
}

function resolveOllamaModelName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Modelo é obrigatório.');
  if (/^hf\.co\//i.test(stripOllamaCommand(trimmed)) || trimmed.includes('/')) {
    try {
      return parsePullInput(trimmed).ollamaName;
    } catch {
      /* fall through for names already registered in Ollama */
    }
  }
  if (/^hf\.co\//i.test(trimmed)) return trimmed;
  return sanitizeLibraryModelName(trimmed);
}

module.exports = {
  stripOllamaCommand,
  sanitizeLibraryModelName,
  parsePullInput,
  resolveOllamaModelName,
};
