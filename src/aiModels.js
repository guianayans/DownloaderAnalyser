const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { resolveSafe, relativeFromRoot, displayPath, ROOT, assertDirectory } = require('./paths');
const ollama = require('./ollamaClient');
const llamaweb = require('./llamawebClient');
const loadOptions = require('./ollamaLoadOptions');
const llamacppLoad = require('./llamacppLoadOptions');
const hfModelRef = require('./hfModelRef');

const GGUF_DIRS = (process.env.AI_GGUF_DIRS || 'pendriver/llamacpp/models')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const OLLAMA_HOST_ROOT = process.env.OLLAMA_HOST_ROOT || '/';
const OLLAMA_CONTAINER_ROOT = (process.env.OLLAMA_CONTAINER_ROOT || '').trim().replace(/\/$/, '') || null;
const OLLAMA_GGUF_STAGING_DIR = (process.env.OLLAMA_GGUF_STAGING_DIR || 'gguf-import')
  .trim()
  .replace(/^\/+|\/+$/g, '') || 'gguf-import';
const OLLAMA_MODELS_DIR = (process.env.OLLAMA_MODELS_DIR || '').trim() || null;
const OLLAMA_MODELS_DIR_CANDIDATES = [
  OLLAMA_MODELS_DIR,
  'pendriver/ollama/models',
  'pendriver/ollama',
  'root/.ollama/models',
  'root/.ollama',
].filter(Boolean);
const OPEN_WEBUI_URL = (
  process.env.OPEN_WEBUI_URL || 'https://openwebui.gvtserver.online'
).replace(/\/$/, '');
const LLAMAWEB_PUBLIC_URL = (process.env.LLAMAWEB_PUBLIC_URL || process.env.LLAMAWEB_URL || 'http://llamacpp.gvtserver.online').replace(/\/$/, '');
const OLLAMA_PUBLIC_URL = (
  process.env.OLLAMA_PUBLIC_URL || 'http://yanserver.ddns.net:11434'
).replace(/\/$/, '');

const pullJobs = new Map();
const loadJobs = new Map();
const unloadJobs = new Map();
const llamawebLoadJobs = new Map();
const LOG_MAX_CHARS = 100000;
const PROGRESS_POLL_MS = 400;

function formatDurationNs(ns) {
  if (!ns || ns <= 0) return null;
  const sec = ns / 1e9;
  return sec >= 10 ? `${sec.toFixed(0)}s` : `${sec.toFixed(1)}s`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function toHostPath(absPath) {
  const rootResolved = path.resolve(ROOT);
  const normalized = path.resolve(absPath);
  if (normalized.startsWith(rootResolved + path.sep) || normalized === rootResolved) {
    const rel = path.relative(rootResolved, normalized);
    const hostRoot = OLLAMA_HOST_ROOT.replace(/\/$/, '') || '';
    const joined = rel ? path.posix.join(hostRoot, rel.split(path.sep).join('/')) : hostRoot || '/';
    return joined.startsWith('/') ? joined : `/${joined}`;
  }
  return normalized;
}

function linkOrCopyGguf(sourceAbs, destAbs) {
  if (fs.existsSync(destAbs)) {
    const srcStat = fs.statSync(sourceAbs);
    const dstStat = fs.statSync(destAbs);
    if (srcStat.size === dstStat.size && srcStat.mtimeMs <= dstStat.mtimeMs + 1000) {
      return;
    }
    fs.unlinkSync(destAbs);
  }

  try {
    fs.linkSync(sourceAbs, destAbs);
    return;
  } catch {
    /* cross-device or permission — try symlink then copy */
  }

  try {
    fs.symlinkSync(sourceAbs, destAbs);
    return;
  } catch {
    /* last resort: full copy (large files) */
  }

  fs.copyFileSync(sourceAbs, destAbs);
}

function resolveOllamaContainerRoot() {
  if (OLLAMA_CONTAINER_ROOT) return OLLAMA_CONTAINER_ROOT;
  if (detectOllamaModelsDir()) return '/root/.ollama';
  return null;
}

/** Resolve the FROM path as seen inside the Ollama container/process. */
function prepareGgufForOllamaImport(abs) {
  const normalized = path.resolve(abs);
  const directHostPath = toHostPath(normalized);
  const containerRoot = resolveOllamaContainerRoot();

  if (!containerRoot) {
    return {
      fromPath: directHostPath,
      hostPath: directHostPath,
      importMethod: 'direct',
      stagingRel: null,
      containerRoot: null,
    };
  }

  const ollamaDirRel = detectOllamaModelsDir();
  if (!ollamaDirRel) {
    throw new Error(
      'Pasta local do Ollama não encontrada. Configure OLLAMA_MODELS_DIR (ex.: pendriver/ollama) ' +
        `e monte no container Ollama como ${containerRoot}.`
    );
  }

  const ollamaDirAbs = resolveSafe(ollamaDirRel);
  if (normalized.startsWith(ollamaDirAbs + path.sep) || normalized === ollamaDirAbs) {
    const relInOllama = path.relative(ollamaDirAbs, normalized);
    const fromPath = path.posix.join(
      containerRoot,
      relInOllama.split(path.sep).join('/')
    );
    return {
      fromPath,
      hostPath: toHostPath(normalized),
      importMethod: 'ollama-dir',
      stagingRel: null,
      containerRoot,
    };
  }

  const stagingRel = path.posix.join(ollamaDirRel.replace(/\\/g, '/'), OLLAMA_GGUF_STAGING_DIR);
  const stagingAbs = resolveSafe(stagingRel);
  fs.mkdirSync(stagingAbs, { recursive: true });
  const destAbs = path.join(stagingAbs, path.basename(normalized));
  linkOrCopyGguf(normalized, destAbs);

  const fromPath = path.posix.join(
    containerRoot,
    OLLAMA_GGUF_STAGING_DIR,
    path.basename(normalized)
  );

  return {
    fromPath,
    hostPath: toHostPath(destAbs),
    importMethod: 'staged',
    stagingRel: path.posix.join(stagingRel, path.basename(normalized)),
    containerRoot,
  };
}

function formatImportError(apiMessage, job) {
  const parts = [apiMessage];
  const msg = (apiMessage || '').toLowerCase();

  if (msg.includes('invalid model name') && job.importMethod === 'staged') {
    parts.push(
      'O Ollama provavelmente não leu o GGUF pelo caminho (mensagem enganosa). ' +
        'Confira o mount /pendriver/ollama → /root/.ollama ou use o upload automático.'
    );
  }

  if (job.importMethod === 'blob') {
    parts.push('Importação por upload do arquivo também falhou.');
  } else if (job.importMethod === 'staged') {
    parts.push(`Caminho no Ollama: ${job.fromPath}`);
    if (job.stagingRel) parts.push(`Link local: ${displayPath(job.stagingRel)}`);
  } else {
    parts.push(`Caminho tentado: ${job.fromPath || job.hostPath}`);
  }

  if (job.importMethod === 'staged' && !msg.includes('invalid model name')) {
    const containerRoot = job.containerRoot || resolveOllamaContainerRoot();
    if (containerRoot && job.ollamaModelsDirRel) {
      parts.push(
        `Monte ${displayPath(job.ollamaModelsDirRel)} → ${containerRoot} no stack do Ollama.`
      );
    }
  }
  return parts.join(' ');
}

function sanitizeModelName(name) {
  return hfModelRef.resolveOllamaModelName(name);
}

function defaultGgufDownloadDir() {
  const preferred = GGUF_DIRS.find((d) => /llamacpp/i.test(d));
  return preferred || GGUF_DIRS[0] || 'pendriver/llamacpp/models';
}

function pullHfGgufToDir({ repo, include, targetDir, onLog, signal, onSpawn }) {
  return new Promise((resolve, reject) => {
    const dir = assertDirectory(targetDir);
    const args = ['download', repo, '--include', include, '--local-dir', dir];
    onLog?.(`$ hf ${args.join(' ')}\n`);

    const child = spawn('hf', args, {
      env: {
        ...process.env,
        HF_XET_HIGH_PERFORMANCE:
          process.env.HF_XET_HIGH_PERFORMANCE || process.env.HF_HUB_ENABLE_HF_TRANSFER || '1',
      },
      signal,
    });
    onSpawn?.(child);

    const append = (chunk) => onLog?.(chunk.toString());

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => {
      if (err.name === 'AbortError') reject(new Error('Download GGUF cancelado.'));
      else reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ dir, repo, include });
      else reject(new Error(`hf download encerrou com código ${code}.`));
    });
  });
}

