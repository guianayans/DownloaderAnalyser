const fs = require('fs');
const path = require('path');
const { listCustomShortcuts, updateCustomShortcut } = require('./shortcuts');
const { PATHS, ensureHistDirs } = require('./histPaths');

const LAYOUT_FILE = PATHS.sidebar;

const DEFAULT_FLUX_CHILDREN = [
  { id: 'flux:raiz', type: 'link', label: 'Raiz', path: 'pendriver/flux' },
  { id: 'flux:models', type: 'link', label: 'Models', path: 'pendriver/flux/models' },
  { id: 'flux:checkpoints', type: 'link', label: 'Checkpoints', path: 'pendriver/flux/models/checkpoints' },
  { id: 'flux:loras', type: 'link', label: 'Loras', path: 'pendriver/flux/models/loras' },
  { id: 'flux:text-encoders', type: 'link', label: 'Text encoders', path: 'pendriver/flux/models/text_encoders' },
  { id: 'flux:diffusion', type: 'link', label: 'Diffusion', path: 'pendriver/flux/models/diffusion_models' },
  { id: 'flux:vae', type: 'link', label: 'VAE', path: 'pendriver/flux/models/vae' },
  { id: 'flux:upscale', type: 'link', label: 'Upscale', path: 'pendriver/flux/models/latent_upscale_models' },
];

const DEFAULT_ROOT = [
  { id: 'link:pendriver', type: 'link', label: 'pendriver', path: 'pendriver' },
  {
    id: 'folder:flux',
    type: 'folder',
    label: 'Flux',
    path: 'pendriver/flux',
    children: DEFAULT_FLUX_CHILDREN,
  },
];

const DEFAULT_ROOT_ORDER = ['link:pendriver', 'folder:flux'];
const DEFAULT_CHILD_ORDERS = {
  'folder:flux': DEFAULT_FLUX_CHILDREN.map((item) => item.id),
};

function ensureDataDir() {
  ensureHistDirs();
}

function defaultLayout() {
  return {
    rootOrder: [...DEFAULT_ROOT_ORDER],
    childOrders: JSON.parse(JSON.stringify(DEFAULT_CHILD_ORDERS)),
    labels: {},
    foldersOpen: {},
  };
}

function loadLayout() {
  ensureDataDir();
  if (!fs.existsSync(LAYOUT_FILE)) return defaultLayout();

  try {
    const raw = fs.readFileSync(LAYOUT_FILE, 'utf8');
    const data = JSON.parse(raw);
    const base = defaultLayout();
    return {
      rootOrder: Array.isArray(data.rootOrder) ? data.rootOrder : base.rootOrder,
      childOrders:
        data.childOrders && typeof data.childOrders === 'object'
          ? { ...base.childOrders, ...data.childOrders }
          : base.childOrders,
      labels: data.labels && typeof data.labels === 'object' ? data.labels : {},
      foldersOpen:
        data.foldersOpen && typeof data.foldersOpen === 'object' ? { ...data.foldersOpen } : {},
    };
  } catch (err) {
    console.error('[downloader] Falha ao carregar layout da sidebar:', err.message);
    return defaultLayout();
  }
}

