'use strict';
const path = require('path');
const express = require('express');
const db = require('./src/db');
const A = require('./src/auth');
const agendador = require('./src/agendador');

async function criarApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.use('/api/painel', require('./src/rotas/painel'));
  app.use('/api/app', require('./src/rotas/app'));
  app.get('/api/saude', async (req, res) => {
    const t = await db.one(`SELECT valor, atualizado_em FROM pulse_agendador WHERE chave = 'ultimo_tick'`);
    res.json({ ok: true, ultimo_tick: t ? t.atualizado_em : null });
  });
  app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
  app.use('/app', express.static(path.join(__dirname, 'public', 'app')));
  app.get('/', (req, res) => res.redirect('/app/'));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || (err.code === '23505' ? 409 : 500);
    if (status >= 500) console.error(err);
    const msg = err.code === '23505' ? 'Registro duplicado (já existe)' : (status >= 500 ? 'Erro interno' : err.message);
    res.status(status).json({ erro: msg });
  });
  return app;
}

async function primeiroAdmin() {
  const n = await db.one('SELECT COUNT(*)::int AS n FROM pulse_usuarios');
  if (n.n > 0) return;
  const login = process.env.ADMIN_LOGIN; const senha = process.env.ADMIN_SENHA;
  if (!login || !senha) { console.warn('Nenhum usuário do painel. Defina ADMIN_LOGIN e ADMIN_SENHA e reinicie para criar o primeiro admin.'); return; }
  await db.q(`INSERT INTO pulse_usuarios (nome, login, senha_hash, perfil) VALUES ($1,$2,$3,'admin')`, [process.env.ADMIN_NOME || 'Administrador', login, A.hashSenha(senha)]);
  console.log(`Admin "${login}" criado.`);
}

if (require.main === module) {
  (async () => {
    A.assinar({ teste: 1 }); // falha cedo se SESSION_SECRET não estiver definido
    await db.migrate();
    await primeiroAdmin();
    const app = await criarApp();
    const porta = Number(process.env.PORT || 3000);
    app.listen(porta, () => console.log(`Pulse em http://localhost:${porta}  (painel: /admin/  ·  app: /app/)`));
    if (process.env.AGENDADOR !== 'off') agendador.iniciar(console);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { criarApp };
