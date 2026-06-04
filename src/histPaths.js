const fs = require('fs');
const path = require('path');

const HIST_ROOT = process.env.DOWNLOADER_HIST_DIR || '/host/pendriver/downloader_hist';
const LEGACY_DATA_DIR = process.env.DOWNLOADER_DATA_DIR || path.join(__dirname, '..', 'data');

const PATHS = {
  jobs: path.join(HIST_ROOT, 'jobs', 'jobs.json'),
  shortcuts: path.join(HIST_ROOT, 'shortcuts', 'shortcuts.json'),
  sidebar: path.join(HIST_ROOT, 'sidebar', 'sidebar-layout.json'),
};

function ensureHistDirs() {
  for (const file of Object.values(PATHS)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
}

function migrateLegacyFile(targetFile, legacyFileName) {
  if (fs.existsSync(targetFile)) return false;
  const legacyFile = path.join(LEGACY_DATA_DIR, legacyFileName);
  if (!fs.existsSync(legacyFile)) return false;
  fs.copyFileSync(legacyFile, targetFile);
  console.log(`[downloader] Histórico migrado: ${legacyFile} -> ${targetFile}`);
  return true;
}

function initHistStorage() {
  ensureHistDirs();
  migrateLegacyFile(PATHS.jobs, 'jobs.json');
  migrateLegacyFile(PATHS.shortcuts, 'shortcuts.json');
  migrateLegacyFile(PATHS.sidebar, 'sidebar-layout.json');
}

module.exports = {
  HIST_ROOT,
  PATHS,
  ensureHistDirs,
  initHistStorage,
};
