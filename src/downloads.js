const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { assertDirectory, relativeFromRoot, ROOT } = require('./paths');
const { loadJobsInto, saveJobsFrom, getJobsFilePath } = require('./jobStore');

const jobs = new Map();
const bootStats = loadJobsInto(jobs);

function persistJobs() {
  try {
    saveJobsFrom(jobs);
  } catch (err) {
    console.error(`[downloader] Falha ao salvar histórico (${getJobsFilePath()}):`, err.message);
  }
}

if (bootStats.staleRunning > 0) {
  persistJobs();
}

const METHOD_DEFS = {
  wget: {
    label: 'wget',
    description: 'HTTP/HTTPS · retoma downloads',
    binary: 'wget',
    kind: 'file',
  },
  curl: {
    label: 'curl',
    description: 'HTTP/HTTPS · retoma',
    binary: 'curl',
    kind: 'file',
  },
  aria2: {
    label: 'aria2c',
    description: 'Multi-conexão · arquivos grandes',
    binary: 'aria2c',
    kind: 'file',
  },
  git: {
    label: 'git clone',
    description: 'Repositórios Git (HTTPS)',
    binary: 'git',
    kind: 'git',
  },
  huggingface: {
    label: 'Hugging Face',
    description: 'Modelos do Hugging Face',
    binary: 'huggingface-cli',
    kind: 'huggingface',
  },
};

function detectBinary(name) {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getAvailableMethods() {
  return Object.entries(METHOD_DEFS).map(([id, def]) => ({
    id,
    label: def.label,
    description: def.description,
    kind: def.kind,
    available: detectBinary(def.binary),
  }));
}

const MAX_LOG_CHARS = 65536;

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** Acumula stdout/stderr como no terminal: \r sobrescreve a linha atual. */
function appendTerminalLog(current, chunk) {
  let buf = current;
  const text = stripAnsi(chunk.toString());

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r') {
      const lastNl = buf.lastIndexOf('\n');
      buf = lastNl === -1 ? '' : buf.slice(0, lastNl + 1);
    } else if (ch === '\n') {
      buf += '\n';
    } else if (ch === '\b') {
      buf = buf.slice(0, -1);
    } else if (ch === '\t' || ch >= ' ') {
      buf += ch;
    }
  }

  if (buf.length > MAX_LOG_CHARS) {
    buf = `… (${buf.length - MAX_LOG_CHARS} chars truncados)\n${buf.slice(-MAX_LOG_CHARS)}`;
  }
  return buf;
}

function basenameFromUrl(url) {
  try {
    const base = path.basename(new URL(url).pathname);
    return base || 'download.bin';
  } catch {
    return 'download.bin';
  }
}

function parseProgress(method, raw) {
  const chunks = raw.replace(/\r/g, '\n').split('\n');
  let best = null;
  let detail = null;

  for (const line of chunks) {
    const text = line.trim();
    if (!text) continue;

    let match;

    if (method === 'wget') {
      match = text.match(/(\d{1,3})%/);
      const sizes = text.match(/([\d.]+\s*[KMG]?i?B)\s*\/\s*([\d.]+\s*[KMG]?i?B)/i);
      if (sizes) detail = `${sizes[1].trim()} / ${sizes[2].trim()}`;
    } else if (method === 'curl') {
      match = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    } else if (method === 'aria2') {
      match = text.match(/\((\d{1,3})%\)/) || text.match(/(\d{1,3})%/);
      const dl = text.match(/DL:([\d.]+[KMG]?i?B(?:\/[\d.]+[KMG]?i?B)?)/i);
      if (dl) detail = dl[1].replace('/', ' / ');
    } else if (method === 'git') {
      match =
        text.match(/Receiving objects:\s+(\d{1,3})%/i) ||
        text.match(/Resolving deltas:\s+(\d{1,3})%/i) ||
        text.match(/Updating files:\s+(\d{1,3})%/i);
    } else if (method === 'huggingface') {
      match = text.match(/(\d{1,3})%/);
      const dl = text.match(/([\d.]+\/[ \d.KMGTP]+B)/);
      if (dl) detail = dl[1];
    } else {
      match = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    }

    if (match) {
      const value = Math.min(100, Math.max(0, parseFloat(match[1])));
      if (best === null || value >= best) best = value;
    }
  }

  return best === null ? null : { percent: best, detail };
}

