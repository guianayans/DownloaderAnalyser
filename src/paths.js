const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.env.DOWNLOADER_ROOT || '/host');
const ROOT_LABEL = process.env.DOWNLOADER_ROOT_LABEL || '/';

function isFilesystemRoot(resolved) {
  return resolved === path.parse(resolved).root;
}

function resolveSafe(requested) {
  const rootResolved = path.resolve(ROOT);
  const normalized = path.resolve(rootResolved, requested || '.');

  if (isFilesystemRoot(rootResolved)) {
    if (!path.isAbsolute(normalized)) {
      throw new Error('Acesso negado: caminho fora do diretório permitido.');
    }
    return normalized;
  }

  if (normalized !== rootResolved && !normalized.startsWith(rootResolved + path.sep)) {
    throw new Error('Acesso negado: caminho fora do diretório permitido.');
  }
  return normalized;
}

function assertDirectory(dirPath) {
  const resolved = resolveSafe(dirPath);
  if (!fs.existsSync(resolved)) {
    throw new Error('Pasta não encontrada.');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error('O caminho informado não é uma pasta.');
  }
  return resolved;
}

function relativeFromRoot(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (!rel || rel === '') return '.';
  return rel.split(path.sep).join('/');
}

function displayPath(relativePath) {
  if (relativePath === '.' || relativePath === '') return ROOT_LABEL;
  const joined = path.posix.join(ROOT_LABEL === '/' ? '' : ROOT_LABEL, relativePath.replace(/\\/g, '/'));
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function listDirectory(requestedPath) {
  const dir = assertDirectory(requestedPath);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const items = entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const full = path.join(dir, e.name);
      let size = null;
      let mtime = null;
      try {
        const stat = fs.statSync(full);
        mtime = stat.mtime.toISOString();
        if (stat.isFile()) size = stat.size;
      } catch {
        /* ignore */
      }
      return {
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        size,
        mtime,
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const rel = relativeFromRoot(dir);
  const parent = dir === path.resolve(ROOT) ? null : relativeFromRoot(path.dirname(dir));

  return {
    root: ROOT_LABEL,
    path: rel,
    displayPath: displayPath(rel),
    parent,
    entries: items,
  };
}

function getDiskStats() {
  try {
    const stat = fs.statfsSync(ROOT);
    const total = stat.blocks * stat.bsize;
    const free = stat.bfree * stat.bsize;
    return { total, free, used: total - free };
  } catch {
    return null;
  }
}

module.exports = {
  ROOT,
  ROOT_LABEL,
  resolveSafe,
  assertDirectory,
  relativeFromRoot,
  displayPath,
  listDirectory,
  getDiskStats,
};
