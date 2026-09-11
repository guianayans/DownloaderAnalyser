const { spawn, execSync } = require('child_process');
const fs = require('fs');

let WebSocketServer = null;
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch (err) {
  console.warn('[downloader] Pacote "ws" não instalado — terminal GPU desativado.', err.message);
}

const GPU_TERMINAL_MODE = (process.env.GPU_TERMINAL_MODE || 'container').trim().toLowerCase();
const GPU_NSENTER_PID = (process.env.GPU_NSENTER_PID || '1').trim();
const GPU_FALLBACK_CMD =
  (process.env.GPU_FALLBACK_CMD || 'nvidia-smi dmon -s pucvmet -d 1').trim();
const DEFAULT_GPU_CMD = (process.env.GPU_TERMINAL_CMD || 'nvtop').trim();

let ptySpawn = null;
let ptySpawnChecked = false;

function getPtySpawn() {
  if (ptySpawnChecked) return ptySpawn;
  ptySpawnChecked = true;
  try {
    ptySpawn = require('node-pty').spawn;
  } catch (err) {
    console.warn('[downloader] node-pty indisponível — terminal GPU sem PTY.', err.message);
    ptySpawn = null;
  }
  return ptySpawn;
}

function containerEnv(extra = {}) {
  const env = { ...process.env, ...extra, TERM: 'xterm-256color' };
  delete env.LD_PRELOAD;
  if (env.LD_LIBRARY_PATH?.includes('/host/')) {
    const cleaned = env.LD_LIBRARY_PATH.split(':').filter((p) => p && !p.startsWith('/host/'));
    if (cleaned.length) env.LD_LIBRARY_PATH = cleaned.join(':');
    else delete env.LD_LIBRARY_PATH;
  }
  return env;
}

function findExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.startsWith('/host/')) continue;
    if (candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    try {
      const found = execSync(`command -v ${candidate}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: containerEnv(),
      }).trim();
      if (found && !found.startsWith('/host/')) return found;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function hasContainerGpuDevices() {
  return (
    fs.existsSync('/dev/nvidia0') ||
    fs.existsSync('/dev/dri/card0') ||
    fs.existsSync('/dev/kfd')
  );
}

function hasHostGpuDevices() {
  return (
    fs.existsSync('/host/dev/nvidia0') ||
    fs.existsSync('/host/dev/dri/card0') ||
    fs.existsSync('/host/dev/kfd')
  );
}

function hasNsenter() {
  return Boolean(findExecutable(['nsenter', '/usr/bin/nsenter']));
}

function buildHostNsCommand(hostBin, args, label) {
  const nsenter = findExecutable(['nsenter', '/usr/bin/nsenter']);
  return {
    bin: nsenter,
    args: ['-t', GPU_NSENTER_PID, '-m', '-u', '-i', '-n', '-p', '--', hostBin, ...args],
    label: label || `${hostBin} (host)`,
    usePty: true,
    env: containerEnv(),
    viaHostNs: true,
  };
}

function resolveContainerNvtop() {
  return findExecutable(['/usr/local/bin/nvtop', '/usr/bin/nvtop', '/bin/nvtop', 'nvtop']);
}

function resolveContainerNvidiaSmi() {
  return findExecutable([
    '/usr/bin/nvidia-smi',
    '/usr/local/nvidia/bin/nvidia-smi',
    'nvidia-smi',
  ]);
}

function testNvml() {
  const smi = resolveContainerNvidiaSmi();
  if (!smi) return false;
  try {
    execSync(`"${smi}" -L`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: containerEnv(),
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

function buildNvidiaSmiDmonCommand() {
  const smi = resolveContainerNvidiaSmi();
  if (!smi) return null;
  const args = GPU_FALLBACK_CMD.replace(/^nvidia-smi\s*/, '').split(/\s+/).filter(Boolean);
  const dmonArgs = args.length ? args : ['dmon', '-s', 'pucvmet', '-d', '1'];
  return {
    bin: smi,
    args: dmonArgs,
    label: `${smi} ${dmonArgs.join(' ')}`,
    usePty: true,
    env: containerEnv(),
  };
}

function normalizeGpuCmd(raw) {
  let cmd = (raw || 'nvtop').trim().replace(/^sudo\s+(-n\s+)?/, '');
  if (cmd.startsWith('/host/')) {
    cmd = cmd.slice('/host'.length) || 'nvtop';
  }
  return cmd;
}

function isNvtopCommand(raw) {
  return /nvtop/i.test(raw || '');
}

function buildNvtopCommand() {
  const containerNvtop = resolveContainerNvtop();

  if (containerNvtop) {
    return {
      bin: containerNvtop,
      args: [],
      label: containerNvtop,
      usePty: true,
      env: containerEnv(),
      allowHostNsFallback: true,
    };
  }

  const useHostNs =
    GPU_TERMINAL_MODE === 'host' ||
    (GPU_TERMINAL_MODE === 'auto' && hasHostGpuDevices() && hasNsenter());

  if (useHostNs && hasNsenter()) {
    return buildHostNsCommand('/usr/bin/nvtop', [], '/usr/bin/nvtop (host ns)');
  }

  return null;
}

function resolveGpuCommand() {
  const custom = normalizeGpuCmd(process.env.GPU_TERMINAL_CMD || DEFAULT_GPU_CMD);

  if (isNvtopCommand(custom)) {
    if (!testNvml()) {
      const dmon = buildNvidiaSmiDmonCommand();
      if (dmon) return dmon;
    }
    const nvtopCmd = buildNvtopCommand();
    if (nvtopCmd) return nvtopCmd;
  }

  const nvidiaSmi = resolveContainerNvidiaSmi();
  const useHostNs =
    GPU_TERMINAL_MODE === 'host' ||
    (GPU_TERMINAL_MODE === 'auto' && !nvidiaSmi && hasHostGpuDevices() && hasNsenter());

  if (useHostNs && hasNsenter()) {
    const args = GPU_FALLBACK_CMD.replace(/^nvidia-smi\s*/, '').split(/\s+/).filter(Boolean);
    return buildHostNsCommand(
      '/usr/bin/nvidia-smi',
      args.length ? args : ['dmon', '-s', 'pucvmet', '-d', '1'],
      'nvidia-smi dmon (host ns)'
    );
  }

  if (nvidiaSmi) {
    const args = GPU_FALLBACK_CMD.replace(/^nvidia-smi\s*/, '').split(/\s+/).filter(Boolean);
    return {
      bin: nvidiaSmi,
      args,
      label: args.length ? `${nvidiaSmi} ${args.join(' ')}` : nvidiaSmi,
      usePty: Boolean(args.length),
      env: containerEnv(),
      pollQuery: !args.length,
    };
  }

  return buildNvtopCommand();
}

function verifyWsSession(req, sessionMiddleware) {
  return new Promise((resolve, reject) => {
    sessionMiddleware(req, {}, () => {
      if (req.session?.authenticated) resolve();
      else reject(new Error('Não autenticado'));
    });
  });
}

function attachGpuTerminal(httpServer, sessionMiddleware) {
  if (!WebSocketServer) {
    console.warn('[downloader] WebSocket indisponível — rebuild/restart após npm install.');
    return;
  }

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    if (!req.url?.startsWith('/api/ai/gpu/terminal')) {
      return;
    }

    try {
      await verifyWsSession(req, sessionMiddleware);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      startGpuStream(ws);
    });
  });

  const pingTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  wss.on('close', () => clearInterval(pingTimer));

  const preview = resolveGpuCommand();
  const containerNvtop = resolveContainerNvtop();
  const smi = resolveContainerNvidiaSmi();
  const nvmlOk = testNvml();
  console.log(
    `[downloader] GPU terminal: ${preview?.label || 'indisponível'} | nvtop=${containerNvtop || 'NÃO'} | nvidia-smi=${smi || 'NÃO'} | NVML=${nvmlOk} | /dev/nvidia*=${hasContainerGpuDevices()}`
  );
  if (!nvmlOk) {
    console.warn(
      '[downloader] NVML indisponível no container — use gpus: all + nvidia-container-toolkit no host (fallback: nvidia-smi dmon ou nsenter)'
    );
  }
}

function startPollingSmi(ws, nvidiaSmi) {
  const queryArgs = [
    '--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits',
  ];

  const runSnapshot = () => {
    if (ws.readyState !== ws.OPEN) return;
    const snap = spawn(nvidiaSmi, queryArgs, { env: containerEnv() });
    let out = '';
    let err = '';
    snap.stdout.on('data', (d) => {
      out += d.toString();
    });
    snap.stderr.on('data', (d) => {
      err += d.toString();
    });
    snap.on('close', (code) => {
      if (ws.readyState !== ws.OPEN) return;
      if (code !== 0) {
        ws.send(`\x1b[31m${(err || `nvidia-smi falhou (${code})`).trim()}\x1b[0m\r\n`);
        ws.send('\x1b[90mMonte /dev/nvidia* no container ou instale nvidia-smi no container.\x1b[0m\r\n\r\n');
        return;
      }
      const ts = new Date().toLocaleTimeString('pt-BR');
      ws.send(`\x1b[90m── ${ts} ──\x1b[0m\r\n`);
      ws.send(`${out.trim()}\r\n\r\n`);
    });
  };

  runSnapshot();
  return setInterval(runSnapshot, 1000);
}

function startGpuStream(ws, cmd = resolveGpuCommand(), depth = 0) {
  let cleaned = false;
  let ptyProcess = null;
  let childProcess = null;
  let pollTimer = null;
  let sawNoGpu = false;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (pollTimer) clearInterval(pollTimer);
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch {
        /* ignore */
      }
    }
    if (childProcess) {
      try {
        childProcess.kill();
      } catch {
        /* ignore */
      }
    }
  }

  ws.on('close', cleanup);

  if (!cmd) {
    ws.send('\r\n\x1b[31mGPU monitor indisponível.\x1b[0m\r\n');
    ws.send('Rebuild da imagem: nvtop deve estar instalado no container (apt install nvtop).\r\n');
    ws.send('Não use binários do host (/host/usr/bin/...) — glibc incompatível.\r\n');
    return;
  }

  ws.send(`\r\n\x1b[36m$ ${cmd.label}\x1b[0m\r\n\r\n`);

  const ptySpawnFn = getPtySpawn();
  if (cmd.usePty && ptySpawnFn) {
    try {
      ptyProcess = ptySpawnFn(cmd.bin, cmd.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: process.env.HOME || '/',
        env: cmd.env || containerEnv(),
      });

      ptyProcess.onData((data) => {
        if (ws.readyState !== ws.OPEN) return;
        if (/no gpu to monitor/i.test(data)) sawNoGpu = true;
        ws.send(data);
      });

      ptyProcess.onExit(({ exitCode } = {}) => {
        if (depth < 2 && sawNoGpu) {
          const smi = resolveContainerNvidiaSmi();
          if (smi) {
            ws.send('\r\n\x1b[33mNVML invisível ao nvtop — usando nvidia-smi…\x1b[0m\r\n\r\n');
            cleanup();
            cleaned = false;
            const dmon = buildNvidiaSmiDmonCommand();
            if (dmon) {
              startGpuStream(ws, dmon, depth + 1);
              return;
            }
            pollTimer = startPollingSmi(ws, smi);
            return;
          }
        }
        if (depth < 2 && sawNoGpu && cmd.allowHostNsFallback && hasNsenter()) {
          ws.send('\r\n\x1b[33mSem GPU no container — tentando nvtop no namespace do host…\x1b[0m\r\n\r\n');
          cleanup();
          cleaned = false;
          startGpuStream(ws, buildHostNsCommand('/usr/bin/nvtop', [], '/usr/bin/nvtop (host ns)'), depth + 1);
          return;
        }
        if (depth < 2 && sawNoGpu) {
          const smi = resolveContainerNvidiaSmi();
          if (smi) {
            ws.send('\r\n\x1b[33mUsando nvidia-smi…\x1b[0m\r\n\r\n');
            cleanup();
            cleaned = false;
            pollTimer = startPollingSmi(ws, smi);
            return;
          }
        }
        if (exitCode !== 0 && exitCode != null) {
          ws.send(`\r\n\x1b[33m[encerrado · código ${exitCode}]\x1b[0m\r\n`);
        } else {
          ws.send('\r\n\x1b[33m[encerrado]\x1b[0m\r\n');
        }
        cleanup();
      });

      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'resize' && ptyProcess?.resize) {
            ptyProcess.resize(Math.max(10, data.cols || 120), Math.max(5, data.rows || 32));
          } else if (data.type === 'input' && ptyProcess?.write) {
            ptyProcess.write(data.data || '');
          }
        } catch {
          /* ignore */
        }
      });
      return;
    } catch (err) {
      ws.send(`\x1b[33mPTY falhou (${err.message})\x1b[0m\r\n\r\n`);
    }
  }

  if (cmd.pollQuery) {
    pollTimer = startPollingSmi(ws, cmd.bin);
    return;
  }

  if (cmd.args.length && cmd.label.includes('dmon')) {
    childProcess = spawn(cmd.bin, cmd.args, { env: containerEnv() });
    childProcess.stdout.on('data', (d) => {
      if (ws.readyState === ws.OPEN) ws.send(d.toString());
    });
    childProcess.stderr.on('data', (d) => {
      if (ws.readyState === ws.OPEN) ws.send(`\x1b[31m${d.toString()}\x1b[0m`);
    });
    childProcess.on('close', (code) => {
      if (code !== 0 && depth < 1) {
        const smi = resolveContainerNvidiaSmi();
        if (smi) {
          ws.send('\r\n\x1b[33mFallback nvidia-smi…\x1b[0m\r\n\r\n');
          cleanup();
          cleaned = false;
          pollTimer = startPollingSmi(ws, smi);
          return;
        }
      }
      cleanup();
    });
    return;
  }

  pollTimer = startPollingSmi(ws, cmd.bin);
}

module.exports = {
  attachGpuTerminal,
  resolveGpuCommand,
  hasContainerGpuDevices,
  hasHostGpuDevices,
  resolveContainerNvtop,
};
