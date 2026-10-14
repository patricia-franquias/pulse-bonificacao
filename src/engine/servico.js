'use strict';
// Orquestração: lê do banco, chama o motor puro (calc.js), grava resultado + extrato.
const db = require('../db');
const C = require('./calc');
const H = require('./horario');
const { TIPOS_CONQUISTA } = require('../defaults');

// ---------------- ciclos ----------------
function bordasMes(ano, mes) {
  const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fim = new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
  return { inicio, fim };
}
async function garantirCiclo(ano, mes) {
  const { inicio, fim } = bordasMes(ano, mes);
  await db.q('INSERT INTO pulse_ciclos (ano, mes, inicio, fim) VALUES ($1,$2,$3,$4) ON CONFLICT (ano, mes) DO NOTHING', [ano, mes, inicio, fim]);
  return db.one('SELECT * FROM pulse_ciclos WHERE ano = $1 AND mes = $2', [ano, mes]);
}
async function cicloDaData(iso) {
  const [ano, mes] = iso.split('-').map(Number);
  return garantirCiclo(ano, mes);
}
async function cicloAtual() {
  const cfg = await db.getConfig();
  const { hoje } = await db.agoraLocal(cfg);
  return cicloDaData(hoje);
}

// ---------------- rotinas ----------------
async function gerarAtribuicoes(data) {
  const dow = H.diaSemana(data);
  const r = await db.q(`INSERT INTO pulse_rotinas_atribuidas (rotina_id, colaborador_id, data, origem, pontos)
      SELECT g.rotina_id, g.colaborador_id, $1::date, 'grade', r.pontos
      FROM pulse_grade_rotinas g
      JOIN pulse_rotinas r ON r.id = g.rotina_id AND r.ativo
      JOIN pulse_colaboradores c ON c.id = g.colaborador_id AND c.ativo AND c.admissao <= $1::date
      WHERE g.dia_semana = $2
      ON CONFLICT (rotina_id, colaborador_id, data) DO NOTHING`, [data, dow]);
  return r.rowCount;
}

async function creditarXp(client, colabId, origem, referencia, xp, descricao, dataRef) {
  await client.query(`INSERT INTO pulse_xp_historico (colaborador_id, origem, referencia, xp, descricao, data_ref)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (colaborador_id, origem, referencia) WHERE referencia IS NOT NULL DO NOTHING`,
  [colabId, origem, referencia, xp, descricao, dataRef]);
}

// Marca itens / conclui rotina. Só no próprio dia (colaborador) — gestor pode corrigir qualquer dia.
async function marcarRotina(atribId, { itens, concluir, autor, permitirOutroDia = false }) {
  const cfg = await db.getConfig();
  const { hoje } = await db.agoraLocal(cfg);
  const a = await db.one(`SELECT a.*, r.tipo, r.itens AS itens_rotina, r.titulo FROM pulse_rotinas_atribuidas a
      JOIN pulse_rotinas r ON r.id = a.rotina_id WHERE a.id = $1`, [atribId]);
  if (!a) throw erro(404, 'Rotina não encontrada');
  if (!permitirOutroDia && a.data !== hoje) throw erro(400, 'Só é possível marcar rotinas do dia');
  const ciclo = await cicloDaData(a.data);
  if (ciclo.status === 'fechado') throw erro(400, 'Ciclo fechado: não é possível alterar');
  let marcados = Array.isArray(itens) ? [...new Set(itens.map(Number))].filter((i) => i >= 0 && i < a.itens_rotina.length) : a.itens_marcados;
  let feita;
  if (a.tipo === 'checklist' && a.itens_rotina.length) feita = marcados.length === a.itens_rotina.length;
  else feita = concluir === undefined ? a.status === 'feita' : !!concluir;
  await db.tx(async (c) => {
    await c.query(`UPDATE pulse_rotinas_atribuidas SET itens_marcados = $2, status = $3, feita_em = CASE WHEN $3 = 'feita' THEN COALESCE(feita_em, NOW()) ELSE NULL END WHERE id = $1`,
      [atribId, JSON.stringify(marcados), feita ? 'feita' : 'pendente']);
    if (feita) {
      const xp = a.tipo === 'checklist' ? Number(cfg.xp_checklist) : Number(cfg.xp_tarefa);
      await creditarXp(c, a.colaborador_id, a.tipo, `exec:${atribId}`, xp, `${a.tipo === 'checklist' ? 'Checklist' : 'Tarefa'}: ${a.titulo}`, a.data);
    } else {
      await c.query(`DELETE FROM pulse_xp_historico WHERE colaborador_id = $1 AND origem = $2 AND referencia = $3`, [a.colaborador_id, a.tipo, `exec:${atribId}`]);
    }
    if (autor) await c.query('INSERT INTO pulse_log_lancamentos (tabela, chave, antes, depois, autor) VALUES ($1,$2,$3,$4,$5)',
      ['pulse_rotinas_atribuidas', String(atribId), JSON.stringify({ status: a.status, itens: a.itens_marcados }), JSON.stringify({ status: feita ? 'feita' : 'pendente', itens: marcados }), autor]);
  });
  await recalcularCiclo(ciclo.id);
  return { feita, itens_marcados: marcados };
}

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }

