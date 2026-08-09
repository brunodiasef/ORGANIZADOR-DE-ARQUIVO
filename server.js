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

// O Supabase Storage só aceita um conjunto limitado de caracteres nas chaves
// (nem tudo que é "URL-safe" passa). Para permitir qualquer nome de pasta/arquivo
// (acentos, º, espaços, parênteses, emojis, o que for), cada "segmento" do caminho
// é convertido para base64url (só letras, números, - e _) ao falar com o Supabase,
// e convertido de volta ao nome original ao mostrar para o usuário.
function encodeSeg(s) {
  return Buffer.from(String(s), 'utf8').toString('base64url');
}
function decodeSeg(s) {
  try {
    return Buffer.from(String(s), 'base64url').toString('utf8');
  } catch (e) {
    return s;
  }
}
function encodePath(logicalPath) {
  return (logicalPath || '').split('/').filter(Boolean).map(encodeSeg).join('/');
}
function decodePath(storageKey) {
  return (storageKey || '').split('/').filter(Boolean).map(decodeSeg).join('/');
}
function encodeName(name) {
  return encodeSeg(name);
}
function decodeName(name) {
  return decodeSeg(name);
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

// ---------- Helpers Supabase (trabalham em "storage key", ou seja, caminho já codificado) ----------
async function listFolder(storagePrefix) {
  const { data, error } = await supabase.storage.from(BUCKET).list(storagePrefix, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });
  if (error) throw new Error(error.message);
  return data || [];
}

function isFolderEntry(entry) {
  return entry.id === null && !entry.metadata;
}

async function buildTree(storagePrefix) {
  const entries = await listFolder(storagePrefix);
  const folders = entries.filter(isFolderEntry).filter(e => e.name !== PLACEHOLDER);
  folders.sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const f of folders) {
    const childStorage = storagePrefix ? storagePrefix + '/' + f.name : f.name;
    out.push({
      name: decodeName(f.name),
      path: decodePath(childStorage),
      children: await buildTree(childStorage),
    });
  }
  return out;
}

async function collectAllPaths(storagePrefix, out) {
  const entries = await listFolder(storagePrefix);
  for (const e of entries) {
    const full = storagePrefix ? storagePrefix + '/' + e.name : e.name;
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
    const storagePrefix = encodePath(cleanPath(req.query.path));
    const entries = await listFolder(storagePrefix);
    const files = entries
      .filter(e => !isFolderEntry(e) && e.name !== PLACEHOLDER)
      .map(e => ({ name: decodeName(e.name), size: e.metadata?.size || 0, modified: e.updated_at || e.created_at }));
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/folder', async (req, res) => {
  try {
    const parentLogical = cleanPath(req.body.path);
    const name = (req.body.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\')) {
      return res.status(400).json({ error: 'Nome de pasta inválido' });
    }
    const parentStorage = encodePath(parentLogical);
    const folderStorageKey = parentStorage ? parentStorage + '/' + encodeName(name) : encodeName(name);
    const { error } = await supabase.storage.from(BUCKET).upload(folderStorageKey + '/' + PLACEHOLDER, Buffer.from(''), {
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
    const logicalPath = cleanPath(req.body.path);
    if (!logicalPath) return res.status(400).json({ error: 'Caminho obrigatório' });
    const storageKey = encodePath(logicalPath);
    const all = [];
    await collectAllPaths(storageKey, all);
    all.push(storageKey + '/' + PLACEHOLDER);
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
    const storageKey = encodePath(cleanPath(req.body.path));
    for (const f of req.files) {
      const filePath = storageKey ? storageKey + '/' + encodeName(f.originalname) : encodeName(f.originalname);
      const { error } = await supabase.storage.from(BUCKET).upload(filePath, f.buffer, {
        upsert: true,
        contentType: f.mimetype || 'application/octet-stream',
      });
      if (error) throw new Error(error.message);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/download', async (req, res) => {
  try {
    const storageKey = encodePath(cleanPath(req.query.path));
    const name = req.query.name;
    const filePath = storageKey ? storageKey + '/' + encodeName(name) : encodeName(name);
    const { data, error } = await supabase.storage.from(BUCKET).download(filePath);
    if (error) throw new Error(error.message);
    const buf = Buffer.from(await data.arrayBuffer());
    if (data.type) res.type(data.type);
    res.setHeader('Content-Disposition', 'inline; filename="' + name + '"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/files', async (req, res) => {
  try {
    const storageKey = encodePath(cleanPath(req.body.path));
    const names = req.body.names || [];
    const paths = names.map(n => (storageKey ? storageKey + '/' + encodeName(n) : encodeName(n)));
    const { error } = await supabase.storage.from(BUCKET).remove(paths);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/files/rename', async (req, res) => {
  try {
    const storageKey = encodePath(cleanPath(req.body.path));
    const { oldName, newName } = req.body;
    const from = storageKey ? storageKey + '/' + encodeName(oldName) : encodeName(oldName);
    const to = storageKey ? storageKey + '/' + encodeName(newName) : encodeName(newName);
    const { error } = await supabase.storage.from(BUCKET).move(from, to);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/move', async (req, res) => {
  try {
    const storageKey = encodePath(cleanPath(req.body.path));
    const destStorageKey = encodePath(cleanPath(req.body.destPath));
    const names = req.body.names || [];
    for (const name of names) {
      const from = storageKey ? storageKey + '/' + encodeName(name) : encodeName(name);
      const to = destStorageKey ? destStorageKey + '/' + encodeName(name) : encodeName(name);
      const { error } = await supabase.storage.from(BUCKET).move(from, to);
      if (error) throw new Error(error.message);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
