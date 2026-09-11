const crypto = require('crypto');
const http = require('http');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const { initHistStorage, HIST_ROOT } = require('./histPaths');
initHistStorage();
const { listDirectory, assertDirectory, ROOT, ROOT_LABEL, getDiskStats } = require('./paths');
const { getAvailableMethods, createJob, cancelJob, deleteJobOutput, removeJobFromHistory, clearJobHistory, getJob, listJobs, getJobsCount, getJobsFilePath } = require('./downloads');
const { listCustomShortcuts, addCustomShortcut, removeCustomShortcut, updateCustomShortcut } = require('./shortcuts');
const { getSidebarTree, updateSidebarLabel, reorderSidebar, updateFolderOpen } = require('./sidebar');
const { listLevel, deleteStorageItems } = require('./storageAnalyzer');
const aiModels = require('./aiModels');
const { attachGpuTerminal } = require('./gpuTerminal');

const PORT = Number(process.env.PORT || 4020);
const PASSWORD = process.env.DOWNLOADER_PASSWORD;
const SESSION_SECRET = process.env.DOWNLOADER_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

if (!PASSWORD) {
  console.error('[downloader] Defina DOWNLOADER_PASSWORD no .env do Coolify.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
const sessionMiddleware = session({
  name: 'downloader.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

function isAuthenticated(req) {
  return Boolean(req.session?.authenticated);
}

function verifyPassword(input, expected) {
  const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(hash(input), hash(expected));
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  return res.redirect('/login');
}

function assertBodyPassword(req) {
  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    throw Object.assign(new Error('Senha obrigatória.'), { status: 403 });
  }
  if (!verifyPassword(password, PASSWORD)) {
    throw Object.assign(new Error('Senha incorreta.'), { status: 403 });
  }
}

function sanitizeJob(job) {
  const { child, targetDir, outputPath, ...safe } = job;
  return {
    ...safe,
    progress: safe.progress ?? 0,
    progressLabel: safe.progressLabel || '0%',
    progressDetail: safe.progressDetail || null,
    outputName: safe.outputName || safe.filename || null,
    canDelete: safe.status === 'completed',
    deleteReason: safe.deleteReason || null,
  };
}

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || !verifyPassword(password, PASSWORD)) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  req.session.authenticated = true;
  return res.json({ ok: true });
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/me') return next();
  return requireAuth(req, res, next);
});

app.get('/api/config', (req, res) => {
  res.json({
    root: ROOT_LABEL,
    fsRoot: ROOT,
    port: PORT,
    methods: getAvailableMethods(),
    disk: getDiskStats(),
  });
});

