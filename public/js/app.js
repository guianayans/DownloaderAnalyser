let currentPath = '.';
let currentDisplayPath = '/';
let config = { methods: [], root: '/', fsRoot: '/host' };
let selectedMethod = 'wget';
let pollTimer = null;
let browseEntries = [];
const lastJobStatuses = new Map();
const BROWSE_PATH_KEY = 'downloader.browsePath';

let shortcutFoldersOpen = {};
let sidebarTree = [];
let sidebarPaths = [];
let dragShortcut = null;

async function loadSidebar() {
  const data = await api('/api/sidebar');
  sidebarTree = data.tree || [];
  sidebarPaths = data.paths || [];
  shortcutFoldersOpen = data.foldersOpen || {};
}

async function persistShortcutFolderOpen(folderId, open) {
  shortcutFoldersOpen = { ...shortcutFoldersOpen, [folderId]: open };
  try {
    const data = await api(`/api/sidebar/folders/${encodeURIComponent(folderId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ open }),
    });
    shortcutFoldersOpen = data.foldersOpen || shortcutFoldersOpen;
  } catch (err) {
    toast(err.message, 'error');
  }
}

function isPathInShortcuts(path) {
  const norm = normalizeBrowsePath(path);
  if (norm === '.') return true;
  return sidebarPaths.some((p) => normalizeBrowsePath(p) === norm);
}

function clearShortcutDropMarkers() {
  document.querySelectorAll('.shortcut-draggable-item, .shortcut-folder-block').forEach((el) => {
    el.classList.remove('is-drop-before', 'is-drop-after');
  });
}

function collectContainerIds(containerId) {
  if (containerId === 'root') return sidebarTree.map((n) => n.id);
  const folder = sidebarTree.find((n) => n.id === containerId);
  return folder?.children?.map((c) => c.id) || [];
}

async function persistSidebarReorder(containerId, ids) {
  const data = await api('/api/sidebar/reorder', {
    method: 'PUT',
    body: JSON.stringify({ containerId, ids }),
  });
  sidebarTree = data.tree || [];
  sidebarPaths = data.paths || [];
  shortcutFoldersOpen = data.foldersOpen || shortcutFoldersOpen;
  renderSidebar();
}

async function applySidebarReorder(containerId, draggedId, targetId, insertBefore) {
  const ids = collectContainerIds(containerId);
  const from = ids.indexOf(draggedId);
  if (from < 0) return;
  ids.splice(from, 1);
  let insertAt = ids.indexOf(targetId);
  if (insertAt < 0) return;
  if (!insertBefore) insertAt += 1;
  ids.splice(insertAt, 0, draggedId);
  try {
    await persistSidebarReorder(containerId, ids);
    toast('Ordem atualizada', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

const DRAG_HANDLE_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="5" cy="4" r="1.2" fill="currentColor"/><circle cx="11" cy="4" r="1.2" fill="currentColor"/><circle cx="5" cy="8" r="1.2" fill="currentColor"/><circle cx="11" cy="8" r="1.2" fill="currentColor"/><circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="11" cy="12" r="1.2" fill="currentColor"/></svg>';

function createDragHandle(itemId, containerId) {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'shortcut-drag-handle';
  handle.draggable = true;
  handle.setAttribute('aria-label', 'Arrastar para reordenar');
  handle.title = 'Arrastar para reordenar';
  handle.innerHTML = DRAG_HANDLE_SVG;

  handle.addEventListener('dragstart', (e) => {
    dragShortcut = { id: itemId, containerId };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ containerId, id: itemId }));
    handle.closest('.shortcut-draggable-item, .shortcut-folder-block')?.classList.add('is-dragging');
  });

  handle.addEventListener('dragend', () => {
    dragShortcut = null;
    clearShortcutDropMarkers();
    document.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
  });

  return handle;
}

function parseDragPayload(raw) {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.id && parsed?.containerId) return parsed;
    } catch {
      /* ignore */
    }
  }
  if (dragShortcut) return dragShortcut;
  return { containerId: null, id: null };
}

function attachDropTarget(el, itemId, containerId) {
  el.addEventListener('dragover', (e) => {
    if (!dragShortcut || dragShortcut.containerId !== containerId || dragShortcut.id === itemId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = el.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    clearShortcutDropMarkers();
    el.classList.toggle('is-drop-before', before);
    el.classList.toggle('is-drop-after', !before);
  });

  el.addEventListener('dragleave', (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    el.classList.remove('is-drop-before', 'is-drop-after');
  });

  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const payload = parseDragPayload(e.dataTransfer.getData('text/plain'));
    if (payload.containerId !== containerId) return;
    const insertBefore = el.classList.contains('is-drop-before');
    clearShortcutDropMarkers();
    if (!payload.id || payload.id === itemId) return;
    await applySidebarReorder(containerId, payload.id, itemId, insertBefore);
  });
}

function setupShortcutContainer(container, containerId) {
  container.dataset.containerId = containerId;

  container.addEventListener('dragover', (e) => {
    if (!dragShortcut || dragShortcut.containerId !== containerId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  container.addEventListener('drop', async (e) => {
    if (e.target.closest('.shortcut-draggable-item, .shortcut-folder-block')) return;
    if (!dragShortcut || dragShortcut.containerId !== containerId) return;
    e.preventDefault();
    clearShortcutDropMarkers();
    const ids = collectContainerIds(containerId).filter((id) => id !== dragShortcut.id);
    ids.push(dragShortcut.id);
    try {
      await persistSidebarReorder(containerId, ids);
      toast('Ordem atualizada', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function startRenameSidebarItem(item, labelEl, disableEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'shortcut-label-input';
  input.value = item.label;
  input.maxLength = 80;
  input.setAttribute('aria-label', 'Renomear atalho');

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    input.replaceWith(labelEl);
    if (disableEl) disableEl.disabled = false;
    if (!save || !next || next === item.label) {
      labelEl.textContent = item.label;
      return;
    }
    try {
      await api(`/api/sidebar/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label: next }),
      });
      await loadSidebar();
      renderSidebar();
      toast('Atalho renomeado', 'success');
    } catch (err) {
      labelEl.textContent = item.label;
      toast(err.message, 'error');
    }
  };

  labelEl.replaceWith(input);
  if (disableEl) disableEl.disabled = true;
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function bindRenameLabel(item, labelEl, disableEl) {
  labelEl.title = `${item.label} — duplo clique para renomear`;
  labelEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startRenameSidebarItem(item, labelEl, disableEl);
  });
}

