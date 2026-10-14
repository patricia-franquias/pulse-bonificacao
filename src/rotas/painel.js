'use strict';
const express = require('express');
const db = require('../db');
const S = require('../engine/servico');
const C = require('../engine/calc');
const H = require('../engine/horario');
const A = require('../auth');
const { TIPOS_CONQUISTA } = require('../defaults');
const limitador = require('./limitador');

const r = express.Router();
const gestor = A.exigirPainel('admin', 'gestor');
const admin = A.exigirPainel('admin');
const w = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const autor = (req) => req.usuario.login;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]?\d|2[0-3]):[0-5]\d$/;
const hora = (v) => { if (v === null || v === undefined || v === '') return null; if (!HORA.test(String(v))) throw S.erro(400, `Horário inválido: ${v}`); return String(v); };
const data = (v) => { if (!DATA.test(String(v))) throw S.erro(400, `Data inválida: ${v}`); return String(v); };

async function cicloAberto(id) {
  const c = await db.one('SELECT * FROM pulse_ciclos WHERE id = $1', [id]);
  if (!c) throw S.erro(404, 'Ciclo não encontrado');
  if (c.status === 'fechado') throw S.erro(400, 'Ciclo fechado: lançamentos bloqueados');
  return c;
}
async function cicloParam(req) {
  if (req.query.ciclo) return db.one('SELECT * FROM pulse_ciclos WHERE id = $1', [Number(req.query.ciclo)]);
  return S.cicloAtual();
}
async function log(tabela, chave, antes, depois, quem) {
  await db.q('INSERT INTO pulse_log_lancamentos (tabela, chave, antes, depois, autor) VALUES ($1,$2,$3,$4,$5)',
    [tabela, chave, antes ? JSON.stringify(antes) : null, depois ? JSON.stringify(depois) : null, quem]);
}

// ---------------- sessão ----------------
r.post('/login', limitador, w(async (req, res) => {
  const { login, senha } = req.body || {};
  const u = await db.one('SELECT * FROM pulse_usuarios WHERE login = $1 AND ativo', [String(login || '')]);
  if (!u || !A.conferirSenha(String(senha || ''), u.senha_hash)) return res.status(401).json({ erro: 'Login ou senha incorretos' });
  A.definirCookie(res, 'pulse_admin', A.assinar({ tipo: 'painel', id: u.id, login: u.login, nome: u.nome, perfil: u.perfil }), 12);
  res.json({ nome: u.nome, perfil: u.perfil });
}));
r.post('/logout', (req, res) => { A.limparCookie(res, 'pulse_admin'); res.json({ ok: true }); });
r.get('/me', gestor, w(async (req, res) => {
  const cfg = await db.getConfig();
  const c = await S.cicloAtual();
  res.json({ ...req.usuario, programa: cfg.programa_nome, restaurante: cfg.restaurante, ciclo_atual: c, forma_pagamento: cfg.forma_pagamento, fonte_horario: cfg.fonte_horario });
}));

// ---------------- ciclos, dashboard, ranking ----------------
r.get('/ciclos', gestor, w(async (req, res) => res.json(await db.many('SELECT * FROM pulse_ciclos ORDER BY ano DESC, mes DESC'))));
r.get('/dashboard', gestor, w(async (req, res) => {
  const ciclo = await cicloParam(req);
  if (!ciclo.calculado_em && ciclo.status === 'aberto') await S.recalcularCiclo(ciclo.id);
  const rk = await S.ranking(ciclo.id);
  const col = await db.one('SELECT percentual_final FROM pulse_nota_coletiva_mensal WHERE ciclo_id = $1', [ciclo.id]);
  const ck = await S.checklistFechamento(ciclo.id);
  const l = rk.linhas;
  const media = (k) => { const v = l.map((x) => x[k]).filter((x) => x !== null && x !== undefined); return v.length ? C.round2(v.reduce((a, b) => a + Number(b), 0) / v.length) : null; };
  res.json({ ciclo: ck.ciclo, indicadores: {
    colaboradores: l.length, vida_media: media('vida'), pontualidade_media: media('pontualidade'), execucao_media: media('taxa'),
    coletiva: col ? col.percentual_final : null, total_previsto: C.round2(l.reduce((a, x) => a + Number(x.total), 0)),
    abonado: C.round2(l.reduce((a, x) => a + Number(x.abonado || 0), 0)),
    resgates_pendentes: (await db.one(`SELECT COUNT(*)::int AS n FROM pulse_loja_resgates WHERE status = 'pendente'`)).n,
  }, checklist: ck.itens, bloqueado: ck.bloqueado });
}));
r.post('/ciclos/:id/recalcular', gestor, w(async (req, res) => { await cicloAberto(Number(req.params.id)); res.json(await S.recalcularCiclo(Number(req.params.id))); }));
r.post('/ciclos/:id/fechar', gestor, w(async (req, res) => res.json(await S.fecharCiclo(Number(req.params.id), autor(req)))));
r.get('/ranking', gestor, w(async (req, res) => { const c = await cicloParam(req); res.json(await S.ranking(c.id)); }));
r.get('/extrato/:ciclo/:colab', gestor, w(async (req, res) => res.json(await S.extrato(Number(req.params.ciclo), Number(req.params.colab)))));
r.get('/metas', gestor, w(async (req, res) => res.json(await S.metasECards())));