function saveLayout(layout) {
  ensureDataDir();
  const payload = JSON.stringify({ ...layout, updatedAt: new Date().toISOString() }, null, 2);
  const tmp = `${LAYOUT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmp, LAYOUT_FILE);
}

function labelFor(id, fallback) {
  const layout = loadLayout();
  return layout.labels[id]?.trim() || fallback;
}

function orderIds(ids, preferredOrder, allIds) {
  const valid = new Set(allIds);
  const seen = new Set();
  const ordered = [];

  for (const id of preferredOrder || []) {
    if (!valid.has(id) || seen.has(id)) continue;
    ordered.push(id);
    seen.add(id);
  }

  for (const id of allIds) {
    if (seen.has(id)) continue;
    ordered.push(id);
    seen.add(id);
  }

  return ordered;
}

function buildCustomFolder(customShortcuts) {
  if (!customShortcuts.length) return null;
  return {
    id: 'folder:custom',
    type: 'folder',
    label: labelFor('folder:custom', 'Meus atalhos'),
    path: null,
    custom: true,
    children: customShortcuts.map((s) => ({
      id: s.id,
      type: 'link',
      label: s.label,
      path: s.path,
      custom: true,
      displayPath: s.displayPath,
    })),
  };
}

function getDefaultNode(id) {
  for (const node of DEFAULT_ROOT) {
    if (node.id === id) return node;
    if (node.type === 'folder') {
      const child = node.children.find((c) => c.id === id);
      if (child) return child;
    }
  }
  return null;
}

function getSidebarTree() {
  const layout = loadLayout();
  const customShortcuts = listCustomShortcuts();
  const customFolder = buildCustomFolder(customShortcuts);

  const rootNodes = [...DEFAULT_ROOT];
  if (customFolder) rootNodes.push(customFolder);

  const rootIds = rootNodes.map((n) => n.id);
  const rootOrder = orderIds(layout.rootOrder, layout.rootOrder, rootIds);

  const tree = rootOrder
    .map((id) => rootNodes.find((n) => n.id === id))
    .filter(Boolean)
    .map((node) => {
      if (node.type === 'link') {
        return { ...node, label: labelFor(node.id, node.label) };
      }

      const childIds = node.children.map((c) => c.id);
      const preferred = node.custom
        ? layout.childOrders['folder:custom'] || childIds
        : layout.childOrders[node.id] || childIds;
      const childOrder = orderIds(preferred, preferred, childIds);

      const children = childOrder
        .map((cid) => node.children.find((c) => c.id === cid))
        .filter(Boolean)
        .map((child) => ({
          ...child,
          label: child.custom ? child.label : labelFor(child.id, child.label),
        }));

      return {
        ...node,
        label: labelFor(node.id, node.label),
        children,
      };
    });

  return {
    tree,
    paths: collectPaths(tree),
    foldersOpen: layout.foldersOpen && typeof layout.foldersOpen === 'object' ? { ...layout.foldersOpen } : {},
  };
}

function collectPaths(nodes) {
  const paths = new Set();
  for (const node of nodes) {
    if (node.path) paths.add(node.path);
    if (node.children) {
      for (const child of node.children) {
        if (child.path) paths.add(child.path);
      }
    }
  }
  return [...paths];
}

function validateLabel(label) {
  const next = (label || '').trim();
  if (!next) throw new Error('Nome do atalho não pode ser vazio.');
  if (next.length > 80) throw new Error('Nome do atalho muito longo (máx. 80 caracteres).');
  return next;
}

function updateSidebarLabel(id, label) {
  const next = validateLabel(label);
  const custom = listCustomShortcuts();
  const isCustom = custom.some((s) => s.id === id);

  if (isCustom) {
    return updateCustomShortcut(id, { label: next });
  }

  const layout = loadLayout();
  const { tree } = getSidebarTree();
  const exists =
    tree.some((n) => n.id === id) || tree.some((n) => n.children?.some((c) => c.id === id));
  if (!exists) throw new Error('Atalho não encontrado.');

  layout.labels[id] = next;
  saveLayout(layout);
  return { id, label: next };
}

function reorderSidebar(containerId, orderedIds) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    throw new Error('Lista de atalhos inválida.');
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new Error('Lista de atalhos contém IDs duplicados.');
  }

  const { tree } = getSidebarTree();
  let expectedIds;

  if (containerId === 'root') {
    expectedIds = tree.map((n) => n.id);
  } else {
    const folder = tree.find((n) => n.id === containerId);
    if (!folder) throw new Error('Grupo de atalhos não encontrado.');
    expectedIds = folder.children.map((c) => c.id);
  }

  if (orderedIds.length !== expectedIds.length) {
    throw new Error('A lista de reordenação deve incluir todos os atalhos do grupo.');
  }
  if (!orderedIds.every((id) => expectedIds.includes(id))) {
    throw new Error('Atalho inválido para este grupo.');
  }

  const layout = loadLayout();
  if (containerId === 'root') {
    layout.rootOrder = orderedIds;
  } else {
    layout.childOrders[containerId] = orderedIds;
  }
  saveLayout(layout);
  return getSidebarTree();
}

function updateFolderOpen(id, open) {
  const { tree } = getSidebarTree();
  const folder = tree.find((n) => n.id === id && n.type === 'folder');
  if (!folder) throw new Error('Pasta de atalhos não encontrada.');

  const layout = loadLayout();
  if (!layout.foldersOpen || typeof layout.foldersOpen !== 'object') {
    layout.foldersOpen = {};
  }
  layout.foldersOpen[id] = Boolean(open);
  saveLayout(layout);
  return getSidebarTree();
}

module.exports = {
  getSidebarTree,
  updateSidebarLabel,
  reorderSidebar,
  updateFolderOpen,
  DEFAULT_ROOT,
};