function applyProgress(job, raw) {
  const parsed = parseProgress(job.method, raw);
  if (!parsed) return;
  job.progress = parsed.percent;
  job.progressLabel = `${Math.round(parsed.percent)}%`;
  if (parsed.detail) job.progressDetail = parsed.detail;
}

function resolveOutputName(method, url, filename) {
  if (method === 'git') {
    return filename || path.basename(url.replace(/\/$/, '')).replace(/\.git$/, '') || 'repo';
  }
  if (method === 'huggingface') {
    const parsed = parseHuggingFaceUrl(url);
    return path.basename(parsed.file);
  }
  return filename || basenameFromUrl(url);
}

function resolveOutputPath(method, url, dir, outputName) {
  if (method === 'git') {
    return { outputPath: path.join(dir, outputName), outputKind: 'directory' };
  }
  if (method === 'huggingface') {
    const parsed = parseHuggingFaceUrl(url);
    return { outputPath: path.join(dir, parsed.file), outputKind: 'file' };
  }
  return { outputPath: path.join(dir, outputName), outputKind: 'file' };
}

function isPathUnderRoot(absPath) {
  const rootResolved = path.resolve(ROOT);
  const resolved = path.resolve(absPath);
  if (rootResolved === path.parse(rootResolved).root) {
    return path.isAbsolute(resolved);
  }
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
}

function expectedOutputPath(job) {
  const dir = assertDirectory(job.targetPath || '.');
  const { outputPath } = resolveOutputPath(job.method, job.url, dir, job.outputName);
  return path.resolve(outputPath);
}

