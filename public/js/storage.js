(function initStorageAnalyzer() {
  const overlay = document.getElementById('storage-overlay');
  if (!overlay) return;

  const els = {
    path: document.getElementById('storage-path'),
    pathToggle: document.getElementById('storage-path-toggle'),
    pathDropdown: document.getElementById('storage-path-dropdown'),
    pickerUp: document.getElementById('storage-picker-up'),
    pickerCrumb: document.getElementById('storage-picker-crumb'),
    pickerList: document.getElementById('storage-picker-list'),
    pickerCurrent: document.getElementById('storage-picker-current'),
    pickerSelect: document.getElementById('storage-picker-select'),
    status: document.getElementById('storage-status'),
    filter: document.getElementById('storage-filter'),
    minSize: document.getElementById('storage-min-size'),
    typeFilter: document.getElementById('storage-type-filter'),
    sortReset: document.getElementById('storage-sort-reset'),
    tbody: document.getElementById('storage-tbody'),
    treemap: document.getElementById('storage-treemap'),
    summary: document.getElementById('storage-summary'),
    loading: document.getElementById('storage-loading'),
  };

  const DEFAULT_SORT = { col: 'size', dir: 'desc' };
  let tableSort = null;

  let scanRoot = '.';
  let diskInfo = null;
  let folderMeta = null;
  let nodeMap = new Map();
  let expanded = new Set();
  let loadedDirs = new Set();
  let scanAbort = 0;
  let pickerOpen = false;
  let pickerPath = '.';
  let pickerLoading = false;

  function normalizePathInput(value) {
    const trimmed = (value || '').trim();
    return trimmed === '' || trimmed === '/' ? '.' : trimmed.replace(/^\/+/, '');
  }

  function setPathInput(path) {
    if (!els.path) return;
    els.path.value = path === '.' ? '.' : path;
  }

  async function fetchBrowse(path) {
    const browse = window.downloaderHooks?.browseFolder;
    if (browse) return browse(path || '.');
    const res = await fetch(`/api/browse?path=${encodeURIComponent(path || '.')}`, {
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      location.replace('/login');
      throw new Error('Não autenticado');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao listar pasta');
    return data;
  }

  function renderPickerCrumb(data) {
    if (!els.pickerCrumb) return;
    const parts = data.path === '.' ? [] : data.path.split('/');
    const crumbs = [{ label: data.root || '/', path: '.' }];
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      crumbs.push({ label: part, path: acc });
    }

    els.pickerCrumb.innerHTML = crumbs
      .map((c, i) => {
        const sep = i > 0 ? '<span class="sep">/</span>' : '';
        return `${sep}<button type="button" data-path="${escapeHtml(c.path)}">${escapeHtml(c.label)}</button>`;
      })
      .join('');

    els.pickerCrumb.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadPicker(btn.dataset.path);
      });
    });
  }

  function renderPickerList(data) {
    if (!els.pickerList) return;
    const dirs = (data.entries || []).filter((e) => e.type === 'directory');
    if (!dirs.length) {
      els.pickerList.innerHTML =
        '<div class="storage-picker-empty">Nenhuma subpasta neste nível</div>';
      return;
    }

    els.pickerList.innerHTML = dirs
      .map((entry) => {
        const next = data.path === '.' ? entry.name : `${data.path}/${entry.name}`;
        return `<button type="button" class="storage-picker-item" data-path="${escapeHtml(next)}">
          <span class="icon">📁</span>
          <span class="name">${escapeHtml(entry.name)}</span>
        </button>`;
      })
      .join('');

    els.pickerList.querySelectorAll('.storage-picker-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadPicker(btn.dataset.path);
      });
    });
  }

  function renderPicker(data) {
    pickerPath = data.path;
    setPathInput(pickerPath);
    if (els.pickerUp) els.pickerUp.disabled = data.path === '.';
    if (els.pickerCurrent) {
      els.pickerCurrent.textContent = data.displayPath || data.path;
      els.pickerCurrent.title = data.displayPath || data.path;
    }
    renderPickerCrumb(data);
    renderPickerList(data);
  }

  async function loadPicker(path) {
    if (!els.pickerList || pickerLoading) return;
    pickerLoading = true;
    els.pickerList.innerHTML = '<div class="storage-picker-loading">Carregando pastas…</div>';
    try {
      const data = await fetchBrowse(normalizePathInput(path));
      renderPicker(data);
    } catch (err) {
      els.pickerList.innerHTML = `<div class="storage-picker-empty error">${escapeHtml(err.message)}</div>`;
    } finally {
      pickerLoading = false;
    }
  }

  function openPicker() {
    if (!els.pathDropdown) return;
    pickerOpen = true;
    els.pathDropdown.classList.remove('hidden');
    els.pathToggle?.classList.add('is-open');
    els.pathToggle?.setAttribute('aria-expanded', 'true');
    loadPicker(normalizePathInput(els.path?.value || scanRoot || '.'));
  }

  function closePicker() {
    if (!els.pathDropdown) return;
    pickerOpen = false;
    els.pathDropdown.classList.add('hidden');
    els.pathToggle?.classList.remove('is-open');
    els.pathToggle?.setAttribute('aria-expanded', 'false');
  }

  function togglePicker() {
    if (pickerOpen) closePicker();
    else openPicker();
  }

  function selectPickerPath() {
    setPathInput(pickerPath);
    closePicker();
  }

  function formatBytes(n) {
    if (n == null || n < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(i === 0 ? 0 : i < 3 ? 1 : 2)} ${units[i]}`;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '—';
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function pctBar(pct, tone) {
    const w = Math.max(0, Math.min(100, pct));
    return `<span class="storage-bar" title="${w.toFixed(2)}% do disco"><span class="storage-bar-fill ${tone || ''}" style="width:${w}%"></span></span>`;
  }

  function barTone(pct) {
    if (pct >= 15) return 'tone-hot';
    if (pct >= 8) return 'tone-warm';
    if (pct >= 2) return 'tone-mid';
    return 'tone-cool';
  }

  function getBrowsePath() {
    return window.downloaderHooks?.getCurrentPath?.() || '.';
  }

  function goBrowse(path) {
    window.downloaderHooks?.loadBrowse?.(path);
  }

  function parentPath(p) {
    if (!p || p === '.') return '.';
    const parts = p.split('/');
    parts.pop();
    return parts.length ? parts.join('/') : '.';
  }

  function displayDepth(entryPath) {
    if (scanRoot === '.') return Math.max(0, entryPath.split('/').length - 1);
    if (entryPath === scanRoot) return 0;
    if (entryPath.startsWith(`${scanRoot}/`)) {
      return entryPath.slice(scanRoot.length + 1).split('/').length;
    }
    return Math.max(0, entryPath.split('/').length - 1);
  }

  function directChildren(parent) {
    return [...nodeMap.values()].filter((row) => parentPath(row.path) === parent);
  }

  function activeSort() {
    return tableSort || DEFAULT_SORT;
  }

  function compareFileCount(a, b) {
    const va = a < 0 ? Number.NEGATIVE_INFINITY : a;
    const vb = b < 0 ? Number.NEGATIVE_INFINITY : b;
    return va - vb;
  }

  function compareRows(a, b) {
    const { col, dir } = activeSort();
    const mul = dir === 'asc' ? 1 : -1;
    let cmp = 0;

    switch (col) {
      case 'name':
        cmp = a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
        break;
      case 'pct':
        cmp = (a.pctOfDisk ?? 0) - (b.pctOfDisk ?? 0);
        break;
      case 'files':
        cmp = compareFileCount(a.fileCount, b.fileCount);
        break;
      case 'date':
        cmp = String(a.mtime || '').localeCompare(String(b.mtime || ''));
        break;
      case 'size':
      default:
        cmp = a.size - b.size;
        break;
    }

    if (cmp === 0) {
      cmp = a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
    }
    return cmp * mul;
  }

  function onSortClick(col) {
    if (!tableSort || tableSort.col !== col) {
      tableSort = { col, dir: 'asc' };
    } else if (tableSort.dir === 'asc') {
      tableSort = { col, dir: 'desc' };
    } else {
      tableSort = { col, dir: 'asc' };
    }
    renderAll();
  }

  function resetSort() {
    tableSort = null;
    renderAll();
  }

  function updateSortHeaders() {
    document.querySelectorAll('.storage-sort-btn').forEach((btn) => {
      const col = btn.dataset.sort;
      const icon = btn.querySelector('.storage-sort-icon');
      const isActive = tableSort?.col === col;

      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-sort', isActive ? (tableSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

      if (icon) {
        icon.textContent = isActive ? (tableSort.dir === 'asc' ? '▴' : '▾') : '';
      }
    });

    if (els.sortReset) {
      els.sortReset.classList.toggle('is-active', tableSort !== null);
      els.sortReset.disabled = tableSort === null;
    }
  }

  function sortSiblings(rows) {
    return [...rows].sort(compareRows);
  }

  function hasLoadedChildren(dirPath) {
    return [...nodeMap.values()].some((row) => parentPath(row.path) === dirPath);
  }

  function buildTreeRows() {
    const out = [];
    const rootParent = scanRoot === '.' ? '.' : scanRoot;

    function walk(parent) {
      const children = sortSiblings(directChildren(parent).filter(passesFilters));
      for (const row of children) {
        out.push(row);
        if (row.type === 'directory' && expanded.has(row.path) && hasLoadedChildren(row.path)) {
          walk(row.path);
        }
      }
    }

    walk(rootParent);
    return out;
  }

  function visibleRows() {
    return buildTreeRows();
  }

  function passesFilters(row) {
    const q = (els.filter?.value || '').trim().toLowerCase();
    if (q && !row.name.toLowerCase().includes(q) && !row.path.toLowerCase().includes(q)) {
      return false;
    }
    const minGb = parseFloat(els.minSize?.value || '0');
    if (minGb > 0 && row.size < minGb * 1024 ** 3) return false;
    const type = els.typeFilter?.value || 'all';
    if (type === 'dirs' && row.type !== 'directory') return false;
    if (type === 'files' && row.type !== 'file') return false;
    return true;
  }

  function mergeLevel(data) {
    diskInfo = data.disk || diskInfo;
    if (data.path === scanRoot || (scanRoot === '.' && data.path === '.')) {
      folderMeta = {
        path: data.path,
        displayPath: data.displayPath,
        folderSize: data.folderSize,
        childrenSum: data.childrenSum,
        entryCount: data.entryCount,
        scannedAt: data.scannedAt,
        durationMs: data.durationMs,
      };
    }

    for (const entry of data.entries || []) {
      nodeMap.set(entry.path, entry);
    }
    loadedDirs.add(data.path);
  }

  async function fetchLevel(path) {
    const q = new URLSearchParams({ path: path || '.' });
    const res = await fetch(`/api/storage/analyze?${q}`, { credentials: 'same-origin' });
    if (res.status === 401) {
      location.replace('/login');
      throw new Error('Não autenticado');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha na análise');
    return data;
  }

  async function ensureChildren(dirPath) {
    if (loadedDirs.has(dirPath)) return;
    if (els.loading) els.loading.classList.remove('hidden');
    try {
      const data = await fetchLevel(dirPath);
      mergeLevel(data);
    } finally {
      if (els.loading) els.loading.classList.add('hidden');
    }
  }

  async function toggleExpand(dirPath) {
    if (expanded.has(dirPath)) {
      expanded.delete(dirPath);
      renderAll();
      return;
    }
    try {
      await ensureChildren(dirPath);
      expanded.add(dirPath);
      renderAll();
    } catch (err) {
      if (typeof window.downloaderHooks?.toast === 'function') {
        window.downloaderHooks.toast(err.message, 'error');
      }
    }
  }

  function renderTable() {
    if (!els.tbody) return;
    const rows = visibleRows();
    if (!rows.length) {
      els.tbody.innerHTML =
        '<tr><td colspan="6" class="storage-empty">Nenhum item. Expanda pastas ou ajuste filtros.</td></tr>';
      return;
    }

    els.tbody.innerHTML = rows
      .map((row) => {
        const isDir = row.type === 'directory';
        const isOpen = expanded.has(row.path);
        const canExpand = isDir;
        const indent = displayDepth(row.path) * 18;
        const toggle = canExpand
          ? `<button type="button" class="storage-tree-toggle${isOpen ? ' is-open' : ''}" data-path="${escapeHtml(row.path)}" aria-expanded="${isOpen}" aria-label="${isOpen ? 'Recolher' : 'Expandir'}">${isOpen ? '▾' : '▸'}</button>`
          : '<span class="storage-tree-spacer"></span>';
        const partial = row.partial
          ? ' <span class="storage-partial" title="Estimativa">~</span>'
          : '';
        const pctDisk = row.pctOfDisk ?? 0;
        const files = row.fileCount < 0 ? '—' : String(row.fileCount.toLocaleString('pt-BR'));
        return `<tr class="storage-row ${isDir ? 'is-dir' : 'is-file'}" data-path="${escapeHtml(row.path)}" data-type="${row.type}">
          <td class="storage-col-name">
            <div class="storage-name-cell" style="padding-left:${indent}px">
              ${toggle}<span class="storage-icon">${isDir ? '📁' : '📄'}</span>
              <span class="storage-name" title="${escapeHtml(row.path)}">${escapeHtml(row.name)}${partial}</span>
            </div>
          </td>
          <td class="storage-col-bar">${pctBar(pctDisk, barTone(pctDisk))}</td>
          <td class="storage-col-pct mono" title="% do disco total">${pctDisk.toFixed(2)}%</td>
          <td class="storage-col-size mono">${formatBytes(row.size)}</td>
          <td class="storage-col-files mono">${files}</td>
          <td class="storage-col-date mono">${formatDate(row.mtime)}</td>
        </tr>`;
      })
      .join('');

    els.tbody.querySelectorAll('.storage-tree-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleExpand(btn.dataset.path);
      });
    });

    els.tbody.querySelectorAll('.storage-row').forEach((tr) => {
      tr.addEventListener('click', () => {
        if (tr.dataset.type === 'directory') toggleExpand(tr.dataset.path);
      });
      tr.addEventListener('dblclick', (e) => {
        e.preventDefault();
        goBrowse(tr.dataset.path);
        closeStorage();
      });
    });
  }

  function renderTreemap() {
    if (!els.treemap) return;
    const topLevel = directChildren(scanRoot === '.' ? '.' : scanRoot);
    const items = sortSiblings(topLevel.filter((e) => e.size > 0)).slice(0, 24);
    const total = items.reduce((s, e) => s + e.size, 0) || 1;

    els.treemap.innerHTML = items
      .map((item, i) => {
        const flexPct = (item.size / total) * 100;
        const hue = 220 - (i / Math.max(items.length - 1, 1)) * 200;
        return `<button type="button" class="storage-tile" style="flex:${item.size} 1 ${Math.max(flexPct, 5)}%;background:hsl(${hue} 55% 38%)" data-path="${escapeHtml(item.path)}" title="${escapeHtml(item.path)} — ${formatBytes(item.size)} (${(item.pctOfDisk || 0).toFixed(1)}% disco)">
          <span class="storage-tile-name">${escapeHtml(item.name)}</span>
          <span class="storage-tile-size">${formatBytes(item.size)} · ${(item.pctOfDisk || 0).toFixed(1)}%</span>
        </button>`;
      })
      .join('');

    els.treemap.querySelectorAll('.storage-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        goBrowse(tile.dataset.path);
        closeStorage();
      });
    });
  }

  function renderSummary() {
    if (!els.summary) return;
    const parts = [`<strong>${escapeHtml(folderMeta?.displayPath || '/')}</strong>`];
    if (diskInfo?.total) {
      const usedPct = Math.round((diskInfo.used / diskInfo.total) * 100);
      parts.push(`Disco ${formatBytes(diskInfo.total)} · Usado ${usedPct}%`);
    }
    if (folderMeta?.folderSize) {
      parts.push(`Pasta ${formatBytes(folderMeta.folderSize)}`);
    }
    if (folderMeta?.entryCount != null) {
      parts.push(`${folderMeta.entryCount} itens neste nível`);
    }
    els.summary.innerHTML = parts.join(' · ');
  }

  function renderStatus() {
    if (!els.status) return;
    const dur = folderMeta?.durationMs ? `${(folderMeta.durationMs / 1000).toFixed(1)}s` : '—';
    els.status.textContent = folderMeta?.scannedAt
      ? `Atualizado ${formatDate(folderMeta.scannedAt)} (${dur}) · expanda pastas para detalhar`
      : '';
  }

  function renderAll() {
    renderSummary();
    renderStatus();
    updateSortHeaders();
    renderTable();
    renderTreemap();
  }

  async function runScan() {
    const token = ++scanAbort;
    scanRoot = els.path?.value?.trim() || scanRoot || '.';
    nodeMap = new Map();
    expanded = new Set();
    loadedDirs = new Set();
    folderMeta = null;
    tableSort = null;

    if (els.loading) els.loading.classList.remove('hidden');
    if (els.status) els.status.textContent = 'Analisando…';

    try {
      const data = await fetchLevel(scanRoot);
      if (token !== scanAbort) return;
      mergeLevel(data);
      if (els.path) els.path.value = scanRoot;
      renderAll();
    } catch (err) {
      if (token !== scanAbort) return;
      if (els.status) els.status.textContent = err.message;
      if (els.tbody) {
        els.tbody.innerHTML = `<tr><td colspan="6" class="storage-empty error">${escapeHtml(err.message)}</td></tr>`;
      }
    } finally {
      if (token === scanAbort && els.loading) els.loading.classList.add('hidden');
    }
  }

  function openStorage(startPath) {
    scanRoot = startPath || getBrowsePath() || '.';
    if (els.path) els.path.value = scanRoot;
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('storage-open');
    runScan();
  }

  function closeStorage() {
    scanAbort += 1;
    closePicker();
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('storage-open');
  }

  document.getElementById('open-storage-btn')?.addEventListener('click', () => openStorage());
  document.getElementById('storage-close')?.addEventListener('click', closeStorage);
  overlay.querySelector('.storage-backdrop')?.addEventListener('click', closeStorage);
  document.getElementById('storage-rescan')?.addEventListener('click', runScan);
  document.getElementById('storage-use-current')?.addEventListener('click', () => {
    scanRoot = getBrowsePath() || '.';
    if (els.path) els.path.value = scanRoot;
    runScan();
  });
  document.getElementById('storage-go-path')?.addEventListener('click', runScan);

  els.pathToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePicker();
  });
  els.pickerUp?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pickerPath && pickerPath !== '.') loadPicker(parentPath(pickerPath));
  });
  els.pickerSelect?.addEventListener('click', (e) => {
    e.stopPropagation();
    selectPickerPath();
  });

  document.addEventListener('click', (e) => {
    if (!pickerOpen) return;
    if (e.target.closest('.storage-path-picker')) return;
    closePicker();
  });

  document.querySelectorAll('.storage-sort-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSortClick(btn.dataset.sort);
    });
  });
  els.sortReset?.addEventListener('click', resetSort);

  for (const el of [els.filter, els.minSize, els.typeFilter]) {
    el?.addEventListener('input', renderAll);
    el?.addEventListener('change', renderAll);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
      if (pickerOpen) {
        e.preventDefault();
        closePicker();
        return;
      }
      closeStorage();
    }
  });

  window.downloaderStorage = { open: openStorage, close: closeStorage };
  updateSortHeaders();
})();