// ---------------- colaboradores, escalas, vínculos ----------------
r.get('/colaboradores', gestor, w(async (req, res) => res.json(await db.many(`SELECT c.id, c.nome, c.matricula, c.cargo, c.admissao, c.ativo, (c.pin_hash IS NOT NULL) AS tem_pin,
    v.identificador, (SELECT row_to_json(e) FROM (SELECT vigente_desde, dias FROM pulse_escalas WHERE colaborador_id = c.id ORDER BY vigente_desde DESC LIMIT 1) e) AS escala
    FROM pulse_colaboradores c LEFT JOIN pulse_vinculos v ON v.colaborador_id = c.id ORDER BY c.ativo DESC, c.nome`))));
r.post('/colaboradores', gestor, w(async (req, res) => {
  const { nome, matricula, cargo, admissao } = req.body;
  if (!nome || !matricula) throw S.erro(400, 'Nome e matrícula são obrigatórios');
  const c = await db.one('INSERT INTO pulse_colaboradores (nome, matricula, cargo, admissao) VALUES ($1,$2,$3,$4) RETURNING id', [nome.trim(), String(matricula).trim(), cargo || null, data(admissao)]);
  res.json(c);
}));
r.put('/colaboradores/:id', gestor, w(async (req, res) => {
  const { nome, matricula, cargo, admissao, ativo } = req.body;
  await db.q('UPDATE pulse_colaboradores SET nome = $2, matricula = $3, cargo = $4, admissao = $5, ativo = $6 WHERE id = $1',
    [Number(req.params.id), nome, matricula, cargo || null, data(admissao), ativo !== false]);
  res.json({ ok: true });
}));
r.post('/colaboradores/:id/pin', gestor, w(async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!/^\d{4,8}$/.test(pin)) throw S.erro(400, 'PIN deve ter de 4 a 8 dígitos');
  await db.q('UPDATE pulse_colaboradores SET pin_hash = $2 WHERE id = $1', [Number(req.params.id), A.hashSenha(pin)]);
  res.json({ ok: true });
}));
r.get('/colaboradores/:id/escalas', gestor, w(async (req, res) => res.json(await db.many('SELECT * FROM pulse_escalas WHERE colaborador_id = $1 ORDER BY vigente_desde DESC', [Number(req.params.id)]))));
r.post('/colaboradores/:id/escalas', gestor, w(async (req, res) => {
  const { vigente_desde, dias } = req.body;
  const limpo = {};
  for (let d = 0; d < 7; d++) {
    const x = dias && dias[d];
    limpo[d] = x && x.entrada && x.saida ? { entrada: hora(x.entrada), saida: hora(x.saida), intervalo: Number(x.intervalo ?? 60) } : null;
  }
  await db.q(`INSERT INTO pulse_escalas (colaborador_id, vigente_desde, dias, criado_por) VALUES ($1,$2,$3,$4)
      ON CONFLICT (colaborador_id, vigente_desde) DO UPDATE SET dias = EXCLUDED.dias, criado_por = EXCLUDED.criado_por, criado_em = NOW()`,
  [Number(req.params.id), data(vigente_desde), JSON.stringify(limpo), autor(req)]);
  await log('pulse_escalas', `${req.params.id}|${vigente_desde}`, null, limpo, autor(req));
  const c = await S.cicloAtual(); await S.recalcularCiclo(c.id);
  res.json({ ok: true });
}));
r.get('/vinculos', gestor, w(async (req, res) => res.json(await db.many(`SELECT c.id, c.nome, c.matricula, c.ativo, v.fonte, v.identificador FROM pulse_colaboradores c
    LEFT JOIN pulse_vinculos v ON v.colaborador_id = c.id ORDER BY c.nome`))));
r.post('/vinculos', gestor, w(async (req, res) => {
  const { colaborador_id, identificador } = req.body;
  await db.q(`INSERT INTO pulse_vinculos (colaborador_id, fonte, identificador) VALUES ($1,'manual',$2)
      ON CONFLICT (colaborador_id) DO UPDATE SET identificador = EXCLUDED.identificador`, [Number(colaborador_id), String(identificador).trim()]);
  const c = await S.cicloAtual(); await S.recalcularCiclo(c.id);
  res.json({ ok: true });
}));
r.delete('/vinculos/:colab', gestor, w(async (req, res) => {
  await db.q('DELETE FROM pulse_vinculos WHERE colaborador_id = $1', [Number(req.params.colab)]);
  const c = await S.cicloAtual(); await S.recalcularCiclo(c.id);
  res.json({ ok: true });
}));