function dirnameRel(relPath) {
  const parts = relPath.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.length ? parts.join('/') : '.';
}

function folderExistsRel(relPath) {
  if (!relPath) return false;
  try {
    const abs = resolveSafe(relPath);
    return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function fileExistsRel(relPath) {
  if (!relPath) return false;
  try {
    const abs = resolveSafe(relPath);
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function hostPathToRel(hostPath) {
  if (!hostPath) return null;
  const normalized = hostPath.replace(/\\/g, '/').trim();
  const hostRoot = (OLLAMA_HOST_ROOT || '/').replace(/\/$/, '') || '';

  let rel = null;
  if (hostRoot && (normalized === hostRoot || normalized.startsWith(`${hostRoot}/`))) {
    rel = normalized === hostRoot ? '.' : normalized.slice(hostRoot.length + 1);
  } else if (normalized.startsWith('/')) {
    rel = normalized.slice(1);
  } else {
    rel = normalized;
  }

  try {
    resolveSafe(rel);
    return rel;
  } catch {
    return null;
  }
}

function extractFromPath(modelfile) {
  if (!modelfile || typeof modelfile !== 'string') return null;
  const match = modelfile.match(/^FROM\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function folderFromModelfile(modelfile) {
  const from = extractFromPath(modelfile);
  if (!from) return null;
  const rel = hostPathToRel(from);
  if (!rel) return null;
  if (fileExistsRel(rel)) return dirnameRel(rel);
  if (folderExistsRel(rel)) return rel;
  return null;
}

function detectOllamaModelsDir() {
  for (const candidate of OLLAMA_MODELS_DIR_CANDIDATES) {
    if (folderExistsRel(candidate)) return candidate;
  }
  return null;
}

function findGgufFileForModel(modelName, ggufScans) {
  const lower = modelName.toLowerCase();
  const base = lower.split(':')[0];

  for (const group of ggufScans) {
    for (const f of group.files) {
      if (f.kind !== 'model') continue;
      const suggested = f.suggestedOllamaName?.toLowerCase();
      if (!suggested) continue;
      if (
        lower === suggested ||
        lower === `${suggested}:latest` ||
        base === suggested ||
        (suggested && lower.startsWith(`${suggested}:`))
      ) {
        return f;
      }
    }
  }
  return null;
}

function resolveOllamaModelFolder(modelName, ggufScans, importJobs, modelfile) {
  const fromModelfile = folderFromModelfile(modelfile);
  if (fromModelfile && folderExistsRel(fromModelfile)) return fromModelfile;

  const ggufFile = findGgufFileForModel(modelName, ggufScans);
  if (ggufFile?.folderPath && folderExistsRel(ggufFile.folderPath)) return ggufFile.folderPath;

  const imported = importJobs.find(
    (j) => j.model === modelName && j.status === 'completed' && j.sourcePath
  );
  if (imported) {
    const dir = dirnameRel(imported.sourcePath);
    if (folderExistsRel(dir)) return dir;
  }

  return detectOllamaModelsDir();
}

async function enrichModelStorage(model, ggufScans, importJobs) {
  let modelfile = null;
  try {
    const info = await ollama.showModel(model.name);
    modelfile = info.modelfile || null;
  } catch {
    /* ignore */
  }

  const ggufFile = findGgufFileForModel(model.name, ggufScans);
  const imported = importJobs.find(
    (j) => j.model === model.name && j.status === 'completed' && j.sourcePath
  );
  const fromModelfile = folderFromModelfile(modelfile);

  if (fromModelfile && folderExistsRel(fromModelfile)) {
    return {
      folderPath: fromModelfile,
      folderDisplayPath: displayPath(fromModelfile),
      folderExists: true,
      storageKind: 'gguf-modelfile',
      linkedGgufPath: null,
    };
  }

  if (imported?.sourcePath) {
    const dir = dirnameRel(imported.sourcePath);
    if (folderExistsRel(dir)) {
      return {
        folderPath: dir,
        folderDisplayPath: displayPath(dir),
        folderExists: true,
        storageKind: 'gguf-import',
        linkedGgufPath: imported.sourcePath,
      };
    }
  }

  if (ggufFile?.folderPath && folderExistsRel(ggufFile.folderPath)) {
    return {
      folderPath: ggufFile.folderPath,
      folderDisplayPath: displayPath(ggufFile.folderPath),
      folderExists: true,
      storageKind: 'gguf-linked',
      linkedGgufPath: ggufFile.path,
    };
  }

  const ollamaDir = detectOllamaModelsDir();
  if (ollamaDir && folderExistsRel(ollamaDir)) {
    return {
      folderPath: ollamaDir,
      folderDisplayPath: displayPath(ollamaDir),
      folderExists: true,
      storageKind: 'ollama-local',
      linkedGgufPath: null,
    };
  }

  return {
    folderPath: null,
    folderDisplayPath: null,
    folderExists: false,
    storageKind: 'ollama-volume',
    linkedGgufPath: null,
  };
}

function ggufNameToModelName(filename) {
  const base = filename.replace(/\.gguf$/i, '');
  const cleaned = base
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/\./g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return cleaned || 'gguf-model';
}

function importModelNameFromGguf(filename, userName) {
  const normalize = (raw) => {
    const trimmed = String(raw || '').trim().toLowerCase();
    if (!trimmed) throw new Error('Nome do modelo é obrigatório.');
    const dotted = trimmed.replace(/\./g, '-').replace(/-+/g, '-');
    const colonIdx = dotted.indexOf(':');
    const base =
      colonIdx >= 0
        ? dotted
            .slice(0, colonIdx)
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
        : dotted.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    const tag =
      colonIdx >= 0
        ? dotted
            .slice(colonIdx + 1)
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'latest'
        : 'latest';
    const name = `${(base || 'gguf-model').slice(0, 60)}:${tag}`;
    return hfModelRef.sanitizeLibraryModelName(name);
  };

  if (userName) {
    try {
      return normalize(userName);
    } catch {
      /* fall through to filename */
    }
  }
  return normalize(ggufNameToModelName(filename));
}

function scanGgufDir(relDir) {
  let absDir;
  try {
    absDir = resolveSafe(relDir);
  } catch {
    return { dir: relDir, displayPath: displayPath(relDir), exists: false, files: [] };
  }

  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    return { dir: relDir, displayPath: displayPath(relDir), exists: false, files: [] };
  }

  const files = fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.gguf'))
    .map((e) => {
      const full = path.join(absDir, e.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        return null;
      }
      const rel = relativeFromRoot(full);
      if (!fileExistsRel(rel)) return null;
      const folderPath = dirnameRel(rel);
      const isMmproj = e.name.toLowerCase().startsWith('mmproj');
      return {
        name: e.name,
        path: rel,
        folderPath,
        folderExists: folderExistsRel(folderPath),
        folderDisplayPath: displayPath(folderPath),
        displayPath: displayPath(rel),
        size: stat.size,
        sizeLabel: formatBytes(stat.size),
        modifiedAt: stat.mtime.toISOString(),
        kind: isMmproj ? 'mmproj' : 'model',
        suggestedOllamaName: isMmproj ? null : ggufNameToModelName(e.name),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    dir: relDir,
    displayPath: displayPath(relDir),
    exists: true,
    files,
  };
}

function listGgufFiles() {
  return GGUF_DIRS.map(scanGgufDir).filter((group) => group.exists && group.files.length > 0);
}

function deleteGgufFile(relPath) {
  const abs = resolveSafe(relPath);
  if (!fs.existsSync(abs)) throw new Error('Arquivo não encontrado.');
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error('O caminho não é um arquivo.');
  if (!abs.toLowerCase().endsWith('.gguf')) throw new Error('Só arquivos .gguf podem ser removidos por aqui.');
  fs.unlinkSync(abs);
  return { ok: true, path: relPath };
}

function sanitizePullJob(job) {
  const { abortController, hfChild, ...safe } = job;
  return safe;
}

function startPullJob(modelName, options = {}) {
  const parsed = hfModelRef.parsePullInput(modelName);
  const name = parsed.ollamaName;
  const saveGguf = options.saveGguf !== false;
  const existing = [...pullJobs.values()].find((j) => j.model === name && j.status === 'running');
  if (existing) return sanitizePullJob(existing);

  const id = uuidv4();
  const abortController = new AbortController();
  const job = {
    id,
    model: name,
    kind: parsed.kind,
    hfRepo: parsed.hfRepo || null,
    hfTag: parsed.hfTag || null,
    ggufDir: parsed.kind === 'hf' && saveGguf ? defaultGgufDownloadDir() : null,
    runCommand: parsed.runCommand || `ollama run ${name}`,
    status: 'running',
    progress: 0,
    progressLabel: parsed.kind === 'hf' ? 'Baixando via Ollama + GGUF…' : 'Iniciando…',
    log:
      parsed.kind === 'hf'
        ? `Referência: ${name}\nDepois de concluir: ${parsed.runCommand}\n`
        : '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    abortController,
    hfChild: null,
  };
  pullJobs.set(id, job);

  const onPullProgress = (chunk) => {
    const current = pullJobs.get(id);
    if (!current || current.status !== 'running') return;

    if (chunk.total && chunk.completed != null) {
      current.progress = Math.min(100, Math.round((chunk.completed / chunk.total) * 100));
      current.progressLabel = `${current.progress}% · Ollama`;
    } else if (chunk.status) {
      current.progressLabel = chunk.status;
    }

    if (chunk.status) {
      current.log = `${current.log}${chunk.status}\n`.slice(-8000);
    }
  };

  const tasks = [ollama.pullModelStream(name, onPullProgress)];

  if (parsed.kind === 'hf' && saveGguf) {
    tasks.push(
      pullHfGgufToDir({
        repo: parsed.hfRepo,
        include: parsed.ggufInclude,
        targetDir: job.ggufDir,
        signal: abortController.signal,
        onLog: (text) => {
          const current = pullJobs.get(id);
          if (!current || current.status !== 'running') return;
          current.log = `${current.log}${text}`.slice(-8000);
        },
        onSpawn: (child) => {
          const current = pullJobs.get(id);
          if (current) current.hfChild = child;
        },
      }).catch((err) => {
        if (abortController.signal.aborted) throw err;
        appendJobLog(job, `Aviso GGUF: ${err.message} (modelo Ollama segue normalmente).`);
        return null;
      })
    );
  }

  Promise.all(tasks)
    .then(() => {
      const current = pullJobs.get(id);
      if (!current) return;
      current.status = 'completed';
      current.progress = 100;
      current.progressLabel = 'Concluído';
      if (current.kind === 'hf') {
        current.log = `${current.log}\nPronto: ${current.runCommand}\n`.slice(-8000);
        if (current.ggufDir) {
          current.log = `${current.log}GGUF em ${displayPath(current.ggufDir)}\n`.slice(-8000);
        }
      }
      current.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      const current = pullJobs.get(id);
      if (!current) return;
      current.status = 'failed';
      current.error = err.message;
      current.progressLabel = 'Falhou';
      current.finishedAt = new Date().toISOString();
    });

  return sanitizePullJob(job);
}

function listPullJobs() {
  return [...pullJobs.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map(sanitizePullJob);
}

function getPullJob(id) {
  const job = pullJobs.get(id);
  return job ? sanitizePullJob(job) : null;
}

function cancelPullJob(id) {
  const job = pullJobs.get(id);
  if (!job) throw new Error('Download não encontrado.');
  if (job.status !== 'running') throw new Error('Este download já terminou.');
  job.abortController?.abort();
  if (job.hfChild) {
    try {
      job.hfChild.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  job.status = 'cancelled';
  job.progressLabel = 'Cancelado';
  job.finishedAt = new Date().toISOString();
  return sanitizePullJob(job);
}

function sanitizeLoadJob(job) {
  const { abortController, _pollTimer, _modelSize, ...safe } = job;
  return safe;
}

function sanitizeUnloadJob(job) {
  const { _pollTimer, _initialVram, ...safe } = job;
  return safe;
}

function appendJobLog(job, line) {
  if (!line) return;
  const ts = new Date().toLocaleTimeString('pt-BR');
  job.log = `${job.log}[${ts}] ${line}\n`.slice(-LOG_MAX_CHARS);
}

function clearJobPoll(job) {
  if (job?._pollTimer) {
    clearInterval(job._pollTimer);
    job._pollTimer = null;
  }
}

async function getModelSizeBytes(modelName) {
  try {
    const models = await ollama.listModels();
    const match = models.find((m) => m.name === modelName || m.model === modelName);
    return match?.size || 0;
  } catch {
    return 0;
  }
}

async function getRunningVram(modelName) {
  try {
    const running = await ollama.listRunning();
    const match = running.find((m) => m.name === modelName || m.model === modelName);
    return match?.sizeVram ?? match?.size ?? 0;
  } catch {
    return 0;
  }
}

function startLoadProgressPoll(jobId, modelName, modelSize) {
  const job = loadJobs.get(jobId);
  if (!job) return;

  job._pollTimer = setInterval(async () => {
    const current = loadJobs.get(jobId);
    if (!current || current.status !== 'running') {
      clearJobPoll(current);
      return;
    }

    try {
      const vram = await getRunningVram(modelName);
      if (vram > 0) {
        if (modelSize > 0) {
          current.progress = Math.min(99, Math.round((vram / modelSize) * 100));
        } else if (current.progress < 90) {
          current.progress = Math.min(90, current.progress + 5);
        }
        current.progressLabel = `${current.progress}% · VRAM ${formatBytes(vram)}`;
        if (current.progress !== current._lastLoggedPct) {
          appendJobLog(current, `VRAM alocada: ${formatBytes(vram)} (${current.progress}%)`);
          current._lastLoggedPct = current.progress;
        }
      } else if (current.progress < 15) {
        current.progress = Math.min(15, current.progress + 2);
        current.progressLabel = `${current.progress}% · preparando…`;
      }
    } catch (err) {
      appendJobLog(current, `Aviso ao consultar VRAM: ${err.message}`);
    }
  }, PROGRESS_POLL_MS);
}

function startUnloadProgressPoll(jobId, modelName, initialVram) {
  const job = unloadJobs.get(jobId);
  if (!job) return;

  job._pollTimer = setInterval(async () => {
    const current = unloadJobs.get(jobId);
    if (!current || current.status !== 'running') {
      clearJobPoll(current);
      return;
    }

    try {
      const vram = await getRunningVram(modelName);
      if (vram <= 0) {
        current.progress = 100;
        current.progressLabel = '100% · descarregado';
        appendJobLog(current, 'Modelo removido da VRAM');
        return;
      }

      const base = initialVram > 0 ? initialVram : vram;
      const freed = Math.max(0, base - vram);
      current.progress = Math.min(99, Math.round((freed / base) * 100));
      current.progressLabel = `${current.progress}% · liberando ${formatBytes(vram)}`;
      if (current.progress !== current._lastLoggedPct) {
        appendJobLog(current, `VRAM restante: ${formatBytes(vram)} (${current.progress}% liberado)`);
        current._lastLoggedPct = current.progress;
      }
    } catch (err) {
      appendJobLog(current, `Aviso: ${err.message}`);
    }
  }, PROGRESS_POLL_MS);
}

function startLoadJob(modelName, loadInput = {}) {
  const config =
    typeof loadInput === 'string'
      ? loadOptions.parseLoadRequest({ model: modelName, keepAlive: loadInput })
      : loadOptions.parseLoadRequest({ model: modelName, ...loadInput });

  const name = config.model;

  const existing = [...loadJobs.values()].find((j) => j.model === name && j.status === 'running');
  if (existing) return sanitizeLoadJob(existing);

  const id = uuidv4();
  const job = {
    id,
    model: name,
    loadConfig: {
      keepAlive: config.keepAlive ?? '24h',
      options: config.options || {},
      system: config.system || '',
      alias: config.alias || '',
    },
    status: 'running',
    progress: 0,
    progressLabel: '0% · iniciando…',
    log: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    abortController: null,
    _pollTimer: null,
    _modelSize: 0,
  };
  loadJobs.set(id, job);
  appendJobLog(job, `Iniciando carga de ${name}`);
  appendJobLog(job, loadOptions.summarizeLoadConfig(config));

  (async () => {
    let loadName = name;
    try {
      const resolved = await loadOptions.resolveLoadModelName(ollama, name, config);
      loadName = resolved.loadName;
      const current = loadJobs.get(id);
      if (!current) return;

      if (resolved.variantName) {
        current.model = resolved.variantName;
        current.baseModel = resolved.baseModel;
        if (resolved.alias) {
          appendJobLog(
            current,
            `Alias "${resolved.alias}" → ${resolved.variantName} (origem: ${resolved.baseModel})`
          );
        } else if (Number(resolved.numCtx) !== Number(resolved.defaultCtx)) {
          appendJobLog(
            current,
            `Contexto ${resolved.numCtx} tokens (padrão ${resolved.defaultCtx}) → variante ${resolved.variantName}`
          );
        }
        if (resolved.created) {
          appendJobLog(
            current,
            resolved.alias
              ? 'Variante registrada no Ollama — use este nome no Cursor'
              : 'Variante criada com PARAMETER num_ctx (necessário para Cursor/API OpenAI)'
          );
        }
        appendJobLog(current, `No Cursor, use o modelo: ${resolved.variantName}`);
      }

      getModelSizeBytes(loadName).then((size) => {
        const j = loadJobs.get(id);
        if (!j) return;
        j._modelSize = size;
        if (size > 0) appendJobLog(j, `Tamanho do modelo: ${formatBytes(size)}`);
        startLoadProgressPoll(id, loadName, size);
      });

      await ollama.runModelStream(loadName, config, (chunk) => {
        const running = loadJobs.get(id);
        if (!running || running.status !== 'running') return;

        if (chunk.response) {
          appendJobLog(running, `resposta: ${chunk.response}`);
        }

        if (typeof chunk.total === 'number' && typeof chunk.completed === 'number' && chunk.total > 0) {
          const pct = Math.min(99, Math.round((chunk.completed / chunk.total) * 100));
          running.progress = Math.max(running.progress, pct);
          running.progressLabel = `${running.progress}% · ${chunk.status || 'transferindo'}`;
          appendJobLog(running, chunk.status || `progresso ${pct}%`);
        } else if (chunk.status) {
          appendJobLog(running, chunk.status);
          if (!running.progressLabel.includes('%')) {
            running.progressLabel = `${running.progress}% · ${chunk.status}`;
          }
        }

        if (chunk.done) {
          const load = formatDurationNs(chunk.load_duration);
          const total = formatDurationNs(chunk.total_duration);
          const parts = ['Modelo pronto na VRAM'];
          if (load) parts.push(`carga: ${load}`);
          if (total) parts.push(`total: ${total}`);
          if (chunk.prompt_eval_count != null) parts.push(`tokens prompt: ${chunk.prompt_eval_count}`);
          if (chunk.eval_count != null) parts.push(`tokens resposta: ${chunk.eval_count}`);
          appendJobLog(running, parts.join(' · '));
          running.progress = 100;
          running.progressLabel = '100% · carregado';
        } else if (chunk.model && !chunk.response && !chunk.status) {
          appendJobLog(running, 'Carregando pesos na GPU…');
        }
      });

      const done = loadJobs.get(id);
      if (!done) return;
      clearJobPoll(done);
      done.status = 'completed';
      done.progress = 100;
      done.progressLabel = '100% · carregado';
      appendJobLog(done, 'Carga concluída — use a aba Uso GPU para monitorar a GPU');
      done.finishedAt = new Date().toISOString();
    } catch (err) {
      const failed = loadJobs.get(id);
      if (!failed) return;
      clearJobPoll(failed);
      failed.status = 'failed';
      failed.error = err.message;
      failed.progressLabel = 'Falhou';
      appendJobLog(failed, `Erro: ${err.message}`);
      failed.finishedAt = new Date().toISOString();
    }
  })();

  return sanitizeLoadJob(job);
}

function startUnloadJob(modelName) {
  const name = (modelName || '').trim();
  if (!name) throw new Error('Modelo é obrigatório.');

  const existing = [...unloadJobs.values()].find((j) => j.model === name && j.status === 'running');
  if (existing) return sanitizeUnloadJob(existing);

  const id = uuidv4();
  const job = {
    id,
    model: name,
    status: 'running',
    progress: 0,
    progressLabel: '0% · descarregando…',
    log: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    _pollTimer: null,
    _initialVram: 0,
  };
  unloadJobs.set(id, job);
  appendJobLog(job, `Descarregando ${name} da VRAM`);

  getRunningVram(name).then((vram) => {
    const current = unloadJobs.get(id);
    if (!current) return;
    current._initialVram = vram;
    if (vram > 0) appendJobLog(current, `VRAM atual: ${formatBytes(vram)}`);
    else appendJobLog(current, 'Modelo não aparece em /api/ps — enviando unload…');
    startUnloadProgressPoll(id, name, vram);
  });

  ollama
    .unloadModel(name)
    .then(() => {
      const current = unloadJobs.get(id);
      if (current) appendJobLog(current, 'Comando unload enviado ao Ollama');
    })
    .catch((err) => {
      const current = unloadJobs.get(id);
      if (current) appendJobLog(current, `unload API: ${err.message}`);
    });

  const finalize = () => {
    const current = unloadJobs.get(id);
    if (!current || current.status !== 'running') return;
    clearJobPoll(current);
    current.status = 'completed';
    current.progress = 100;
    current.progressLabel = '100% · descarregado';
    appendJobLog(current, 'Descarregamento concluído');
    current.finishedAt = new Date().toISOString();
  };

  const fail = (err) => {
    const current = unloadJobs.get(id);
    if (!current) return;
    clearJobPoll(current);
    current.status = 'failed';
    current.error = err.message;
    current.progressLabel = 'Falhou';
    appendJobLog(current, `Erro: ${err.message}`);
    current.finishedAt = new Date().toISOString();
  };

  const waitUntilGone = async () => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const current = unloadJobs.get(id);
      if (!current || current.status !== 'running') return;
      const vram = await getRunningVram(name);
      if (vram <= 0) {
        finalize();
        return;
      }
      await new Promise((r) => setTimeout(r, PROGRESS_POLL_MS));
    }
    fail(new Error('Tempo esgotado aguardando descarregar da VRAM'));
  };

  waitUntilGone().catch(fail);

  return sanitizeUnloadJob(job);
}

function listLoadJobs() {
  return [...loadJobs.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map(sanitizeLoadJob);
}

function getLoadJob(id) {
  const job = loadJobs.get(id);
  return job ? sanitizeLoadJob(job) : null;
}

function listUnloadJobs() {
  return [...unloadJobs.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map(sanitizeUnloadJob);
}

function getUnloadJob(id) {
  const job = unloadJobs.get(id);
  return job ? sanitizeUnloadJob(job) : null;
}

const importJobs = new Map();

function sanitizeImportJob(job) {
  const { child, ...safe } = job;
  return safe;
}

function startImportJob({ relPath, modelName }) {
  const abs = resolveSafe(relPath);
  if (!fs.existsSync(abs)) throw new Error('Arquivo GGUF não encontrado.');
  if (!abs.toLowerCase().endsWith('.gguf')) throw new Error('Arquivo deve ser .gguf');
  if (path.basename(abs).toLowerCase().startsWith('mmproj')) {
    throw new Error('Arquivos mmproj são auxiliares de visão — importe o modelo principal.');
  }

  const name = importModelNameFromGguf(path.basename(abs), modelName);
  const prepared = prepareGgufForOllamaImport(abs);
  const id = uuidv4();

  const job = {
    id,
    model: name,
    sourcePath: relPath,
    hostPath: prepared.hostPath,
    fromPath: prepared.fromPath,
    importMethod: prepared.importMethod,
    stagingRel: prepared.stagingRel,
    containerRoot: prepared.containerRoot,
    ollamaModelsDirRel: detectOllamaModelsDir(),
    status: 'running',
    progressLabel: 'Importando…',
    log: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    child: null,
  };
  importJobs.set(id, job);

  if (prepared.importMethod === 'staged') {
    job.log = `Link em ${displayPath(prepared.stagingRel)} → ${prepared.fromPath}\n`;
  } else {
    job.log = `Import via API: from ${prepared.fromPath}\n`;
  }

  const appendProgress = (chunk) => {
    const current = importJobs.get(id);
    if (!current || current.status !== 'running') return;
    if (chunk.status) {
      current.progressLabel = chunk.status;
      current.log = `${current.log}${chunk.status}\n`.slice(-8000);
      if (/enviando gguf|calculando sha256|enviando arquivo/i.test(chunk.status)) {
        current.importMethod = 'blob';
      }
    }
  };

  ollama
    .importGgufModel(name, { fromPath: prepared.fromPath, absPath: abs }, appendProgress)
    .then(() => {
      const current = importJobs.get(id);
      if (!current) return;
      current.status = 'completed';
      current.progressLabel = 'Importado no Ollama';
      current.finishedAt = new Date().toISOString();
    })
    .catch((apiErr) => {
      const current = importJobs.get(id);
      if (!current) return;
      current.status = 'failed';
      current.error = formatImportError(apiErr.message, current);
      current.progressLabel = 'Falhou';
      current.finishedAt = new Date().toISOString();
      current.log = `${current.log}Erro: ${apiErr.message}\n`.slice(-8000);
    });

  return sanitizeImportJob(job);
}

function listImportJobs() {
  return [...importJobs.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map(sanitizeImportJob);
}

function getImportJob(id) {
  const job = importJobs.get(id);
  return job ? sanitizeImportJob(job) : null;
}

function findLlamawebEntry(modelId, models) {
  const lower = (modelId || '').toLowerCase();
  if (!lower) return null;
  return (
    models.find((m) => {
      const id = (m.id || '').toLowerCase();
      if (id === lower || id === `${lower}.gguf`) return true;
      const base = path.basename(m.path || '')
        .replace(/\.gguf$/i, '')
        .toLowerCase();
      return base === lower;
    }) || null
  );
}

function matchGgufToOllamaModel(file, ollamaModels) {
  if (!file || file.kind !== 'model') return null;
  const suggested = (file.suggestedOllamaName || '').toLowerCase();
  const base = file.name.replace(/\.gguf$/i, '').toLowerCase();

  for (const m of ollamaModels) {
    const name = (m.name || m.model || '').toLowerCase();
    if (!name) continue;
    const nameBase = name.split(':')[0];
    if (suggested && (nameBase === suggested || name === suggested)) return m.name || m.model;
    if (nameBase === base || name === base) return m.name || m.model;
    if (suggested && name.includes(suggested)) return m.name || m.model;
  }
  return null;
}

function enrichGgufWithOllama(file, ollamaModels, runningNames) {
  if (file.kind !== 'model') return file;
  const matched = matchGgufToOllamaModel(file, ollamaModels);
  const ollamaModelName = matched || file.suggestedOllamaName;
  return {
    ...file,
    ollamaRegistered: Boolean(matched),
    ollamaModelName,
    ollamaRunning: matched ? runningNames.has(matched) : false,
    ollamaHostPath: toHostPath(resolveSafe(file.path)),
  };
}

function enrichGgufWithLlamaweb(file, llamawebModels) {
  if (file.kind !== 'model') return file;
  const guessedId = llamaweb.modelIdFromGgufPath(file.path);
  const entry = findLlamawebEntry(guessedId, llamawebModels);
  const status = entry?.status?.value || 'unloaded';
  return {
    ...file,
    llamawebModelId: entry?.id || guessedId,
    llamawebStatus: status,
    llamawebLoaded: status === 'loaded' || status === 'sleeping',
  };
}

async function getOverview() {
  const connection = await ollama.checkConnection();
  const llamawebConnection = await llamaweb.checkConnection();
  let ollamaModels = [];
  let running = [];
  let llamawebModels = [];

  if (connection.ok) {
    try {
      [ollamaModels, running] = await Promise.all([ollama.listModels(), ollama.listRunning()]);
    } catch (err) {
      connection.modelsError = err.message;
    }
  }

  if (llamawebConnection.ok) {
    try {
      llamawebModels = await llamaweb.listModels(true);
    } catch (err) {
      llamawebConnection.modelsError = err.message;
    }
  }

  const runningNames = new Set(running.map((m) => m.name));
  const ggufScans = listGgufFiles();
  const recentImports = listImportJobs();

  const ggufScansWithLlama = ggufScans.map((group) => ({
    ...group,
    files: group.files.map((f) => {
      const withLlama = enrichGgufWithLlamaweb(f, llamawebModels);
      return enrichGgufWithOllama(withLlama, ollamaModels, runningNames);
    }),
  }));

  const allGguf = ggufScansWithLlama.flatMap((d) => d.files.filter((f) => f.kind === 'model'));

  const enrichedOllamaAll = await Promise.all(
    ollamaModels.map(async (m) => {
      const storage = await enrichModelStorage(m, ggufScans, recentImports);
      return {
        ...m,
        ...storage,
        sizeLabel: formatBytes(m.size),
        running: runningNames.has(m.name),
      };
    })
  );

  const enrichedOllama = enrichedOllamaAll.filter((m) => m.folderExists);

  const enrichedRunningAll = await Promise.all(
    running.map(async (m) => {
      const installed = enrichedOllamaAll.find((o) => o.name === m.name);
      const storage = installed
        ? {
            folderPath: installed.folderPath,
            folderDisplayPath: installed.folderDisplayPath,
            folderExists: installed.folderExists,
            storageKind: installed.storageKind,
          }
        : await enrichModelStorage(m, ggufScans, recentImports);
      return {
        ...m,
        ...storage,
        sizeLabel: formatBytes(m.size),
      };
    })
  );

  const enrichedRunning = enrichedRunningAll.filter((m) => m.folderExists);

  return {
    connection,
    llamawebConnection,
    llamawebPublicUrl: LLAMAWEB_PUBLIC_URL,
    llamawebModels,
    llamawebRunning: llamawebModels.filter((m) =>
      ['loaded', 'sleeping', 'loading'].includes(m.status?.value)
    ),
    openWebUiUrl: OPEN_WEBUI_URL,
    ollamaPublicUrl: OLLAMA_PUBLIC_URL,
    ggufDirs: GGUF_DIRS,
    ollamaHostRoot: OLLAMA_HOST_ROOT,
    ollamaContainerRoot: resolveOllamaContainerRoot(),
    ollamaModelsDir: detectOllamaModelsDir(),
    ollamaModels: enrichedOllama,
    running: enrichedRunning,
    hiddenOllamaCount: enrichedOllamaAll.filter((m) => !m.folderExists).length,
    gguf: ggufScansWithLlama,
    ggufOrphan: allGguf.filter((f) => !f.ollamaRegistered),
    pullJobs: listPullJobs().slice(0, 20),
    loadJobs: listLoadJobs().slice(0, 20),
    unloadJobs: listUnloadJobs().slice(0, 20),
    importJobs: listImportJobs().slice(0, 20),
    llamawebLoadJobs: listLlamaWebLoadJobs().slice(0, 20),
    popularModels: [
      'hf.co/unsloth/gemma-4-E4B-it-GGUF:Q8_0',
      'llama3.2:3b',
      'llama3.2:1b',
      'qwen2.5-coder:14b',
      'qwen2.5:7b',
      'qwen3.5:9b',
      'gpt-oss:20b',
      'deepseek-r1:8b',
      'mistral:7b',
      'gemma2:9b',
      'phi3:mini',
    ],
  };
}

async function getModelDetail(modelName) {
  const name = sanitizeModelName(modelName);
  const info = await ollama.showModel(name);
  const details = info.details || {};
  const publicBase = OLLAMA_PUBLIC_URL;
  const openAiBase = `${publicBase}/v1`;

  let running = false;
  try {
    const active = await ollama.listRunning();
    running = active.some((m) => m.name === name);
  } catch {
    /* ignore */
  }

  return {
    model: name,
    info,
    running,
    publicOllamaUrl: publicBase,
    openWebUiUrl: OPEN_WEBUI_URL,
    endpoints: {
      chat: `${publicBase}/api/chat`,
      generate: `${publicBase}/api/generate`,
      tags: `${publicBase}/api/tags`,
      openAiChat: `${openAiBase}/chat/completions`,
      openAiModels: `${openAiBase}/models`,
    },
    snippets: {
      curlChat: `curl ${publicBase}/api/chat -d '{"model":"${name}","messages":[{"role":"user","content":"Olá"}],"stream":false}'`,
      curlOpenAi: `curl ${openAiBase}/chat/completions -H "Content-Type: application/json" -d '{"model":"${name}","messages":[{"role":"user","content":"Olá"}]}'`,
      continueYaml: [
        'models:',
        `  - name: ${name}`,
        '    provider: ollama',
        `    model: ${name}`,
        `    apiBase: ${publicBase}`,
      ].join('\n'),
      cursor: {
        baseUrl: openAiBase,
        apiKey: 'ollama',
        model: name,
      },
    },
    specs: {
      parameterSize: details.parameter_size || null,
      quantization: details.quantization_level || null,
      family: details.family || null,
      format: details.format || null,
    },
  };
}

async function getModelLoadDefaults(modelName) {
  const name = sanitizeModelName(modelName);
  const defaults = await loadOptions.getModelLoadDefaults(ollama, name);
  return {
    ...defaults,
    schema: loadOptions.getLoadOptionsSchema(),
  };
}

function sanitizeLlamaWebLoadJob(job) {
  const { _pollTimer, ...safe } = job;
  return safe;
}

function listLlamaWebLoadJobs() {
  return [...llamawebLoadJobs.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map(sanitizeLlamaWebLoadJob);
}

function getLlamaWebLoadJob(id) {
  const job = llamawebLoadJobs.get(id);
  return job ? sanitizeLlamaWebLoadJob(job) : null;
}

function startLlamaWebLoadJob({ relPath, loadInput = {} }) {
  const abs = resolveSafe(relPath);
  if (!fs.existsSync(abs)) throw new Error('Arquivo GGUF não encontrado.');
  if (!abs.toLowerCase().endsWith('.gguf')) throw new Error('Arquivo deve ser .gguf');
  if (path.basename(abs).toLowerCase().startsWith('mmproj')) {
    throw new Error('Arquivos mmproj são auxiliares — carregue o modelo principal.');
  }

  const loadConfig = llamacppLoad.parseLoadRequest({
    path: relPath,
    modelId: llamaweb.modelIdFromGgufPath(relPath),
    ...(typeof loadInput === 'object' ? loadInput : {}),
  });
  const extraArgs = llamacppLoad.buildExtraArgs(loadConfig.options);
  const modelId = loadConfig.modelId || llamaweb.modelIdFromGgufPath(relPath);

  const existing = [...llamawebLoadJobs.values()].find(
    (j) => j.modelId === modelId && j.status === 'running'
  );
  if (existing) return sanitizeLlamaWebLoadJob(existing);

  const id = uuidv4();
  const job = {
    id,
    modelId,
    sourcePath: relPath,
    operation: 'load',
    loadConfig: { options: loadConfig.options, extraArgs },
    status: 'running',
    progress: 0,
    progressLabel: '0% · preparando…',
    log: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    _pollTimer: null,
  };
  llamawebLoadJobs.set(id, job);
  appendJobLog(job, `Iniciando carga de ${modelId}`);
  appendJobLog(job, llamacppLoad.summarizeLoadConfig(loadConfig));
  if (extraArgs.length) {
    appendJobLog(job, `extra_args: ${extraArgs.join(' ')}`);
  } else {
    appendJobLog(job, 'Sem extra_args — usa preset global do llama.cpp');
  }

  (async () => {
    let resolvedId = modelId;
    let pollTimer = null;
    try {
      appendJobLog(job, 'Atualizando lista de modelos no llama.cpp…');
      job.progress = 5;
      job.progressLabel = '5% · sincronizando…';
      const models = await llamaweb.listModels(true);
      const entry = findLlamawebEntry(modelId, models);
      resolvedId = entry?.id || modelId;
      if (resolvedId !== modelId) {
        job.modelId = resolvedId;
        appendJobLog(job, `ID no llama.cpp: ${resolvedId}`);
      }
      appendJobLog(job, `Carregando ${resolvedId} na VRAM…`);
      job.progress = 10;
      job.progressLabel = '10% · iniciando…';
      await llamaweb.loadModel(resolvedId, extraArgs);
      job.progress = 25;
      job.progressLabel = '25% · aguardando GPU…';

      pollTimer = setInterval(async () => {
        if (job.status !== 'running') return;
        try {
          const current = await llamaweb.listModels(false);
          const item = findLlamawebEntry(resolvedId, current);
          const status = item?.status?.value;
          if (status === 'loading') {
            job.progress = Math.min(95, Math.max(job.progress, 30) + 8);
            job.progressLabel = `${job.progress}% · carregando pesos na GPU…`;
          } else if (status === 'loaded' || status === 'sleeping') {
            job.progress = 100;
            job.progressLabel = '100% · carregado';
          }
        } catch {
          /* ignore poll errors */
        }
      }, 1500);
      job._pollTimer = pollTimer;

      await llamaweb.waitForModelStatus(resolvedId, 'loaded');
      clearInterval(pollTimer);
      job._pollTimer = null;
      job.status = 'completed';
      job.progress = 100;
      job.progressLabel = '100% · carregado';
      appendJobLog(job, `Carga concluída — use em ${LLAMAWEB_PUBLIC_URL}/`);
      appendJobLog(job, 'Use a aba Uso GPU para monitorar a VRAM');
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      if (pollTimer) clearInterval(pollTimer);
      job._pollTimer = null;
      job.status = 'failed';
      job.error = err.message;
      job.progressLabel = 'Falhou';
      appendJobLog(job, `Erro: ${err.message}`);
      if (/extra_args is not allowed/i.test(err.message)) {
        appendJobLog(
          job,
          'Adicione --models-allow-extra-args ao comando do container llamacpp e redeploy.'
        );
      }
      job.finishedAt = new Date().toISOString();
    }
  })();

  return sanitizeLlamaWebLoadJob(job);
}

async function getGgufLoadDefaults(relPath) {
  const abs = resolveSafe(relPath);
  if (!fs.existsSync(abs)) throw new Error('Arquivo GGUF não encontrado.');

  const modelId = llamaweb.modelIdFromGgufPath(relPath);
  const stat = fs.statSync(abs);
  let options = llamacppLoad.guessDefaultsFromSize(stat.size);
  let lastArgs = null;

  try {
    const models = await llamaweb.listModels(false);
    const entry = findLlamawebEntry(modelId, models);
    if (entry?.status?.args) {
      lastArgs = entry.status.args;
      options = { ...options, ...llamacppLoad.parseArgsArray(entry.status.args) };
    }
  } catch {
    /* ignore */
  }

  let serverHint = null;
  try {
    await llamaweb.checkConnection();
    serverHint = llamacppLoad.getLoadOptionsSchema().hint;
  } catch {
    serverHint = 'llama.cpp offline — configure LLAMAWEB_URL no Downloader.';
  }

  return {
    model: modelId,
    path: relPath,
    fileName: path.basename(abs),
    sizeLabel: formatBytes(stat.size),
    options,
    system: '',
    keepAlive: null,
    contextLength: options.num_ctx || 8192,
    lastLoadArgs: lastArgs,
    schema: llamacppLoad.getLoadOptionsSchema(),
    hint: serverHint,
  };
}

function startLlamaWebUnloadJob(modelId) {
  const idName = (modelId || '').trim();
  if (!idName) throw new Error('Modelo é obrigatório.');

  const existing = [...llamawebLoadJobs.values()].find(
    (j) => j.modelId === idName && j.status === 'running'
  );
  if (existing) return sanitizeLlamaWebLoadJob(existing);

  const id = uuidv4();
  const job = {
    id,
    modelId: idName,
    operation: 'unload',
    status: 'running',
    progress: 0,
    progressLabel: 'Descarregando…',
    log: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  llamawebLoadJobs.set(id, job);
  appendJobLog(job, `Descarregando ${idName} da VRAM…`);

  (async () => {
    try {
      await llamaweb.unloadModel(idName);
      job.progress = 50;
      job.progressLabel = '50% · liberando memória…';
      await llamaweb.waitForModelStatus(idName, 'unloaded');
      job.status = 'completed';
      job.progress = 100;
      job.progressLabel = 'Descarregado';
      appendJobLog(job, 'VRAM liberada');
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      job.progressLabel = 'Falhou';
      appendJobLog(job, `Erro: ${err.message}`);
      job.finishedAt = new Date().toISOString();
    }
  })();

  return sanitizeLlamaWebLoadJob(job);
}

module.exports = {
  formatBytes,
  getOverview,
  getModelDetail,
  getModelLoadDefaults,
  getGgufLoadDefaults,
  getLoadOptionsSchema: loadOptions.getLoadOptionsSchema,
  getLlamaCppLoadOptionsSchema: llamacppLoad.getLoadOptionsSchema,
  listGgufFiles,
  deleteGgufFile,
  startPullJob,
  listPullJobs,
  getPullJob,
  cancelPullJob,
  startLoadJob,
  listLoadJobs,
  getLoadJob,
  startUnloadJob,
  listUnloadJobs,
  getUnloadJob,
  startImportJob,
  listImportJobs,
  getImportJob,
  startLlamaWebLoadJob,
  listLlamaWebLoadJobs,
  getLlamaWebLoadJob,
  startLlamaWebUnloadJob,
  ollama,
  llamaweb,
  sanitizeModelName,
  parsePullInput: hfModelRef.parsePullInput,
};
