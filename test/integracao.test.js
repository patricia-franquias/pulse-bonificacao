'use strict';
// Teste contra PostgreSQL real. Use um banco descartável:
//   TEST_DATABASE_URL=postgres://... node --test test/integracao.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const URL = process.env.TEST_DATABASE_URL;
if (!URL) { test('integração (pulado: defina TEST_DATABASE_URL)', { skip: true }, () => {}); return; }
process.env.DATABASE_URL = URL;
const db = require('../src/db');
const S = require('../src/engine/servico');

async function reset() {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
}

async function setup() {
  await reset();
  // Mês de teste: setembro/2026 (já passado → pode ser fechado).
  const mk = async (nome, mat, adm) => (await db.one('INSERT INTO pulse_colaboradores (nome, matricula, admissao) VALUES ($1,$2,$3) RETURNING id', [nome, mat, adm])).id;
  const ana = await mk('Ana', '001', '2025-01-10');
  const beto = await mk('Beto', '002', '2025-03-01');
  const caio = await mk('Caio', '003', '2026-09-20'); // novato: entrou dia 20 de um mês de 30
  const dani = await mk('Dani', '004', '2025-01-01'); // sem vínculo → fora do ranking
  for (const [id, m] of [[ana, '001'], [beto, '002'], [caio, '003']]) await db.q(`INSERT INTO pulse_vinculos VALUES ($1,'manual',$2)`, [id, m]);
  // Escala 6x1 (folga na quarta = 3), 16:00–23:00, intervalo 60.
  const dias = {}; for (let d = 0; d < 7; d++) dias[d] = d === 3 ? null : { entrada: '16:00', saida: '23:00', intervalo: 60 };
  for (const id of [ana, beto, caio]) await db.q(`INSERT INTO pulse_escalas (colaborador_id, vigente_desde, dias, criado_por) VALUES ($1,'2025-01-01',$2,'teste')`, [id, JSON.stringify(dias)]);
  const marc = (id, data, e, si = '19:00', ri = '20:00', s = '23:00') => db.q(`INSERT INTO pulse_marcacoes (colaborador_id, data, entrada, saida_intervalo, retorno_intervalo, saida, lancado_por) VALUES ($1,$2,$3,$4,$5,$6,'teste')`, [id, data, e, si, ri, s]);
  // Ana: 01 (ter) no horário; 02 = quarta (folga); 03 e 04 no horário; 05 entrou 19:00 = 3 h de atraso.
  await marc(ana, '2026-09-01', '16:00'); await marc(ana, '2026-09-03', '16:00'); await marc(ana, '2026-09-04', '16:00');
  await marc(ana, '2026-09-05', '19:00', '20:00', '21:00');
  // Beto: 2 faltas lançadas + 1 dia no horário + 1 dia 16:03 (pontualidade 70, vida sem desconto: 3 min < 5).
  await db.q(`INSERT INTO pulse_ponto_labels (colaborador_id, data, rotulo, lancado_por) VALUES ($1,'2026-09-01','FALTA','t'), ($1,'2026-09-02','FALTA','t')`, [beto]);
  await marc(beto, '2026-09-04', '16:00'); await marc(beto, '2026-09-05', '16:03');
  // Caio: 1 dia no horário.
  await marc(caio, '2026-09-21', '16:00');
  // Rotinas: Ana 10/10, Beto 20/20, Caio nada atribuído.
  const r1 = (await db.one(`INSERT INTO pulse_rotinas (titulo, tipo, pontos) VALUES ('Abrir loja','tarefa',1) RETURNING id`)).id;
  for (let i = 1; i <= 20; i++) {
    const d = `2026-09-${String(i).padStart(2, '0')}`;
    if (i <= 10) await db.q(`INSERT INTO pulse_rotinas_atribuidas (rotina_id, colaborador_id, data, status, pontos) VALUES ($1,$2,$3,'feita',1)`, [r1, ana, d]);
    await db.q(`INSERT INTO pulse_rotinas_atribuidas (rotina_id, colaborador_id, data, status, pontos) VALUES ($1,$2,$3,'feita',1)`, [r1, beto, d]);
  }
  const ciclo = await S.garantirCiclo(2026, 9);
  return { ana, beto, caio, dani, ciclo };
}