// ---------------- recálculo ----------------
async function carregarEntrada(ciclo, cfg, hojeRef) {
  const limite = ciclo.fim < hojeRef ? ciclo.fim : hojeRef; // dias calculados: até hoje
  const colabs = await db.many(`SELECT c.id, c.nome, c.admissao FROM pulse_colaboradores c
      JOIN pulse_vinculos v ON v.colaborador_id = c.id
      WHERE c.ativo AND c.admissao <= $1 ORDER BY c.nome`, [ciclo.fim]);
  const ids = colabs.map((c) => c.id);
  const regs = await H.registrosDiarios(cfg, ids, ciclo.inicio, limite);
  const labels = ids.length ? await db.many('SELECT colaborador_id, data, rotulo FROM pulse_ponto_labels WHERE colaborador_id = ANY($1) AND data BETWEEN $2 AND $3', [ids, ciclo.inicio, limite]) : [];
  const atribs = ids.length ? await db.many(`SELECT a.id, a.colaborador_id, a.data, a.status, a.pontos, r.tipo FROM pulse_rotinas_atribuidas a
      JOIN pulse_rotinas r ON r.id = a.rotina_id WHERE a.colaborador_id = ANY($1) AND a.data BETWEEN $2 AND $3`, [ids, ciclo.inicio, ciclo.fim]) : [];
  const consumo = await db.many('SELECT colaborador_id, consumo FROM pulse_consumo_mensal WHERE ciclo_id = $1', [ciclo.id]);
  const consumoMap = Object.fromEntries(consumo.map((x) => [x.colaborador_id, x.consumo]));
  const coletivaIn = {
    plataformas: await db.many('SELECT plataforma, nota, amostra, fonte FROM pulse_plataformas_notas WHERE ciclo_id = $1 ORDER BY plataforma', [ciclo.id]),
    auditorias: await db.many('SELECT data, tipo, nota, descricao FROM pulse_auditorias WHERE ciclo_id = $1 ORDER BY data', [ciclo.id]),
    erros: await db.many('SELECT data, descricao FROM pulse_erros_pedidos WHERE ciclo_id = $1 ORDER BY data', [ciclo.id]),
    errosConfirmados: !!(await db.one(`SELECT 1 FROM pulse_pernas_medidas WHERE ciclo_id = $1 AND perna = 'erros'`, [ciclo.id])),
  };
  const pessoas = colabs.map((c) => {
    const lab = Object.fromEntries(labels.filter((l) => l.colaborador_id === c.id).map((l) => [l.data, l.rotulo]));
    const porData = {};
    for (const r of regs[c.id] || []) porData[r.data] = r;
    for (const d of Object.keys(lab)) if (!porData[d]) porData[d] = { data: d };
    const dias = Object.values(porData).filter((r) => r.data >= c.admissao).sort((a, b) => a.data.localeCompare(b.data)).map((r) => ({
      data: r.data, rotulo: lab[r.data] || null,
      marc: r.tem_marcacao ? { entrada: r.entrada, saida_intervalo: r.saida_intervalo, retorno_intervalo: r.retorno_intervalo, saida: r.saida } : null,
      previsto: r.previsto_entrada ? { entrada: r.previsto_entrada, saida: r.previsto_saida, intervalo_min: r.intervalo_min } : null,
    }));
    // Rotinas que contam: dias passados, ou já feitas hoje; dia com ausência lançada não conta.
    const ausente = (d) => lab[d] && C.ROTULOS[lab[d]] && C.ROTULOS[lab[d]].ausencia;
    const minhas = atribs.filter((a) => a.colaborador_id === c.id && (a.data < hojeRef || a.status === 'feita') && !ausente(a.data));
    return { colaborador_id: c.id, nome: c.nome, admissao: c.admissao, dias, atribs: minhas,
      pendentesAusencia: atribs.filter((a) => a.colaborador_id === c.id && ausente(a.data)).length,
      consumo: consumoMap[c.id] ?? null };
  });
  return { pessoas, coletivaIn, limite };
}