// ---------------- ponto: marcações manuais + ocorrência do dia ----------------
r.get('/ponto', gestor, w(async (req, res) => {
  const cfg = await db.getConfig();
  const dia = req.query.data ? data(req.query.data) : (await db.agoraLocal(cfg)).hoje;
  const colabs = await db.many(`SELECT c.id, c.nome FROM pulse_colaboradores c JOIN pulse_vinculos v ON v.colaborador_id = c.id
      WHERE c.ativo AND c.admissao <= $1 ORDER BY c.nome`, [dia]);
  const regs = await H.registrosDiarios({ fonte_horario: 'manual' }, colabs.map((c) => c.id), dia, dia);
  const marc = await db.many('SELECT * FROM pulse_marcacoes WHERE data = $1', [dia]);
  const labs = await db.many('SELECT * FROM pulse_ponto_labels WHERE data = $1', [dia]);
  const ovs = await db.many('SELECT * FROM pulse_schedule_overrides WHERE data = $1', [dia]);
  const ciclo = await S.cicloDaData(dia);
  const hh = (t) => (t ? String(t).slice(0, 5) : null);
  res.json({ data: dia, ciclo_fechado: ciclo.status === 'fechado', rotulos: Object.entries(C.ROTULOS).map(([k, v]) => ({ codigo: k, nome: v.nome })),
    linhas: colabs.map((c) => {
      const reg = (regs[c.id] || [])[0] || null; const m = marc.find((x) => x.colaborador_id === c.id);
      const l = labs.find((x) => x.colaborador_id === c.id); const o = ovs.find((x) => x.colaborador_id === c.id);
      return { colaborador_id: c.id, nome: c.nome,
        previsto: reg && reg.previsto_entrada ? { entrada: reg.previsto_entrada, saida: reg.previsto_saida, intervalo: reg.intervalo_min, excecao: reg.excecao } : null,
        marcacao: m ? { entrada: hh(m.entrada), saida_intervalo: hh(m.saida_intervalo), retorno_intervalo: hh(m.retorno_intervalo), saida: hh(m.saida),
          lancado_por: m.lancado_por, lancado_em: m.lancado_em, atualizado_por: m.atualizado_por, atualizado_em: m.atualizado_em } : null,
        rotulo: l ? { rotulo: l.rotulo, observacao: l.observacao, lancado_por: l.lancado_por, lancado_em: l.lancado_em } : null,
        excecao: o ? { entrada: hh(o.previsto_entrada), saida: hh(o.previsto_saida), intervalo: o.intervalo_min, motivo: o.motivo, criado_por: o.criado_por } : null };
    }) });
}));
r.put('/ponto/:colab/:data', gestor, w(async (req, res) => {
  const colab = Number(req.params.colab); const dia = data(req.params.data);
  const ciclo = await S.cicloDaData(dia); await cicloAberto(ciclo.id);
  const cfg = await db.getConfig(); const { hoje } = await db.agoraLocal(cfg);
  if (dia > hoje) throw S.erro(400, 'Não é possível lançar dia futuro');
  const b = req.body || {}; const quem = autor(req);
  // Marcações
  if (b.marcacao !== undefined) {
    const antes = await db.one('SELECT entrada, saida_intervalo, retorno_intervalo, saida FROM pulse_marcacoes WHERE colaborador_id = $1 AND data = $2', [colab, dia]);
    const m = b.marcacao;
    const vazio = !m || ['entrada', 'saida_intervalo', 'retorno_intervalo', 'saida'].every((k) => !m[k]);
    if (vazio) { if (antes) await db.q('DELETE FROM pulse_marcacoes WHERE colaborador_id = $1 AND data = $2', [colab, dia]); }
    else {
      const v = [hora(m.entrada), hora(m.saida_intervalo), hora(m.retorno_intervalo), hora(m.saida)];
      if (!v[0]) throw S.erro(400, 'Informe ao menos a entrada');
      await db.q(`INSERT INTO pulse_marcacoes (colaborador_id, data, entrada, saida_intervalo, retorno_intervalo, saida, lancado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (colaborador_id, data) DO UPDATE SET entrada = EXCLUDED.entrada, saida_intervalo = EXCLUDED.saida_intervalo,
          retorno_intervalo = EXCLUDED.retorno_intervalo, saida = EXCLUDED.saida, atualizado_por = $7, atualizado_em = NOW()`, [colab, dia, ...v, quem]);
    }
    await log('pulse_marcacoes', `${colab}|${dia}`, antes, vazio ? null : m, quem);
  }
  // Ocorrência do dia (rótulo)
  if (b.rotulo !== undefined) {
    const antes = await db.one('SELECT rotulo, observacao FROM pulse_ponto_labels WHERE colaborador_id = $1 AND data = $2', [colab, dia]);
    if (!b.rotulo) { if (antes) await db.q('DELETE FROM pulse_ponto_labels WHERE colaborador_id = $1 AND data = $2', [colab, dia]); }
    else {
      const cod = C.normalizarRotulo(b.rotulo);
      if (!cod) throw S.erro(400, `Ocorrência desconhecida: ${b.rotulo}`);
      await db.q(`INSERT INTO pulse_ponto_labels (colaborador_id, data, rotulo, observacao, lancado_por) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (colaborador_id, data) DO UPDATE SET rotulo = EXCLUDED.rotulo, observacao = EXCLUDED.observacao, lancado_por = EXCLUDED.lancado_por, lancado_em = NOW()`,
      [colab, dia, cod, b.observacao || null, quem]);
    }
    await log('pulse_ponto_labels', `${colab}|${dia}`, antes, b.rotulo ? { rotulo: b.rotulo, observacao: b.observacao } : null, quem);
  }
  // Exceção autorizada do dia
  if (b.excecao !== undefined) {
    const antes = await db.one('SELECT previsto_entrada, previsto_saida, intervalo_min, motivo FROM pulse_schedule_overrides WHERE colaborador_id = $1 AND data = $2', [colab, dia]);
    if (!b.excecao) { if (antes) await db.q('DELETE FROM pulse_schedule_overrides WHERE colaborador_id = $1 AND data = $2', [colab, dia]); }
    else {
      const e = b.excecao;
      if (!e.motivo) throw S.erro(400, 'Exceção precisa de motivo');
      await db.q(`INSERT INTO pulse_schedule_overrides (colaborador_id, data, previsto_entrada, previsto_saida, intervalo_min, motivo, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (colaborador_id, data) DO UPDATE SET previsto_entrada = EXCLUDED.previsto_entrada, previsto_saida = EXCLUDED.previsto_saida,
          intervalo_min = EXCLUDED.intervalo_min, motivo = EXCLUDED.motivo, criado_por = EXCLUDED.criado_por, criado_em = NOW()`,
      [colab, dia, hora(e.entrada), hora(e.saida), Number(e.intervalo ?? 60), e.motivo, quem]);
    }
    await log('pulse_schedule_overrides', `${colab}|${dia}`, antes, b.excecao, quem);
  }
  await S.invalidarMarcadorDia(colab, dia);
  await S.recalcularCiclo(ciclo.id);
  res.json({ ok: true });
}));
r.get('/log', gestor, w(async (req, res) => res.json(await db.many('SELECT * FROM pulse_log_lancamentos ORDER BY id DESC LIMIT 300'))));

