const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'troque-esta-senha';
const ANIVERSARIANTE = process.env.ANIVERSARIANTE || 'Aniversariante';
const DATABASE_URL = process.env.DATABASE_URL;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// ---------------------------------------------------------------------------
// Armazenamento: Postgres se DATABASE_URL existir, senão arquivo JSON local.
// Cada assinatura guarda um token secreto que só quem assinou recebe; é ele
// que permite a pessoa editar a própria assinatura (e só a dela).
// ---------------------------------------------------------------------------

function fileStore() {
  let data = { assinaturas: [], presente: null, nextId: 1 };
  if (fs.existsSync(DATA_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { console.error('data.json inválido, começando vazio'); }
  }
  const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

  return {
    async init() {},
    async listar() { return data.assinaturas.slice(); },
    async buscar(id) { return data.assinaturas.find(a => a.id === id) || null; },
    async existeEmail(email, excetoId) { return data.assinaturas.some(a => a.email === email && a.id !== excetoId); },
    async adicionar({ nome, email, mensagem, token }) {
      const a = { id: data.nextId++, nome, email, mensagem, token, criadoEm: new Date().toISOString() };
      data.assinaturas.push(a);
      save();
      return a;
    },
    async atualizar(id, { nome, email, mensagem }) {
      const a = data.assinaturas.find(x => x.id === id);
      if (!a) return null;
      Object.assign(a, { nome, email, mensagem });
      save();
      return a;
    },
    async remover(id) {
      data.assinaturas = data.assinaturas.filter(a => a.id !== id);
      save();
    },
    async getPresente() { return data.presente; },
    async setPresente(p) { data.presente = p; save(); },
  };
}

function pgStore() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  const linha = r => ({ id: r.id, nome: r.nome, email: r.email, mensagem: r.mensagem, token: r.token, criadoEm: r.criado_em.toISOString() });

  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS assinaturas (
          id SERIAL PRIMARY KEY,
          nome TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          mensagem TEXT NOT NULL DEFAULT '',
          criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS token TEXT;
        CREATE TABLE IF NOT EXISTS config (
          chave TEXT PRIMARY KEY,
          valor JSONB
        );
      `);
    },
    async listar() {
      const { rows } = await pool.query('SELECT * FROM assinaturas ORDER BY id');
      return rows.map(linha);
    },
    async buscar(id) {
      const { rows } = await pool.query('SELECT * FROM assinaturas WHERE id = $1', [id]);
      return rows[0] ? linha(rows[0]) : null;
    },
    async existeEmail(email, excetoId) {
      const { rowCount } = await pool.query('SELECT 1 FROM assinaturas WHERE email = $1 AND id <> $2', [email, excetoId || 0]);
      return rowCount > 0;
    },
    async adicionar({ nome, email, mensagem, token }) {
      const { rows } = await pool.query(
        'INSERT INTO assinaturas (nome, email, mensagem, token) VALUES ($1, $2, $3, $4) RETURNING *',
        [nome, email, mensagem, token]
      );
      return linha(rows[0]);
    },
    async atualizar(id, { nome, email, mensagem }) {
      const { rows } = await pool.query(
        'UPDATE assinaturas SET nome = $2, email = $3, mensagem = $4 WHERE id = $1 RETURNING *',
        [id, nome, email, mensagem]
      );
      return rows[0] ? linha(rows[0]) : null;
    },
    async remover(id) { await pool.query('DELETE FROM assinaturas WHERE id = $1', [id]); },
    async getPresente() {
      const { rows } = await pool.query("SELECT valor FROM config WHERE chave = 'presente'");
      return rows[0] ? rows[0].valor : null;
    },
    async setPresente(p) {
      await pool.query(
        "INSERT INTO config (chave, valor) VALUES ('presente', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor",
        [JSON.stringify(p)]
      );
    },
  };
}

const store = DATABASE_URL ? pgStore() : fileStore();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUPLICADO = 'Este e-mail já assinou o cartão.';

function limpar(s, max) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// Valida os campos de uma assinatura; devolve { erro } ou { dados }.
function validar(body) {
  const nome = limpar(body.nome, 80);
  const email = limpar(body.email, 120).toLowerCase();
  const mensagem = limpar(body.mensagem, 500);
  if (nome.length < 2) return { erro: 'Informe seu nome.' };
  if (!EMAIL_RE.test(email)) return { erro: 'Informe um e-mail válido.' };
  return { dados: { nome, email, mensagem } };
}

const publica = ({ id, nome, mensagem, criadoEm }) => ({ id, nome, mensagem, criadoEm });
const semToken = ({ token, ...resto }) => resto;

function rateio(presente, total) {
  if (!presente || !presente.valorTotal || total === 0) return null;
  // Arredonda para cima no centavo, para o total nunca ficar abaixo do valor do presente.
  return Math.ceil((presente.valorTotal * 100) / total) / 100;
}

function mesmoSegredo(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isAdmin(req) {
  return mesmoSegredo(req.get('x-admin-key'), ADMIN_KEY);
}

// Limite simples por IP: no máximo 5 assinaturas a cada 10 minutos.
const tentativas = new Map();
function limitePorIp(req, res, next) {
  const ip = req.ip;
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter(t => agora - t < 10 * 60 * 1000);
  if (lista.length >= 5) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  lista.push(agora);
  tentativas.set(ip, lista);
  next();
}

async function editar(id, req, res) {
  const { erro, dados } = validar(req.body);
  if (erro) return res.status(400).json({ erro });
  if (await store.existeEmail(dados.email, id)) return res.status(409).json({ erro: DUPLICADO });
  try {
    const a = await store.atualizar(id, dados);
    if (!a) return res.status(404).json({ erro: 'Assinatura não encontrada.' });
    res.json(semToken(a));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: DUPLICADO });
    throw e;
  }
}

// Só quem tem o token daquela assinatura passa daqui.
async function donoDaAssinatura(req, res) {
  const a = await store.buscar(Number(req.params.id));
  if (!a || !mesmoSegredo(req.get('x-edit-token'), a.token)) {
    res.status(403).json({ erro: 'Você só pode editar a sua própria assinatura. Se precisar, peça para quem organiza corrigir.' });
    return null;
  }
  return a;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/info', async (req, res, next) => {
  try {
    const [assinaturas, presente] = await Promise.all([store.listar(), store.getPresente()]);
    res.json({
      aniversariante: ANIVERSARIANTE,
      total: assinaturas.length,
      presente,
      valorPorPessoa: rateio(presente, assinaturas.length),
    });
  } catch (e) { next(e); }
});

// Lista pública: sem e-mails nem tokens.
app.get('/api/assinaturas', async (req, res, next) => {
  try { res.json((await store.listar()).map(publica)); } catch (e) { next(e); }
});

app.post('/api/assinaturas', limitePorIp, async (req, res, next) => {
  try {
    const { erro, dados } = validar(req.body);
    if (erro) return res.status(400).json({ erro });
    if (await store.existeEmail(dados.email)) return res.status(409).json({ erro: DUPLICADO });

    const token = crypto.randomBytes(18).toString('base64url');
    const a = await store.adicionar({ ...dados, token });
    // O token só volta aqui, para quem acabou de assinar.
    res.status(201).json({ ...publica(a), token });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: DUPLICADO });
    next(e);
  }
});

app.get('/api/assinaturas/:id', async (req, res, next) => {
  try {
    const a = await donoDaAssinatura(req, res);
    if (a) res.json(semToken(a));
  } catch (e) { next(e); }
});

app.put('/api/assinaturas/:id', async (req, res, next) => {
  try {
    const a = await donoDaAssinatura(req, res);
    if (a) await editar(a.id, req, res);
  } catch (e) { next(e); }
});

// ---- Admin ----

app.use('/api/admin', (req, res, next) => {
  if (!isAdmin(req)) return res.status(401).json({ erro: 'Senha de admin inválida.' });
  next();
});

app.get('/api/admin/assinaturas', async (req, res, next) => {
  try { res.json((await store.listar()).map(semToken)); } catch (e) { next(e); }
});

app.put('/api/admin/assinaturas/:id', async (req, res, next) => {
  try { await editar(Number(req.params.id), req, res); } catch (e) { next(e); }
});

app.delete('/api/admin/assinaturas/:id', async (req, res, next) => {
  try {
    await store.remover(Number(req.params.id));
    res.status(204).end();
  } catch (e) { next(e); }
});

app.put('/api/admin/presente', async (req, res, next) => {
  try {
    const descricao = limpar(req.body.descricao, 200);
    const valorTotal = Number(req.body.valorTotal);
    if (!descricao) {
      await store.setPresente(null);
      return res.json({ presente: null });
    }
    if (!Number.isFinite(valorTotal) || valorTotal <= 0) return res.status(400).json({ erro: 'Valor total inválido.' });
    const presente = { descricao, valorTotal: Math.round(valorTotal * 100) / 100 };
    await store.setPresente(presente);
    res.json({ presente });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
});

store.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Cartão rodando em http://localhost:${PORT} (armazenamento: ${DATABASE_URL ? 'Postgres' : DATA_FILE})`);
    if (ADMIN_KEY === 'troque-esta-senha') console.warn('ATENÇÃO: defina a variável ADMIN_KEY antes de publicar.');
  });
}).catch(err => {
  console.error('Falha ao iniciar o armazenamento:', err);
  process.exit(1);
});
