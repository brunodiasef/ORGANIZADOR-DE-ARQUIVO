const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'mude-esta-senha';
const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo-tambem';
const BUCKET = process.env.SUPABASE_BUCKET || 'arquivos';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PLACEHOLDER = '.keep';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function cleanPath(p) {
  return (p || '')
    .split('/')
    .filter(seg => seg && seg !== '.' && seg !== '..')
    .join('/');
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

// ---------- Helpers Supabase ----------
async function listFolder(prefix) {
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });
  if (error) throw new Error(error.message);
  return data || [];
}

function isFolderEntry(entry) {
  // No Supabase Storage, "pastas" aparecem na listagem sem metadata (não são arquivos reais)
  return entry.id === null && !entry.metadata;
}

async function buildTree(prefix) {
  const entries = await listFolder(prefix);
  const folders = entries.filter(isFolderEntry).filter(e => e.name !== PLACEHOLDER);
  folders.sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const f of folders) {
    const childPrefix = prefix ? prefix + '/' + f.name : f.name;
    out.push({ name: f.name, path: childPrefix, children: await buildTree(childPrefix) });
  }
  return out;
}

async function collectAllPaths(prefix, out) {
  const entries = await listFolder(prefix);
  for (const e of entries) {
    const full = prefix ? prefix + '/' + e.name : e.name;
    if (isFolderEntry(e)) {
      await collectAllPaths(full, out);
    } else {
      out.push(full);
    }
  }
}

// ---------- Rotas ----------
app.get('/api/tree', async (req, res) => {
  try {
    res.json({ tree: await buildTree('') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files', async (req, res) => {
  try {
    const prefix = cleanPath(req.query.path);
    const entries = await listFolder(prefix);
    const files = entries
      .filter(e => !isFolderEntry(e) && e.name !== PLACEHOLDER)
      .map(e => ({ name: e.name, size: e.metadata?.size || 0, modified: e.updated_at || e.created_at }));
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/folder', async (req, res) => {
  try {
    const parent = cleanPath(req.body.path);
    const name = (req.body.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\')) {
      return res.status(400).json({ error: 'Nome de pasta inválido' });
    }
    const folderPath = parent ? parent + '/' + name : name;
    const { error } = await supabase.storage.from(BUCKET).upload(folderPath + '/' + PLACEHOLDER, Buffer.from(''), {
      contentType: 'text/plain',
      upsert: false,
    });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message.includes('already exists') ? 'Já existe uma pasta com esse nome' : e.message });
  }
});

app.delete('/api/folder', async (req, res) => {
  try {
    const folderPath = cleanPath(req.body.path);
    if (!folderPath) return res.status(400).json({ error: 'Caminho obrigatório' });
    const all = [];
    await collectAllPaths(folderPath, all);
    all.push(folderPath + '/' + PLACEHOLDER);
    if (all.length) {
      const { error } = await supabase.storage.from(BUCKET).remove(all);
      if (error) throw new Error(error.message);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.post('/api/files', upload.array('files'), async (req, res) => {
  try {
    const folderPath = cleanPath(req.body.path);
    for (const f of req.files) {
      const filePath = folderPath ? folderPath + '/' + f.originalname : f.originalname;
      const { error } = await supabase.storage.from(BUCKET).upload(filePath, f.buffer, { upsert: true });
      if (error) throw new Error(error.message);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/download', async (req, res) => {
  try {
    const folderPath = cleanPath(req.query.path);
    const name = req.query.name;
    const filePath = folderPath ? folderPath + '/' + name : name;
    const { data, error } = await supabase.storage.from(BUCKET).download(filePath);
    if (error) throw new Error(error.message);
    const buf = Buffer.from(await data.arrayBuffer());
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/files', async (req, res) => {
  try {
    const folderPath = cleanPath(req.body.path);
    const names = req.body.names || [];
    const paths = names.map(n => (folderPath ? folderPath + '/' + n : n));
    const { error } = await supabase.storage.from(BUCKET).remove(paths);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/files/rename', async (req, res) => {
  try {
    const folderPath = cleanPath(req.body.path);
    const { oldName, newName } = req.body;
    const from = folderPath ? folderPath + '/' + oldName : oldName;
    const to = folderPath ? folderPath + '/' + newName : newName;
    const { error } = await supabase.storage.from(BUCKET).move(from, to);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/move', async (req, res) => {
  try {
    const folderPath = cleanPath(req.body.path);
    const destPath = cleanPath(req.body.destPath);
    const names = req.body.names || [];
    for (const name of names) {
      const from = folderPath ? folderPath + '/' + name : name;
      const to = destPath ? destPath + '/' + name : name;
      const { error } = await supabase.storage.from(BUCKET).move(from, to);
      if (error) throw new Error(error.message);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
