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
    && pip3 install --no-cache-dir --break-system-packages "huggingface_hub[cli]" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev \
    && rm -rf /root/.npm

COPY . .

EXPOSE 4020

CMD ["npm", "start"]
