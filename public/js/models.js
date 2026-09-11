(function initAiModelsManager() {
  /** Seção "GGUF no disco" na aba Ollama — desativada até reativar manualmente. */
  const SHOW_GGUF_ORPHANS_IN_OLLAMA = false;

  const overlay = document.getElementById('models-overlay');
  if (!overlay) return;

  const hooks = () => window.downloaderHooks || {};
  const api = (path, options) => hooks().api?.(path, options);
  const toast = (msg, type) => hooks().toast?.(msg, type);
  const confirmWithPassword = (opts) => hooks().confirmWithPassword?.(opts);

  const els = {
    summary: document.getElementById('models-summary'),
    statusBar: document.getElementById('models-ollama-status'),
    importJobs: document.getElementById('models-import-jobs'),
    ggufOrphansWrap: document.getElementById('models-gguf-orphans-wrap'),
    ggufOrphans: document.getElementById('models-gguf-orphans'),
    ggufOrphansCount: document.getElementById('models-gguf-orphans-count'),
    running: document.getElementById('models-running'),
    runningCount: document.getElementById('models-running-count'),
    installed: document.getElementById('models-installed'),
    installedCount: document.getElementById('models-installed-count'),
    gguf: document.getElementById('models-gguf'),
    ggufRunning: document.getElementById('models-gguf-running'),
    ggufRunningCount: document.getElementById('models-gguf-running-count'),
    ggufFilesCount: document.getElementById('models-gguf-files-count'),
    pullForm: document.getElementById('models-pull-form'),
    pullName: document.getElementById('models-pull-name'),
    pullSaveGguf: document.getElementById('models-pull-save-gguf'),
    pullJobs: document.getElementById('models-pull-jobs'),
    popularChips: document.getElementById('models-popular-chips'),
    loading: document.getElementById('models-loading'),
    footerStatus: document.getElementById('models-footer-status'),
    footerHint: document.getElementById('models-footer-hint'),
    webuiLink: document.getElementById('models-open-webui'),
    llamacppLink: document.getElementById('models-open-llamacpp'),
    ggufStatus: document.getElementById('models-gguf-status'),
    loadLog: document.getElementById('models-load-log'),
    loadLogTitle: document.getElementById('models-load-log-title'),
    loadLogStatus: document.getElementById('models-load-log-status'),
    loadLogPct: document.getElementById('models-load-log-pct'),
    loadProgressFill: document.getElementById('models-load-progress-fill'),
    loadLogText: document.getElementById('models-load-log-text'),
    mainView: document.getElementById('models-main-view'),
    folderView: document.getElementById('models-folder-view'),
    folderCrumb: document.getElementById('models-folder-crumb'),
    folderList: document.getElementById('models-folder-list'),
    folderLoading: document.getElementById('models-folder-loading'),
    folderUp: document.getElementById('models-folder-up'),
    tabs: overlay.querySelector('.models-tabs'),
    detailOverlay: document.getElementById('model-detail-overlay'),
    detailTitle: document.getElementById('model-detail-title'),
    detailSubtitle: document.getElementById('model-detail-subtitle'),
    detailLoading: document.getElementById('model-detail-loading'),
    detailBody: document.getElementById('model-detail-body'),
    loadOverlay: document.getElementById('model-load-overlay'),
    loadTitle: document.getElementById('model-load-title'),
    loadSubtitle: document.getElementById('model-load-subtitle'),
    loadLoading: document.getElementById('model-load-loading'),
    loadForm: document.getElementById('model-load-form'),
    loadKeepAlive: document.getElementById('model-load-keep-alive'),
    loadKeepAliveWrap: document.getElementById('model-load-keep-alive-wrap'),
    loadPresetChips: document.getElementById('model-load-preset-chips'),
    loadUserChips: document.getElementById('model-load-user-chips'),
    loadPresetName: document.getElementById('model-load-preset-name'),
    loadSavePresetBtn: document.getElementById('model-load-save-preset-btn'),
    loadContextHint: document.getElementById('model-load-context-hint'),
    loadAliasWrap: document.getElementById('model-load-alias-wrap'),
    loadAlias: document.getElementById('model-load-alias'),
    loadGroups: document.getElementById('model-load-groups'),
    loadSavePreset: document.getElementById('model-load-save-preset'),
  };

  const LOAD_PRESET_KEY = 'downloader.ollamaLoadConfig';
  const USER_PRESETS_KEY = 'downloader.ollamaUserPresets';
  let loadConfigBackend = 'ollama';
  let loadConfigGgufPath = null;
  let loadConfigModel = null;
  let loadConfigData = null;
  let loadConfigSaved = null;
  let loadActivePresetId = null;

  let activeTab = 'ollama';
  let pollTimer = null;
  let overview = null;
  let busyModels = new Set();
  let folderPath = null;
  let loadPollTimer = null;
  let hideJobLogTimer = null;
  let activeJobId = null;
  let activeJobKind = null;

  function hasRunningJob(data) {
    if (!data) return false;
    return (
      (data.loadJobs || []).some((j) => j.status === 'running') ||
      (data.unloadJobs || []).some((j) => j.status === 'running') ||
      (data.llamawebLoadJobs || []).some((j) => j.status === 'running')
    );
  }

  function llamawebStatusPill(status) {
    if (status === 'loaded') return '<span class="models-pill running">llama.cpp · VRAM</span>';
    if (status === 'sleeping') return '<span class="models-pill">llama.cpp · dormindo</span>';
    if (status === 'loading') return '<span class="models-pill warn">llama.cpp · carregando</span>';
    return '';
  }

  function scheduleHideJobLog(delayMs = 2000) {
    if (hideJobLogTimer) clearTimeout(hideJobLogTimer);
    hideJobLogTimer = setTimeout(() => {
      hideJobLogTimer = null;
      if (!loadPollTimer) hideJobLog();
    }, delayMs);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
  }

  function setTab(tab) {
    activeTab = tab;
    overlay.querySelectorAll('.models-tab').forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    overlay.querySelectorAll('.models-tab-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== `models-tab-${tab}`);
    });
    overlay.querySelector('.models-panel')?.classList.toggle('is-terminal-tab', tab === 'terminal');

    if (tab === 'terminal') {
      if (els.footerHint) els.footerHint.textContent = 'nvtop · q para sair · ↻ reinicia · Esc fecha o painel';
      window.gpuTerminal?.connect?.();
      requestAnimationFrame(() => {
        window.gpuTerminal?.resize?.();
        setTimeout(() => window.gpuTerminal?.resize?.(), 120);
      });
    } else if (els.footerHint && !isFolderViewOpen()) {
      els.footerHint.textContent = 'Carregar = manter na VRAM · Esc para fechar';
    }
  }

  function isFolderViewOpen() {
    return !els.folderView?.classList.contains('hidden');
  }

  function showMainView() {
    els.folderView?.classList.add('hidden');
    els.mainView?.classList.remove('hidden');
    els.tabs?.classList.remove('hidden');
    if (els.footerHint) els.footerHint.textContent = 'Carregar = manter na VRAM · Esc para fechar';
    folderPath = null;
  }

  function showFolderView() {
    els.mainView?.classList.add('hidden');
    els.folderView?.classList.remove('hidden');
    els.tabs?.classList.add('hidden');
    if (els.footerHint) els.footerHint.textContent = 'Esc = voltar · clique em pastas para navegar';
  }

  async function openFolderInOverlay(path) {
    folderPath = path || '.';
    showFolderView();
    await loadFolderBrowse(folderPath);
  }

  async function loadFolderBrowse(path) {
    if (els.folderLoading) els.folderLoading.classList.remove('hidden');
    if (els.folderList) els.folderList.innerHTML = '';
    try {
      const data = await api(`/api/browse?path=${encodeURIComponent(path || '.')}`);
      folderPath = data.path || path || '.';
      renderFolderBrowse(data);
    } catch (err) {
      toast?.(err.message, 'error');
      showMainView();
    } finally {
      if (els.folderLoading) els.folderLoading.classList.add('hidden');
    }
  }

  function renderFolderBrowse(data) {
    if (els.folderUp) els.folderUp.disabled = !data.parent && data.path === '.';

    if (els.folderCrumb) {
      const parts = data.path === '.' ? [] : data.path.split('/');
      const crumbs = [{ label: data.root || '/', path: '.' }];
      let acc = '';
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        crumbs.push({ label: part, path: acc });
      }
      els.folderCrumb.innerHTML = crumbs
        .map((c, i) => {
          const sep = i > 0 ? '<span class="sep">/</span>' : '';
          return `${sep}<button type="button" class="models-folder-crumb-btn" data-path="${escapeHtml(c.path)}">${escapeHtml(c.label)}</button>`;
        })
        .join('');
    }

    if (!els.folderList) return;
    const entries = data.entries || [];
    if (!entries.length) {
      els.folderList.innerHTML = '<div class="models-empty">Pasta vazia</div>';
      return;
    }

    els.folderList.innerHTML = entries
      .map((entry) => {
        const isDir = entry.type === 'directory';
        const icon = isDir ? '📁' : entry.name.toLowerCase().endsWith('.gguf') ? '📦' : '📄';
        const nextPath = data.path === '.' ? entry.name : `${data.path}/${entry.name}`;
        const size = isDir ? '' : `<span class="models-folder-size muted">${formatBytes(entry.size)}</span>`;
        const ggufClass = !isDir && entry.name.toLowerCase().endsWith('.gguf') ? ' is-gguf' : '';
        if (isDir) {
          return `
          <button type="button" class="models-folder-item is-dir"
            data-path="${escapeHtml(nextPath)}">
            <span class="models-folder-icon" aria-hidden="true">${icon}</span>
            <span class="models-folder-name mono">${escapeHtml(entry.name)}</span>
          </button>`;
        }
        return `
          <div class="models-folder-item is-file${ggufClass}">
            <span class="models-folder-icon" aria-hidden="true">${icon}</span>
            <span class="models-folder-name mono">${escapeHtml(entry.name)}</span>
            ${size}
          </div>`;
      })
      .join('');
  }

  function openOverlay() {
    try {
      overlay.classList.remove('hidden');
      overlay.setAttribute('aria-hidden', 'false');
      document.body.classList.add('models-open');
      showMainView();
      setTab('ollama');
      refresh({ showLoading: true });
      startPolling();
    } catch (err) {
      console.error('[models]', err);
      toast?.('Erro ao abrir modelos de IA', 'error');
    }
  }

  function closeOverlay() {
    showMainView();
    hideJobLog();
    window.gpuTerminal?.disconnect?.();
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('models-open');
    stopPolling();
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (!isFolderViewOpen()) refresh({ silent: true });
    }, 2500);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function refresh({ showLoading = false, silent = false } = {}) {
    if (isFolderViewOpen()) return;
    if (!hooks().api) {
      if (!silent) toast?.('App ainda carregando — tente de novo', 'error');
      return;
    }
    if (showLoading && els.loading) els.loading.classList.remove('hidden');
    try {
      const data = await api('/api/ai/overview');
      if (!data) throw new Error('Resposta vazia do servidor');
      overview = data;
      render(data);
      if (els.footerStatus) {
        const ollama = data.connection || {};
        const llama = data.llamawebConnection || {};
        const parts = [];
        parts.push(ollama.ok ? 'Ollama online' : 'Ollama offline');
        parts.push(llama.ok ? 'LlamaCpp online' : 'LlamaCpp offline');
        els.footerStatus.textContent = parts.join(' · ');
      }
    } catch (err) {
      if (!silent) toast?.(err.message, 'error');
    } finally {
      if (els.loading) els.loading.classList.add('hidden');
    }
  }

  function connIndicator(label, ok, detail) {
    const cls = ok ? 'models-conn-ok' : 'models-conn-err';
    const title = detail ? ` title="${escapeHtml(detail)}"` : '';
    return `<span class="models-conn-dot ${cls}"${title}>● ${escapeHtml(label)}</span>`;
  }

  function renderConnectionSummary(data) {
    if (!els.summary) return;
    const ollama = data.connection || {};
    const llama = data.llamawebConnection || {};
    const ollamaDetail = ollama.ok
      ? ollama.host || 'Ollama disponível'
      : ollama.error || ollama.host || 'Sem conexão — configure OLLAMA_HOST';
    const llamaDetail = llama.ok
      ? llama.url || data.llamawebPublicUrl || 'llama.cpp disponível'
      : llama.error || llama.url || 'Sem conexão — configure LLAMAWEB_URL';

    const primary = ollama.ok
      ? `<span class="models-conn-ok">● Conectado</span> · <span class="models-summary-host mono">${escapeHtml(ollama.host || '')}</span>`
      : `<span class="models-conn-err">● Offline</span> · ${escapeHtml(ollama.error || 'sem conexão')}`;

    const services = [
      connIndicator('Ollama', ollama.ok, ollamaDetail),
      connIndicator('LlamaCpp', llama.ok, llamaDetail),
    ].join('<span class="models-summary-sep muted">·</span>');

    els.summary.innerHTML = `
      <span class="models-summary-primary">${primary}</span>
      <span class="models-summary-services">${services}</span>`;
  }

  function render(data) {
    renderConnectionSummary(data);
    const conn = data.connection || {};

    if (els.statusBar) {
      if (!conn.ok) {
        els.statusBar.innerHTML = '';
      } else if (data.ollamaModels?.length === 0) {
        const hidden = data.hiddenOllamaCount || 0;
        const hiddenHint = hidden
          ? ` Há ${hidden} registro(s) no Ollama sem arquivo local — remova com <code>ollama rm nome</code> no terminal.`
          : '';
        els.statusBar.innerHTML = `<div class="models-alert models-alert-info">Nenhum modelo com arquivo local encontrado.${hiddenHint} Use a aba <strong>Baixar modelo</strong>.</div>`;
      } else {
        const hidden = data.hiddenOllamaCount || 0;
        if (hidden > 0) {
          els.statusBar.innerHTML = `<div class="models-alert models-alert-info">${hidden} modelo(s) oculto(s) — registrados no Ollama mas sem pasta/arquivo local. Remova com <code>ollama rm nome</code> no terminal.</div>`;
        } else {
          els.statusBar.innerHTML = '';
        }
      }
    }

    if (els.webuiLink) {
      if (data.openWebUiUrl) {
        els.webuiLink.href = data.openWebUiUrl;
        els.webuiLink.classList.remove('hidden');
      } else {
        els.webuiLink.classList.add('hidden');
      }
    }

    if (els.llamacppLink) {
      if (data.llamawebPublicUrl && data.llamawebConnection?.ok) {
        els.llamacppLink.href = data.llamawebPublicUrl;
        els.llamacppLink.classList.remove('hidden');
      } else {
        els.llamacppLink.classList.add('hidden');
      }
    }

    renderGgufStatus(data);

    renderImportJobs(data.importJobs || []);
    renderGgufOrphans(data);
    renderRunning(data.running || []);
    renderInstalled(data.ollamaModels || []);
    renderGgufRunning(data);
    renderGguf(data);
    renderPullJobs(data.pullJobs || []);
    renderPopular(data.popularModels || []);
    renderLoadJobs(data);

    const activeLoad = (data.loadJobs || []).find((j) => j.status === 'running');
    const activeUnload = (data.unloadJobs || []).find((j) => j.status === 'running');
    const activeLlamaWeb = (data.llamawebLoadJobs || []).find((j) => j.status === 'running');
    if (activeLoad) {
      if (hideJobLogTimer) {
        clearTimeout(hideJobLogTimer);
        hideJobLogTimer = null;
      }
      updateJobLog(activeLoad, 'load');
      if (activeJobId !== activeLoad.id || activeJobKind !== 'load') {
        activeJobId = activeLoad.id;
        activeJobKind = 'load';
        pollJob('load', activeLoad.id);
      }
    } else if (activeUnload) {
      if (hideJobLogTimer) {
        clearTimeout(hideJobLogTimer);
        hideJobLogTimer = null;
      }
      updateJobLog(activeUnload, 'unload');
      if (activeJobId !== activeUnload.id || activeJobKind !== 'unload') {
        activeJobId = activeUnload.id;
        activeJobKind = 'unload';
        pollJob('unload', activeUnload.id);
      }
    } else if (activeLlamaWeb) {
      if (hideJobLogTimer) {
        clearTimeout(hideJobLogTimer);
        hideJobLogTimer = null;
      }
      updateJobLog(activeLlamaWeb, 'llamaweb');
      if (activeJobId !== activeLlamaWeb.id || activeJobKind !== 'llamaweb') {
        activeJobId = activeLlamaWeb.id;
        activeJobKind = 'llamaweb';
        pollJob('llamaweb', activeLlamaWeb.id);
      }
    } else {
      const activeImport = (data.importJobs || []).find((j) => j.status === 'running');
      if (activeImport) {
        if (activeJobId !== activeImport.id || activeJobKind !== 'import') {
          activeJobId = activeImport.id;
          activeJobKind = 'import';
          pollImport(activeImport.id);
        }
      }
    }
  }

  function renderLoadJobs(data) {
    if (!els.loadLog) return;
    if (hasRunningJob(data)) return;
    if (hideJobLogTimer || loadPollTimer) return;
    hideJobLog();
  }

  function updateJobLog(job, kind) {
    if (!job || !els.loadLog) return;
    els.loadLog.classList.remove('hidden');
    const pct = job.progress ?? (job.status === 'completed' ? 100 : 0);
    const label = job.model || job.modelId || 'modelo';
    const isUnload =
      kind === 'unload' || (kind === 'llamaweb' && job.operation === 'unload');
    if (els.loadLogTitle) {
      els.loadLogTitle.textContent = isUnload ? `Descarregando ${label}` : `Carregando ${label}`;
    }
    if (els.loadLogPct) els.loadLogPct.textContent = `${pct}%`;
    if (els.loadProgressFill) els.loadProgressFill.style.width = `${pct}%`;
    if (els.loadLogStatus) {
      els.loadLogStatus.textContent = job.progressLabel || job.status || '';
      els.loadLogStatus.className = `muted models-load-status is-${job.status || 'running'}`;
    }
    if (els.loadLogText) {
      els.loadLogText.textContent = job.log || '';
      els.loadLogText.scrollTop = els.loadLogText.scrollHeight;
    }
    if (job.status === 'completed' || job.status === 'failed') {
      busyModels.delete(job.model);
      busyModels.delete(job.modelId);
    }
  }

  function hideJobLog() {
    els.loadLog?.classList.add('hidden');
    activeJobId = null;
    activeJobKind = null;
    if (loadPollTimer) {
      clearTimeout(loadPollTimer);
      loadPollTimer = null;
    }
    if (hideJobLogTimer) {
      clearTimeout(hideJobLogTimer);
      hideJobLogTimer = null;
    }
  }

  async function pollJob(kind, id) {
    if (loadPollTimer) clearTimeout(loadPollTimer);
    const endpoint =
      kind === 'llamaweb'
        ? `/api/ai/llamaweb/load/${encodeURIComponent(id)}`
        : kind === 'unload'
          ? `/api/ai/ollama/unload/${encodeURIComponent(id)}`
          : `/api/ai/ollama/load/${encodeURIComponent(id)}`;
    try {
      const data = await api(endpoint);
      const job = data.job;
      if (!job) return;
      updateJobLog(job, kind);
      if (job.status === 'running') {
        loadPollTimer = setTimeout(() => pollJob(kind, id), 350);
      } else {
        loadPollTimer = null;
        activeJobId = null;
        activeJobKind = null;
        updateJobLog(job, kind);
        const label = job.model || job.modelId || 'modelo';
        if (kind === 'load' && job.status === 'completed') {
          toast?.(`Modelo ${label} carregado — pronto para o Open WebUI`, 'success');
          scheduleHideJobLog(6000);
          setTimeout(() => setTab('terminal'), 400);
        } else if (kind === 'load' && job.status === 'failed') {
          toast?.(job.error || 'Falha ao carregar modelo', 'error');
          scheduleHideJobLog(5000);
        } else if (kind === 'unload' && job.status === 'completed') {
          toast?.(`Modelo ${label} descarregado da VRAM`, 'success');
          scheduleHideJobLog(1500);
        } else if (kind === 'unload' && job.status === 'failed') {
          toast?.(job.error || 'Falha ao descarregar', 'error');
          scheduleHideJobLog(4000);
        } else if (kind === 'llamaweb' && job.status === 'completed') {
          if (job.operation === 'unload') {
            toast?.(`Modelo ${label} descarregado da VRAM`, 'success');
            scheduleHideJobLog(1500);
          } else {
            toast?.(`Modelo ${label} carregado na VRAM`, 'success');
            scheduleHideJobLog(6000);
            setTimeout(() => setTab('terminal'), 400);
          }
        } else if (kind === 'llamaweb' && job.status === 'failed') {
          toast?.(job.error || 'Falha ao carregar modelo', 'error');
          scheduleHideJobLog(5000);
        }
        await refresh({ silent: true });
      }
    } catch (err) {
      if (!loadPollTimer) toast?.(err.message, 'error');
    }
  }

  function modelActions(modelName, { running = false, folderPath = null } = {}) {
    const busy = busyModels.has(modelName);
    const runBtn = running
      ? `<button type="button" class="btn-ghost btn-sm models-unload" data-model="${escapeHtml(modelName)}" ${busy ? 'disabled' : ''}>Descarregar</button>`
      : `<button type="button" class="btn-primary btn-sm models-run" data-model="${escapeHtml(modelName)}" ${busy ? 'disabled' : ''}>Carregar</button>`;
    const folderBtn = folderPath
      ? `<button type="button" class="btn-ghost btn-sm models-open-folder" data-path="${escapeHtml(folderPath)}" title="Abrir pasta do modelo">Abrir pasta</button>`
      : '';
    return `
      ${runBtn}
      ${folderBtn}
      <button type="button" class="btn-ghost btn-sm models-info" data-model="${escapeHtml(modelName)}">Detalhes</button>
      <button type="button" class="btn-ghost btn-sm models-delete" data-model="${escapeHtml(modelName)}">Excluir</button>
    `;
  }

  function storageMeta(m) {
    const kind = m.storageKind || '';
    if (kind === 'ollama-volume') {
      return ' · <span class="models-pill">volume Ollama</span>';
    }
    if (kind === 'ollama-local' && m.folderDisplayPath) {
      return ` · <span class="models-pill">Ollama</span> ${escapeHtml(m.folderDisplayPath)}`;
    }
    if (kind.startsWith('gguf') && m.folderDisplayPath) {
      return ` · <span class="models-pill">GGUF</span> ${escapeHtml(m.folderDisplayPath)}`;
    }
    if (m.folderDisplayPath) return ` · ${escapeHtml(m.folderDisplayPath)}`;
    return '';
  }

  function renderRunning(running) {
    if (els.runningCount) els.runningCount.textContent = String(running.length);
    if (!els.running) return;

    if (!running.length) {
      els.running.innerHTML = '<div class="models-empty">Nenhum modelo carregado na memória. Use <strong>Carregar</strong> para deixar pronto no Open WebUI.</div>';
      return;
    }

    els.running.innerHTML = running
      .map(
        (m) => `
      <article class="models-card is-running">
        <div class="models-card-main">
          <div class="models-card-icon" aria-hidden="true">⚡</div>
          <div class="models-card-body">
            <div class="models-card-title mono">${escapeHtml(m.name)}</div>
            <div class="models-card-meta muted">${escapeHtml(m.sizeLabel || '')}${m.details?.parameter_size ? ` · ${escapeHtml(m.details.parameter_size)}` : ''}${storageMeta(m)}</div>
          </div>
        </div>
        <div class="models-card-actions">${modelActions(m.name, { running: true, folderPath: m.folderPath })}</div>
      </article>`
      )
      .join('');
  }

  function renderInstalled(models) {
    if (els.installedCount) els.installedCount.textContent = String(models.length);
    if (!els.installed) return;

    if (!models.length) {
      els.installed.innerHTML = '<div class="models-empty">Nenhum modelo instalado.</div>';
      return;
    }

    els.installed.innerHTML = models
      .map(
        (m) => `
      <article class="models-card${m.running ? ' is-active' : ''}">
        <div class="models-card-main">
          <div class="models-card-icon" aria-hidden="true">🦙</div>
          <div class="models-card-body">
            <div class="models-card-title mono">${escapeHtml(m.name)}</div>
            <div class="models-card-meta muted">
              ${escapeHtml(m.sizeLabel || '')}
              ${m.details?.parameter_size ? ` · ${escapeHtml(m.details.parameter_size)}` : ''}
              ${m.details?.quantization_level ? ` · ${escapeHtml(m.details.quantization_level)}` : ''}
              ${m.running ? ' · <span class="models-pill running">rodando</span>' : ''}
              ${storageMeta(m)}
            </div>
          </div>
        </div>
        <div class="models-card-actions">${modelActions(m.name, { running: m.running, folderPath: m.folderPath })}</div>
      </article>`
      )
      .join('');
  }

  function ggufFileByModelId(data, modelId) {
    const groups = data.gguf || [];
    for (const group of groups) {
      for (const f of group.files || []) {
        if (f.llamawebModelId === modelId) return f;
      }
    }
    return null;
  }

  function ggufOllamaActions(file) {
    if (file.kind !== 'model') return '';
    if (!file.ollamaRegistered) {
      return `<button type="button" class="btn-secondary btn-sm models-gguf-import" data-path="${escapeHtml(file.path)}" data-model="${escapeHtml(file.suggestedOllamaName || '')}">Importar no Ollama</button>`;
    }
    const name = file.ollamaModelName;
    const busy = busyModels.has(name);
    if (file.ollamaRunning) {
      return `<button type="button" class="btn-ghost btn-sm models-unload" data-model="${escapeHtml(name)}" ${busy ? 'disabled' : ''}>Descarregar Ollama</button>`;
    }
    return `<button type="button" class="btn-secondary btn-sm models-run" data-model="${escapeHtml(name)}" ${busy ? 'disabled' : ''}>Carregar Ollama</button>`;
  }

  function ggufOllamaPill(file) {
    if (file.kind !== 'model') return '';
    if (file.ollamaRegistered) {
      return file.ollamaRunning
        ? ' · <span class="models-pill running">Ollama · VRAM</span>'
        : ' · <span class="models-pill">Ollama</span>';
    }
    return ' · <span class="models-pill warn">sem Ollama</span>';
  }

  function renderGgufOrphans(data) {
    if (!SHOW_GGUF_ORPHANS_IN_OLLAMA) {
      if (els.ggufOrphansWrap) els.ggufOrphansWrap.classList.add('hidden');
      if (els.ggufOrphans) els.ggufOrphans.innerHTML = '';
      return;
    }

    const orphans = (data.ggufOrphan || []).filter((f) => f.kind === 'model');
    if (els.ggufOrphansCount) els.ggufOrphansCount.textContent = String(orphans.length);
    if (els.ggufOrphansWrap) {
      els.ggufOrphansWrap.classList.toggle('hidden', !orphans.length);
    }
    if (!els.ggufOrphans) return;
    if (!orphans.length) {
      els.ggufOrphans.innerHTML = '';
      return;
    }
    els.ggufOrphans.innerHTML = orphans
      .map(
        (f) => `
      <article class="models-card">
        <div class="models-card-main">
          <div class="models-card-icon" aria-hidden="true">📦</div>
          <div class="models-card-body">
            <div class="models-card-title mono">${escapeHtml(f.name)}</div>
            <div class="models-card-meta muted">
              ${escapeHtml(f.sizeLabel)} · ${escapeHtml(f.displayPath)}
              · <span class="models-pill warn">importar</span>
            </div>
          </div>
        </div>
        <div class="models-card-actions">
          <button type="button" class="btn-primary btn-sm models-gguf-import" data-path="${escapeHtml(f.path)}" data-model="${escapeHtml(f.suggestedOllamaName || '')}">Importar no Ollama</button>
          <button type="button" class="btn-ghost btn-sm models-open-folder" data-path="${escapeHtml(f.folderPath || f.path)}">Abrir pasta</button>
        </div>
      </article>`
      )
      .join('');
  }

  function renderImportJobs(jobs) {
    if (!els.importJobs) return;
    const active = (jobs || []).filter((j) => j.status === 'running');
    if (!active.length) {
      els.importJobs.classList.add('hidden');
      els.importJobs.innerHTML = '';
      return;
    }
    els.importJobs.classList.remove('hidden');
    els.importJobs.innerHTML = active
      .map(
        (j) => `
      <article class="models-job">
        <div class="models-job-head">
          <span class="mono">${escapeHtml(j.model)}</span>
          <span class="models-pill warn">importando</span>
          <span class="muted">${escapeHtml(j.progressLabel || '')}</span>
        </div>
        <div class="models-job-meta muted">${escapeHtml(j.sourcePath || '')}</div>
      </article>`
      )
      .join('');
  }

  function ggufActions(file) {
    const modelId = file.llamawebModelId || '';
    const busy = busyModels.has(modelId);
    const loaded = file.llamawebLoaded;
    const runBtn = loaded
      ? `<button type="button" class="btn-ghost btn-sm models-llamaweb-unload" data-model-id="${escapeHtml(modelId)}" ${busy ? 'disabled' : ''}>Descarregar</button>`
      : `<button type="button" class="btn-primary btn-sm models-llamaweb-load" data-path="${escapeHtml(file.path)}" data-model-id="${escapeHtml(modelId)}" ${busy ? 'disabled' : ''}>Carregar</button>`;
    const folderBtn =
      file.folderExists && file.folderPath
        ? `<button type="button" class="btn-ghost btn-sm models-open-folder" data-path="${escapeHtml(file.folderPath)}" title="Abrir pasta do arquivo">Abrir pasta</button>`
        : '';
    return `
      ${runBtn}
      ${ggufOllamaActions(file)}
      ${folderBtn}
      <button type="button" class="btn-ghost btn-sm models-delete-gguf" data-path="${escapeHtml(file.path)}">Excluir</button>
    `;
  }

  function renderGgufRunning(data) {
    const running = (data.llamawebRunning || []).filter((m) =>
      ['loaded', 'sleeping', 'loading'].includes(m.status?.value)
    );
    if (els.ggufRunningCount) els.ggufRunningCount.textContent = String(running.length);
    if (!els.ggufRunning) return;

    if (!running.length) {
      els.ggufRunning.innerHTML =
        '<div class="models-empty">Nenhum modelo na VRAM. Use <strong>Carregar</strong> em um arquivo .gguf abaixo.</div>';
      return;
    }

    els.ggufRunning.innerHTML = running
      .map((m) => {
        const file = ggufFileByModelId(data, m.id);
        const status = m.status?.value;
        const statusPill =
          status === 'loading'
            ? '<span class="models-pill warn">carregando</span>'
            : status === 'sleeping'
              ? '<span class="models-pill">dormindo</span>'
              : '<span class="models-pill running">VRAM</span>';
        const busy = busyModels.has(m.id);
        return `
      <article class="models-card is-running">
        <div class="models-card-main">
          <div class="models-card-icon" aria-hidden="true">⚡</div>
          <div class="models-card-body">
            <div class="models-card-title mono">${escapeHtml(file?.name || m.id)}</div>
            <div class="models-card-meta muted">
              ${file ? escapeHtml(file.sizeLabel) : ''}
              ${file?.displayPath ? ` · ${escapeHtml(file.displayPath)}` : ''}
              · ${statusPill}
            </div>
          </div>
        </div>
        <div class="models-card-actions">
          <button type="button" class="btn-ghost btn-sm models-llamaweb-unload" data-model-id="${escapeHtml(m.id)}" ${busy ? 'disabled' : ''}>Descarregar</button>
          ${
            file?.folderPath
              ? `<button type="button" class="btn-ghost btn-sm models-open-folder" data-path="${escapeHtml(file.folderPath)}">Abrir pasta</button>`
              : ''
          }
        </div>
      </article>`;
      })
      .join('');
  }

  function renderGgufStatus(data) {
    if (!els.ggufStatus) return;
    const conn = data.llamawebConnection || {};
    if (!conn.ok) {
      els.ggufStatus.innerHTML = '';
      return;
    }
    const loaded = (data.llamawebModels || []).filter((m) =>
      ['loaded', 'sleeping'].includes(m.status?.value)
    );
    if (!loaded.length) {
      els.ggufStatus.innerHTML = '';
      return;
    }
    els.ggufStatus.innerHTML = `<div class="models-alert models-alert-info">${loaded.length} modelo(s) carregado(s) na VRAM</div>`;
  }

  function renderGguf(data) {
    if (!els.gguf) return;
    const groups = (data.gguf || []).filter((g) => g.exists && g.files?.length);
    const modelFiles = groups.flatMap((g) => (g.files || []).filter((f) => f.kind === 'model'));
    if (els.ggufFilesCount) els.ggufFilesCount.textContent = String(modelFiles.length);

    if (!groups.length) {
      els.gguf.innerHTML = '<div class="models-empty">Nenhum arquivo .gguf encontrado nas pastas configuradas.</div>';
      return;
    }

    els.gguf.innerHTML = groups
      .map((group) => {
        const files = group.files || [];
        const fileRows = files
          .map((f) => {
            const isMm = f.kind === 'mmproj';
            return `
            <article class="models-card${f.llamawebLoaded ? ' is-active' : ''}">
              <div class="models-card-main">
                <div class="models-card-icon" aria-hidden="true">${isMm ? '👁' : '📦'}</div>
                <div class="models-card-body">
                  <div class="models-card-title mono">${escapeHtml(f.name)}</div>
                  <div class="models-card-meta muted">
                    ${escapeHtml(f.sizeLabel)} · ${escapeHtml(f.displayPath)}
                    ${llamawebStatusPill(f.llamawebStatus)}
                    ${ggufOllamaPill(f)}
                    ${isMm ? ' · <span class="models-pill">mmproj</span>' : ''}
                  </div>
                </div>
              </div>
              <div class="models-card-actions">${isMm ? '' : ggufActions(f)}</div>
            </article>`;
          })
          .join('');

        return `
        <div class="models-gguf-group">
          <div class="models-section-head">
            <h3>${escapeHtml(group.displayPath || group.dir)}</h3>
            <span class="badge">${files.length}</span>
          </div>
          ${fileRows}
        </div>`;
      })
      .join('');
  }

  function renderPullJobs(jobs) {
    if (!els.pullJobs) return;
    const active = jobs.filter((j) => j.status === 'running');
    if (!active.length) {
      els.pullJobs.innerHTML = '<div class="models-empty">Nenhum download em andamento.</div>';
      return;
    }
    els.pullJobs.innerHTML = active
      .map((j) => {
        const kind =
          j.kind === 'hf'
            ? '<span class="models-pill running">HF · Ollama</span>'
            : '<span class="models-pill">Ollama</span>';
        const runHint = j.runCommand
          ? `<div class="models-pull-run-hint mono muted">Depois: ${escapeHtml(j.runCommand)}</div>`
          : '';
        const ggufHint =
          j.ggufDir && j.kind === 'hf'
            ? `<div class="models-pull-run-hint mono muted">GGUF → ${escapeHtml(j.ggufDir)}</div>`
            : '';
        return `
      <article class="models-job">
        <div class="models-job-head">
          <span class="mono">${escapeHtml(j.model)}</span>
          ${kind}
          <span class="muted">${escapeHtml(j.progressLabel || '')}</span>
        </div>
        ${runHint}
        ${ggufHint}
        <div class="models-progress"><div class="models-progress-fill" style="width:${j.progress || 0}%"></div></div>
        <div class="models-job-actions">
          <button type="button" class="btn-ghost btn-sm models-cancel-pull" data-id="${escapeHtml(j.id)}">Cancelar</button>
        </div>
      </article>`;
      })
      .join('');
  }

  function renderPopular(models) {
    if (!els.popularChips) return;
    els.popularChips.innerHTML = models
      .map(
        (m) =>
          `<button type="button" class="models-chip" data-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`
      )
      .join('');
  }

  function loadPresetStorageKey(model) {
    return loadConfigBackend === 'llamacpp'
      ? `${LOAD_PRESET_KEY}.gguf.${model}`
      : `${LOAD_PRESET_KEY}.${model}`;
  }

  function readSavedLoadConfig(model) {
    try {
      const raw = localStorage.getItem(loadPresetStorageKey(model));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeSavedLoadConfig(model, config) {
    try {
      localStorage.setItem(loadPresetStorageKey(model), JSON.stringify(config));
    } catch {
      /* ignore quota */
    }
  }

  function readUserPresets() {
    try {
      const raw = localStorage.getItem(USER_PRESETS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function writeUserPresets(list) {
    try {
      localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(list));
    } catch {
      /* ignore quota */
    }
  }

  function addUserPreset(name, config) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new Error('Digite um nome para o preset.');
    const presets = readUserPresets();
    if (presets.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error('Já existe um preset com esse nome.');
    }
    const entry = {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      keepAlive: config.keepAlive || '24h',
      options: config.options || {},
      system: config.system || '',
      savedAt: new Date().toISOString(),
    };
    presets.unshift(entry);
    writeUserPresets(presets);
    return entry;
  }

  function deleteUserPreset(id) {
    writeUserPresets(readUserPresets().filter((p) => p.id !== id));
  }

  function renderUserPresetChips() {
    if (!els.loadUserChips) return;
    const presets = readUserPresets();
    if (!presets.length) {
      els.loadUserChips.innerHTML = '<span class="model-load-no-presets muted">Nenhum salvo ainda</span>';
      return;
    }
    els.loadUserChips.innerHTML = presets
      .map(
        (p) => `
      <span class="model-load-user-chip-wrap">
        <button type="button" class="models-chip model-load-user-preset" data-user-preset="${escapeHtml(p.id)}" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>
        <button type="button" class="model-load-user-preset-del" data-delete-preset="${escapeHtml(p.id)}" title="Excluir preset">×</button>
      </span>`
      )
      .join('');
  }

  function closeLoadConfig() {
    els.loadOverlay?.classList.add('hidden');
    els.loadOverlay?.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('model-load-open');
    loadConfigBackend = 'ollama';
    loadConfigGgufPath = null;
    loadConfigModel = null;
    loadConfigData = null;
    loadConfigSaved = null;
    loadActivePresetId = null;
    els.loadKeepAliveWrap?.classList.remove('hidden');
  }

  function optionValueForField(def, values, explicitKeys, backend) {
    const v = values?.[def.key];
    const isExplicit = explicitKeys?.has(def.key);
    if (v !== undefined && v !== null && v !== '') return v;
    if (backend === 'llamacpp' && !isExplicit) {
      return def.type === 'boolean' ? false : '';
    }
    if (def.default !== undefined && def.default !== null) return def.default;
    return def.type === 'boolean' ? false : '';
  }

  function snapNumericField(field) {
    const snap = Number(field.dataset.snapStep);
    if (!Number.isFinite(snap) || snap <= 0) return;
    const min = field.min !== '' ? Number(field.min) : null;
    const max = field.max !== '' ? Number(field.max) : null;
    const raw = Number(field.value);
    if (!Number.isFinite(raw)) return;
    let next = Math.round(raw / snap) * snap;
    if (Number.isFinite(min)) next = Math.max(min, next);
    if (Number.isFinite(max)) next = Math.min(max, next);
    if (next !== raw) {
      field.value = String(next);
      field.dataset.explicit = 'true';
    }
  }

  function renderLoadOptionField(def, values, explicitKeys, backend) {
    const id = `model-load-opt-${def.key}`;
    const isExplicit = explicitKeys?.has(def.key);
    const val = optionValueForField(def, values, explicitKeys, backend);
    const explicitAttr = isExplicit ? ' data-explicit="true"' : '';
    const hint = def.hint ? `<span class="model-load-opt-hint">${escapeHtml(def.hint)}</span>` : '';
    const wide = def.type === 'textarea' || def.type === 'stop_list' ? ' is-wide' : '';
    const placeholder =
      backend === 'llamacpp' && !isExplicit && def.default != null && def.type === 'number'
        ? ` placeholder="${escapeHtml(String(def.default))}"`
        : '';

    if (def.type === 'boolean') {
      const checked = val === true || val === 'true';
      return `
        <div class="model-load-opt model-load-opt-check${wide}">
          <label for="${id}">
            <input type="checkbox" id="${id}" name="${escapeHtml(def.key)}" data-opt="${escapeHtml(def.key)}"${explicitAttr} ${checked ? 'checked' : ''} />
            ${escapeHtml(def.label)}
          </label>
          ${hint}
        </div>`;
    }

    if (def.type === 'textarea') {
      return `
        <div class="model-load-opt${wide}">
          <label for="${id}">${escapeHtml(def.label)}</label>
          <textarea id="${id}" name="${escapeHtml(def.key)}" data-opt="${escapeHtml(def.key)}"${explicitAttr} rows="4" spellcheck="false">${escapeHtml(String(val || ''))}</textarea>
          ${hint}
        </div>`;
    }

    if (def.type === 'stop_list') {
      const text = Array.isArray(val) ? val.join('\n') : String(val || '');
      return `
        <div class="model-load-opt${wide}">
          <label for="${id}">${escapeHtml(def.label)}</label>
          <textarea id="${id}" name="${escapeHtml(def.key)}" data-opt="${escapeHtml(def.key)}"${explicitAttr} rows="3" spellcheck="false" placeholder="USER:&#10;ASSISTANT:">${escapeHtml(text)}</textarea>
          ${hint}
        </div>`;
    }

    const attrs = [
      `id="${id}"`,
      `name="${escapeHtml(def.key)}"`,
      `data-opt="${escapeHtml(def.key)}"`,
      'type="number"',
    ];
    if (explicitAttr) attrs.push('data-explicit="true"');
    if (def.min != null) attrs.push(`min="${def.min}"`);
    if (def.max != null) attrs.push(`max="${def.max}"`);
    if (def.snapStep != null) {
      attrs.push(`data-snap-step="${def.snapStep}"`);
      attrs.push('step="1"');
    } else if (def.step != null) {
      attrs.push(`step="${def.step}"`);
    }
    if (val !== '' && val != null) attrs.push(`value="${escapeHtml(String(val))}"`);
    if (placeholder) attrs.push(placeholder.trim());

    return `
      <div class="model-load-opt${wide}">
        <label for="${id}">${escapeHtml(def.label)}</label>
        <input ${attrs.join(' ')} />
        ${hint}
      </div>`;
  }

  function renderLoadConfigForm(data, saved) {
    const schema = data.schema || {};
    const backend = schema.backend || loadConfigBackend || 'ollama';
    const groups = schema.groups || [];
    const options = schema.options || [];
    const keepChoices = schema.keepAliveChoices || [];
    const presets = schema.presets || [];

    const mergedOptions = { ...(data.options || {}), ...(saved?.options || {}) };
    const explicitOptionKeys = new Set(Object.keys(mergedOptions).filter((k) => k !== 'system'));
    const merged = {
      keepAlive: saved?.keepAlive || data.keepAlive || '24h',
      options: mergedOptions,
      system: saved?.system ?? data.system ?? '',
      alias: saved?.alias || data.alias || '',
    };

    if (els.loadAliasWrap) {
      els.loadAliasWrap.classList.toggle('hidden', backend !== 'ollama');
    }
    if (els.loadAlias) {
      els.loadAlias.value = merged.alias || '';
    }

    if (els.loadKeepAliveWrap) {
      els.loadKeepAliveWrap.classList.toggle('hidden', schema.showKeepAlive === false);
    }

    if (els.loadKeepAlive && schema.showKeepAlive !== false) {
      els.loadKeepAlive.innerHTML = keepChoices
        .map(
          (c) =>
            `<option value="${escapeHtml(c.value)}"${merged.keepAlive === c.value || String(merged.keepAlive) === c.value ? ' selected' : ''}>${escapeHtml(c.label)}</option>`
        )
        .join('');
    }

    if (els.loadContextHint) {
      if (data.hint && schema.backend === 'llamacpp') {
        els.loadContextHint.textContent = data.hint;
      } else {
        const ctx = data.contextLength || mergedOptions.num_ctx;
        const gpu = mergedOptions.num_gpu;
        let gpuNote = '';
        if (gpu === 0 || gpu === '0') gpuNote = ' · Camadas na GPU = 0 → modelo só na RAM (CPU)';
        else if (gpu != null && gpu !== '' && Number(gpu) > 0) {
          gpuNote = ` · Camadas na GPU = ${gpu} → parte na VRAM, resto na RAM`;
        } else if (gpu === -1 || gpu === '-1') gpuNote = ' · Camadas na GPU = -1 → máximo possível na VRAM';
        els.loadContextHint.textContent = ctx
          ? `Contexto nativo do modelo: ~${Number(ctx).toLocaleString('pt-BR')} tokens${gpuNote}. Alias + contexto customizado criam uma variante no Ollama para o Cursor.`
          : `Ajuste Camadas na GPU para dividir entre VRAM e RAM${gpuNote}`;
      }
    }

    if (els.loadPresetChips) {
      els.loadPresetChips.innerHTML = presets
        .map(
          (p) =>
            `<button type="button" class="models-chip model-load-preset${loadActivePresetId === p.id ? ' is-active' : ''}" data-preset="${escapeHtml(p.id)}">${escapeHtml(p.label)}</button>`
        )
        .join('');
    }

    renderUserPresetChips();

    if (els.loadGroups) {
      const systemDef = schema.systemField;
      const values = { ...merged.options, system: merged.system };
      const systemExplicit = Boolean(merged.system);
      els.loadGroups.innerHTML = groups
        .map((group) => {
          const fields = options.filter((o) => o.group === group.id);
          const extra =
            group.id === 'prompt' && systemDef
              ? renderLoadOptionField(
                  systemDef,
                  values,
                  systemExplicit ? new Set(['system']) : explicitOptionKeys,
                  backend
                )
              : '';
          const openGroup =
            backend === 'llamacpp' &&
            (fields.some((def) => explicitOptionKeys.has(def.key)) ||
              (group.id === 'prompt' && systemExplicit));
          if (!fields.length && !extra) return '';
          return `
            <details class="model-load-group"${openGroup ? ' open' : ''}>
              <summary>
                ${escapeHtml(group.label)}
                ${group.hint ? `<span class="model-load-group-hint">${escapeHtml(group.hint)}</span>` : ''}
              </summary>
              <div class="model-load-group-body">
                ${fields.map((def) => renderLoadOptionField(def, values, explicitOptionKeys, backend)).join('')}
                ${extra}
              </div>
            </details>`;
        })
        .join('');
    }
  }

  function applyConfigValues(config) {
    if (!loadConfigData || !config) return;
    const baseOptions = { ...(loadConfigData.options || {}) };
    const nextOptions = config.options ? { ...baseOptions, ...config.options } : baseOptions;
    const next = {
      keepAlive: config.keepAlive ?? loadConfigData.keepAlive ?? '24h',
      options: nextOptions,
      system: config.system ?? loadConfigData.system ?? '',
      alias: config.alias ?? loadConfigSaved?.alias ?? '',
    };
    renderLoadConfigForm(
      { ...loadConfigData, ...next },
      next
    );
  }

  function applyLoadPreset(presetId) {
    const schema = loadConfigData?.schema;
    const preset = schema?.presets?.find((p) => p.id === presetId);
    if (!preset || !loadConfigData) return;

    loadActivePresetId = presetId;
    const baseOptions = { ...(loadConfigData.options || {}) };
    const nextOptions =
      presetId === 'model' ? { ...baseOptions } : { ...baseOptions, ...(preset.options || {}) };

    applyConfigValues({
      keepAlive: preset.keepAlive || loadConfigData.keepAlive,
      options: nextOptions,
      system: presetId === 'model' ? loadConfigData.system : loadConfigSaved?.system ?? loadConfigData.system,
    });
  }

  function applyUserPreset(presetId) {
    const preset = readUserPresets().find((p) => p.id === presetId);
    if (!preset) return;
    loadActivePresetId = null;
    applyConfigValues({
      keepAlive: preset.keepAlive,
      options: preset.options,
      system: preset.system,
    });
  }

  async function saveCurrentUserPreset() {
    const name = els.loadPresetName?.value?.trim();
    try {
      const payload = collectLoadConfigPayload();
      const { model, ...config } = payload;
      addUserPreset(name, config);
      if (els.loadPresetName) els.loadPresetName.value = '';
      renderUserPresetChips();
      toast?.(`Preset "${name}" salvo`, 'success');
    } catch (err) {
      toast?.(err.message, 'error');
    }
  }

  function collectLoadConfigPayload() {
    const options = {};
    const llamaCpp = loadConfigBackend === 'llamacpp';
    els.loadForm?.querySelectorAll('[data-opt]').forEach((field) => {
      const key = field.dataset.opt;
      if (!key) return;
      if (key === 'system') {
        return;
      }
      if (llamaCpp && field.dataset.explicit !== 'true') return;
      if (field.type === 'checkbox') {
        options[key] = field.checked;
        return;
      }
      const raw = field.value;
      if (raw === '' || raw == null) return;
      if (field.type === 'number') {
        snapNumericField(field);
        const n = Number(field.value);
        if (Number.isFinite(n)) options[key] = n;
        return;
      }
      options[key] = raw;
    });

    const systemField = els.loadForm?.querySelector('[data-opt="system"]');
    const system = systemField?.value?.trim() || '';
    const alias = loadConfigBackend === 'ollama' ? els.loadAlias?.value?.trim() || '' : '';

    return {
      model: loadConfigModel,
      keepAlive: els.loadKeepAlive?.value || '24h',
      options,
      system,
      ...(alias ? { alias } : {}),
    };
  }

  async function openLoadConfig(modelName) {
    loadConfigBackend = 'ollama';
    loadConfigGgufPath = null;
    loadConfigModel = modelName;
    loadConfigSaved = readSavedLoadConfig(modelName);

    if (els.loadTitle) els.loadTitle.textContent = 'Carregar modelo';
    if (els.loadSubtitle) els.loadSubtitle.textContent = modelName;
    if (els.loadLoading) els.loadLoading.classList.remove('hidden');
    if (els.loadForm) els.loadForm.classList.add('hidden');
    els.loadOverlay?.classList.remove('hidden');
    els.loadOverlay?.setAttribute('aria-hidden', 'false');
    document.body.classList.add('model-load-open');

    try {
      const data = await api(`/api/ai/ollama/models/load-defaults?model=${encodeURIComponent(modelName)}`);
      loadConfigData = data;
      renderLoadConfigForm(data, loadConfigSaved);
      if (els.loadLoading) els.loadLoading.classList.add('hidden');
      if (els.loadForm) els.loadForm.classList.remove('hidden');
    } catch (err) {
      closeLoadConfig();
      toast?.(err.message, 'error');
    }
  }

  async function openLoadConfigGguf(relPath, modelId) {
    loadConfigBackend = 'llamacpp';
    loadConfigGgufPath = relPath;
    loadConfigModel = modelId;
    loadConfigSaved = readSavedLoadConfig(modelId);

    if (els.loadTitle) els.loadTitle.textContent = 'Carregar GGUF';
    if (els.loadSubtitle) els.loadSubtitle.textContent = modelId;
    if (els.loadLoading) els.loadLoading.classList.remove('hidden');
    if (els.loadForm) els.loadForm.classList.add('hidden');
    els.loadOverlay?.classList.remove('hidden');
    els.loadOverlay?.setAttribute('aria-hidden', 'false');
    document.body.classList.add('model-load-open');

    try {
      const data = await api(`/api/ai/llamaweb/load-defaults?path=${encodeURIComponent(relPath)}`);
      loadConfigData = data;
      renderLoadConfigForm(data, loadConfigSaved);
      if (els.loadLoading) els.loadLoading.classList.add('hidden');
      if (els.loadForm) els.loadForm.classList.remove('hidden');
    } catch (err) {
      closeLoadConfig();
      toast?.(err.message, 'error');
    }
  }

  async function runModel(name, loadPayload = null) {
    busyModels.add(name);
    if (overview) render(overview);
    setTab('ollama');
    try {
      const body = loadPayload || { model: name };
      const data = await api('/api/ai/ollama/run', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      activeJobId = data.job?.id || null;
      activeJobKind = 'load';
      updateJobLog(data.job, 'load');
      if (data.job?.id) pollJob('load', data.job.id);
    } catch (err) {
      busyModels.delete(name);
      toast?.(err.message, 'error');
      if (overview) render(overview);
    }
  }

  async function unloadModel(name) {
    busyModels.add(name);
    if (overview) render(overview);
    setTab('ollama');
    try {
      const data = await api('/api/ai/ollama/unload', {
        method: 'POST',
        body: JSON.stringify({ model: name }),
      });
      activeJobId = data.job?.id || null;
      activeJobKind = 'unload';
      updateJobLog(data.job, 'unload');
      if (data.job?.id) pollJob('unload', data.job.id);
    } catch (err) {
      busyModels.delete(name);
      toast?.(err.message, 'error');
      if (overview) render(overview);
    }
  }

  async function deleteModel(name) {
    const ok = await confirmWithPassword?.({
      title: 'Excluir modelo do Ollama',
      message: `Remover permanentemente "${name}"?`,
      action: (password) =>
        api('/api/ai/ollama/models', {
          method: 'DELETE',
          body: JSON.stringify({ password, model: name }),
        }),
    });
    if (ok) {
      toast?.('Modelo removido do Ollama', 'success');
      await refresh();
    }
  }

  function copyText(text) {
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast?.('Copiado', 'success'))
      .catch(() => toast?.('Falha ao copiar', 'error'));
  }

  function decodeCopyAttr(value) {
    try {
      return decodeURIComponent(value || '');
    } catch {
      return value || '';
    }
  }

  function closeModelDetail() {
    els.detailOverlay?.classList.add('hidden');
    els.detailOverlay?.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('model-detail-open');
  }

  function openModelDetailShell(name) {
    if (els.detailTitle) els.detailTitle.textContent = 'Detalhes do modelo';
    if (els.detailSubtitle) els.detailSubtitle.textContent = name;
    if (els.detailBody) {
      els.detailBody.classList.add('hidden');
      els.detailBody.innerHTML = '';
    }
    if (els.detailLoading) els.detailLoading.classList.remove('hidden');
    els.detailOverlay?.classList.remove('hidden');
    els.detailOverlay?.setAttribute('aria-hidden', 'false');
    document.body.classList.add('model-detail-open');
  }

  function findLocalModelMeta(name) {
    if (!overview) return null;
    return (
      (overview.running || []).find((m) => m.name === name) ||
      (overview.ollamaModels || []).find((m) => m.name === name)
    );
  }

  function renderModelDetail(data, localMeta) {
    const specs = data.specs || {};
    const ep = data.endpoints || {};
    const snip = data.snippets || {};
    const cursor = snip.cursor || {};

    const specItem = (label, value) =>
      value
        ? `<div class="model-detail-spec"><span class="model-detail-spec-label">${escapeHtml(label)}</span><span class="model-detail-spec-value">${escapeHtml(value)}</span></div>`
        : '';

    const copyRow = (label, value, href) => {
      const enc = encodeURIComponent(value || '');
      const inner = href
        ? `<a class="model-detail-url mono" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(value)}</a>`
        : `<span class="model-detail-url mono">${escapeHtml(value)}</span>`;
      return `
        <div class="model-detail-row">
          <span class="model-detail-row-label">${escapeHtml(label)}</span>
          <div class="model-detail-row-value">
            <div class="model-detail-copy-row">
              ${inner}
              <button type="button" class="btn-ghost btn-sm model-detail-copy" data-copy="${enc}">Copiar</button>
            </div>
          </div>
        </div>`;
    };

    const runningPill = data.running
      ? '<span class="model-detail-pill ok">Carregado na VRAM</span>'
      : '<span class="model-detail-pill warn">Não carregado — use <strong>Carregar</strong> antes de usar na IDE</span>';

    const cursorBlock = `Base URL: ${cursor.baseUrl || ''}\nAPI Key: ollama\nModel: ${cursor.model || data.model}`;

    return `
      <section class="model-detail-section">
        <h3>Especificações</h3>
        <div class="model-detail-specs">
          ${specItem('Parâmetros', specs.parameterSize)}
          ${specItem('Quantização', specs.quantization)}
          ${specItem('Família', specs.family)}
          ${specItem('Formato', specs.format)}
          ${specItem('Tamanho', localMeta?.sizeLabel || null)}
        </div>
        <p style="margin-top:0.65rem">${runningPill}</p>
        ${
          localMeta?.folderDisplayPath
            ? `<p class="model-detail-hint muted">Pasta: <code>${escapeHtml(localMeta.folderDisplayPath)}</code></p>`
            : ''
        }
      </section>

      <section class="model-detail-section">
        <h3>Conexão API</h3>
        <p class="model-detail-hint muted">Configure sua IDE na rede local apontando para o servidor. Garanta que a porta <code>11434</code> do Ollama está acessível externamente.</p>
        ${copyRow('Servidor Ollama', data.publicOllamaUrl, data.publicOllamaUrl)}
        ${copyRow('API Chat', ep.chat, ep.chat)}
        ${copyRow('OpenAI compat.', ep.openAiChat, ep.openAiChat)}
        ${copyRow('Nome do modelo', data.model, null)}
      </section>

      <section class="model-detail-section">
        <h3>Cursor / VS Code</h3>
        <p class="model-detail-hint muted">Use provider OpenAI-compatible com Base URL e API Key <code>ollama</code> (qualquer valor aceito pelo Ollama).</p>
        ${copyRow('Base URL', cursor.baseUrl, cursor.baseUrl)}
        <pre class="model-detail-pre mono">${escapeHtml(cursorBlock)}</pre>
        <button type="button" class="btn-ghost btn-sm model-detail-copy" data-copy="${encodeURIComponent(cursorBlock)}">Copiar config</button>
      </section>

      <section class="model-detail-section">
        <h3>Continue.dev</h3>
        <p class="model-detail-hint muted">Adicione ao <code>config.yaml</code> do Continue:</p>
        <pre class="model-detail-pre mono">${escapeHtml(snip.continueYaml || '')}</pre>
        <button type="button" class="btn-ghost btn-sm model-detail-copy" data-copy="${encodeURIComponent(snip.continueYaml || '')}">Copiar YAML</button>
      </section>

      <section class="model-detail-section">
        <h3>Teste (curl)</h3>
        <pre class="model-detail-pre mono">${escapeHtml(snip.curlChat || '')}</pre>
        <button type="button" class="btn-ghost btn-sm model-detail-copy" data-copy="${encodeURIComponent(snip.curlChat || '')}">Copiar curl</button>
        <p class="model-detail-hint muted">OpenAI compat.: <code>${escapeHtml(ep.openAiChat || '')}</code></p>
      </section>

      ${
        data.openWebUiUrl
          ? `<section class="model-detail-section"><h3>Open WebUI</h3><div class="model-detail-links"><a href="${escapeHtml(data.openWebUiUrl)}" target="_blank" rel="noopener">${escapeHtml(data.openWebUiUrl)}</a></div></section>`
          : ''
      }

      <section class="model-detail-section">
        <h3>Documentação</h3>
        <div class="model-detail-links">
          <a href="https://github.com/ollama/ollama/blob/main/docs/api.md" target="_blank" rel="noopener">API Ollama</a>
          <a href="https://github.com/ollama/ollama/blob/main/docs/openai.md" target="_blank" rel="noopener">Compatibilidade OpenAI</a>
        </div>
      </section>`;
  }

  async function showModelInfo(name) {
    openModelDetailShell(name);
    try {
      const data = await api(`/api/ai/ollama/models/info?model=${encodeURIComponent(name)}`);
      const localMeta = findLocalModelMeta(name);
      if (els.detailTitle) els.detailTitle.textContent = data.model || name;
      if (els.detailBody) {
        els.detailBody.innerHTML = renderModelDetail(data, localMeta);
        els.detailBody.classList.remove('hidden');
      }
    } catch (err) {
      closeModelDetail();
      toast?.(err.message, 'error');
    } finally {
      if (els.detailLoading) els.detailLoading.classList.add('hidden');
    }
  }

  async function pollImport(id) {
    if (loadPollTimer) clearTimeout(loadPollTimer);
    try {
      const data = await api(`/api/ai/gguf/import/${encodeURIComponent(id)}`);
      const job = data.job;
      if (!job) return;
      if (job.status === 'running') {
        loadPollTimer = setTimeout(() => pollImport(id), 800);
      } else {
        loadPollTimer = null;
        activeJobId = null;
        activeJobKind = null;
        busyModels.delete(job.model);
        busyModels.delete(job.sourcePath);
        if (job.status === 'completed') {
          toast?.(`Modelo ${job.model} importado — use Carregar Ollama ou a API`, 'success');
        } else if (job.status === 'failed') {
          toast?.(job.error || 'Falha ao importar no Ollama', 'error');
        }
        await refresh({ silent: true });
      }
    } catch (err) {
      if (!loadPollTimer) toast?.(err.message, 'error');
    }
  }

  async function importGgufToOllama(path, modelName) {
    const key = modelName || path;
    busyModels.add(key);
    if (overview) render(overview);
    try {
      const data = await api('/api/ai/gguf/import', {
        method: 'POST',
        body: JSON.stringify({ path, modelName: modelName || undefined }),
      });
      toast?.('Importação no Ollama iniciada', 'success');
      setTab('ollama');
      if (data.job?.id) {
        activeJobId = data.job.id;
        activeJobKind = 'import';
        pollImport(data.job.id);
      }
      await refresh({ silent: true });
    } catch (err) {
      busyModels.delete(key);
      toast?.(err.message, 'error');
      if (overview) render(overview);
    }
  }

  async function pullModel(name, saveGguf = true) {
    try {
      await api('/api/ai/ollama/pull', {
        method: 'POST',
        body: JSON.stringify({ model: name, saveGguf }),
      });
      toast?.(`Download de ${name} iniciado`, 'success');
      setTab('pull');
      await refresh();
    } catch (err) {
      toast?.(err.message, 'error');
    }
  }

  async function runLlamaWebLoad(path, modelId, loadPayload = null) {
    const id = modelId || path;
    busyModels.add(id);
    if (overview) render(overview);
    setTab('gguf');
    try {
      const body = {
        path,
        modelId,
        ...(loadPayload || {}),
      };
      const data = await api('/api/ai/llamaweb/load', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      activeJobId = data.job?.id || null;
      activeJobKind = 'llamaweb';
      updateJobLog(data.job, 'llamaweb');
      if (data.job?.id) pollJob('llamaweb', data.job.id);
    } catch (err) {
      busyModels.delete(id);
      toast?.(err.message, 'error');
      if (overview) render(overview);
    }
  }

  async function unloadLlamaWeb(modelId) {
    if (!modelId) return;
    busyModels.add(modelId);
    if (overview) render(overview);
    setTab('gguf');
    try {
      const data = await api('/api/ai/llamaweb/unload', {
        method: 'POST',
        body: JSON.stringify({ modelId }),
      });
      activeJobId = data.job?.id || null;
      activeJobKind = 'llamaweb';
      updateJobLog(data.job, 'llamaweb');
      if (data.job?.id) pollJob('llamaweb', data.job.id);
    } catch (err) {
      busyModels.delete(modelId);
      toast?.(err.message, 'error');
      if (overview) render(overview);
    }
  }

  async function deleteGguf(path) {
    const ok = await confirmWithPassword?.({
      title: 'Excluir arquivo GGUF',
      message: `Remover permanentemente "${path}"?`,
      action: (password) =>
        api('/api/ai/gguf', {
          method: 'DELETE',
          body: JSON.stringify({ password, path }),
        }),
    });
    if (ok) {
      toast?.('Arquivo removido', 'success');
      await refresh();
    }
  }

  window.aiModels = { open: openOverlay, close: closeOverlay };

  document.getElementById('models-terminal-reconnect')?.addEventListener('click', () => {
    window.gpuTerminal?.connect?.({ reset: true });
  });

  overlay.querySelector('.models-backdrop')?.addEventListener('click', closeOverlay);
  document.getElementById('models-close')?.addEventListener('click', closeOverlay);
  document.getElementById('open-models-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    openOverlay();
  });
  document.getElementById('models-refresh')?.addEventListener('click', async () => {
    if (!hasRunningJob(overview)) hideJobLog();
    await refresh({ showLoading: true });
  });
  document.getElementById('models-load-log-close')?.addEventListener('click', hideJobLog);
  document.getElementById('models-folder-back')?.addEventListener('click', showMainView);
  document.getElementById('models-folder-up')?.addEventListener('click', async () => {
    if (!folderPath || folderPath === '.') return;
    try {
      const data = await api(`/api/browse?path=${encodeURIComponent(folderPath)}`);
      if (data.parent != null) await loadFolderBrowse(data.parent);
    } catch (err) {
      toast?.(err.message, 'error');
    }
  });

  overlay.querySelectorAll('.models-tab').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  els.pullForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = els.pullName?.value?.trim();
    if (!name) return;
    const saveGguf = els.pullSaveGguf?.checked !== false;
    await pullModel(name, saveGguf);
    if (els.pullName) els.pullName.value = '';
  });

  els.folderCrumb?.addEventListener('click', (e) => {
    const btn = e.target.closest('.models-folder-crumb-btn');
    if (!btn) return;
    loadFolderBrowse(btn.dataset.path);
  });

  els.folderList?.addEventListener('click', (e) => {
    const item = e.target.closest('.models-folder-item.is-dir');
    if (!item) return;
    loadFolderBrowse(item.dataset.path);
  });

  overlay.addEventListener('click', async (e) => {
    const run = e.target.closest('.models-run');
    if (run) return openLoadConfig(run.dataset.model);

    const unload = e.target.closest('.models-unload');
    if (unload) return unloadModel(unload.dataset.model);

    const del = e.target.closest('.models-delete');
    if (del) return deleteModel(del.dataset.model);

    const info = e.target.closest('.models-info');
    if (info) return showModelInfo(info.dataset.model);

    const chip = e.target.closest('.models-chip');
    if (chip) {
      if (els.pullName) els.pullName.value = chip.dataset.model;
      return pullModel(chip.dataset.model, els.pullSaveGguf?.checked !== false);
    }

    const cancelPull = e.target.closest('.models-cancel-pull');
    if (cancelPull) {
      try {
        await api(`/api/ai/ollama/pull/${encodeURIComponent(cancelPull.dataset.id)}/cancel`, {
          method: 'POST',
        });
        toast?.('Download cancelado', 'success');
        await refresh();
      } catch (err) {
        toast?.(err.message, 'error');
      }
      return;
    }

    const lwLoad = e.target.closest('.models-llamaweb-load');
    if (lwLoad) return openLoadConfigGguf(lwLoad.dataset.path, lwLoad.dataset.modelId);

    const lwUnload = e.target.closest('.models-llamaweb-unload');
    if (lwUnload) return unloadLlamaWeb(lwUnload.dataset.modelId);

    const ggufImport = e.target.closest('.models-gguf-import');
    if (ggufImport) {
      return importGgufToOllama(ggufImport.dataset.path, ggufImport.dataset.model);
    }

    const delGguf = e.target.closest('.models-delete-gguf');
    if (delGguf) return deleteGguf(delGguf.dataset.path);

    const openFolder = e.target.closest('.models-open-folder');
    if (openFolder) {
      await openFolderInOverlay(openFolder.dataset.path);
    }
  });

  document.getElementById('model-detail-close')?.addEventListener('click', closeModelDetail);
  els.detailOverlay?.querySelector('.model-detail-backdrop')?.addEventListener('click', closeModelDetail);
  els.detailBody?.addEventListener('click', (e) => {
    const btn = e.target.closest('.model-detail-copy');
    if (!btn) return;
    copyText(decodeCopyAttr(btn.dataset.copy));
  });

  document.getElementById('model-load-close')?.addEventListener('click', closeLoadConfig);
  document.getElementById('model-load-cancel')?.addEventListener('click', closeLoadConfig);
  els.loadOverlay?.querySelector('.model-load-backdrop')?.addEventListener('click', closeLoadConfig);
  els.loadForm?.addEventListener('blur', (e) => {
    const field = e.target.closest('[data-opt][type="number"]');
    if (!field) return;
    snapNumericField(field);
  }, true);
  els.loadForm?.addEventListener('input', (e) => {
    const field = e.target.closest('[data-opt]');
    if (!field) return;
    field.dataset.explicit = 'true';
    loadActivePresetId = null;
    els.loadPresetChips?.querySelectorAll('.model-load-preset.is-active').forEach((btn) => {
      btn.classList.remove('is-active');
    });
  });
  els.loadPresetChips?.addEventListener('click', (e) => {
    const btn = e.target.closest('.model-load-preset');
    if (!btn) return;
    applyLoadPreset(btn.dataset.preset);
  });
  els.loadUserChips?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete-preset]');
    if (del) {
      deleteUserPreset(del.dataset.deletePreset);
      renderUserPresetChips();
      toast?.('Preset removido', 'success');
      return;
    }
    const btn = e.target.closest('.model-load-user-preset');
    if (!btn) return;
    applyUserPreset(btn.dataset.userPreset);
  });
  els.loadSavePresetBtn?.addEventListener('click', () => saveCurrentUserPreset());
  els.loadPresetName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveCurrentUserPreset();
    }
  });
  els.loadForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!loadConfigModel) return;
    const payload = collectLoadConfigPayload();
    if (loadConfigBackend === 'llamacpp') {
      delete payload.keepAlive;
    }
    if (els.loadSavePreset?.checked) writeSavedLoadConfig(loadConfigModel, payload);
    const backend = loadConfigBackend;
    const model = loadConfigModel;
    const ggufPath = loadConfigGgufPath;
    closeLoadConfig();
    if (backend === 'llamacpp') {
      await runLlamaWebLoad(ggufPath, model, payload);
    } else {
      await runModel(model, payload);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.loadOverlay?.classList.contains('hidden')) {
      e.preventDefault();
      closeLoadConfig();
      return;
    }
    if (e.key === 'Escape' && !els.detailOverlay?.classList.contains('hidden')) {
      e.preventDefault();
      closeModelDetail();
      return;
    }
    if (e.key !== 'Escape' || overlay.classList.contains('hidden')) return;
    if (isFolderViewOpen()) {
      e.preventDefault();
      showMainView();
      return;
    }
    closeOverlay();
  });
})();