async function recalcularCiclo(cicloId, { hojeRef } = {}) {
  const ciclo = await db.one('SELECT * FROM pulse_ciclos WHERE id = $1', [cicloId]);
  if (!ciclo) throw erro(404, 'Ciclo não encontrado');
  if (ciclo.status === 'fechado') return { fechado: true };
  const cfg = await db.getConfig();
  if (!hojeRef) hojeRef = (await db.agoraLocal(cfg)).hoje;
  const { pessoas, coletivaIn } = await carregarEntrada(ciclo, cfg, hojeRef);
  for (const p of pessoas) {
    p.vidaRes = C.calcVida(p.dias, cfg);
    p.pontRes = C.calcPontualidade(p.dias, cfg);
    p.scoreRes = C.calcScore(p.atribs);
  }
  const coletiva = C.calcColetiva(coletivaIn, cfg);
  const premios = C.calcPremios(pessoas, coletiva, ciclo, cfg);
  const porId = Object.fromEntries(pessoas.map((p) => [p.colaborador_id, p]));

  await db.tx(async (c) => {
    const ids = pessoas.map((p) => p.colaborador_id);
    for (const t of ['pulse_assiduidade_mensal', 'pulse_pontualidade_mensal', 'pulse_score_mensal', 'pulse_premiacao_mensal']) {
      await c.query(`DELETE FROM ${t} WHERE ciclo_id = $1 AND NOT (colaborador_id = ANY($2))`, [cicloId, ids]);
    }
    for (const p of pessoas) {
      const v = p.vidaRes, pt = p.pontRes, s = p.scoreRes;
      await c.query(`INSERT INTO pulse_assiduidade_mensal (ciclo_id, colaborador_id, percentual, minutos_atraso, faltas, atestados, sancoes, detalhe)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (ciclo_id, colaborador_id) DO UPDATE SET percentual = EXCLUDED.percentual,
          minutos_atraso = EXCLUDED.minutos_atraso, faltas = EXCLUDED.faltas, atestados = EXCLUDED.atestados, sancoes = EXCLUDED.sancoes, detalhe = EXCLUDED.detalhe`,
      [cicloId, p.colaborador_id, v.percentual, Math.round(v.minutos_atraso), v.faltas, v.atestados, v.sancoes, JSON.stringify(v.detalhe)]);
      await c.query(`INSERT INTO pulse_pontualidade_mensal (ciclo_id, colaborador_id, percentual, dias_avaliados, dias_certos, desvio, detalhe)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (ciclo_id, colaborador_id) DO UPDATE SET percentual = EXCLUDED.percentual,
          dias_avaliados = EXCLUDED.dias_avaliados, dias_certos = EXCLUDED.dias_certos, desvio = EXCLUDED.desvio, detalhe = EXCLUDED.detalhe`,
      [cicloId, p.colaborador_id, pt.percentual, pt.dias_avaliados, pt.dias_certos, JSON.stringify({ ...pt.desvio, motivo: pt.motivo }), JSON.stringify(pt.detalhe)]);
      await c.query(`INSERT INTO pulse_score_mensal (ciclo_id, colaborador_id, score, atribuidas, feitas, taxa)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (ciclo_id, colaborador_id) DO UPDATE SET score = EXCLUDED.score,
          atribuidas = EXCLUDED.atribuidas, feitas = EXCLUDED.feitas, taxa = EXCLUDED.taxa`,
      [cicloId, p.colaborador_id, s.score, s.atribuidas, s.feitas, s.taxa]);
    }
    await c.query(`INSERT INTO pulse_nota_coletiva_mensal (ciclo_id, percentual_final, fontes_detalhe) VALUES ($1,$2,$3)
        ON CONFLICT (ciclo_id) DO UPDATE SET percentual_final = EXCLUDED.percentual_final, fontes_detalhe = EXCLUDED.fontes_detalhe`,
    [cicloId, coletiva.percentual, JSON.stringify(coletiva.pernas)]);
    for (const r of premios) {
      await c.query(`INSERT INTO pulse_premiacao_mensal (ciclo_id, colaborador_id, posicao, fator_tempo_casa, r_assiduidade, r_score, r_coletiva, r_podio, total, consumo, abonado, desconto_folha, extrato, calculado_em)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
          ON CONFLICT (ciclo_id, colaborador_id) DO UPDATE SET posicao = EXCLUDED.posicao, fator_tempo_casa = EXCLUDED.fator_tempo_casa,
          r_assiduidade = EXCLUDED.r_assiduidade, r_score = EXCLUDED.r_score, r_coletiva = EXCLUDED.r_coletiva, r_podio = EXCLUDED.r_podio,
          total = EXCLUDED.total, consumo = EXCLUDED.consumo, abonado = EXCLUDED.abonado, desconto_folha = EXCLUDED.desconto_folha,
          extrato = EXCLUDED.extrato, calculado_em = NOW()`,
      [cicloId, r.colaborador_id, r.posicao, r.fator, r.r_assiduidade, r.r_score, r.r_coletiva, r.r_podio, r.total, r.consumo, r.abonado, r.desconto_folha, JSON.stringify(r.extrato)]);
    }
    // 7.8 marcadores diários — só dias PASSADOS (o gestor ainda lança ocorrências de hoje).
    for (const p of pessoas) {
      for (const d of p.dias) {
        if (d.data >= hojeRef) continue;
        let tipo = null;
        if (d.rotulo === 'FALTA') tipo = 'dia_com_falta';
        else if (d.marc && d.marc.entrada && d.previsto) tipo = p.vidaRes.atrasoPorDia[d.data] ? 'dia_com_atraso' : 'dia_sem_atraso';
        if (!tipo) continue;
        const existe = await c.query(`SELECT 1 FROM pulse_xp_historico WHERE colaborador_id = $1 AND origem IN ('dia_sem_atraso','dia_com_atraso','dia_com_falta') AND referencia = $2`, [p.colaborador_id, d.data]);
        if (existe.rowCount) continue; // marcador do dia já gravado (correções apagam o marcador antes)
        const xp = tipo === 'dia_sem_atraso' ? Number(cfg.xp_dia_sem_atraso) : 0;
        await creditarXp(c, p.colaborador_id, tipo, d.data, xp, tipo === 'dia_sem_atraso' ? 'Dia sem atraso' : (tipo === 'dia_com_falta' ? 'Dia com falta' : 'Dia com atraso'), d.data);
      }
      // XP das execuções feitas (idempotente; também é creditado na hora de marcar).
      for (const a of p.atribs.filter((x) => x.status === 'feita')) {
        await creditarXp(c, p.colaborador_id, a.tipo, `exec:${a.id}`, a.tipo === 'checklist' ? Number(cfg.xp_checklist) : Number(cfg.xp_tarefa), null, a.data);
      }
    }
    await c.query('UPDATE pulse_ciclos SET calculado_em = NOW() WHERE id = $1', [cicloId]);
  });
  await avaliarConquistas();
  return { pessoas: premios.length, coletiva: coletiva.percentual, porId: !!porId };
}