// ---------------- rotinas ----------------
r.get('/rotinas', gestor, w(async (req, res) => res.json({
  rotinas: await db.many('SELECT * FROM pulse_rotinas ORDER BY ativo DESC, titulo'),
  grade: await db.many(`SELECT g.*, c.nome, r.titulo FROM pulse_grade_rotinas g JOIN pulse_colaboradores c ON c.id = g.colaborador_id JOIN pulse_rotinas r ON r.id = g.rotina_id ORDER BY c.nome, g.dia_semana`),
})));
r.post('/rotinas', gestor, w(async (req, res) => {
  const { titulo, tipo, itens, pontos } = req.body;
  if (!titulo || !['tarefa', 'checklist'].includes(tipo)) throw S.erro(400, 'Título e tipo (tarefa/checklist) obrigatórios');
  const lista = (Array.isArray(itens) ? itens : String(itens || '').split('\n')).map((s) => String(s).trim()).filter(Boolean);
  if (tipo === 'checklist' && !lista.length) throw S.erro(400, 'Checklist precisa de itens');
  res.json(await db.one('INSERT INTO pulse_rotinas (titulo, tipo, itens, pontos) VALUES ($1,$2,$3,$4) RETURNING id', [titulo, tipo, JSON.stringify(lista), Number(pontos || 1)]));
}));
r.put('/rotinas/:id', gestor, w(async (req, res) => {
  const { titulo, itens, pontos, ativo } = req.body;
  const lista = (Array.isArray(itens) ? itens : String(itens || '').split('\n')).map((s) => String(s).trim()).filter(Boolean);
  await db.q('UPDATE pulse_rotinas SET titulo = $2, itens = $3, pontos = $4, ativo = $5 WHERE id = $1', [Number(req.params.id), titulo, JSON.stringify(lista), Number(pontos || 1), ativo !== false]);
  res.json({ ok: true });
}));
r.post('/grade', gestor, w(async (req, res) => {
  const { rotina_id, colaborador_id, dias } = req.body;
  for (const d of dias || []) await db.q('INSERT INTO pulse_grade_rotinas (rotina_id, colaborador_id, dia_semana) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [Number(rotina_id), Number(colaborador_id), Number(d)]);
  const cfg = await db.getConfig(); const { hoje } = await db.agoraLocal(cfg); await S.gerarAtribuicoes(hoje);
  res.json({ ok: true });
}));
r.delete('/grade/:id', gestor, w(async (req, res) => { await db.q('DELETE FROM pulse_grade_rotinas WHERE id = $1', [Number(req.params.id)]); res.json({ ok: true }); }));
r.get('/atribuicoes', gestor, w(async (req, res) => {
  const cfg = await db.getConfig(); const dia = req.query.data ? data(req.query.data) : (await db.agoraLocal(cfg)).hoje;
  await S.gerarAtribuicoes(dia);
  res.json({ data: dia, linhas: await db.many(`SELECT a.*, r.titulo, r.tipo, r.itens AS itens_rotina, c.nome FROM pulse_rotinas_atribuidas a
      JOIN pulse_rotinas r ON r.id = a.rotina_id JOIN pulse_colaboradores c ON c.id = a.colaborador_id WHERE a.data = $1 ORDER BY c.nome, r.titulo`, [dia]) });
}));
r.post('/atribuicoes', gestor, w(async (req, res) => {
  const { rotina_id, colaborador_id, data: d } = req.body;
  const rot = await db.one('SELECT pontos FROM pulse_rotinas WHERE id = $1', [Number(rotina_id)]);
  await db.q(`INSERT INTO pulse_rotinas_atribuidas (rotina_id, colaborador_id, data, origem, pontos) VALUES ($1,$2,$3,'avulsa',$4) ON CONFLICT DO NOTHING`, [Number(rotina_id), Number(colaborador_id), data(d), rot.pontos]);
  const c = await S.cicloDaData(d); await S.recalcularCiclo(c.id);
  res.json({ ok: true });
}));
r.delete('/atribuicoes/:id', gestor, w(async (req, res) => {
  const a = await db.one('SELECT * FROM pulse_rotinas_atribuidas WHERE id = $1', [Number(req.params.id)]);
  if (!a) throw S.erro(404, 'Não encontrada');
  const c = await S.cicloDaData(a.data); await cicloAberto(c.id);
  await db.q('DELETE FROM pulse_xp_historico WHERE colaborador_id = $1 AND referencia = $2', [a.colaborador_id, `exec:${a.id}`]);
  await db.q('DELETE FROM pulse_rotinas_atribuidas WHERE id = $1', [a.id]);
  await log('pulse_rotinas_atribuidas', String(a.id), a, null, autor(req));
  await S.recalcularCiclo(c.id);
  res.json({ ok: true });
}));
r.post('/atribuicoes/:id/marcar', gestor, w(async (req, res) => res.json(await S.marcarRotina(Number(req.params.id), { ...req.body, autor: autor(req), permitirOutroDia: true }))));

// ---------------- registros da nota coletiva ----------------
r.get('/registros', gestor, w(async (req, res) => {
  const c = await cicloParam(req);
  res.json({ ciclo: c,
    plataformas: await db.many('SELECT * FROM pulse_plataformas_notas WHERE ciclo_id = $1 ORDER BY plataforma', [c.id]),
    auditorias: await db.many('SELECT * FROM pulse_auditorias WHERE ciclo_id = $1 ORDER BY data', [c.id]),
    erros: await db.many('SELECT * FROM pulse_erros_pedidos WHERE ciclo_id = $1 ORDER BY data', [c.id]),
    erros_confirmados: await db.one(`SELECT * FROM pulse_pernas_medidas WHERE ciclo_id = $1 AND perna = 'erros'`, [c.id]),
    coletiva: await db.one('SELECT * FROM pulse_nota_coletiva_mensal WHERE ciclo_id = $1', [c.id]),
    pesos: (await db.getConfig()).coletiva_pesos });
}));
const posRegistro = async (cicloId) => { await S.recalcularCiclo(cicloId); return db.one('SELECT * FROM pulse_nota_coletiva_mensal WHERE ciclo_id = $1', [cicloId]); };
r.post('/registros/:ciclo/plataformas', gestor, w(async (req, res) => {
  const c = await cicloAberto(Number(req.params.ciclo)); const { plataforma, nota, amostra, fonte } = req.body;
  if (!(Number(nota) >= 0 && Number(nota) <= 5)) throw S.erro(400, 'Nota deve estar entre 0 e 5');
  await db.q(`INSERT INTO pulse_plataformas_notas (ciclo_id, plataforma, nota, amostra, fonte, lancado_por) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (ciclo_id, plataforma) DO UPDATE SET nota = EXCLUDED.nota, amostra = EXCLUDED.amostra, fonte = EXCLUDED.fonte, lancado_por = EXCLUDED.lancado_por, lancado_em = NOW()`,
  [c.id, plataforma || 'iFood', Number(nota), amostra ? Number(amostra) : null, fonte || null, autor(req)]);
  res.json(await posRegistro(c.id));
}));
r.delete('/registros/:ciclo/plataformas/:plat', gestor, w(async (req, res) => {
  const c = await cicloAberto(Number(req.params.ciclo));
  await db.q('DELETE FROM pulse_plataformas_notas WHERE ciclo_id = $1 AND plataforma = $2', [c.id, req.params.plat]); res.json(await posRegistro(c.id));
}));
r.post('/registros/:ciclo/auditorias', gestor, w(async (req, res) => {
  const c = await cicloAberto(Number(req.params.ciclo)); const { data: d, tipo, nota, descricao } = req.body;
  if (!(Number(nota) >= 0 && Number(nota) <= 100)) throw S.erro(400, 'Nota deve estar entre 0 e 100');
  await db.q('INSERT INTO pulse_auditorias (ciclo_id, data, tipo, nota, descricao, lancado_por) VALUES ($1,$2,$3,$4,$5,$6)', [c.id, data(d), tipo === 'higieniza' ? 'higieniza' : 'propria', Number(nota), descricao || null, autor(req)]);
  res.json(await posRegistro(c.id));
}));
r.delete('/registros/:ciclo/auditorias/:id', gestor, w(async (req, res) => {
  const c = await cicloAberto(Number(req.params.ciclo));
  await db.q('DELETE FROM pulse_auditorias WHERE id = $1 AND ciclo_id = $2', [Number(req.params.id), c.id]); res.json(await posRegistro(c.id));
}));
r.post('/registros/:ciclo/erros', gestor, w(async (req, res) => {
  const c = await cicloAberto(Number(req.params.ciclo)); const { data: d, descricao } = req.body;
  if (!descricao) throw S.erro(400, 'Descreva o erro');
  await db.q('INSERT INTO pulse_erros_pedidos (ciclo_id, data, descricao, lancado_por) VALUES ($1,$2,$3,$4)', [c.id, data(d), descricao, autor(req)]);
  res.json(await posRegistro(c.id));
}));
r.delete('/registros/:ciclo/erros/:id', gestor, w(async (req, res) => {
  const c = await cicloAberto(Number(req.params.ciclo));
  await db.q('DELETE FROM pulse_erros_pedidos WHERE id = $1 AND ciclo_id = $2', [Number(req.params.id), c.id]); res.json(await posRegistro(c.id));
}));
r.post('/registros/:ciclo/erros-confirmados', gestor, w(async (req, res) => {
  const c = await cicloAberto(Number(req.params.ciclo));
  if (req.body.confirmar) await db.q(`INSERT INTO pulse_pernas_medidas (ciclo_id, perna, confirmado_por) VALUES ($1,'erros',$2) ON CONFLICT DO NOTHING`, [c.id, autor(req)]);
  else await db.q(`DELETE FROM pulse_pernas_medidas WHERE ciclo_id = $1 AND perna = 'erros'`, [c.id]);
  res.json(await posRegistro(c.id));
}));

// ---------------- consumo do mês (base do abono) ----------------
r.get('/consumo', gestor, w(async (req, res) => {
  const c = await cicloParam(req);
  res.json({ ciclo: c, linhas: await db.many(`SELECT c.id AS colaborador_id, c.nome, m.consumo, m.lancado_por, m.lancado_em, p.total, p.abonado, p.desconto_folha
      FROM pulse_colaboradores c JOIN pulse_vinculos v ON v.colaborador_id = c.id
      LEFT JOIN pulse_consumo_mensal m ON m.colaborador_id = c.id AND m.ciclo_id = $1
      LEFT JOIN pulse_premiacao_mensal p ON p.colaborador_id = c.id AND p.ciclo_id = $1
      WHERE c.ativo ORDER BY c.nome`, [c.id]) });
}));
r.put('/consumo/:ciclo/:colab', gestor, w(async (req, res) => {
  const c = await cicloAberto(Number(req.params.ciclo)); const colab = Number(req.params.colab);
  const v = req.body.consumo;
  const antes = await db.one('SELECT consumo FROM pulse_consumo_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [c.id, colab]);
  if (v === null || v === '') await db.q('DELETE FROM pulse_consumo_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [c.id, colab]);
  else {
    if (!(Number(v) >= 0)) throw S.erro(400, 'Consumo inválido');
    await db.q(`INSERT INTO pulse_consumo_mensal (ciclo_id, colaborador_id, consumo, lancado_por) VALUES ($1,$2,$3,$4)
        ON CONFLICT (ciclo_id, colaborador_id) DO UPDATE SET consumo = EXCLUDED.consumo, lancado_por = EXCLUDED.lancado_por, lancado_em = NOW()`, [c.id, colab, Number(v), autor(req)]);
  }
  await log('pulse_consumo_mensal', `${c.id}|${colab}`, antes, { consumo: v }, autor(req));
  await S.recalcularCiclo(c.id);
  res.json({ ok: true });
}));

// ---------------- avaliações ----------------
r.get('/avaliacoes', gestor, w(async (req, res) => res.json(await db.many(`SELECT a.*, c.nome FROM pulse_avaliacoes a JOIN pulse_colaboradores c ON c.id = a.colaborador_id ORDER BY a.data DESC, a.id DESC LIMIT 200`))));
r.post('/avaliacoes', gestor, w(async (req, res) => {
  const { colaborador_id, data: d, positiva, comentario } = req.body;
  const cfg = await db.getConfig();
  const a = await db.one('INSERT INTO pulse_avaliacoes (colaborador_id, data, positiva, comentario, autor) VALUES ($1,$2,$3,$4,$5) RETURNING id', [Number(colaborador_id), data(d), !!positiva, comentario || null, autor(req)]);
  if (positiva) await db.tx((c) => S.creditarXp(c, Number(colaborador_id), 'avaliacao', `aval:${a.id}`, Number(cfg.xp_avaliacao), 'Avaliação positiva', d));
  await S.avaliarConquistas([Number(colaborador_id)]);
  res.json(a);
}));

// ---------------- conquistas, níveis, loja, resgates ----------------
r.get('/conquistas', gestor, w(async (req, res) => res.json({
  tipos: Object.entries(TIPOS_CONQUISTA).map(([k, v]) => ({ tipo: k, nome: v.nome, unidade: v.unidade })),
  conquistas: (await db.many(`SELECT q.*, (SELECT COUNT(*)::int FROM pulse_conquistas_desbloqueadas d WHERE d.conquista_id = q.id) AS desbloqueios FROM pulse_conquistas q ORDER BY q.ativo DESC, q.tipo, q.meta`))
    .map((q) => ({ ...q, regra: TIPOS_CONQUISTA[q.tipo] ? TIPOS_CONQUISTA[q.tipo].texto(Number(q.meta)) : q.tipo })),
  moedas: (await db.getConfig()).moedas_raridade,
})));
r.post('/conquistas', admin, w(async (req, res) => {
  const { nome, descricao, tipo, meta, raridade } = req.body;
  if (!TIPOS_CONQUISTA[tipo]) throw S.erro(400, 'Tipo de condição inválido');
  const codigo = String(nome).toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
  await db.q('INSERT INTO pulse_conquistas (codigo, nome, descricao, tipo, meta, raridade) VALUES ($1,$2,$3,$4,$5,$6)', [codigo, nome, descricao || null, tipo, Number(meta), raridade]);
  await S.avaliarConquistas(); res.json({ ok: true });
}));
r.put('/conquistas/:id', admin, w(async (req, res) => {
  const { nome, descricao, tipo, meta, raridade, ativo } = req.body;
  if (!TIPOS_CONQUISTA[tipo]) throw S.erro(400, 'Tipo de condição inválido');
  await db.q('UPDATE pulse_conquistas SET nome = $2, descricao = $3, tipo = $4, meta = $5, raridade = $6, ativo = $7 WHERE id = $1', [Number(req.params.id), nome, descricao || null, tipo, Number(meta), raridade, ativo !== false]);
  await S.avaliarConquistas(); res.json({ ok: true });
}));
r.get('/niveis', gestor, w(async (req, res) => res.json(await S.niveis())));
r.put('/niveis', admin, w(async (req, res) => {
  const lista = (req.body || []).map((n, i) => ({ nivel: i + 1, nome: String(n.nome), xp_min: Number(n.xp_min) }));
  if (!lista.length || lista[0].xp_min !== 0) throw S.erro(400, 'O primeiro nível precisa começar em 0 XP');
  for (let i = 1; i < lista.length; i++) if (!(lista[i].xp_min > lista[i - 1].xp_min)) throw S.erro(400, 'As faixas de XP precisam ser crescentes');
  await db.tx(async (c) => { await c.query('DELETE FROM pulse_niveis'); for (const n of lista) await c.query('INSERT INTO pulse_niveis VALUES ($1,$2,$3)', [n.nivel, n.nome, n.xp_min]); });
  await S.avaliarConquistas(); res.json({ ok: true });
}));
r.get('/loja', gestor, w(async (req, res) => res.json(await db.many('SELECT * FROM pulse_loja_produtos ORDER BY ativo DESC, custo'))));
r.post('/loja', admin, w(async (req, res) => {
  const { nome, descricao, custo, estoque } = req.body;
  await db.q('INSERT INTO pulse_loja_produtos (nome, descricao, custo, estoque) VALUES ($1,$2,$3,$4)', [nome, descricao || null, Number(custo), estoque === '' || estoque === null || estoque === undefined ? null : Number(estoque)]);
  res.json({ ok: true });
}));
r.put('/loja/:id', admin, w(async (req, res) => {
  const { nome, descricao, custo, estoque, ativo } = req.body;
  await db.q('UPDATE pulse_loja_produtos SET nome = $2, descricao = $3, custo = $4, estoque = $5, ativo = $6 WHERE id = $1',
    [Number(req.params.id), nome, descricao || null, Number(custo), estoque === '' || estoque === null || estoque === undefined ? null : Number(estoque), ativo !== false]);
  res.json({ ok: true });
}));
r.get('/resgates', gestor, w(async (req, res) => res.json(await db.many(`SELECT r.*, c.nome, p.nome AS produto, p.estoque, (SELECT saldo FROM pulse_coins_carteira w WHERE w.colaborador_id = r.colaborador_id) AS saldo
    FROM pulse_loja_resgates r JOIN pulse_colaboradores c ON c.id = r.colaborador_id JOIN pulse_loja_produtos p ON p.id = r.produto_id
    ORDER BY (r.status = 'pendente') DESC, r.criado_em DESC LIMIT 200`))));
r.post('/resgates/:id/:acao', gestor, w(async (req, res) => {
  const { id, acao } = req.params;
  if (!['aprovar', 'recusar'].includes(acao)) throw S.erro(400, 'Ação inválida');
  await db.tx(async (c) => {
    const rg = (await c.query('SELECT * FROM pulse_loja_resgates WHERE id = $1 FOR UPDATE', [Number(id)])).rows[0];
    if (!rg || rg.status !== 'pendente') throw S.erro(400, 'Resgate não está pendente');
    if (acao === 'aprovar') {
      const saldo = (await c.query('SELECT saldo FROM pulse_coins_carteira WHERE colaborador_id = $1', [rg.colaborador_id])).rows[0].saldo;
      if (saldo < rg.custo) throw S.erro(400, 'Saldo de moedas insuficiente');
      const p = (await c.query('SELECT * FROM pulse_loja_produtos WHERE id = $1 FOR UPDATE', [rg.produto_id])).rows[0];
      if (p.estoque !== null) {
        if (p.estoque <= 0) throw S.erro(400, 'Sem estoque');
        await c.query('UPDATE pulse_loja_produtos SET estoque = estoque - 1 WHERE id = $1', [p.id]);
      }
      await c.query(`INSERT INTO pulse_coins_historico (colaborador_id, origem, referencia, valor, descricao) VALUES ($1,'resgate',$2,$3,$4)`, [rg.colaborador_id, String(rg.id), -rg.custo, `Resgate: ${p.nome}`]);
    }
    await c.query('UPDATE pulse_loja_resgates SET status = $2, decidido_por = $3, decidido_em = NOW(), motivo = $4 WHERE id = $1',
      [rg.id, acao === 'aprovar' ? 'aprovado' : 'recusado', autor(req), (req.body && req.body.motivo) || null]);
  });
  await S.avaliarConquistas(); res.json({ ok: true });
}));

// ---------------- histórico ----------------
r.get('/historico', gestor, w(async (req, res) => res.json(await db.many(`SELECT c.*, COUNT(h.*)::int AS pessoas, COALESCE(SUM(h.total),0) AS total, COALESCE(SUM(h.abonado),0) AS abonado
    FROM pulse_ciclos c LEFT JOIN pulse_premiacao_historico h ON h.ciclo_id = c.id WHERE c.status = 'fechado' GROUP BY c.id ORDER BY c.ano DESC, c.mes DESC`))));

// ---------------- configurações e usuários ----------------
r.get('/configuracoes', gestor, w(async (req, res) => {
  const { CONFIG } = require('../defaults'); const cfg = await db.getConfig();
  res.json(CONFIG.map(([chave, , descricao, tipo, grupo]) => ({ chave, valor: cfg[chave], descricao, tipo, grupo })));
}));
r.put('/configuracoes', admin, w(async (req, res) => {
  const { CONFIG } = require('../defaults'); const validas = new Set(CONFIG.map((c) => c[0]));
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!validas.has(k)) throw S.erro(400, `Configuração desconhecida: ${k}`);
    await db.q('UPDATE pulse_configuracoes SET valor = $2, atualizado_em = NOW(), atualizado_por = $3 WHERE chave = $1', [k, JSON.stringify(v), autor(req)]);
  }
  const abertos = await db.many(`SELECT id FROM pulse_ciclos WHERE status = 'aberto'`);
  for (const c of abertos) await S.recalcularCiclo(c.id); // ciclos fechados não mudam
  res.json({ ok: true });
}));
r.get('/usuarios', admin, w(async (req, res) => res.json(await db.many('SELECT id, nome, login, perfil, ativo FROM pulse_usuarios ORDER BY nome'))));
r.post('/usuarios', admin, w(async (req, res) => {
  const { nome, login, senha, perfil } = req.body;
  if (!senha || String(senha).length < 8) throw S.erro(400, 'Senha com no mínimo 8 caracteres');
  await db.q('INSERT INTO pulse_usuarios (nome, login, senha_hash, perfil) VALUES ($1,$2,$3,$4)', [nome, login, A.hashSenha(senha), perfil === 'admin' ? 'admin' : 'gestor']);
  res.json({ ok: true });
}));

module.exports = r;
