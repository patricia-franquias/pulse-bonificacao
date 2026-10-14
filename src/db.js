'use strict';
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const D = require('./defaults');

// DATE como texto ISO (evita deslocamento de fuso); NUMERIC como número.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => parseInt(v, 10));

let pool = null;
function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  }
  return pool;
}
function setPool(p) { pool = p; }

const q = (text, params) => getPool().query(text, params);
async function one(text, params) { const r = await q(text, params); return r.rows[0] || null; }
async function many(text, params) { const r = await q(text, params); return r.rows; }

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await q(sql);
  for (const [chave, valor, descricao] of D.CONFIG) {
    await q('INSERT INTO pulse_configuracoes (chave, valor, descricao) VALUES ($1, $2, $3) ON CONFLICT (chave) DO UPDATE SET descricao = EXCLUDED.descricao',
      [chave, JSON.stringify(valor), descricao]);
  }
  const nNiv = await one('SELECT COUNT(*)::int AS n FROM pulse_niveis');
  if (nNiv.n === 0) for (const [nivel, nome, xp] of D.NIVEIS) await q('INSERT INTO pulse_niveis VALUES ($1,$2,$3)', [nivel, nome, xp]);
  for (const [codigo, nome, descricao, tipo, meta, raridade] of D.CONQUISTAS) {
    await q('INSERT INTO pulse_conquistas (codigo, nome, descricao, tipo, meta, raridade) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (codigo) DO NOTHING',
      [codigo, nome, descricao, tipo, meta, raridade]);
  }
  const nLoja = await one('SELECT COUNT(*)::int AS n FROM pulse_loja_produtos');
  if (nLoja.n === 0) for (const [nome, descricao, custo, estoque] of D.LOJA) {
    await q('INSERT INTO pulse_loja_produtos (nome, descricao, custo, estoque) VALUES ($1,$2,$3,$4)', [nome, descricao, custo, estoque]);
  }
}

async function getConfig() {
  const rows = await many('SELECT chave, valor FROM pulse_configuracoes');
  const cfg = Object.fromEntries(D.CONFIG.map(([k, v]) => [k, v]));
  for (const r of rows) cfg[r.chave] = r.valor;
  return cfg;
}

// 7.10: "hoje" vem do banco no fuso configurado — nunca do relógio do servidor.
async function agoraLocal(cfg) {
  const fuso = (cfg && cfg.fuso) || 'America/Sao_Paulo';
  return one(`SELECT (NOW() AT TIME ZONE $1)::date AS hoje,
                     EXTRACT(HOUR FROM (NOW() AT TIME ZONE $1))::int AS hora,
                     to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS agora`, [fuso]);
}

module.exports = { q, one, many, tx, migrate, getConfig, agoraLocal, getPool, setPool };
