(function initGpuTerminal() {
  const container = document.getElementById('models-gpu-terminal');
  if (!container) return;

  let term = null;
  let fitAddon = null;
  let ws = null;
  let wantsConnect = false;

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/ai/gpu/terminal`;
  }

  function getTerminalClass() {
    if (typeof Terminal !== 'undefined') return Terminal;
    if (typeof window !== 'undefined' && window.Terminal) return window.Terminal;
    return null;
  }

  function getFitAddonClass() {
    if (typeof FitAddon === 'function') return FitAddon;
    if (typeof FitAddon !== 'undefined' && typeof FitAddon.FitAddon === 'function') return FitAddon.FitAddon;
    return null;
  }

  function ensureTerm() {
    const TerminalClass = getTerminalClass();
    if (term) return term;
    if (!TerminalClass) return null;

    term = new TerminalClass({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SF Mono, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#4d9fff',
      },
      scrollback: 5000,
      convertEol: true,
    });

    const FitAddonClass = getFitAddonClass();
    if (FitAddonClass) {
      fitAddon = new FitAddonClass();
      term.loadAddon(fitAddon);
    }

    container.innerHTML = '';
    term.open(container);

    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    return term;
  }

  function resizeTerm() {
    if (!term) return;
    try {
      if (fitAddon) {
        fitAddon.fit();
      } else {
        const rect = container.getBoundingClientRect();
        const cols = Math.max(40, Math.floor(rect.width / 8));
        const rows = Math.max(12, Math.floor(rect.height / 18));
        term.resize(cols, rows);
      }
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch {
      /* ignore */
    }
  }

  function showLoadError() {
    container.innerHTML =
      '<div class="models-gpu-terminal-fallback">Terminal indisponível — recarregue a página (Ctrl+Shift+R).</div>';
  }

  function openSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    ws = new WebSocket(getWsUrl());

    ws.onmessage = (ev) => {
      if (!term) return;
      if (typeof ev.data === 'string') term.write(ev.data);
      else if (ev.data instanceof Blob) {
        ev.data.text().then((t) => term.write(t));
      }
    };

    ws.onopen = () => resizeTerm();

    ws.onclose = () => {
      if (wantsConnect && term) {
        term.write('\r\n\x1b[90m[conexão encerrada — reconecte na aba Uso GPU]\x1b[0m\r\n');
      }
      ws = null;
    };

    ws.onerror = () => {
      if (!term) return;
      term.write('\r\n\x1b[31mFalha na conexão com o terminal GPU.\x1b[0m\r\n');
      term.write('\x1b[90mVerifique sudo nvtop e /dev/nvidia* no container.\x1b[0m\r\n');
    };
  }

  function connect({ reset = false } = {}) {
    wantsConnect = true;
    if (!ensureTerm()) {
      showLoadError();
      return;
    }
    if (reset) {
      term.clear();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
    }
    openSocket();
    requestAnimationFrame(() => resizeTerm());
  }

  function disconnect() {
    wantsConnect = false;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
  }

  window.addEventListener('resize', () => {
    if (wantsConnect) resizeTerm();
  });

  window.gpuTerminal = {
    connect,
    disconnect,
    resize: resizeTerm,
    isConnected: () => ws?.readyState === WebSocket.OPEN,
  };
})();
