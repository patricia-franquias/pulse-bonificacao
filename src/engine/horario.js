'use strict';
// Fonte de horário (seção 8). O motor consome UM registro por colaborador por dia:
// { data, entrada, saida_intervalo, retorno_intervalo, saida, previsto_entrada, previsto_saida, intervalo_min }
// Para trocar a fonte (API de relógio, arquivo AFD), escreva outro adaptador com a mesma saída.
const db = require('../db');

function addDias(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diaSemana(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
function* datas(inicio, fim) { for (let d = inicio; d <= fim; d = addDias(d, 1)) yield d; }
const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

// Escala versionada: versão com maior vigente_desde <= data.
function previstoDaEscala(versoes, data) {
  let v = null;
  for (const e of versoes) if (e.vigente_desde <= data && (!v || e.vigente_desde > v.vigente_desde)) v = e;
  if (!v) return null;
  const d = v.dias[String(diaSemana(data))];
  if (!d || !d.entrada || !d.saida) return null;
  return { entrada: d.entrada, saida: d.saida, intervalo_min: d.intervalo ?? 60 };
}

// Adaptador C — lançamento manual. Exceção autorizada do dia vence a escala.
async function registrosManuais(colabIds, inicio, fim) {
  if (!colabIds.length) return {};
  const [escalas, overrides, marc] = await Promise.all([
    db.many('SELECT colaborador_id, vigente_desde, dias FROM pulse_escalas WHERE colaborador_id = ANY($1) AND vigente_desde <= $2', [colabIds, fim]),
    db.many('SELECT * FROM pulse_schedule_overrides WHERE colaborador_id = ANY($1) AND data BETWEEN $2 AND $3', [colabIds, inicio, fim]),
    db.many('SELECT * FROM pulse_marcacoes WHERE colaborador_id = ANY($1) AND data BETWEEN $2 AND $3', [colabIds, inicio, fim]),
  ]);
  const out = {};
  for (const id of colabIds) {
    const versoes = escalas.filter((e) => e.colaborador_id === id);
    const ov = Object.fromEntries(overrides.filter((o) => o.colaborador_id === id).map((o) => [o.data, o]));
    const mk = Object.fromEntries(marc.filter((m) => m.colaborador_id === id).map((m) => [m.data, m]));
    const regs = [];
    for (const data of datas(inicio, fim)) {
      const o = ov[data];
      const prev = o ? { entrada: hhmm(o.previsto_entrada), saida: hhmm(o.previsto_saida), intervalo_min: o.intervalo_min ?? 60 } : previstoDaEscala(versoes, data);
      const m = mk[data];
      if (!prev && !m) continue;
      regs.push({ data,
        entrada: m ? hhmm(m.entrada) : null, saida_intervalo: m ? hhmm(m.saida_intervalo) : null,
        retorno_intervalo: m ? hhmm(m.retorno_intervalo) : null, saida: m ? hhmm(m.saida) : null,
        tem_marcacao: !!m, excecao: !!o,
        previsto_entrada: prev ? prev.entrada : null, previsto_saida: prev ? prev.saida : null, intervalo_min: prev ? prev.intervalo_min : null });
    }
    out[id] = regs;
  }
  return out;
}

// Adaptador D — sem controle de horário: só o previsto (para saber dias de escala), sem marcações.
async function registrosSemHorario(colabIds, inicio, fim) {
  const r = await registrosManuais(colabIds, inicio, fim);
  for (const id of Object.keys(r)) r[id] = r[id].map((x) => ({ ...x, entrada: null, saida_intervalo: null, retorno_intervalo: null, saida: null, tem_marcacao: false }));
  return r;
}

async function registrosDiarios(cfg, colabIds, inicio, fim) {
  if (cfg.fonte_horario === 'nenhuma') return registrosSemHorario(colabIds, inicio, fim);
  return registrosManuais(colabIds, inicio, fim);
}

module.exports = { registrosDiarios, addDias, diaSemana, datas, previstoDaEscala };
