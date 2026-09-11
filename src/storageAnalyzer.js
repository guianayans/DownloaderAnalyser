const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  assertDirectory,
  relativeFromRoot,
  displayPath,
  getDiskStats,
  resolveSafe,
} = require('./paths');

function duBytes(absPath) {
  try {
    const out = execFileSync('du', ['-sb', absPath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 180000,
    });
    const n = parseInt(String(out).split('\t')[0], 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return null;
  }
}

function safeStat(absPath) {
  try {
    return fs.statSync(absPath);
  } catch {
    return null;
  }
}

function applyPercentages(entries, parentRel, parentTotal, disk) {
  const diskTotal = disk?.total > 0 ? disk.total : parentTotal;
  const siblingTotal =
    entries.reduce((sum, row) => sum + row.size, 0) || parentTotal || 1;
  const barBase = siblingTotal > 0 ? siblingTotal : 1;

  for (const row of entries) {
    row.parentPath = parentRel;
    row.parentSize = barBase;
    row.pctOfDisk = diskTotal > 0 ? (row.size / diskTotal) * 100 : 0;
    row.pctOfParent = (row.size / barBase) * 100;
    row.hasChildren = row.type === 'directory';
  }
  return entries;
}

function listLevel(requestedPath) {
  const absDir = assertDirectory(requestedPath || '.');
  const rel = relativeFromRoot(absDir);
  const disk = getDiskStats();
  const started = Date.now();

  const folderDu = duBytes(absDir);

  let dirEntries;
  try {
    dirEntries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Não foi possível ler a pasta: ${err.message}`);
  }

  const entries = dirEntries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const full = path.join(absDir, e.name);
      const childRel = rel === '.' ? e.name : `${rel}/${e.name}`;
      const stat = safeStat(full);
      if (!stat) return null;

      if (stat.isFile()) {
        return {
          name: e.name,
          path: childRel,
          type: 'file',
          size: stat.size,
          fileCount: 1,
          mtime: stat.mtime.toISOString(),
          partial: false,
        };
      }

      const du = duBytes(full);
      return {
        name: e.name,
        path: childRel,
        type: 'directory',
        size: du != null ? du : 0,
        fileCount: -1,
        mtime: stat.mtime.toISOString(),
        partial: du == null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.size - a.size);

  const childrenSum = entries.reduce((sum, e) => sum + e.size, 0);
  const folderSize = folderDu != null ? folderDu : 0;
  const parentTotal = Math.max(folderSize, childrenSum, 1);
  applyPercentages(entries, rel, parentTotal, disk);

  return {
    path: rel,
    displayPath: displayPath(rel),
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    truncated: false,
    mode: 'level',
    disk,
    folderSize: folderSize || childrenSum,
    childrenSum,
    entryCount: entries.length,
    entries,
    largest: entries.slice(0, 40),
  };
}

function normalizeDeletePath(raw) {
  const trimmed = String(raw || '').trim().replace(/^\/+/, '');
  return trimmed === '' || trimmed === '.' ? null : trimmed;
}

function deleteStorageItems(paths) {
  if (!Array.isArray(paths) || !paths.length) {
    throw new Error('Informe ao menos um caminho.');
  }

  const normalized = [
    ...new Set(paths.map(normalizeDeletePath).filter(Boolean)),
  ];

  if (!normalized.length) {
    throw new Error('Nenhum caminho válido para excluir.');
  }

  normalized.sort((a, b) => b.split('/').length - a.split('/').length);

  const rootResolved = path.resolve(ROOT);
  const removed = [];
  const errors = [];

  for (const rel of normalized) {
    try {
      const abs = resolveSafe(rel);
      if (abs === rootResolved) {
        throw new Error('Não é permitido excluir a raiz.');
      }
      if (!fs.existsSync(abs)) {
        throw new Error('Não encontrado.');
      }
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        fs.rmSync(abs, { recursive: true, force: true });
      } else if (stat.isFile()) {
        fs.unlinkSync(abs);
      } else {
        throw new Error('Tipo de item não suportado.');
      }
      removed.push(rel);
    } catch (err) {
      errors.push({ path: rel, error: err.message });
    }
  }

  if (!removed.length) {
    throw new Error(errors[0]?.error || 'Nenhum item foi excluído.');
  }

  return { ok: true, removed, errors };
}

module.exports = {
  listLevel,
  deleteStorageItems,
};