// Correção de um dia já passado: apaga o marcador para ser regravado no próximo recálculo.
async function invalidarMarcadorDia(colabId, data) {
  await db.q(`DELETE FROM pulse_xp_historico WHERE colaborador_id = $1 AND origem IN ('dia_sem_atraso','dia_com_atraso','dia_com_falta') AND referencia = $2`, [colabId, data]);
}

// ---------------- níveis, sequência, conquistas ----------------
async function niveis() { return db.many('SELECT * FROM pulse_niveis ORDER BY xp_min'); }
function nivelDe(lista, xp) {
  let atual = lista[0], prox = null;
  for (let i = 0; i < lista.length; i++) if (xp >= lista[i].xp_min) { atual = lista[i]; prox = lista[i + 1] || null; }
  return { nivel: atual.nivel, nome: atual.nome, xp, xp_min: atual.xp_min, proximo: prox ? { nivel: prox.nivel, nome: prox.nome, xp_min: prox.xp_min } : null,
    faltam: prox ? prox.xp_min - xp : 0, pct: prox ? C.round2(((xp - atual.xp_min) / (prox.xp_min - atual.xp_min)) * 100) : 100 };
}

async function metricasConquista(colabId, lista) {
  const xp = (await db.one('SELECT xp_total FROM pulse_xp_total WHERE colaborador_id = $1', [colabId])).xp_total;
  const marc = await db.many(`SELECT referencia AS data, origem AS tipo FROM pulse_xp_historico WHERE colaborador_id = $1 AND origem IN ('dia_sem_atraso','dia_com_atraso','dia_com_falta')`, [colabId]);
  const seq = C.calcSequencia(marc);
  const ex = await db.one(`SELECT COUNT(*) FILTER (WHERE r.tipo = 'tarefa')::int AS tarefas, COUNT(*) FILTER (WHERE r.tipo = 'checklist')::int AS checklists
      FROM pulse_rotinas_atribuidas a JOIN pulse_rotinas r ON r.id = a.rotina_id WHERE a.colaborador_id = $1 AND a.status = 'feita'`, [colabId]);
  // Meses fechados: só contam meses completos (fator 1) — bloqueia conquista "vacuamente verdadeira" de novato.
  const hist = await db.one(`SELECT COUNT(*) FILTER (WHERE faltas = 0 AND fator_tempo_casa >= 1)::int AS meses_sem_falta,
      COALESCE(MAX(vida) FILTER (WHERE fator_tempo_casa >= 1), 0) AS melhor_vida FROM pulse_premiacao_historico WHERE colaborador_id = $1`, [colabId]);
  const sc = await db.one('SELECT COALESCE(MAX(score),0)::int AS m FROM pulse_score_mensal WHERE colaborador_id = $1', [colabId]);
  const coins = await db.one('SELECT saldo, acumulado FROM pulse_coins_carteira WHERE colaborador_id = $1', [colabId]);
  const res = await db.one(`SELECT COUNT(*)::int AS n FROM pulse_loja_resgates WHERE colaborador_id = $1 AND status = 'aprovado'`, [colabId]);
  const conq = await db.one('SELECT COUNT(*)::int AS n FROM pulse_conquistas_desbloqueadas WHERE colaborador_id = $1', [colabId]);
  const av = await db.one('SELECT COUNT(*)::int AS n FROM pulse_avaliacoes WHERE colaborador_id = $1 AND positiva', [colabId]);
  const nv = nivelDe(lista, xp);
  return { xp_total: xp, nivel: nv.nivel, tarefas: ex.tarefas, checklists: ex.checklists,
    dias_seguidos_sem_atraso: seq.maior, dias_sem_atraso_total: seq.total, sequencia_atual: seq.atual,
    mes_sem_falta: hist.meses_sem_falta, vida_pct: Number(hist.melhor_vida), score_mes: sc.m,
    moedas_acumuladas: coins.acumulado, moedas_saldo: coins.saldo, resgates: res.n, conquistas_desbloqueadas: conq.n, avaliacoes_positivas: av.n };
}

