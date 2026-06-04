# Downloader

Painel web para explorar arquivos no servidor e iniciar downloads com **wget**, **curl**, **aria2**, **git** e **Hugging Face CLI**. Inclui histórico persistente, atalhos na sidebar, análise de armazenamento (estilo WinDirStat) e interface responsiva para desktop e mobile.

---

## Funcionalidades

- Login com senha e sessão segura
- Explorador de pastas com breadcrumb e filtros
- Downloads assíncronos com barra de progresso e histórico
- Atalhos personalizados (fixar pasta atual) com drag-and-drop e renomear
- Sidebar com pastas agrupadas e estado expandido/colapsado persistente
- Análise de armazenamento com tabela ordenável e mapa de uso
- Deploy via Docker + Traefik/Coolify

---

## Requisitos

- **Docker** e **Docker Compose** (recomendado para produção)
- Ou **Node.js ≥ 20** para desenvolvimento local
- No container: `wget`, `curl`, `git`, `aria2`, `huggingface-cli` (já incluídos na imagem)

---

## Configuração — o que alterar em outra máquina

Ao publicar ou rodar em outro servidor, ajuste **três áreas**: variáveis de ambiente, volumes Docker e domínio no proxy.

### 1. Variáveis de ambiente (`.env`)

Copie o exemplo e edite:

```bash
cp .env.example .env
```

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `DOWNLOADER_PASSWORD` | Sim | Senha de login do painel |
| `DOWNLOADER_SESSION_SECRET` | Sim | Segredo da sessão (string longa aleatória) |
| `DOWNLOADER_ROOT` | Não | Pasta **real** que o app pode acessar **dentro do container** (padrão: `/host`) |
| `DOWNLOADER_ROOT_LABEL` | Não | Rótulo exibido na UI como raiz (padrão: `/`) |
| `DOWNLOADER_HIST_DIR` | Não | Onde salvar histórico, atalhos e layout da sidebar **no disco do host** |
| `PORT` | Não | Porta interna (padrão: `4020`) |
| `HF_HUB_ENABLE_HF_TRANSFER` | Não | `1` acelera downloads do Hugging Face |
| `HF_TOKEN` | Não | Token HF para modelos privados |

Gerar segredo de sessão:

```bash
openssl rand -hex 32
```

### 2. Onde o app salva dados no servidor

Existem **dois tipos** de caminho:

#### A) Arquivos que você navega e baixa (`DOWNLOADER_ROOT`)

É a raiz do explorador. No Docker, monte o disco do host em `/host`:

```yaml
volumes:
  - /:/host                    # acesso ao filesystem do host
  - /caminho/do/app:/app       # código do app
```

- `DOWNLOADER_ROOT=/host` → o app enxerga `/` do host (com restrições de segurança no código).
- Para limitar a uma pasta específica, monte só ela:

```yaml
volumes:
  - /mnt/dados:/host
```

```env
DOWNLOADER_ROOT=/host
DOWNLOADER_ROOT_LABEL=/mnt/dados
```

#### B) Histórico persistente (`DOWNLOADER_HIST_DIR`)

Jobs, atalhos customizados e layout da sidebar ficam aqui:

```
{DOWNLOADER_HIST_DIR}/
├── jobs/jobs.json
├── shortcuts/shortcuts.json
└── sidebar/sidebar-layout.json
```

Exemplo (como no deploy original):

```env
DOWNLOADER_HIST_DIR=/host/pendriver/downloader_hist
```

No host isso corresponde a `/pendriver/downloader_hist`. Em outra máquina, escolha qualquer pasta persistente, por exemplo:

```env
DOWNLOADER_HIST_DIR=/host/var/lib/downloader/hist
```

Com volume `- /:/host`, o caminho real no host será `/var/lib/downloader/hist`.

> **Importante:** crie a pasta no host ou deixe o app criar na primeira execução (o código faz `mkdir -p` automaticamente).

