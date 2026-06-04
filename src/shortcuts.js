const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { assertDirectory, displayPath } = require('./paths');
const { PATHS, ensureHistDirs } = require('./histPaths');

const SHORTCUTS_FILE = PATHS.shortcuts;

function ensureDataDir() {
  ensureHistDirs();
}

function loadShortcuts() {
  ensureDataDir();
  if (!fs.existsSync(SHORTCUTS_FILE)) return [];

  try {
    const raw = fs.readFileSync(SHORTCUTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.shortcuts) ? data.shortcuts : [];
  } catch (err) {
    console.error('[downloader] Falha ao carregar atalhos:', err.message);
    return [];
  }
}

function saveShortcuts(shortcuts) {
  ensureDataDir();
  const payload = JSON.stringify(
    { shortcuts, updatedAt: new Date().toISOString() },
    null,
    2
  );
  const tmp = `${SHORTCUTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmp, SHORTCUTS_FILE);
}

function normalizeRelPath(rel) {
  if (!rel || rel === '.' || rel === '/') return '.';
  return String(rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';
}

function labelFromPath(rel) {
  if (rel === '.') return '/';
  const parts = rel.split('/').filter(Boolean);
  return parts[parts.length - 1] || rel;
}

function listCustomShortcuts() {
  return loadShortcuts()
    .map((s, index) => ({
      ...s,
      order: typeof s.order === 'number' ? s.order : index,
    }))
    .sort((a, b) => a.order - b.order);
}

function addCustomShortcut({ path: rel, label }) {
  const normalized = normalizeRelPath(rel || '.');
  if (normalized === '.') {
    throw new Error('Não é possível adicionar a raiz aos atalhos.');
  }

  assertDirectory(normalized);
  const shortcuts = loadShortcuts();

  if (shortcuts.some((s) => normalizeRelPath(s.path) === normalized)) {
    throw new Error('Esta pasta já está nos atalhos.');
  }

  const entry = {
    id: uuidv4(),
    path: normalized,
    label: (label || '').trim() || labelFromPath(normalized),
    displayPath: displayPath(normalized),
    order: shortcuts.reduce((max, s) => Math.max(max, typeof s.order === 'number' ? s.order : -1), -1) + 1,
    createdAt: new Date().toISOString(),
  };

  shortcuts.push(entry);
  saveShortcuts(shortcuts);
  return entry;
}

function removeCustomShortcut(id) {
  const shortcuts = loadShortcuts();
  const index = shortcuts.findIndex((s) => s.id === id);
  if (index === -1) throw new Error('Atalho não encontrado.');
  const [removed] = shortcuts.splice(index, 1);
  saveShortcuts(shortcuts);
  return removed;
}

function updateCustomShortcut(id, { label }) {
  const shortcuts = loadShortcuts();
  const entry = shortcuts.find((s) => s.id === id);
  if (!entry) throw new Error('Atalho não encontrado.');

  const nextLabel = (label || '').trim();
  if (!nextLabel) throw new Error('Nome do atalho não pode ser vazio.');
  if (nextLabel.length > 80) throw new Error('Nome do atalho muito longo (máx. 80 caracteres).');

  entry.label = nextLabel;
  saveShortcuts(shortcuts);
  return entry;
}

function reorderCustomShortcuts(orderedIds) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    throw new Error('Lista de atalhos inválida.');
  }

  const shortcuts = loadShortcuts();
  const idSet = new Set(orderedIds);
  if (idSet.size !== orderedIds.length) {
    throw new Error('Lista de atalhos contém IDs duplicados.');
  }
  if (orderedIds.length !== shortcuts.length) {
    throw new Error('A lista de reordenação deve incluir todos os atalhos.');
  }
  if (!orderedIds.every((id) => shortcuts.some((s) => s.id === id))) {
    throw new Error('Atalho não encontrado na lista.');
  }

  for (const shortcut of shortcuts) {
    shortcut.order = orderedIds.indexOf(shortcut.id);
  }

  shortcuts.sort((a, b) => a.order - b.order);
  saveShortcuts(shortcuts);
  return shortcuts;
}

module.exports = {
  listCustomShortcuts,
  addCustomShortcut,
  removeCustomShortcut,
  updateCustomShortcut,
  reorderCustomShortcuts,
  normalizeRelPath,
};