test('integração: cálculo, aceites, idempotência e fechamento', async (t) => {
  const { ana, beto, caio, dani, ciclo } = await setup();

  await t.test('perna ausente: sem lançamento, coletiva null e checklist faltando', async () => {
    await S.recalcularCiclo(ciclo.id);
    const col = await db.one('SELECT * FROM pulse_nota_coletiva_mensal WHERE ciclo_id = $1', [ciclo.id]);
    assert.equal(col.percentual_final, null);
    const ck = await S.checklistFechamento(ciclo.id);
    assert.ok(ck.bloqueado);
    assert.ok(ck.itens.find((i) => /auditoria/.test(i.item)).status === 'faltando');
  });

  await db.q(`INSERT INTO pulse_plataformas_notas (ciclo_id, plataforma, nota, amostra, fonte, lancado_por) VALUES ($1,'iFood',4.8,120,'painel público','t')`, [ciclo.id]);
  await db.q(`INSERT INTO pulse_pernas_medidas (ciclo_id, perna, confirmado_por) VALUES ($1,'erros','t')`, [ciclo.id]);

  await t.test('auditoria não lançada redistribui; coletiva ≠ 0', async () => {
    await S.recalcularCiclo(ciclo.id);
    const col = await db.one('SELECT * FROM pulse_nota_coletiva_mensal WHERE ciclo_id = $1', [ciclo.id]);
    assert.equal(col.percentual_final, 97.33);
  });

  await db.q(`INSERT INTO pulse_auditorias (ciclo_id, data, tipo, nota, lancado_por) VALUES ($1,'2026-09-15','propria',90,'t')`, [ciclo.id]);

  await t.test('Vida, pontualidade, taxa, tempo de casa e vínculo', async () => {
    await S.recalcularCiclo(ciclo.id);
    const a = await db.one('SELECT * FROM pulse_assiduidade_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [ciclo.id, ana]);
    assert.equal(a.minutos_atraso, 180); assert.equal(a.percentual, 97);
    const b = await db.one('SELECT * FROM pulse_assiduidade_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [ciclo.id, beto]);
    assert.equal(b.percentual, 80); assert.equal(b.faltas, 2);
    const pb = await db.one('SELECT * FROM pulse_pontualidade_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [ciclo.id, beto]);
    assert.equal(pb.percentual, 85); // (100 + 70) / 2
    const sa = await db.one('SELECT * FROM pulse_score_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [ciclo.id, ana]);
    const sb = await db.one('SELECT * FROM pulse_score_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [ciclo.id, beto]);
    assert.equal(sa.taxa, 100); assert.equal(sb.taxa, 100);
    const pa = await db.one('SELECT * FROM pulse_premiacao_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [ciclo.id, ana]);
    const pbb = await db.one('SELECT * FROM pulse_premiacao_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [ciclo.id, beto]);
    assert.equal(pa.r_score, pbb.r_score);
    const pc = await db.one('SELECT * FROM pulse_premiacao_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [ciclo.id, caio]);
    assert.equal(pc.r_score, 0);
    assert.equal(Number(pc.fator_tempo_casa).toFixed(4), (11 / 30).toFixed(4));
    const pd = await db.one('SELECT * FROM pulse_premiacao_mensal WHERE ciclo_id = $1 AND colaborador_id = $2', [ciclo.id, dani]);
    assert.equal(pd, null); // sem vínculo, fora do ranking
  });

  await t.test('sequência: folga de quarta não quebra; atraso quebra', async () => {
    const m = await S.metricasConquista(ana, await S.niveis());
    // Ana: 01 ok, (02 folga), 03 ok, 04 ok, 05 atraso → maior 3, atual 0
    assert.equal(m.dias_seguidos_sem_atraso, 3); assert.equal(m.sequencia_atual, 0); assert.equal(m.dias_sem_atraso_total, 3);
  });

  await t.test('recálculo 3 vezes: totais e XP idênticos', async () => {
    const snap = async () => ({
      p: await db.many('SELECT colaborador_id, total, posicao FROM pulse_premiacao_mensal WHERE ciclo_id = $1 ORDER BY colaborador_id', [ciclo.id]),
      xp: await db.many('SELECT colaborador_id, xp_total FROM pulse_xp_total ORDER BY colaborador_id'),
      coins: await db.many('SELECT colaborador_id, saldo FROM pulse_coins_carteira ORDER BY colaborador_id'),
    });
    const s1 = await snap();
    await S.recalcularCiclo(ciclo.id); await S.recalcularCiclo(ciclo.id); await S.recalcularCiclo(ciclo.id);
    assert.deepEqual(await snap(), s1);
  });

  await t.test('fechamento bloqueado sem consumo; fecha com consumo; extrato congela', async () => {
    await assert.rejects(() => S.fecharCiclo(ciclo.id, 'teste'), /faltando/);
    for (const [id, v] of [[ana, 250], [beto, 0], [caio, 40]]) await db.q('INSERT INTO pulse_consumo_mensal (ciclo_id, colaborador_id, consumo, lancado_por) VALUES ($1,$2,$3,$4)', [ciclo.id, id, v, 't']);
    await S.fecharCiclo(ciclo.id, 'teste');
    const hist = await db.many('SELECT * FROM pulse_premiacao_historico WHERE ciclo_id = $1 ORDER BY posicao', [ciclo.id]);
    assert.equal(hist.length, 3);
    const ha = hist.find((h) => h.colaborador_id === ana);
    assert.ok(ha.abonado <= 250 && ha.abonado <= ha.total);
    const hb = hist.find((h) => h.colaborador_id === beto);
    assert.equal(hb.abonado, 0); assert.equal(hb.desconto_folha, 0);
    const ext1 = await S.extrato(ciclo.id, ana);
    await db.q(`UPDATE pulse_configuracoes SET valor = '999' WHERE chave = 'teto_assiduidade'`);
    await S.recalcularCiclo(ciclo.id); // não faz nada em ciclo fechado
    const ext2 = await S.extrato(ciclo.id, ana);
    assert.deepEqual(ext2.blocos, ext1.blocos);
    assert.equal(ext2.previsao, false);
    // pontos do mês viraram XP (uma vez)
    const xp = await db.one(`SELECT COUNT(*)::int AS n FROM pulse_xp_historico WHERE origem = 'pontos_mes' AND colaborador_id = $1`, [beto]);
    assert.equal(xp.n, 1);
    const prox = await db.one('SELECT * FROM pulse_ciclos WHERE ano = 2026 AND mes = 10');
    assert.ok(prox);
  });

  await t.test('conquistas: novato não ganha "mês sem falta"; Ana ganha', async () => {
    const q = async (id) => (await db.many(`SELECT c.codigo FROM pulse_conquistas_desbloqueadas d JOIN pulse_conquistas c ON c.id = d.conquista_id WHERE d.colaborador_id = $1`, [id])).map((r) => r.codigo);
    assert.ok((await q(ana)).includes('mes-sem-falta'));
    assert.ok(!(await q(caio)).includes('mes-sem-falta'));
    assert.ok(!(await q(beto)).includes('mes-sem-falta'));
    const coins = await db.one('SELECT saldo FROM pulse_coins_carteira WHERE colaborador_id = $1', [ana]);
    assert.ok(coins.saldo > 0);
  });

  await db.getPool().end();
});