function progresso(conquista, m) {
  const t = TIPOS_CONQUISTA[conquista.tipo];
  const atual = Number(m[conquista.tipo] ?? 0);
  const meta = Number(conquista.meta);
  return { atual: Math.min(atual, meta), meta, unidade: t ? t.unidade : '', pct: meta > 0 ? C.round2(Math.min(100, (atual / meta) * 100)) : 100,
    regra: t ? t.texto(meta) : conquista.tipo };
}

// Avaliação em cascata: desbloquear dá moedas e conta conquistas, o que pode desbloquear outras.
async function avaliarConquistas(colabIds) {
  const cfg = await db.getConfig();
  const lista = await niveis();
  const ids = colabIds || (await db.many('SELECT id FROM pulse_colaboradores WHERE ativo')).map((r) => r.id);
  const conquistas = await db.many('SELECT * FROM pulse_conquistas WHERE ativo');
  const novas = [];
  for (const id of ids) {
    for (let rodada = 0; rodada < 10; rodada++) {
      const m = await metricasConquista(id, lista);
      const ja = new Set((await db.many('SELECT conquista_id FROM pulse_conquistas_desbloqueadas WHERE colaborador_id = $1', [id])).map((r) => r.conquista_id));
      const liberar = conquistas.filter((c) => !ja.has(c.id) && Number(m[c.tipo] ?? 0) >= Number(c.meta));
      if (!liberar.length) break;
      await db.tx(async (cl) => {
        for (const c of liberar) {
          const ins = await cl.query('INSERT INTO pulse_conquistas_desbloqueadas (colaborador_id, conquista_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, c.id]);
          if (ins.rowCount) {
            const moedas = Number((cfg.moedas_raridade || {})[c.raridade] || 0);
            await cl.query(`INSERT INTO pulse_coins_historico (colaborador_id, origem, referencia, valor, descricao) VALUES ($1,'conquista',$2,$3,$4)
                ON CONFLICT (colaborador_id, origem, referencia) WHERE referencia IS NOT NULL DO NOTHING`, [id, String(c.id), moedas, `Conquista: ${c.nome}`]);
            novas.push({ colaborador_id: id, conquista: c.nome });
          }
        }
      });
    }
  }
  return novas;
}

// ---------------- checklist de fechamento ----------------
async function checklistFechamento(cicloId) {
  const ciclo = await db.one('SELECT * FROM pulse_ciclos WHERE id = $1', [cicloId]);
  const cfg = await db.getConfig();
  const { hoje } = await db.agoraLocal(cfg);
  const itens = [];
  const add = (item, numero, fonte, status, detalhe) => itens.push({ item, numero, fonte, status, detalhe: detalhe || null });

  const semVinc = await db.many(`SELECT c.nome FROM pulse_colaboradores c LEFT JOIN pulse_vinculos v ON v.colaborador_id = c.id WHERE c.ativo AND v.colaborador_id IS NULL ORDER BY c.nome`);
  add('Colaboradores ativos sem vínculo (fora do ranking)', semVinc.length, 'Cadastro × Vínculos', semVinc.length ? 'alerta' : 'ok', semVinc.map((x) => x.nome).join(', '));
  const inatVinc = await db.many(`SELECT c.nome FROM pulse_colaboradores c JOIN pulse_vinculos v ON v.colaborador_id = c.id WHERE NOT c.ativo ORDER BY c.nome`);
  add('Colaboradores inativos ainda vinculados', inatVinc.length, 'Cadastro × Vínculos', inatVinc.length ? 'alerta' : 'ok', inatVinc.map((x) => x.nome).join(', '));
  const vinculados = await db.many(`SELECT c.id, c.nome, c.admissao FROM pulse_colaboradores c JOIN pulse_vinculos v ON v.colaborador_id = c.id WHERE c.ativo AND c.admissao <= $1`, [ciclo.fim]);
  const semEscala = await db.many(`SELECT c.nome FROM pulse_colaboradores c JOIN pulse_vinculos v ON v.colaborador_id = c.id
      WHERE c.ativo AND NOT EXISTS (SELECT 1 FROM pulse_escalas e WHERE e.colaborador_id = c.id AND e.vigente_desde <= $1)`, [ciclo.fim]);
  add('Vinculados sem escala cadastrada (sem previsto, pontualidade não mede)', semEscala.length, 'Escalas', semEscala.length ? 'alerta' : 'ok', semEscala.map((x) => x.nome).join(', '));

  if (cfg.fonte_horario !== 'nenhuma') {
    const limite = ciclo.fim < hoje ? ciclo.fim : H.addDias(hoje, -1);
    let pend = [];
    if (limite >= ciclo.inicio && vinculados.length) {
      const regs = await H.registrosDiarios(cfg, vinculados.map((v) => v.id), ciclo.inicio, limite);
      const labels = await db.many('SELECT colaborador_id, data FROM pulse_ponto_labels WHERE data BETWEEN $1 AND $2', [ciclo.inicio, limite]);
      const lab = new Set(labels.map((l) => `${l.colaborador_id}|${l.data}`));
      for (const v of vinculados) for (const r of regs[v.id] || []) {
        if (r.data < v.admissao) continue;
        if (r.previsto_entrada && !r.tem_marcacao && !lab.has(`${v.id}|${r.data}`)) pend.push(`${v.nome} ${r.data.slice(8, 10)}/${r.data.slice(5, 7)}`);
      }
    }
    add('Dias de escala sem marcação nem ocorrência lançada', pend.length, 'Lançamento manual (Ponto)', pend.length ? 'alerta' : 'ok',
      pend.length ? pend.slice(0, 30).join('; ') + (pend.length > 30 ? ` … (+${pend.length - 30})` : '') : 'Não é falta: confira se foi folga ou esquecimento de lançamento.');
    const ult = await db.one(`SELECT COUNT(*)::int AS n, MAX(COALESCE(atualizado_em, lancado_em)) AS ultimo FROM pulse_marcacoes WHERE data BETWEEN $1 AND $2`, [ciclo.inicio, ciclo.fim]);
    add('Fonte de horário', ult.n, 'Lançamento manual', 'info', ult.n ? `${ult.n} marcação(ões) no ciclo; última em ${new Date(ult.ultimo).toLocaleString('pt-BR', { timeZone: cfg.fuso })}` : 'Nenhuma marcação lançada no ciclo');
  } else add('Fonte de horário', 0, 'Configuração', 'info', 'Sem controle de horário: Pontualidade e desconto por atraso desligados');

  const naoConc = await db.one(`SELECT COUNT(*)::int AS n FROM pulse_rotinas_atribuidas WHERE status = 'pendente' AND data BETWEEN $1 AND $2 AND data < $3`, [ciclo.inicio, ciclo.fim, hoje]);
  add('Rotinas atribuídas e não concluídas no mês', naoConc.n, 'Rotinas', naoConc.n ? 'alerta' : 'ok', naoConc.n ? 'Entram como não feitas na taxa de execução.' : null);

  const col = await db.one('SELECT * FROM pulse_nota_coletiva_mensal WHERE ciclo_id = $1', [cicloId]);
  const pernas = col ? col.fontes_detalhe : [];
  for (const nome of [['ifood', 'Nota coletiva — plataformas de delivery'], ['auditoria', 'Nota coletiva — auditoria própria / Higieniza'], ['erros', 'Nota coletiva — erros operacionais']]) {
    const p = pernas.find((x) => x.perna === nome[0]);
    add(nome[1], p && p.medida ? p.valor : null, 'Registros', p && p.medida ? 'ok' : 'faltando', p ? p.fonte : 'não calculado');
  }
  if (cfg.forma_pagamento === 'abono_consumo') {
    const semConsumo = await db.many(`SELECT c.nome FROM pulse_premiacao_mensal p JOIN pulse_colaboradores c ON c.id = p.colaborador_id
        LEFT JOIN pulse_consumo_mensal m ON m.ciclo_id = p.ciclo_id AND m.colaborador_id = p.colaborador_id
        WHERE p.ciclo_id = $1 AND m.colaborador_id IS NULL ORDER BY c.nome`, [cicloId]);
    add('Consumo do mês na loja lançado (base do abono)', semConsumo.length, 'PDV → aba Consumo', semConsumo.length ? 'faltando' : 'ok',
      semConsumo.length ? `Sem consumo lançado: ${semConsumo.map((x) => x.nome).join(', ')} (lance 0 para quem não consumiu)` : null);
  }
  const fresco = ciclo.calculado_em && (Date.now() - new Date(ciclo.calculado_em).getTime()) < 24 * 3600 * 1000;
  add('Cálculo atualizado nas últimas 24 h', ciclo.calculado_em ? 1 : 0, 'Recálculo', fresco ? 'ok' : 'faltando',
    ciclo.calculado_em ? `Último recálculo: ${new Date(ciclo.calculado_em).toLocaleString('pt-BR', { timeZone: cfg.fuso })}` : 'Nunca calculado');
  if (ciclo.fim >= hoje) add('Mês ainda em andamento', null, 'Calendário', 'faltando', `O ciclo termina em ${ciclo.fim.slice(8, 10)}/${ciclo.fim.slice(5, 7)}; só pode ser fechado depois.`);
  return { ciclo, itens, bloqueado: itens.some((i) => i.status === 'faltando') };
}

// ---------------- fechamento ----------------
async function fecharCiclo(cicloId, autor) {
  const ciclo = await db.one('SELECT * FROM pulse_ciclos WHERE id = $1', [cicloId]);
  if (!ciclo) throw erro(404, 'Ciclo não encontrado');
  if (ciclo.status === 'fechado') throw erro(400, 'Ciclo já fechado');
  const cfg = await db.getConfig();
  const { hoje } = await db.agoraLocal(cfg);
  if (ciclo.fim >= hoje) throw erro(400, 'O ciclo só pode ser fechado depois do último dia do mês');
  await recalcularCiclo(cicloId, { hojeRef: H.addDias(ciclo.fim, 1) });
  const ck = await checklistFechamento(cicloId);
  if (ck.bloqueado) throw erro(409, 'Checklist de fechamento com itens faltando: ' + ck.itens.filter((i) => i.status === 'faltando').map((i) => i.item).join('; '));
  await db.tx(async (c) => {
    const linhas = (await c.query(`SELECT p.*, a.percentual AS vida, a.faltas, t.percentual AS pont, s.taxa, s.score FROM pulse_premiacao_mensal p
        JOIN pulse_assiduidade_mensal a USING (ciclo_id, colaborador_id) JOIN pulse_pontualidade_mensal t USING (ciclo_id, colaborador_id)
        JOIN pulse_score_mensal s USING (ciclo_id, colaborador_id) WHERE p.ciclo_id = $1`, [cicloId])).rows;
    for (const l of linhas) {
      const ext = { ...l.extrato, fechado: true };
      await c.query(`INSERT INTO pulse_premiacao_historico (ciclo_id, colaborador_id, posicao, vida, pontualidade, taxa, score, faltas, fator_tempo_casa,
          r_assiduidade, r_score, r_coletiva, r_podio, total, consumo, abonado, desconto_folha, xp_convertido, extrato)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [cicloId, l.colaborador_id, l.posicao, l.vida, l.pont, l.taxa, l.score, l.faltas, l.fator_tempo_casa, l.r_assiduidade, l.r_score, l.r_coletiva,
        l.r_podio, l.total, l.consumo, l.abonado, l.desconto_folha, l.score, JSON.stringify(ext)]);
      if (l.score > 0) await creditarXp(c, l.colaborador_id, 'pontos_mes', `ciclo:${cicloId}`, l.score, `Pontos de rotina de ${String(ciclo.mes).padStart(2, '0')}/${ciclo.ano}`, ciclo.fim);
    }
    await c.query(`UPDATE pulse_ciclos SET status = 'fechado', fechado_em = NOW(), fechado_por = $2 WHERE id = $1`, [cicloId, autor]);
  });
  const prox = ciclo.mes === 12 ? [ciclo.ano + 1, 1] : [ciclo.ano, ciclo.mes + 1];
  await garantirCiclo(prox[0], prox[1]);
  await avaliarConquistas();
  return { ok: true };
}

// ---------------- leitura: ranking, extrato, metas ----------------
async function ranking(cicloId) {
  const ciclo = await db.one('SELECT * FROM pulse_ciclos WHERE id = $1', [cicloId]);
  const lista = await niveis();
  const fechado = ciclo.status === 'fechado';
  const rows = fechado
    ? await db.many(`SELECT h.*, h.vida AS vida, h.pontualidade AS pont, c.nome, c.matricula FROM pulse_premiacao_historico h
        JOIN pulse_colaboradores c ON c.id = h.colaborador_id WHERE h.ciclo_id = $1 ORDER BY h.posicao`, [cicloId])
    : await db.many(`SELECT p.*, a.percentual AS vida, t.percentual AS pont, s.taxa, s.score, c.nome, c.matricula FROM pulse_premiacao_mensal p
        JOIN pulse_colaboradores c ON c.id = p.colaborador_id
        JOIN pulse_assiduidade_mensal a USING (ciclo_id, colaborador_id) JOIN pulse_pontualidade_mensal t USING (ciclo_id, colaborador_id)
        JOIN pulse_score_mensal s USING (ciclo_id, colaborador_id) WHERE p.ciclo_id = $1 ORDER BY p.posicao`, [cicloId]);
  const totConq = (await db.one('SELECT COUNT(*)::int AS n FROM pulse_conquistas WHERE ativo')).n;
  const out = [];
  for (const r of rows) {
    const xp = (await db.one('SELECT xp_total FROM pulse_xp_total WHERE colaborador_id = $1', [r.colaborador_id])).xp_total;
    const pt = await db.one('SELECT dias_avaliados, dias_certos, desvio FROM pulse_pontualidade_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [cicloId, r.colaborador_id]);
    const sc = await db.one('SELECT atribuidas, feitas, score FROM pulse_score_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [cicloId, r.colaborador_id]);
    const coins = await db.one('SELECT saldo FROM pulse_coins_carteira WHERE colaborador_id = $1', [r.colaborador_id]);
    const cq = await db.one('SELECT COUNT(*)::int AS n FROM pulse_conquistas_desbloqueadas WHERE colaborador_id = $1', [r.colaborador_id]);
    out.push({ colaborador_id: r.colaborador_id, nome: r.nome, posicao: r.posicao, nivel: nivelDe(lista, xp),
      vida: r.vida, pontualidade: r.pont, pont_dias: pt ? { avaliados: pt.dias_avaliados, certos: pt.dias_certos, motivo: pt.desvio.motivo } : null,
      taxa: r.taxa, atribuidas: sc ? sc.atribuidas : null, feitas: sc ? sc.feitas : null, score: sc ? sc.score : r.score,
      coins: coins.saldo, conquistas: `${cq.n}/${totConq}`,
      r_assiduidade: r.r_assiduidade, r_score: r.r_score, r_coletiva: r.r_coletiva, r_podio: r.r_podio, total: r.total,
      consumo: r.consumo, abonado: r.abonado, desconto_folha: r.desconto_folha });
  }
  return { ciclo, fechado, linhas: out };
}

async function extrato(cicloId, colabId) {
  const ciclo = await db.one('SELECT * FROM pulse_ciclos WHERE id = $1', [cicloId]);
  if (!ciclo) throw erro(404, 'Ciclo não encontrado');
  const r = ciclo.status === 'fechado'
    ? await db.one('SELECT extrato, fechado_em AS calculado_em FROM pulse_premiacao_historico WHERE ciclo_id = $1 AND colaborador_id = $2', [cicloId, colabId])
    : await db.one('SELECT extrato, calculado_em FROM pulse_premiacao_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [cicloId, colabId]);
  if (!r) throw erro(404, 'Sem extrato para este colaborador neste ciclo');
  return { ...r.extrato, previsao: ciclo.status !== 'fechado', calculado_em: r.calculado_em, ciclo_id: cicloId };
}

async function metasECards(colabIds) {
  const lista = await niveis();
  const conquistas = await db.many('SELECT * FROM pulse_conquistas WHERE ativo ORDER BY meta');
  const ids = colabIds || (await db.many(`SELECT c.id FROM pulse_colaboradores c JOIN pulse_vinculos v ON v.colaborador_id = c.id WHERE c.ativo ORDER BY c.nome`)).map((r) => r.id);
  const out = [];
  for (const id of ids) {
    const c = await db.one('SELECT id, nome FROM pulse_colaboradores WHERE id = $1', [id]);
    const m = await metricasConquista(id, lista);
    const ja = new Set((await db.many('SELECT conquista_id FROM pulse_conquistas_desbloqueadas WHERE colaborador_id = $1', [id])).map((r) => r.conquista_id));
    const cards = conquistas.map((q) => ({ id: q.id, nome: q.nome, raridade: q.raridade, desbloqueada: ja.has(q.id), ...progresso(q, m) }));
    out.push({ colaborador_id: id, nome: c.nome, nivel: nivelDe(lista, m.xp_total), sequencia_atual: m.sequencia_atual, maior_sequencia: m.dias_seguidos_sem_atraso,
      total_sem_atraso: m.dias_sem_atraso_total, coins: m.moedas_saldo, desbloqueadas: ja.size, total_cards: conquistas.length,
      em_andamento: cards.filter((x) => !x.desbloqueada).sort((a, b) => b.pct - a.pct), cards });
  }
  return out;
}

module.exports = {
  bordasMes, garantirCiclo, cicloDaData, cicloAtual, gerarAtribuicoes, marcarRotina, recalcularCiclo, invalidarMarcadorDia,
  niveis, nivelDe, metricasConquista, progresso, avaliarConquistas, checklistFechamento, fecharCiclo, ranking, extrato, metasECards, erro, creditarXp,
};
