'use strict';
// API do app do colaborador. Login por matrícula + PIN. O extrato é público dentro da equipe:
// mostra nome e métricas do programa, nunca documento ou salário.
const express = require('express');
const db = require('../db');
const S = require('../engine/servico');
const A = require('../auth');
const limitador = require('./limitador');

const r = express.Router();
const w = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const eu = A.exigirColaborador;

r.post('/login', limitador, w(async (req, res) => {
  const { matricula, pin } = req.body || {};
  const c = await db.one('SELECT * FROM pulse_colaboradores WHERE matricula = $1 AND ativo', [String(matricula || '').trim()]);
  if (!c || !A.conferirSenha(String(pin || ''), c.pin_hash)) return res.status(401).json({ erro: 'Matrícula ou PIN incorretos' });
  A.definirCookie(res, 'pulse_app', A.assinar({ tipo: 'colaborador', id: c.id, nome: c.nome }, 24 * 30), 24 * 30);
  res.json({ nome: c.nome });
}));
r.post('/logout', (req, res) => { A.limparCookie(res, 'pulse_app'); res.json({ ok: true }); });

r.get('/perfil', eu, w(async (req, res) => {
  const id = req.colab.id;
  const cfg = await db.getConfig();
  const ciclo = await S.cicloAtual();
  if (!ciclo.calculado_em) await S.recalcularCiclo(ciclo.id);
  const [m] = await S.metasECards([id]);
  const p = await db.one(`SELECT p.*, a.percentual AS vida, t.percentual AS pont, t.dias_avaliados, t.dias_certos, s.taxa, s.atribuidas, s.feitas, s.score
      FROM pulse_premiacao_mensal p JOIN pulse_assiduidade_mensal a USING (ciclo_id, colaborador_id) JOIN pulse_pontualidade_mensal t USING (ciclo_id, colaborador_id)
      JOIN pulse_score_mensal s USING (ciclo_id, colaborador_id) WHERE p.ciclo_id = $1 AND p.colaborador_id = $2`, [ciclo.id, id]);
  res.json({ id, nome: req.colab.nome, programa: cfg.programa_nome, restaurante: cfg.restaurante, forma_pagamento: cfg.forma_pagamento, teto_total: cfg.teto_total,
    ciclo, nivel: m.nivel, coins: m.coins, sequencia_atual: m.sequencia_atual, maior_sequencia: m.maior_sequencia,
    conquistas: `${m.desbloqueadas}/${m.total_cards}`, proximas: m.em_andamento.slice(0, 3),
    mes: p ? { posicao: p.posicao, vida: p.vida, pontualidade: p.pont, dias_avaliados: p.dias_avaliados, dias_certos: p.dias_certos,
      taxa: p.taxa, atribuidas: p.atribuidas, feitas: p.feitas, score: p.score, total: p.total, consumo: p.consumo, abonado: p.abonado } : null });
}));

r.get('/rotinas', eu, w(async (req, res) => {
  const cfg = await db.getConfig(); const { hoje } = await db.agoraLocal(cfg);
  await S.gerarAtribuicoes(hoje);
  res.json({ data: hoje, linhas: await db.many(`SELECT a.id, a.status, a.itens_marcados, a.pontos, r.titulo, r.tipo, r.itens FROM pulse_rotinas_atribuidas a
      JOIN pulse_rotinas r ON r.id = a.rotina_id WHERE a.colaborador_id = $1 AND a.data = $2 ORDER BY a.status DESC, r.titulo`, [req.colab.id, hoje]) });
}));
r.post('/rotinas/:id', eu, w(async (req, res) => {
  const a = await db.one('SELECT colaborador_id FROM pulse_rotinas_atribuidas WHERE id = $1', [Number(req.params.id)]);
  if (!a || a.colaborador_id !== req.colab.id) return res.status(404).json({ erro: 'Rotina não encontrada' });
  res.json(await S.marcarRotina(Number(req.params.id), { itens: req.body.itens, concluir: req.body.concluir }));
}));