function renderDraggableLeaf(container, item, { containerId, showUnpin = false }) {
  const wrap = document.createElement('div');
  wrap.className = `shortcut-draggable-item${item.custom ? ' is-custom' : ''}`;
  wrap.dataset.id = item.id;
  wrap.dataset.containerId = containerId;

  const handle = createDragHandle(item.id, containerId);
  attachDropTarget(wrap, item.id, containerId);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `shortcut-row is-leaf${item.custom ? ' is-custom' : ''}${pathMatchesCurrent(item.path, { exact: true }) ? ' is-active' : ''}`;
  btn.dataset.path = item.path;

  const dot = document.createElement('span');
  dot.className = 'tree-dot';
  dot.setAttribute('aria-hidden', 'true');

  const labelEl = document.createElement('span');
  labelEl.className = 'tree-label';
  labelEl.textContent = item.label;
  bindRenameLabel(item, labelEl, btn);

  btn.appendChild(dot);
  btn.appendChild(labelEl);
  btn.addEventListener('click', () => loadBrowse(item.path));

  if (showUnpin) {
    btn.classList.add('has-unpin');
    const unpin = document.createElement('button');
    unpin.type = 'button';
    unpin.className = 'shortcut-unpin';
    unpin.setAttribute('aria-label', 'Remover dos atalhos');
    unpin.title = 'Remover dos atalhos';
    unpin.textContent = '×';
    unpin.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeCustomShortcut(item.id);
    });
    btn.appendChild(unpin);
  }

  wrap.appendChild(handle);
  wrap.appendChild(btn);

  container.appendChild(wrap);
}

