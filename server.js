const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_PASSWORD = process.env.APP_PASSWORD || 'mude-esta-senha';
const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo-tambem';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Garante que nenhum caminho pedido escapa da pasta de dados (segurança básica)
function safeJoin(base, relPath) {
  const target = path.normalize(path.join(base, relPath || ''));
  const baseNorm = path.normalize(base + path.sep);
  if (!(target + path.sep).startsWith(baseNorm) && target !== path.normalize(base)) {
    throw new Error('Caminho inválido');
  }
  return target;
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Sessão expirada, faça login de novo' });
  }
}

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== APP_PASSWORD) return res.status(401).json({ error: 'Senha incorreta' });
  const token = jwt.sign({ ok: true }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

app.use('/api', authMiddleware);

// ---------- Árvore de pastas ----------
async function buildTree(dir, relPath = '') {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const children = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      const childRel = relPath ? relPath + '/' + e.name : e.name;
      children.push({
        name: e.name,
        path: childRel,
        children: await buildTree(path.join(dir, e.name), childRel),
      });
    }
  }
  children.sort((a, b) => a.name.localeCompare(b.name));
  return children;
}

app.get('/api/tree', async (req, res) => {
  try {
    res.json({ tree: await buildTree(DATA_DIR) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Arquivos de uma pasta ----------
app.get('/api/files', async (req, res) => {
  try {
    const dir = safeJoin(DATA_DIR, req.query.path || '');
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      if (e.isFile()) {
        const stat = await fsp.stat(path.join(dir, e.name));
        files.push({ name: e.name, size: stat.size, modified: stat.mtime });
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Pastas: criar / excluir ----------
app.post('/api/folder', async (req, res) => {
  try {
    const { path: relPath, name } = req.body;
    if (!name || name.includes('/') || name.includes('\\')) {
      return res.status(400).json({ error: 'Nome de pasta inválido' });
    }
    const dir = safeJoin(DATA_DIR, path.join(relPath || '', name));
    await fsp.mkdir(dir);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.code === 'EEXIST' ? 'Já existe uma pasta com esse nome' : e.message });
  }
});

app.delete('/api/folder', async (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'Caminho obrigatório' });
    const dir = safeJoin(DATA_DIR, relPath);
    await fsp.rm(dir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Arquivos: enviar / baixar / renomear / mover / excluir ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

app.post('/api/files', upload.array('files'), async (req, res) => {
  try {
    const dir = safeJoin(DATA_DIR, req.body.path || '');
    for (const f of req.files) {
      await fsp.writeFile(safeJoin(dir, f.originalname), f.buffer);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/download', async (req, res) => {
  try {
    const filePath = safeJoin(DATA_DIR, path.join(req.query.path || '', req.query.name));
    res.download(filePath, req.query.name);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/files', async (req, res) => {
  try {
    const { path: relPath, names } = req.body;
    const dir = safeJoin(DATA_DIR, relPath || '');
    for (const name of names) {
      await fsp.rm(safeJoin(dir, name), { force: true });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/files/rename', async (req, res) => {
  try {
    const { path: relPath, oldName, newName } = req.body;
    const dir = safeJoin(DATA_DIR, relPath || '');
    await fsp.rename(safeJoin(dir, oldName), safeJoin(dir, newName));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/move', async (req, res) => {
  try {
    const { path: relPath, names, destPath } = req.body;
    const dir = safeJoin(DATA_DIR, relPath || '');
    const dest = safeJoin(DATA_DIR, destPath || '');
    for (const name of names) {
      await fsp.rename(safeJoin(dir, name), safeJoin(dest, name));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