function createJob({ method, url, targetDir, filename }) {
  const def = METHOD_DEFS[method];
  if (!def) throw new Error('Método de download inválido.');
  if (!detectBinary(def.binary)) {
    throw new Error(`Ferramenta "${def.binary}" não está instalada no container.`);
  }
  if (!url || typeof url !== 'string') throw new Error('URL obrigatória.');
  if (!/^https?:\/\//i.test(url) && method !== 'git') {
    throw new Error('URL deve começar com http:// ou https://');
  }
  if (method === 'git' && !/^(https?:\/\/|git@)/i.test(url)) {
    throw new Error('URL Git deve ser HTTPS ou git@host:repo.git');
  }

  const dir = assertDirectory(targetDir);
  const outputName = resolveOutputName(method, url, filename);
  const { outputPath, outputKind } = resolveOutputPath(method, url, dir, outputName);
  const id = uuidv4();
  const job = {
    id,
    method,
    url,
    targetDir: dir,
    targetPath: relativeFromRoot(dir),
    filename: filename || null,
    outputName,
    outputPath: path.resolve(outputPath),
    outputKind,
    status: 'running',
    exitCode: null,
    logText: '',
    pid: null,
    progress: 0,
    progressLabel: '0%',
    progressDetail: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    deletedAt: null,
    deleteReason: null,
  };

  jobs.set(id, job);
  persistJobs();

  const append = (chunk) => {
    const text = chunk.toString();
    job.logText = appendTerminalLog(job.logText, text);
    applyProgress(job, text);
  };

  let cmd;
  let args;

  if (method === 'wget') {
    const out = path.join(dir, outputName);
    cmd = 'wget';
    args = ['-c', '--progress=bar:force:noscroll', '-O', out, url];
  } else if (method === 'curl') {
    const out = path.join(dir, outputName);
    cmd = 'curl';
    args = ['-L', '-C', '-', '--progress-bar', '-o', out, url];
  } else if (method === 'aria2') {
    cmd = 'aria2c';
    args = [
      '-c',
      '-x', '4',
      '-s', '4',
      '--summary-interval=1',
      '--console-log-level=notice',
      '-d', dir,
      '-o', outputName,
      url,
    ];
  } else if (method === 'git') {
    const folder = outputName;
    cmd = 'git';
    args = ['clone', '--depth', '1', '--progress', url, path.join(dir, folder)];
  } else if (method === 'huggingface') {
    const parsed = parseHuggingFaceUrl(url);
    cmd = 'huggingface-cli';
    args = ['download', parsed.repo, parsed.file, '--local-dir', dir];
    if (filename) {
      job.logText += 'Aviso: filename customizado ignorado para huggingface-cli; arquivo vai para local-dir.\n';
    }
  }

  job.logText = `$ ${cmd} ${args.join(' ')}\n`;

  const child = spawn(cmd, args, {
    cwd: dir,
    env: {
      ...process.env,
      HF_HUB_ENABLE_HF_TRANSFER: process.env.HF_HUB_ENABLE_HF_TRANSFER || '1',
    },
  });

  job.child = child;
  job.pid = child.pid;

  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (err) => {
    job.status = 'failed';
    job.exitCode = 1;
    job.logText = appendTerminalLog(job.logText, `\nErro ao iniciar processo: ${err.message}\n`);
    job.finishedAt = new Date().toISOString();
    job.child = null;
    persistJobs();
  });
  child.on('close', (code) => {
    if (job.status === 'cancelled') return;
    job.exitCode = code;
    job.status = code === 0 ? 'completed' : 'failed';
    if (code === 0) {
      job.progress = 100;
      job.progressLabel = '100%';
    }
    job.finishedAt = new Date().toISOString();
    job.child = null;
    job.logText = appendTerminalLog(
      job.logText,
      code === 0 ? '\nDownload concluído.\n' : `\nProcesso encerrado com código ${code}.\n`
    );
    persistJobs();
  });

  return job;
}

function parseHuggingFaceUrl(url) {
  const match = url.match(
    /^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)(?:\/resolve\/[^/]+\/(.+))?$/i
  );
  if (!match) {
    throw new Error(
      'URL Hugging Face inválida. Use formato: https://huggingface.co/USER/REPO/resolve/main/caminho/arquivo.ext'
    );
  }
  const repo = match[1];
  const file = match[2];
  if (!file) {
    throw new Error('Informe a URL completa até o arquivo (resolve/main/...).');
  }
  return { repo, file };
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  if (job.child) {
    job.child.kill('SIGTERM');
    setTimeout(() => {
      if (job.status === 'running' && job.child) job.child.kill('SIGKILL');
    }, 3000);
  }
  job.status = 'cancelled';
  job.finishedAt = new Date().toISOString();
  job.logText = appendTerminalLog(job.logText, '\nDownload cancelado pelo usuário.\n');
  persistJobs();
  return true;
}