app.get('/api/browse', (req, res) => {
  try {
    const rel = req.query.path || '.';
    const data = listDirectory(rel);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mkdir', (req, res) => {
  try {
    const { path: rel, name } = req.body || {};
    if (!name || /[\\/]/.test(name) || name.includes('..')) {
      return res.status(400).json({ error: 'Nome de pasta inválido.' });
    }
    const parent = assertDirectory(rel || '.');
    const target = path.join(parent, name);
    if (fs.existsSync(target)) {
      return res.status(400).json({ error: 'Pasta já existe.' });
    }
    fs.mkdirSync(target, { recursive: false });
    res.json({ ok: true, path: path.relative(ROOT, target) || '.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/download', (req, res) => {
  try {
    const { url, method, path: rel, filename } = req.body || {};
    const job = createJob({
      method: method || 'wget',
      url: url?.trim(),
      targetDir: rel || '.',
      filename: filename?.trim() || null,
    });
    res.json({ jobId: job.id, status: job.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const ok = cancelJob(req.params.id);
  if (!ok) return res.status(400).json({ error: 'Não foi possível cancelar este download.' });
  res.json({ ok: true });
});

app.post('/api/jobs/:id/delete-file', (req, res) => {
  try {
    const result = deleteJobOutput(req.params.id);
    res.json({ ok: true, removed: result.removed, job: sanitizeJob(result.job) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/jobs/:id', (req, res) => {
  try {
    assertBodyPassword(req);
    removeJobFromHistory(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/api/jobs/clear-history', (req, res) => {
  try {
    assertBodyPassword(req);
    const result = clearJobHistory();
    res.json({ ok: true, removed: result.removed });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get('/api/jobs', (req, res) => {
  res.json({ jobs: listJobs().map(sanitizeJob) });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  res.json({ job: sanitizeJob(job) });
});

app.get('/api/shortcuts', (req, res) => {
  res.json({ shortcuts: listCustomShortcuts() });
});

app.post('/api/shortcuts', (req, res) => {
  try {
    const { path: rel, label } = req.body || {};
    const shortcut = addCustomShortcut({ path: rel, label });
    res.json({ ok: true, shortcut });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/shortcuts/:id', (req, res) => {
  try {
    const removed = removeCustomShortcut(req.params.id);
    res.json({ ok: true, shortcut: removed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/sidebar', (req, res) => {
  res.json(getSidebarTree());
});

app.patch('/api/sidebar/items/:id', (req, res) => {
  try {
    const { label } = req.body || {};
    const item = updateSidebarLabel(req.params.id, label);
    res.json({ ok: true, item, ...getSidebarTree() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/sidebar/reorder', (req, res) => {
  try {
    const { containerId, ids } = req.body || {};
    const result = reorderSidebar(containerId, ids);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/sidebar/folders/:id', (req, res) => {
  try {
    const { open } = req.body || {};
    if (typeof open !== 'boolean') {
      return res.status(400).json({ error: 'Campo "open" (boolean) é obrigatório.' });
    }
    const result = updateFolderOpen(req.params.id, open);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/storage/analyze', (req, res) => {
  try {
    const rel = req.query.path || '.';
    const result = listLevel(rel);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/storage/delete', (req, res) => {
  try {
    assertBodyPassword(req);
    const { paths } = req.body || {};
    const result = deleteStorageItems(paths);
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get('/api/ai/overview', async (_req, res) => {
  try {
    const data = await aiModels.getOverview();
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/ollama/models/info', async (req, res) => {
  try {
    const name = req.query.model;
    if (!name) return res.status(400).json({ error: 'Modelo é obrigatório.' });
    const detail = await aiModels.getModelDetail(name);
    res.json(detail);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/api/ai/ollama/pull', (req, res) => {
  try {
    const { model, saveGguf } = req.body || {};
    const job = aiModels.startPullJob(model, { saveGguf });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/ollama/pull', (_req, res) => {
  res.json({ jobs: aiModels.listPullJobs() });
});

app.post('/api/ai/ollama/pull/:id/cancel', (req, res) => {
  try {
    const job = aiModels.cancelPullJob(req.params.id);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/ollama/load-options', (_req, res) => {
  res.json(aiModels.getLoadOptionsSchema());
});

app.get('/api/ai/ollama/models/load-defaults', async (req, res) => {
  try {
    const model = req.query.model;
    if (!model) return res.status(400).json({ error: 'Parâmetro model é obrigatório.' });
    const data = await aiModels.getModelLoadDefaults(model);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ai/ollama/run', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.model) return res.status(400).json({ error: 'Modelo é obrigatório.' });
    const job = aiModels.startLoadJob(body.model, body);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/ollama/load', (_req, res) => {
  res.json({ jobs: aiModels.listLoadJobs() });
});

app.get('/api/ai/ollama/load/:id', (req, res) => {
  const job = aiModels.getLoadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Carregamento não encontrado.' });
  res.json({ job });
});

app.post('/api/ai/ollama/unload', (req, res) => {
  try {
    const { model } = req.body || {};
    if (!model) return res.status(400).json({ error: 'Modelo é obrigatório.' });
    const job = aiModels.startUnloadJob(model);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/ollama/unload', (_req, res) => {
  res.json({ jobs: aiModels.listUnloadJobs() });
});

app.get('/api/ai/ollama/unload/:id', (req, res) => {
  const job = aiModels.getUnloadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Descarregamento não encontrado.' });
  res.json({ job });
});

app.delete('/api/ai/ollama/models', async (req, res) => {
  try {
    assertBodyPassword(req);
    const { model } = req.body || {};
    if (!model) return res.status(400).json({ error: 'Modelo é obrigatório.' });
    await aiModels.ollama.deleteModel(model);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/api/ai/gguf/import', (req, res) => {
  try {
    const { path: relPath, modelName } = req.body || {};
    if (!relPath) return res.status(400).json({ error: 'Caminho do arquivo é obrigatório.' });
    const job = aiModels.startImportJob({ relPath, modelName });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/gguf/import/:id', (req, res) => {
  const job = aiModels.getImportJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Importação não encontrada.' });
  res.json({ job });
});

app.delete('/api/ai/gguf', (req, res) => {
  try {
    assertBodyPassword(req);
    const { path: relPath } = req.body || {};
    if (!relPath) return res.status(400).json({ error: 'Caminho do arquivo é obrigatório.' });
    aiModels.deleteGgufFile(relPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/api/ai/llamaweb/load', (req, res) => {
  try {
    const { path: relPath, options, modelId, system } = req.body || {};
    if (!relPath) return res.status(400).json({ error: 'Caminho do arquivo é obrigatório.' });
    const job = aiModels.startLlamaWebLoadJob({
      relPath,
      loadInput: { options, modelId, system },
    });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/llamaweb/load-defaults', async (req, res) => {
  try {
    const relPath = req.query.path;
    if (!relPath) return res.status(400).json({ error: 'Parâmetro path é obrigatório.' });
    const data = await aiModels.getGgufLoadDefaults(relPath);
    res.json(data);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get('/api/ai/llamaweb/load-options', (_req, res) => {
  res.json(aiModels.getLlamaCppLoadOptionsSchema());
});

app.post('/api/ai/llamaweb/unload', (req, res) => {
  try {
    const { modelId } = req.body || {};
    if (!modelId) return res.status(400).json({ error: 'Modelo é obrigatório.' });
    const job = aiModels.startLlamaWebUnloadJob(modelId);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/llamaweb/load', (_req, res) => {
  res.json({ jobs: aiModels.listLlamaWebLoadJobs() });
});

app.get('/api/ai/llamaweb/load/:id', (req, res) => {
  const job = aiModels.getLlamaWebLoadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Operação não encontrada.' });
  res.json({ job });
});

app.use('/css', express.static(path.join(PUBLIC_DIR, 'css'), { maxAge: '1h' }));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), { maxAge: '1h' }));

app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/login.html', (_req, res) => res.redirect('/login'));

app.get('/', requireAuth, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/index.html', requireAuth, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const httpServer = http.createServer(app);
attachGpuTerminal(httpServer, sessionMiddleware);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[downloader] ROOT=${ROOT} LABEL=${ROOT_LABEL} PORT=${PORT}`);
  console.log(`[downloader] Histórico em: ${HIST_ROOT}`);
  console.log(`[downloader] Jobs: ${getJobsFilePath()} (${getJobsCount()} job(s))`);
});
