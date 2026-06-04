const fs = require('fs');
const path = require('path');
const { PATHS, ensureHistDirs } = require('./histPaths');

const JOBS_FILE = PATHS.jobs;

function getJobsFilePath() {
  return JOBS_FILE;
}

function ensureDataDir() {
  ensureHistDirs();
}

function serializeJob(job) {
  const { child, ...rest } = job;
  return rest;
}

function loadJobsInto(map) {
  ensureDataDir();
  if (!fs.existsSync(JOBS_FILE)) {
    console.log(`[downloader] Histórico: nenhum arquivo em ${JOBS_FILE}`);
    return { loaded: 0, staleRunning: 0 };
  }

  let staleRunning = 0;
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const list = Array.isArray(data?.jobs) ? data.jobs : [];
    for (const job of list) {
      if (!job?.id) continue;
      if (job.status === 'running') {
        job.status = 'failed';
        job.finishedAt = job.finishedAt || new Date().toISOString();
        job.logText = `${job.logText || ''}\nInterrompido (servidor reiniciado).\n`;
        staleRunning += 1;
      }
      map.set(job.id, job);
    }
    console.log(`[downloader] Histórico: ${map.size} job(s) carregado(s) de ${JOBS_FILE}`);
    return { loaded: map.size, staleRunning };
  } catch (err) {
    console.error(`[downloader] Falha ao carregar histórico (${JOBS_FILE}):`, err.message);
    return { loaded: 0, staleRunning: 0 };
  }
}

function saveJobsFrom(map) {
  ensureDataDir();
  const jobs = [...map.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(serializeJob);
  const payload = JSON.stringify({ jobs, updatedAt: new Date().toISOString() }, null, 2);
  const tmp = `${JOBS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmp, JOBS_FILE);
}

module.exports = {
  getJobsFilePath,
  loadJobsInto,
  saveJobsFrom,
};