function renderSidebarFolder(parent, entry, { rootLevel = false }) {
  const isOpen = shortcutFoldersOpen[entry.id] === true;

  const folder = document.createElement('div');
  folder.className = `shortcut-folder${isOpen ? ' open' : ''}${rootLevel ? ' shortcut-folder-block' : ''}`;
  folder.dataset.folderId = entry.id;

  if (rootLevel) {
    folder.classList.add('shortcut-folder-block');
    folder.dataset.id = entry.id;
    folder.dataset.containerId = 'root';
    attachDropTarget(folder, entry.id, 'root');
  }

  const head = document.createElement('div');
  head.className = 'shortcut-row is-folder shortcut-folder-head';
  if (entry.path && pathMatchesCurrent(entry.path)) head.classList.add('is-active');

  if (rootLevel) head.appendChild(createDragHandle(entry.id, 'root'));

  const expander = document.createElement('button');
  expander.type = 'button';
  expander.className = 'tree-expander';
  expander.setAttribute('aria-expanded', String(isOpen));
  expander.setAttribute('aria-label', isOpen ? 'Recolher pasta' : 'Expandir pasta');
  expander.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4.5 6L8 9.5 11.5 6z"/></svg>';

  const folderBtn = document.createElement('button');
  folderBtn.type = 'button';
  folderBtn.className = 'tree-folder-link';
  folderBtn.dataset.path = entry.path || '';

  const folderIcon = document.createElement('span');
  folderIcon.className = 'tree-folder-icon';
  folderIcon.setAttribute('aria-hidden', 'true');
  folderIcon.innerHTML =
    '<svg viewBox="0 0 16 16" width="15" height="15"><path fill="currentColor" d="M2 4.5A1.5 1.5 0 013.5 3h3.172a1.5 1.5 0 011.06.44L9.5 5H12.5A1.5 1.5 0 0114 6.5v5A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-7z"/></svg>';

  const folderLabel = document.createElement('span');
  folderLabel.className = 'tree-label';
  folderLabel.textContent = entry.label;
  bindRenameLabel(entry, folderLabel, folderBtn);

  folderBtn.appendChild(folderIcon);
  folderBtn.appendChild(folderLabel);

  if (entry.path) {
    folderBtn.addEventListener('click', () => loadBrowse(entry.path));
  } else {
    folderBtn.classList.add('is-group-only');
    folderBtn.addEventListener('click', () => expander.click());
  }

  expander.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !folder.classList.contains('open');
    folder.classList.toggle('open', open);
    expander.setAttribute('aria-expanded', String(open));
    expander.setAttribute('aria-label', open ? 'Recolher pasta' : 'Expandir pasta');
    persistShortcutFolderOpen(entry.id, open);
  });

  head.appendChild(expander);
  head.appendChild(folderBtn);
  folder.appendChild(head);

  const children = document.createElement('div');
  children.className = 'shortcut-tree-children';
  children.setAttribute('role', 'group');
  children.setAttribute('aria-label', entry.label);

  for (const child of entry.children || []) {
    renderDraggableLeaf(children, child, { containerId: entry.id, showUnpin: Boolean(entry.custom) });
  }
  setupShortcutContainer(children, entry.id);

  folder.appendChild(children);
  parent.appendChild(folder);
}

function normalizeBrowsePath(p) {
  if (!p || p === '.' || p === '/') return '.';
  return String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';
}

function pathMatchesCurrent(shortcutPath, { exact = false } = {}) {
  const cur = normalizeBrowsePath(currentPath);
  const target = normalizeBrowsePath(shortcutPath);
  if (target === '.') return cur === '.';
  if (exact) return cur === target;
  return cur === target || cur.startsWith(`${target}/`);
}

function renderSidebar() {
  const el = document.getElementById('shortcuts');
  el.innerHTML = '';
  const tree = document.createElement('div');
  tree.className = 'shortcut-tree';
  setupShortcutContainer(tree, 'root');

  for (const node of sidebarTree) {
    if (node.type === 'link') {
      renderDraggableLeaf(tree, node, { containerId: 'root' });
      continue;
    }
    if (node.type === 'folder') renderSidebarFolder(tree, node, { rootLevel: true });
  }

  el.appendChild(tree);
  updateShortcutActiveStates();
}

