#!/bin/sh
set -e
cd /app

# O volume downloader_node_modules persiste entre deploys — sincroniza deps novas (ex.: ws, node-pty)
if [ -f package.json ]; then
  npm install --omit=dev --no-audit --no-fund
fi

if ! command -v nvtop >/dev/null 2>&1 && ! test -x /usr/local/bin/nvtop; then
  echo "[downloader] AVISO: nvtop não encontrado no container — faça rebuild da imagem (docker compose build --no-cache)"
fi

if command -v nvidia-smi >/dev/null 2>&1; then
  if nvidia-smi -L >/dev/null 2>&1; then
    echo "[downloader] NVIDIA NVML OK no container"
  else
    echo "[downloader] AVISO: nvidia-smi presente mas sem GPU/NVML — instale nvidia-container-toolkit no host e use gpus: all no compose"
  fi
else
  echo "[downloader] AVISO: nvidia-smi ausente no container — nvtop pode mostrar 'No GPU to monitor'"
fi

exec "$@"
