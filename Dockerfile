FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    git \
    aria2 \
    ca-certificates \
    python3 \
    python3-pip \
    build-essential \
    util-linux \
    cmake \
    pkg-config \
    libncurses-dev \
    libtinfo-dev \
    libdrm-dev \
    libudev-dev \
    libsystemd-dev \
    && git clone --depth 1 https://github.com/Syllo/nvtop.git /tmp/nvtop \
    && cmake -S /tmp/nvtop -B /tmp/nvtop/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DNVIDIA_SUPPORT=ON \
        -DAMDGPU_SUPPORT=OFF \
        -DINTEL_SUPPORT=OFF \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
    && cmake --build /tmp/nvtop/build -j"$(nproc)" \
    && cmake --install /tmp/nvtop/build \
    && rm -rf /tmp/nvtop \
    && test -x /usr/local/bin/nvtop \
    && pip3 install --no-cache-dir --break-system-packages "huggingface_hub[cli]" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && rm -rf /root/.npm

COPY . .

RUN mkdir -p public/vendor/xterm public/vendor/xterm-addon-fit \
    && curl -fsSL -o public/vendor/xterm/xterm.min.js "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js" \
    && curl -fsSL -o public/vendor/xterm/xterm.min.css "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" \
    && curl -fsSL -o public/vendor/xterm-addon-fit/addon-fit.min.js "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"

RUN chmod +x docker-entrypoint.sh

EXPOSE 4020

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]