r.get('/ranking', eu, w(async (req, res) => {
  const c = req.query.ciclo ? await db.one('SELECT * FROM pulse_ciclos WHERE id = $1', [Number(req.query.ciclo)]) : await S.cicloAtual();
  const rk = await S.ranking(c.id);
  // Sem valores de consumo/desconto em folha de outras pessoas.
  rk.linhas = rk.linhas.map(({ consumo, abonado, desconto_folha, ...x }) => ({ ...x, eu: x.colaborador_id === req.colab.id }));
  res.json({ ...rk, ciclos: await db.many(`SELECT id, ano, mes, status FROM pulse_ciclos ORDER BY ano DESC, mes DESC LIMIT 12`) });
}));
r.get('/extrato/:ciclo/:colab', eu, w(async (req, res) => {
  const e = await S.extrato(Number(req.params.ciclo), Number(req.params.colab));
  if (Number(req.params.colab) !== req.colab.id) e.pagamento = { forma: e.pagamento.forma, linhas: ['Detalhe do consumo é visível só para a própria pessoa.'] };
  res.json(e);
}));
r.get('/conquistas', eu, w(async (req, res) => { const [m] = await S.metasECards([req.colab.id]); res.json(m); }));
r.get('/niveis', eu, w(async (req, res) => {
  const [m] = await S.metasECards([req.colab.id]);
  res.json({ niveis: await S.niveis(), atual: m.nivel });
}));
r.get('/novidades', eu, w(async (req, res) => res.json(await db.many(`SELECT d.conquista_id, q.nome, q.raridade, q.descricao FROM pulse_conquistas_desbloqueadas d
    JOIN pulse_conquistas q ON q.id = d.conquista_id WHERE d.colaborador_id = $1 AND NOT d.vista ORDER BY d.desbloqueada_em`, [req.colab.id]))));
r.post('/novidades/vistas', eu, w(async (req, res) => { await db.q('UPDATE pulse_conquistas_desbloqueadas SET vista = TRUE WHERE colaborador_id = $1', [req.colab.id]); res.json({ ok: true }); }));

r.get('/loja', eu, w(async (req, res) => {
  const saldo = (await db.one('SELECT saldo FROM pulse_coins_carteira WHERE colaborador_id = $1', [req.colab.id])).saldo;
  const reservado = (await db.one(`SELECT COALESCE(SUM(custo),0)::int AS n FROM pulse_loja_resgates WHERE colaborador_id = $1 AND status = 'pendente'`, [req.colab.id])).n;
  res.json({ saldo, disponivel: saldo - reservado,
    produtos: await db.many('SELECT id, nome, descricao, custo, estoque FROM pulse_loja_produtos WHERE ativo ORDER BY custo'),
    resgates: await db.many(`SELECT r.id, r.status, r.custo, r.criado_em, r.motivo, p.nome FROM pulse_loja_resgates r JOIN pulse_loja_produtos p ON p.id = r.produto_id
      WHERE r.colaborador_id = $1 ORDER BY r.criado_em DESC LIMIT 30`, [req.colab.id]) });
}));
r.post('/loja/:produto/resgatar', eu, w(async (req, res) => {
  const cfg = await db.getConfig();
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [req.colab.id]);
    const p = (await c.query('SELECT * FROM pulse_loja_produtos WHERE id = $1 AND ativo', [Number(req.params.produto)])).rows[0];
    if (!p) throw S.erro(404, 'Prêmio não encontrado');
    if (p.estoque !== null && p.estoque <= 0) throw S.erro(400, 'Sem estoque');
    const saldo = (await c.query('SELECT saldo FROM pulse_coins_carteira WHERE colaborador_id = $1', [req.colab.id])).rows[0].saldo;
    const reservado = (await c.query(`SELECT COALESCE(SUM(custo),0)::int AS n FROM pulse_loja_resgates WHERE colaborador_id = $1 AND status = 'pendente'`, [req.colab.id])).rows[0].n;
    if (saldo - reservado < p.custo) throw S.erro(400, 'Moedas insuficientes');
    const hoje = (await c.query(`SELECT COUNT(*)::int AS n FROM pulse_loja_resgates WHERE colaborador_id = $1 AND (criado_em AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date`, [req.colab.id, cfg.fuso])).rows[0].n;
    if (hoje >= Number(cfg.resgates_por_dia)) throw S.erro(400, 'Limite de resgates de hoje atingido');
    await c.query('INSERT INTO pulse_loja_resgates (colaborador_id, produto_id, custo) VALUES ($1,$2,$3)', [req.colab.id, p.id, p.custo]);
  });
  res.json({ ok: true });
}));

module.exports = r;