### 3. `docker-compose.yml` — checklist para outro servidor

Edite estes pontos antes do deploy:

| Item | O que mudar |
|------|-------------|
| `build.context` | Caminho onde o código fica no **host** (ex.: `/opt/downloader`) |
| `volumes` | Montagem do app e do disco (`/:/host` ou pasta específica) |
| `environment.DOWNLOADER_HIST_DIR` | Pasta de histórico no container (via `/host/...`) |
| `labels` Traefik `Host(...)` | Seu domínio (ex.: `downloader.seudominio.com`) |
| `networks.coolify` | Nome da rede do seu Coolify/Traefik (pode ser `coolify` ou outro) |

Exemplo mínimo de volumes para outra pessoa:

```yaml
volumes:
  - /opt/downloader:/app
  - downloader_node_modules:/app/node_modules
  - /:/host
environment:
  DOWNLOADER_ROOT: "/host"
  DOWNLOADER_ROOT_LABEL: "/"
  DOWNLOADER_HIST_DIR: "/host/opt/downloader/data/hist"
```

### 4. Domínio / proxy (`dynamic-proxy.yaml`)

Se usar Traefik file provider, altere a regra de host:

```yaml
rule: 'Host(`downloader.seudominio.com`)'
```

### 5. Atalhos padrão da sidebar (opcional)

Os atalhos iniciais (`pendriver`, `Flux`, etc.) estão em `src/sidebar.js` (`DEFAULT_ROOT`). Em um servidor novo você pode:

- Deixar como está e usar **“Fixar pasta”** na UI para criar atalhos próprios, ou
- Editar `DEFAULT_ROOT` / `DEFAULT_FLUX_CHILDREN` antes do deploy.

---

## Deploy com Docker (Coolify)

1. Clone o repositório no servidor (ex.: `/opt/downloader`).
2. Configure `.env` com senha e segredo.
3. Ajuste `docker-compose.yml` (volumes, domínio, rede).
4. No Coolify: **New Resource → Docker Compose** apontando para este diretório.
5. Defina as variáveis de ambiente no painel (ou use `.env`).
6. Deploy e acesse pelo domínio configurado no Traefik.

Healthcheck: `GET /login` na porta `4020`.

---

## Desenvolvimento local

```bash
cd downloader
npm install
cp .env.example .env
# Edite DOWNLOADER_ROOT para uma pasta local, ex.:
# DOWNLOADER_ROOT=/Users/voce/Downloads
# DOWNLOADER_HIST_DIR=./data/hist

export DOWNLOADER_PASSWORD=sua-senha
export DOWNLOADER_SESSION_SECRET=$(openssl rand -hex 32)
export DOWNLOADER_ROOT=/caminho/local
export DOWNLOADER_HIST_DIR=./data/hist

npm start
```

Abra `http://localhost:4020`.

---

## Estrutura do projeto

```
downloader/
├── public/           # Frontend (HTML, CSS, JS)
├── src/
│   ├── server.js     # API Express
│   ├── paths.js      # Raiz do filesystem (DOWNLOADER_ROOT)
│   ├── histPaths.js  # Histórico persistente (DOWNLOADER_HIST_DIR)
│   ├── downloads.js  # Jobs de download
│   ├── sidebar.js    # Árvore de atalhos
│   └── storageAnalyzer.js
├── docker-compose.yml
├── Dockerfile
├── dynamic-proxy.yaml
└── .env.example
```

---

## Segurança

- **Nunca** commite `.env` com senhas reais (já está no `.gitignore`).
- Use senha forte e `DOWNLOADER_SESSION_SECRET` único por instalação.
- O app expõe o filesystem montado em `DOWNLOADER_ROOT` — restrinja volumes e firewall.
- Mantenha HTTPS via Traefik/Coolify.

---

## Licença

Projeto de uso pessoal / self-hosted. Ajuste a licença conforme sua preferência (MIT, etc.).