function deleteJobOutput(id) {
  const job = jobs.get(id);
  if (!job) {
    throw new Error('Download não encontrado.');
  }
  if (job.status === 'running') {
    throw new Error('Aguarde o download terminar antes de apagar.');
  }
  if (job.status === 'deleted') {
    throw new Error('Arquivo já foi removido.');
  }
  if (job.status !== 'completed') {
    throw new Error('Só é possível apagar downloads concluídos.');
  }

  const target = expectedOutputPath(job);
  if (!isPathUnderRoot(target)) {
    throw new Error('Caminho fora da área permitida.');
  }
  if (job.outputPath && path.resolve(job.outputPath) !== target) {
    throw new Error('Registro do download inválido.');
  }

  let removed = false;
  if (fs.existsSync(target)) {
    const stat = fs.statSync(target);
    const kind = job.outputKind || (job.method === 'git' ? 'directory' : 'file');
    if (kind === 'directory') {
      if (!stat.isDirectory()) {
        throw new Error('Tipo de arquivo inconsistente.');
      }
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      if (!stat.isFile()) {
        throw new Error('Tipo de arquivo inconsistente.');
      }
      fs.unlinkSync(target);
    }
    removed = true;
  }

  job.status = 'deleted';
  job.deletedAt = new Date().toISOString();
  job.deleteReason = 'user';
  const logMsg = removed
    ? '\nArquivo removido pelo usuário.\n'
    : '\nArquivo já não existia no disco.\n';
  if (!(job.logText || '').includes('removido pelo usuário') && !(job.logText || '').includes('já não existia')) {
    job.logText = appendTerminalLog(job.logText || '', logMsg);
  }
  persistJobs();
  return { ok: true, removed, job };
}

function removeJobFromHistory(id) {
  const job = jobs.get(id);
  if (!job) {
    throw new Error('Download não encontrado.');
  }
  if (job.status === 'running') {
    throw new Error('Cancele o download antes de remover do histórico.');
  }
  jobs.delete(id);
  persistJobs();
  return { ok: true, id };
}

function clearJobHistory() {
  const running = [...jobs.values()].filter((j) => j.status === 'running');
  if (running.length) {
    throw new Error('Cancele os downloads em andamento antes de limpar o histórico.');
  }
  const count = jobs.size;
  jobs.clear();
  persistJobs();
  return { ok: true, removed: count };
}

function outputExists(job) {
  try {
    const target = expectedOutputPath(job);
    if (!isPathUnderRoot(target)) return false;
    if (!fs.existsSync(target)) return false;
    const stat = fs.statSync(target);
    const kind = job.outputKind || (job.method === 'git' ? 'directory' : 'file');
    return kind === 'directory' ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

function markJobMissingOnDisk(job) {
  if (job.status === 'deleted') return false;

  job.status = 'deleted';
  job.deletedAt = job.deletedAt || new Date().toISOString();
  job.deleteReason = 'external';

  if (!(job.logText || '').includes('removido externamente')) {
    job.logText = appendTerminalLog(
      job.logText || '',
      '\nArquivo não encontrado no disco (removido externamente).\n'
    );
  }
  return true;
}

/** Marca cards como deletados; nunca remove entradas do histórico. */
function syncMissingFiles() {
  let changed = false;
  for (const job of jobs.values()) {
    if (job.status !== 'completed') continue;
    if (!outputExists(job) && markJobMissingOnDisk(job)) {
      changed = true;
    }
  }
  if (changed) persistJobs();
}

function getJob(id) {
  syncMissingFiles();
  return jobs.get(id) || null;
}

function listJobs() {
  syncMissingFiles();
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function migrateLoadedJobs() {
  let changed = false;
  for (const job of jobs.values()) {
    if (!job.outputPath && job.outputName && job.method) {
      try {
        const dir = job.targetDir || assertDirectory(job.targetPath || '.');
        const { outputPath, outputKind } = resolveOutputPath(
          job.method,
          job.url,
          dir,
          job.outputName
        );
        job.outputPath = path.resolve(outputPath);
        job.outputKind = outputKind;
        if (!job.targetDir) job.targetDir = dir;
        changed = true;
      } catch {
        /* ignore */
      }
    }
    if (job.status === 'deleted' && !job.deleteReason) {
      job.deleteReason = 'user';
      changed = true;
    }
  }
  if (changed) persistJobs();
}

migrateLoadedJobs();
syncMissingFiles();

module.exports = {
  getAvailableMethods,
  createJob,
  cancelJob,
  deleteJobOutput,
  removeJobFromHistory,
  clearJobHistory,
  getJob,
  listJobs,
  getJobsCount: () => jobs.size,
  getJobsFilePath,
};
