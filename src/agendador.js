'use strict';
// Processo de fundo, de hora em hora (seção 7, Fechamento):
// garante o ciclo do mês, gera as rotinas do dia, fecha ciclo vencido (se o checklist permitir)
// e recalcula todos uma vez por madrugada.
const db = require('./db');
const S = require('./engine/servico');

async function tick(log = console) {
  const cfg = await db.getConfig();
  const { hoje, hora } = await db.agoraLocal(cfg);
  const atual = await S.cicloDaData(hoje);
  const geradas = await S.gerarAtribuicoes(hoje);

  // Ciclos vencidos ainda abertos: tenta fechar; se o checklist bloquear, fica aberto e aparece no Dashboard.
  const vencidos = await db.many(`SELECT * FROM pulse_ciclos WHERE status = 'aberto' AND fim < $1 ORDER BY inicio`, [hoje]);
  for (const c of vencidos) {
    try { await S.fecharCiclo(c.id, 'agendador'); log.info && log.info(`[agendador] ciclo ${c.mes}/${c.ano} fechado`); }
    catch (e) { log.info && log.info(`[agendador] ciclo ${c.mes}/${c.ano} não fechado: ${e.message}`); }
  }

  const ultimo = await db.one(`SELECT valor FROM pulse_agendador WHERE chave = 'recalculo_diario'`);
  if (hora >= Number(cfg.recalculo_hora) && (!ultimo || ultimo.valor < hoje)) {
    const abertos = await db.many(`SELECT id FROM pulse_ciclos WHERE status = 'aberto'`);
    for (const c of abertos) await S.recalcularCiclo(c.id);
    await db.q(`INSERT INTO pulse_agendador (chave, valor) VALUES ('recalculo_diario', $1)
        ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`, [hoje]);
  }
  await db.q(`INSERT INTO pulse_agendador (chave, valor) VALUES ('ultimo_tick', $1)
      ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`, [new Date().toISOString()]);
  return { hoje, hora, ciclo: atual.id, rotinas_geradas: geradas };
}

function iniciar(log = console) {
  const rodar = () => tick(log).catch((e) => log.error && log.error('[agendador]', e));
  rodar();
  return setInterval(rodar, 60 * 60 * 1000);
}

module.exports = { tick, iniciar };