function updatePinShortcutButton() {
  const btn = document.getElementById('pin-shortcut-btn');
  if (!btn) return;

  const atRoot = normalizeBrowsePath(currentPath) === '.';
  const pinned = isPathInShortcuts(currentPath);

  btn.disabled = atRoot || pinned;
  btn.classList.toggle('is-pinned', pinned && !atRoot);

  if (atRoot) {
    btn.textContent = 'Adicionar aos atalhos';
    btn.title = 'A raiz não pode ser adicionada';
  } else if (pinned) {
    btn.textContent = 'Já está nos atalhos';
    btn.title = 'Esta pasta já está nos atalhos';
  } else {
    btn.textContent = 'Adicionar aos atalhos';
    btn.title = `Fixar ${currentDisplayPath}`;
  }
}

async function addCurrentFolderShortcut() {
  const norm = normalizeBrowsePath(currentPath);
  if (norm === '.' || isPathInShortcuts(currentPath)) return;

  try {
    await api('/api/shortcuts', {
      method: 'POST',
      body: JSON.stringify({ path: currentPath }),
    });
    await loadSidebar();
    renderSidebar();
    updatePinShortcutButton();
    toast('Pasta adicionada aos atalhos', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeCustomShortcut(id) {
  try {
    await api(`/api/shortcuts/${id}`, { method: 'DELETE' });
    await loadSidebar();
    renderSidebar();
    updatePinShortcutButton();
    toast('Atalho removido', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function updateShortcutActiveStates() {
  document.querySelectorAll('.shortcut-row.is-leaf').forEach((row) => {
    row.classList.toggle('is-active', pathMatchesCurrent(row.dataset.path, { exact: true }));
  });
  document.querySelectorAll('.shortcut-row.is-folder').forEach((row) => {
    const link = row.querySelector('.tree-folder-link');
    if (link) row.classList.toggle('is-active', pathMatchesCurrent(link.dataset.path));
  });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('Não autenticado');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

function toast(message, type = 'info') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

let passwordDialogResolver = null;

function initPasswordDialog() {
  const dialog = document.getElementById('password-dialog');
  const input = document.getElementById('password-dialog-input');
  const errorEl = document.getElementById('password-dialog-error');
  const titleEl = document.getElementById('password-dialog-title');
  const messageEl = document.getElementById('password-dialog-message');

  function closeDialog(value) {
    dialog.classList.add('hidden');
    dialog.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('password-dialog-open');
    input.value = '';
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
    const resolve = passwordDialogResolver;
    passwordDialogResolver = null;
    resolve?.(value);
  }

  document.getElementById('password-dialog-cancel')?.addEventListener('click', () => closeDialog(null));
  dialog.querySelector('.password-dialog-backdrop')?.addEventListener('click', () => closeDialog(null));
  document.getElementById('password-dialog-confirm')?.addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) {
      errorEl.textContent = 'Digite a senha.';
      errorEl.classList.remove('hidden');
      input.focus();
      return;
    }
    closeDialog(value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('password-dialog-confirm')?.click();
    }
    if (e.key === 'Escape') closeDialog(null);
  });

  return function promptPassword({ title, message }) {
    if (passwordDialogResolver) return Promise.resolve(null);
    titleEl.textContent = title || 'Confirmar senha';
    messageEl.textContent = message || '';
    dialog.classList.remove('hidden');
    dialog.setAttribute('aria-hidden', 'false');
    document.body.classList.add('password-dialog-open');
    input.focus();
    return new Promise((resolve) => {
      passwordDialogResolver = resolve;
    });
  };
}

const promptPassword = initPasswordDialog();

async function confirmWithPassword({ title, message, action }) {
  const password = await promptPassword({ title, message });
  if (!password) return false;
  try {
    await action(password);
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

function formatBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function absPath(rel) {
  if (rel === '.') return config.root || '/';
  const base = config.root === '/' ? '' : config.root;
  return `${base}/${rel}`.replace(/\/+/g, '/');
}

function formatDiskGb(bytes) {
  if (bytes == null) return '—';
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}

function diskUsageFillStyle(usedPct) {
  const t = Math.max(0, Math.min(100, usedPct)) / 100;
  const hue = 120 - t * 120;
  const light = 48 - t * 8;
  return `linear-gradient(90deg, hsl(${hue} 78% ${light}%), hsl(${hue} 70% ${light - 8}%))`;
}

function renderDisk(disk) {
  if (!disk) return;
  const pct = disk.total ? Math.round((disk.used / disk.total) * 100) : 0;
  document.getElementById('disk-free').textContent = `Livre: ${formatDiskGb(disk.free)}`;
  document.getElementById('disk-used').textContent = `Usado: ${pct}%`;
  const fill = document.getElementById('disk-fill');
  fill.style.width = `${pct}%`;
  fill.style.background = diskUsageFillStyle(pct);
}

function renderBreadcrumb(data) {
  const el = document.getElementById('breadcrumb');
  el.innerHTML = '';
  const parts = data.path === '.' ? [] : data.path.split(/[\\/]/);
  const crumbs = [{ label: '/', path: '.' }];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ label: part, path: acc });
  }
  crumbs.forEach((c, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      el.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = c.label;
    btn.addEventListener('click', () => loadBrowse(c.path));
    el.appendChild(btn);
  });
}

function renderFolderList(data) {
  const list = document.getElementById('folder-list');
  const filter = (document.getElementById('filter-input').value || '').toLowerCase();
  browseEntries = data.entries;
  const entries = data.entries.filter((e) => e.name.toLowerCase().includes(filter));

  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = '<div class="empty-state">Nenhum item nesta pasta</div>';
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = `folder-item ${entry.type === 'file' ? 'file' : ''}`;
    row.innerHTML = `
      <div class="folder-item-left">
        <div class="folder-icon ${entry.type === 'directory' ? 'dir' : 'file'}">${entry.type === 'directory' ? '📁' : '📄'}</div>
        <span class="folder-name">${entry.name}</span>
      </div>
      <span class="folder-meta">${entry.type === 'directory' ? 'pasta' : formatBytes(entry.size)}</span>
    `;
    if (entry.type === 'directory') {
      row.addEventListener('click', () => {
        const next = data.path === '.' ? entry.name : `${data.path}/${entry.name}`;
        loadBrowse(next);
      });
    }
    list.appendChild(row);
  }
}

function updatePathDisplay() {
  document.getElementById('current-path').textContent = currentDisplayPath;
  const rootLabel = document.getElementById('root-label');
  if (rootLabel) {
    rootLabel.textContent = currentDisplayPath;
    rootLabel.title = currentDisplayPath;
  }
}

function jobMatchesCurrentFolder(job) {
  return normalizeBrowsePath(job.targetPath) === normalizeBrowsePath(currentPath);
}

function saveBrowsePath(path) {
  try {
    sessionStorage.setItem(BROWSE_PATH_KEY, normalizeBrowsePath(path));
  } catch { /* ignore */ }
}

function loadSavedBrowsePath() {
  try {
    const saved = sessionStorage.getItem(BROWSE_PATH_KEY);
    return saved ? normalizeBrowsePath(saved) : '.';
  } catch {
    return '.';
  }
}

function jobOutputName(job) {
  if (job.outputName) return job.outputName;
  if (job.filename) return job.filename;
  try {
    const u = new URL(job.url);
    const part = u.pathname.split('/').filter(Boolean).pop();
    return part ? decodeURIComponent(part) : 'download';
  } catch {
    return 'download';
  }
}

async function loadBrowse(path = currentPath, { silent = false } = {}) {
  if (!silent) {
    const list = document.getElementById('folder-list');
    list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  }
  try {
    const data = await api(`/api/browse?path=${encodeURIComponent(path)}`);
    currentPath = data.path;
    currentDisplayPath = data.displayPath || absPath(data.path);
    renderBreadcrumb(data);
    renderFolderList(data);
    updatePathDisplay();
    document.getElementById('up-btn').disabled = data.path === '.';
    saveBrowsePath(currentPath);
    updateShortcutActiveStates();
    updatePinShortcutButton();
    return true;
  } catch (err) {
    if (!silent) {
      const list = document.getElementById('folder-list');
      list.innerHTML = `<div class="empty-state">${err.message}</div>`;
      toast(err.message, 'error');
    }
    return false;
  }
}

const METHOD_ICONS = {
  wget: 'W',
  curl: 'C',
  aria2: 'A2',
  git: 'Git',
  huggingface: 'HF',
};

function renderMethods() {
  const grid = document.getElementById('method-grid');
  grid.innerHTML = '';
  for (const m of config.methods) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'method-card';
    card.dataset.method = m.id;
    if (!m.available) card.classList.add('disabled');
    if (m.id === selectedMethod && m.available) card.classList.add('active');
    const icon = METHOD_ICONS[m.id] || '?';
    card.innerHTML = `
      <div class="method-card-inner">
        <div class="method-icon">${icon}</div>
        <div class="method-body">
          <span class="method-name">${m.label}${m.available ? '' : ' · off'}</span>
          <span class="method-desc">${m.description}</span>
        </div>
        <div class="method-radio" aria-hidden="true"></div>
      </div>
    `;
    if (m.available) {
      card.addEventListener('click', () => {
        selectedMethod = m.id;
        document.querySelectorAll('.method-card').forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
      });
    }
    grid.appendChild(card);
  }
  if (!config.methods.find((m) => m.id === selectedMethod && m.available)) {
    const first = config.methods.find((m) => m.available);
    if (first) {
      selectedMethod = first.id;
      grid.querySelector(`[data-method="${first.id}"]`)?.classList.add('active');
    }
  }
}

function statusLabel(s) {
  const map = {
    running: 'Em andamento',
    completed: 'Concluído',
    failed: 'Falhou',
    cancelled: 'Cancelado',
    deleted: 'Deletado',
  };
  return map[s] || s;
}

async function cancelJob(id) {
  try {
    await api(`/api/jobs/${id}/cancel`, { method: 'POST', body: '{}' });
    toast('Download cancelado', 'success');
    await loadJobs();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteJobFile(id, outputName, targetPath) {
  const label = outputName || 'este arquivo';
  if (!confirm(`Apagar "${label}" do servidor?\n\nEsta ação não pode ser desfeita.`)) return;
  try {
    await api(`/api/jobs/${id}/delete-file`, { method: 'POST', body: '{}' });
    toast('Arquivo removido', 'success');
    await loadJobs();
    if (jobMatchesCurrentFolder({ targetPath })) {
      await loadBrowse(currentPath, { silent: true });
      try {
        config = await api('/api/config');
        renderDisk(config.disk);
      } catch { /* ignore */ }
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function removeJobHistoryEntry(id, outputName) {
  const label = outputName || 'este item';
  const ok = await confirmWithPassword({
    title: 'Remover do histórico',
    message: `Remover "${label}" da lista? O arquivo no disco não será apagado.`,
    action: (password) =>
      api(`/api/jobs/${id}`, { method: 'DELETE', body: JSON.stringify({ password }) }),
  });
  if (!ok) return;
  lastJobStatuses.delete(id);
  toast('Removido do histórico', 'success');
  await loadJobs();
}

async function clearJobsHistory() {
  const count = document.getElementById('jobs-count')?.textContent || '0';
  if (Number(count) === 0) {
    toast('Nenhum download no histórico', 'info');
    return;
  }
  const ok = await confirmWithPassword({
    title: 'Limpar histórico',
    message: `Remover todos os ${count} downloads da lista? Os arquivos no disco não serão apagados.`,
    action: (password) =>
      api('/api/jobs/clear-history', { method: 'POST', body: JSON.stringify({ password }) }),
  });
  if (!ok) return;
  lastJobStatuses.clear();
  toast('Histórico limpo', 'success');
  await loadJobs();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function jobLogText(job) {
  if (job.logText && job.logText.trim()) return job.logText;
  if (Array.isArray(job.log) && job.log.length) return job.log.join('\n');
  return '';
}

function deleteReasonLabel(job) {
  if (job.status !== 'deleted') return '';
  if (job.deleteReason === 'external') return 'Arquivo removido do disco (fora do app)';
  return 'Arquivo removido pelo usuário';
}

function progressBarHtml(job) {
  if (job.status === 'deleted') {
    return `
      <div class="job-progress-wrap is-deleted-bar">
        <div class="job-progress-head">
          <span class="job-progress-pct">—</span>
          <span class="job-progress-detail">${deleteReasonLabel(job)}</span>
        </div>
        <div class="job-progress-track">
          <div class="job-progress-fill deleted-fill" style="width: 0%"></div>
        </div>
      </div>
    `;
  }

  const pct = job.status === 'completed' ? 100 : Math.round(job.progress || 0);
  const label = job.status === 'completed' ? '100%' : job.progressLabel || `${pct}%`;
  const detail = job.progressDetail ? `<span class="job-progress-detail">${job.progressDetail}</span>` : '';
  const indeterminate = job.status === 'running' && pct === 0 && job.method === 'git';

  if (job.status !== 'running' && job.status !== 'completed') return '';

  return `
    <div class="job-progress-wrap ${job.status === 'completed' ? 'is-complete' : ''}">
      <div class="job-progress-head">
        <span class="job-progress-pct">${label}</span>
        ${detail}
      </div>
      <div class="job-progress-track">
        <div class="job-progress-fill ${indeterminate ? 'indeterminate' : ''}" style="width: ${indeterminate ? '100' : pct}%"></div>
      </div>
    </div>
  `;
}

async function loadJobs() {
  const openIds = new Set(
    [...document.querySelectorAll('.job.open')].map((el) => el.dataset.jobId).filter(Boolean)
  );

  const { jobs } = await api('/api/jobs');
  const container = document.getElementById('jobs');
  document.getElementById('jobs-count').textContent = String(jobs.length);

  let refreshBrowse = false;
  for (const job of jobs) {
    const prev = lastJobStatuses.get(job.id);
    if (prev === 'running' && job.status === 'completed' && jobMatchesCurrentFolder(job)) {
      refreshBrowse = true;
    }
    if (prev === 'completed' && job.status === 'deleted' && jobMatchesCurrentFolder(job)) {
      refreshBrowse = true;
    }
    lastJobStatuses.set(job.id, job.status);
  }

  if (!jobs.length) {
    container.innerHTML = '<div class="empty-state">Nenhum download iniciado ainda</div>';
    if (refreshBrowse) {
      await loadBrowse(currentPath, { silent: true });
      try {
        config = await api('/api/config');
        renderDisk(config.disk);
      } catch { /* ignore */ }
    }
    return;
  }

  const hasRunning = jobs.some((j) => j.status === 'running');
  if (hasRunning && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = setInterval(loadJobs, 1000);
  } else if (!hasRunning && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = setInterval(loadJobs, 3000);
  }

  container.innerHTML = '';
  for (const job of jobs) {
    const div = document.createElement('div');
    div.className = `job${job.status === 'deleted' ? ' is-deleted' : ''}`;
    div.dataset.jobId = job.id;
    const rel = job.targetPath || '/';
    const displayRel = rel === '.' ? '/' : `/${rel.replace(/^\//, '')}`;
    const outputName = escapeHtml(jobOutputName(job));
    const deleteBtn = job.canDelete
      ? `<button type="button" class="btn-danger-ghost delete-btn" data-id="${job.id}">Apagar</button>`
      : '';
    div.innerHTML = `
      ${job.status !== 'running' ? `<button type="button" class="job-remove-btn" data-id="${job.id}" title="Remover do histórico" aria-label="Remover do histórico">×</button>` : ''}
      <div class="job-summary">
        <div class="job-main">
          <div class="job-title-row">
            <span class="job-method-badge method-${job.method}">${job.method}</span>
            <span class="status ${job.status}">${statusLabel(job.status)}</span>
          </div>
          <div class="job-filename" title="${outputName}">${outputName}</div>
          <div class="job-url">${job.url}</div>
          <div class="job-path">→ ${displayRel}</div>
          ${progressBarHtml(job)}
        </div>
        <div class="job-actions">
          ${job.status === 'running' ? `<button type="button" class="btn-ghost cancel-btn" data-id="${job.id}">Cancelar</button>` : ''}
          ${deleteBtn}
        </div>
      </div>
      <div class="job-log-wrap">
        <div class="job-log-head"><span class="job-log-dot"></span> saída do comando</div>
        <div class="job-log-scroll">
          <pre class="job-log">${escapeHtml(jobLogText(job)) || 'Aguardando log…'}</pre>
        </div>
      </div>
    `;
    div.querySelector('.job-summary').addEventListener('click', (e) => {
      if (e.target.closest('.cancel-btn, .delete-btn, .job-remove-btn')) return;
      div.classList.toggle('open');
    });
    div.querySelector('.cancel-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelJob(job.id);
    });
    div.querySelector('.delete-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteJobFile(job.id, jobOutputName(job), job.targetPath);
    });
    div.querySelector('.job-remove-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeJobHistoryEntry(job.id, jobOutputName(job));
    });
    if (job.status === 'running' || openIds.has(job.id)) div.classList.add('open');
    container.appendChild(div);
  }

  for (const job of jobs) {
    if (job.status !== 'running') continue;
    const el = container.querySelector(`.job[data-job-id="${job.id}"] .job-log-scroll`);
    if (el) el.scrollTop = el.scrollHeight;
  }

  if (refreshBrowse) {
    await loadBrowse(currentPath, { silent: true });
    try {
      config = await api('/api/config');
      renderDisk(config.disk);
    } catch { /* ignore */ }
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadJobs, 1500);
}

function showError(msg) {
  const el = document.getElementById('app-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function init() {
  try {
    config = await api('/api/config');
    renderDisk(config.disk);
    await loadSidebar();
    renderSidebar();
    renderMethods();
    const savedPath = loadSavedBrowsePath();
    const restored = await loadBrowse(savedPath, { silent: true });
    if (!restored) await loadBrowse('.');
    await loadJobs();
    startPolling();
  } catch (err) {
    showError(`Erro ao carregar: ${err.message}. Verifique se o volume /:/host está montado no container.`);
    toast(err.message, 'error');
  }
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' });
  location.replace('/login');
});

document.getElementById('refresh-btn').addEventListener('click', async () => {
  await loadBrowse(currentPath);
  config = await api('/api/config');
  renderDisk(config.disk);
  toast('Atualizado', 'success');
});

document.getElementById('jobs-refresh').addEventListener('click', loadJobs);
document.getElementById('jobs-clear-history').addEventListener('click', clearJobsHistory);

document.getElementById('up-btn').addEventListener('click', async () => {
  const data = await api(`/api/browse?path=${encodeURIComponent(currentPath)}`);
  if (data.parent != null) await loadBrowse(data.parent);
  else if (data.path !== '.') await loadBrowse('.');
});

document.getElementById('filter-input').addEventListener('input', () => {
  renderFolderList({ path: currentPath, entries: browseEntries });
});

document.getElementById('mkdir-btn').addEventListener('click', async () => {
  const name = document.getElementById('mkdir-name').value.trim();
  if (!name) return;
  try {
    await api('/api/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: currentPath, name }),
    });
    document.getElementById('mkdir-name').value = '';
    toast(`Pasta "${name}" criada`, 'success');
    await loadBrowse(currentPath);
  } catch (e) {
    toast(e.message, 'error');
  }
});

document.getElementById('pin-shortcut-btn')?.addEventListener('click', addCurrentFolderShortcut);

document.getElementById('copy-path-btn').addEventListener('click', async () => {
  const p = currentDisplayPath;
  try {
    await navigator.clipboard.writeText(p);
    toast('Caminho copiado', 'success');
  } catch {
    toast(p, 'info');
  }
});

document.getElementById('paste-url-btn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) document.getElementById('url').value = text.trim();
  } catch {
    toast('Não foi possível colar', 'error');
  }
});

async function startDownloadToFolder(url, filename, targetPath) {
  await api('/api/download', {
    method: 'POST',
    body: JSON.stringify({
      url: url.trim(),
      method: selectedMethod,
      path: targetPath ?? currentPath,
      filename: filename?.trim() || null,
    }),
  });
  toast('Download iniciado na pasta aberta', 'success');
  await loadJobs();
}

window.downloaderHooks = {
  getDisplayPath: () => currentDisplayPath,
  getCurrentPath: () => currentPath,
  getSelectedMethod: () => selectedMethod,
  loadBrowse: (path) => loadBrowse(path),
  startDownload: (url, filename, targetPath) => startDownloadToFolder(url, filename, targetPath),
  toast,
  browseFolder: (path) => api(`/api/browse?path=${encodeURIComponent(path || '.')}`),
  getSidebar: () => api('/api/sidebar'),
  api,
  confirmWithPassword,
};

document.getElementById('download-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('form-error');
  err.classList.add('hidden');
  const btn = document.getElementById('start-btn');
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    await startDownloadToFolder(
      document.getElementById('url').value,
      document.getElementById('filename').value.trim() || null,
      currentPath
    );
    document.getElementById('url').value = '';
    document.getElementById('filename').value = '';
  } catch (error) {
    err.textContent = error.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
});

init().catch((err) => {
  showError(err.message || 'Falha ao iniciar o app.');
});
