'use strict';
// Motor de cálculo puro: sem banco, sem relógio. Cada função devolve o número E a explicação,
// para o extrato ser construído junto com o cálculo (seção 11, passo 3).

// ---------------- utilitários ----------------
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

function toMin(hhmm) {
  if (hhmm === null || hhmm === undefined || hhmm === '') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm).trim());
  if (!m) return null;
  // Lançamento manual: "00:00" é meia-noite de verdade. (Um adaptador de relógio que use "00:00" como vazio
  // deve convertê-lo para null antes de chegar aqui.)
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmtNum(v, casas = 1) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
const fmtPct = (v) => (v === null || v === undefined ? '—' : `${fmtNum(v, 1)}%`);
const fmtBRL = (v) => `R$ ${fmtNum(v, 2)}`;
function fmtData(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}`; }

// ---------------- rótulos do dia (7.2) ----------------
const ROTULOS = {
  FALTA: { nome: 'Falta', desconto: 'vida_desconto_falta', ausencia: true, quebraSequencia: true },
  ATESTADO: { nome: 'Atestado', desconto: 'vida_desconto_atestado', ausencia: true },
  SANCAO: { nome: 'Sanção', desconto: 'vida_desconto_sancao', ausencia: false },
  FOLGA: { nome: 'Folga', ausencia: true },
  FERIADO: { nome: 'Feriado', ausencia: true },
  FERIAS: { nome: 'Férias', ausencia: true },
  AFASTAMENTO: { nome: 'Afastamento', ausencia: true },
  // Exceções definidas na versão 2 do programa: não descontam.
  AUSENCIA_LEGAL: { nome: 'Ausência legal (CLT art. 473)', ausencia: true },
  ACIDENTE_TRABALHO: { nome: 'Acidente de trabalho', ausencia: true },
  AFASTAMENTO_SINTOMA: { nome: 'Afastado pela gerência por sintoma', ausencia: true },
};
const SINONIMOS = {
  'FALTA': 'FALTA', 'FALTOU': 'FALTA', 'FALTA INJUSTIFICADA': 'FALTA',
  'ATESTADO': 'ATESTADO', 'LICENCA': 'ATESTADO', 'LICENÇA': 'ATESTADO', 'ATESTADO MEDICO': 'ATESTADO', 'ATESTADO MÉDICO': 'ATESTADO',
  'SANCAO': 'SANCAO', 'SANÇÃO': 'SANCAO', 'SUSPENSAO': 'SANCAO', 'SUSPENSÃO': 'SANCAO', 'ADVERTENCIA': 'SANCAO', 'ADVERTÊNCIA': 'SANCAO',
  'FOLGA': 'FOLGA', 'DSR': 'FOLGA', 'FOLGA COMPENSATORIA': 'FOLGA', 'BANCO DE HORAS': 'FOLGA',
  'FERIADO': 'FERIADO', 'FERIAS': 'FERIAS', 'FÉRIAS': 'FERIAS',
  'AFASTAMENTO': 'AFASTAMENTO', 'INSS': 'AFASTAMENTO',
  'AUSENCIA LEGAL': 'AUSENCIA_LEGAL', 'AUSÊNCIA LEGAL': 'AUSENCIA_LEGAL', 'AUSENCIA_LEGAL': 'AUSENCIA_LEGAL',
  'LICENCA MATERNIDADE': 'AUSENCIA_LEGAL', 'LICENÇA MATERNIDADE': 'AUSENCIA_LEGAL', 'LICENCA PATERNIDADE': 'AUSENCIA_LEGAL', 'LICENÇA PATERNIDADE': 'AUSENCIA_LEGAL',
  'NOJO': 'AUSENCIA_LEGAL', 'GALA': 'AUSENCIA_LEGAL', 'DOACAO DE SANGUE': 'AUSENCIA_LEGAL', 'DOAÇÃO DE SANGUE': 'AUSENCIA_LEGAL',
  'ACIDENTE DE TRABALHO': 'ACIDENTE_TRABALHO', 'ACIDENTE_TRABALHO': 'ACIDENTE_TRABALHO',
  'AFASTAMENTO POR SINTOMA': 'AFASTAMENTO_SINTOMA', 'AFASTAMENTO_SINTOMA': 'AFASTAMENTO_SINTOMA', 'SINTOMA': 'AFASTAMENTO_SINTOMA',
};
function normalizarRotulo(txt) {
  if (!txt) return null;
  const k = String(txt).trim().toUpperCase().replace(/\s+/g, ' ');
  if (ROTULOS[k]) return k;
  return SINONIMOS[k] || null;
}

// ---------------- dia normalizado ----------------
// Converte marcações e previsto em minutos, tratando virada da meia-noite:
// qualquer horário mais de 6 h antes da entrada é lido como do dia seguinte.
function normalizarDia(dia) {
  const out = { data: dia.data, rotulo: dia.rotulo || null, marc: null, prev: null };
  if (dia.marc) {
    const e = toMin(dia.marc.entrada);
    const fix = (v) => (v === null || e === null ? v : (v < e - 360 ? v + 1440 : v));
    out.marc = {
      entrada: e,
      saida_intervalo: fix(toMin(dia.marc.saida_intervalo)),
      retorno_intervalo: fix(toMin(dia.marc.retorno_intervalo)),
      saida: fix(toMin(dia.marc.saida)),
    };
  }
  if (dia.previsto) {
    const pe = toMin(dia.previsto.entrada);
    let ps = toMin(dia.previsto.saida);
    if (pe !== null && ps !== null && ps <= pe) ps += 1440;
    if (pe !== null) out.prev = { entrada: pe, saida: ps, intervalo: dia.previsto.intervalo_min ?? 60 };
  }
  return out;
}

// ---------------- 7.1 Vida ----------------
function calcVida(diasBrutos, cfg) {
  const dias = diasBrutos.map(normalizarDia);
  const descontos = [];
  let faltas = 0, atestados = 0, sancoes = 0, minutos = 0;
  const atrasoPorDia = {};
  for (const d of dias) {
    const r = d.rotulo ? ROTULOS[d.rotulo] : null;
    if (r && r.desconto) {
      const pts = Number(cfg[r.desconto]);
      if (d.rotulo === 'FALTA') faltas++;
      if (d.rotulo === 'ATESTADO') atestados++;
      if (d.rotulo === 'SANCAO') sancoes++;
      descontos.push({ data: d.data, tipo: r.nome, pontos: pts, texto: `${fmtData(d.data)} — ${r.nome}: −${fmtNum(pts, 1)}%` });
    }
    if (d.marc && d.prev && d.marc.entrada !== null) {
      let min = 0; const partes = [];
      const atr = d.marc.entrada - d.prev.entrada;
      if (atr > cfg.vida_tolerancia_entrada) { min += atr; partes.push(`entrada ${atr} min atrasada`); }
      if (d.marc.saida_intervalo !== null && d.marc.retorno_intervalo !== null) {
        const exc = (d.marc.retorno_intervalo - d.marc.saida_intervalo) - d.prev.intervalo;
        if (exc > cfg.vida_tolerancia_intervalo) { min += exc; partes.push(`intervalo ${exc} min além do previsto`); }
      }
      if (min > 0) {
        minutos += min; atrasoPorDia[d.data] = min;
        descontos.push({ data: d.data, tipo: 'Atraso', minutos: min, pontos: null, texto: `${fmtData(d.data)} — ${partes.join(' + ')}` });
      }
    }
  }
  const descHoras = (minutos / 60) * Number(cfg.vida_desconto_hora);
  const total = faltas * cfg.vida_desconto_falta + atestados * cfg.vida_desconto_atestado + sancoes * cfg.vida_desconto_sancao + descHoras;
  const percentual = round2(Math.max(0, 100 - total));
  return {
    percentual, minutos_atraso: minutos, faltas, atestados, sancoes, atrasoPorDia,
    detalhe: {
      descontos,
      resumo: [
        faltas ? `${faltas} falta(s) × ${fmtNum(cfg.vida_desconto_falta, 0)}% = −${fmtNum(faltas * cfg.vida_desconto_falta, 1)}%` : null,
        atestados ? `${atestados} atestado(s) × ${fmtNum(cfg.vida_desconto_atestado, 0)}% = −${fmtNum(atestados * cfg.vida_desconto_atestado, 1)}%` : null,
        sancoes ? `${sancoes} sanção(ões) × ${fmtNum(cfg.vida_desconto_sancao, 0)}% = −${fmtNum(sancoes * cfg.vida_desconto_sancao, 1)}%` : null,
        minutos ? `${minutos} min de atraso = ${fmtNum(minutos / 60, 2)} h × ${fmtNum(cfg.vida_desconto_hora, 0)}% = −${fmtNum(descHoras, 2)}%` : null,
      ].filter(Boolean),
    },
  };
}

// ---------------- 7.3 Pontualidade ----------------
const TIPOS_DESVIO = {
  entrada_atrasada: 'entrada atrasada',
  entrada_antecipada: 'entrada antecipada',
  intervalo: 'intervalo fora do previsto',
  saida: 'saiu depois',
};
function calcPontualidade(diasBrutos, cfg) {
  const dias = diasBrutos.map(normalizarDia);
  const porDia = []; const desvio = { entrada_atrasada: 0, entrada_antecipada: 0, intervalo: 0, saida: 0 };
  for (const d of dias) {
    if (!d.marc || d.marc.entrada === null || !d.prev) continue; // sem entrada ou sem previsto: sai da média
    const dv = { entrada_atrasada: 0, entrada_antecipada: 0, intervalo: 0, saida: 0 };
    const diff = d.marc.entrada - d.prev.entrada;
    if (diff > 0) dv.entrada_atrasada = Math.max(0, diff - cfg.pont_tol_atraso);
    if (diff < 0) dv.entrada_antecipada = Math.max(0, -diff - cfg.pont_tol_antecipada);
    if (d.marc.saida_intervalo !== null && d.marc.retorno_intervalo !== null) {
      const dur = d.marc.retorno_intervalo - d.marc.saida_intervalo;
      dv.intervalo = Math.max(0, Math.abs(dur - d.prev.intervalo) - cfg.pont_tol_intervalo);
    }
    if (d.marc.saida !== null && d.prev.saida !== null) dv.saida = Math.max(0, d.marc.saida - d.prev.saida - cfg.pont_tol_saida);
    const totalMin = dv.entrada_atrasada + dv.entrada_antecipada + dv.intervalo + dv.saida;
    const nota = Math.max(0, 100 - totalMin * cfg.pont_peso);
    for (const k of Object.keys(desvio)) desvio[k] += dv[k];
    const motivo = totalMin === 0 ? 'sem desvio'
      : Object.entries(dv).filter(([, v]) => v > 0).map(([k, v]) => `${TIPOS_DESVIO[k]} ${v} min`).join(', ');
    porDia.push({ data: d.data, nota, desvios: dv, motivo });
  }
  if (!porDia.length) return { percentual: null, dias_avaliados: 0, dias_certos: 0, desvio, detalhe: [], motivo: 'sem dia medido' };
  const media = porDia.reduce((s, x) => s + x.nota, 0) / porDia.length;
  const certos = porDia.filter((x) => x.nota === 100).length;
  const maior = Object.entries(desvio).sort((a, b) => b[1] - a[1])[0];
  const motivo = maior[1] === 0 ? 'sem desvio' : `${TIPOS_DESVIO[maior[0]]} ${maior[1]} min`;
  return { percentual: round2(media), dias_avaliados: porDia.length, dias_certos: certos, desvio, detalhe: porDia, motivo };
}

// ---------------- 7.4 Score = taxa de execução ----------------
// atribs: [{data, status, tipo, pontos}] já filtradas (só as que contam).
function calcScore(atribs) {
  const atribuidas = atribs.length;
  const feitas = atribs.filter((a) => a.status === 'feita').length;
  const score = atribs.filter((a) => a.status === 'feita').reduce((s, a) => s + Number(a.pontos || 0), 0);
  const taxa = atribuidas === 0 ? null : round2((feitas / atribuidas) * 100);
  return { atribuidas, feitas, score, taxa };
}

// ---------------- 7.6 Nota coletiva ----------------
function calcColetiva(input, cfg) {
  const pesos = cfg.coletiva_pesos || { ifood: 40, auditoria: 40, erros: 20 };
  const pernas = [];
  // iFood (e outras plataformas): nota pública 0–5, lançada à mão.
  const notas = input.plataformas || [];
  if (notas.length) {
    const media = notas.reduce((s, n) => s + Number(n.nota), 0) / notas.length;
    pernas.push({ perna: 'ifood', nome: 'Nota das plataformas de delivery', medida: true, valor: round2((media / 5) * 100),
      fonte: notas.map((n) => `${n.plataforma}: ${fmtNum(n.nota, 2)}/5${n.amostra ? ` (${n.amostra} avaliações)` : ''}${n.fonte ? ` — ${n.fonte}` : ''}`).join('; '),
      amostra: notas.reduce((s, n) => s + (Number(n.amostra) || 0), 0) || null,
      conta: `média ${fmtNum(media, 2)} ÷ 5 = ${fmtPct((media / 5) * 100)}` });
  } else pernas.push({ perna: 'ifood', nome: 'Nota das plataformas de delivery', medida: false, valor: null, fonte: 'não lançada', amostra: null });
  // Auditoria própria / Higieniza: nota 0–100 por auditoria; média do mês.
  const aud = input.auditorias || [];
  if (aud.length) {
    const media = aud.reduce((s, a) => s + Number(a.nota), 0) / aud.length;
    pernas.push({ perna: 'auditoria', nome: 'Auditoria própria / Higieniza', medida: true, valor: round2(media),
      fonte: aud.map((a) => `${fmtData(a.data)} ${a.tipo === 'higieniza' ? 'Higieniza' : 'própria'}: ${fmtPct(Number(a.nota))}`).join('; '),
      amostra: aud.length, conta: `média de ${aud.length} auditoria(s) = ${fmtPct(media)}` });
  } else pernas.push({ perna: 'auditoria', nome: 'Auditoria própria / Higieniza', medida: false, valor: null, fonte: 'não lançada', amostra: null });
  // Erros operacionais: só é medido se houver erro lançado OU confirmação de "medido sem erros".
  const qErros = (input.erros || []).length;
  const pen = Number(cfg.coletiva_penalidade_erro);
  if (qErros > 0 || input.errosConfirmados) {
    const v = Math.max(0, 100 - qErros * pen);
    pernas.push({ perna: 'erros', nome: 'Erros operacionais', medida: true, valor: v,
      fonte: qErros ? `${qErros} erro(s) lançado(s) pela operação` : 'mês confirmado sem erros', amostra: qErros,
      conta: `100 − ${qErros} × ${fmtNum(pen, 0)} = ${fmtPct(v)}` });
  } else pernas.push({ perna: 'erros', nome: 'Erros operacionais', medida: false, valor: null, fonte: 'não lançado (zero erros lançados = não medido)', amostra: null });

  const medidas = pernas.filter((p) => p.medida);
  const somaPesos = medidas.reduce((s, p) => s + Number(pesos[p.perna] || 0), 0);
  for (const p of pernas) {
    p.peso_nominal = Number(pesos[p.perna] || 0);
    p.peso_efetivo = p.medida && somaPesos > 0 ? round2((p.peso_nominal / somaPesos) * 100) : 0;
  }
  const percentual = somaPesos > 0 ? round2(medidas.reduce((s, p) => s + p.valor * p.peso_nominal, 0) / somaPesos) : null;
  return { percentual, pernas };
}

// ---------------- 7.9 Tempo de casa ----------------
function diasEntre(a, b) { // inclusivo, datas ISO
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
}
function fatorTempoCasa(admissao, inicio, fim) {
  if (!admissao || admissao <= inicio) return { fator: 1, dias: null, total: diasEntre(inicio, fim) };
  const total = diasEntre(inicio, fim);
  const dias = Math.max(0, diasEntre(admissao, fim));
  return { fator: dias / total, dias, total };
}

// ---------------- 7.5 Ranking ----------------
function compararRanking(a, b) {
  if (b.vida !== a.vida) return b.vida - a.vida;
  const pa = a.pontualidade === null ? 100 : a.pontualidade;
  const pb = b.pontualidade === null ? 100 : b.pontualidade;
  if (pb !== pa) return pb - pa;
  const ta = a.taxa === null ? -1 : a.taxa;
  const tb = b.taxa === null ? -1 : b.taxa;
  if (tb !== ta) return tb - ta;
  if (b.score !== a.score) return b.score - a.score;
  return String(a.nome).localeCompare(String(b.nome), 'pt-BR');
}

// ---------------- Prêmio + extrato ----------------
// pessoas: [{colaborador_id, nome, admissao, vida:{...}, pont:{...}, score:{...}, consumo}]
function calcPremios(pessoas, coletiva, ciclo, cfg) {
  const ordenadas = pessoas.map((p) => ({ ...p,
    vida: p.vidaRes.percentual,
    pontualidade: cfg.pont_habilitada ? p.pontRes.percentual : null,
    taxa: p.scoreRes.taxa, score: p.scoreRes.score })).sort(compararRanking);
  const taxas = ordenadas.map((p) => p.taxa).filter((t) => t !== null);
  const maiorTaxa = taxas.length ? Math.max(...taxas) : null;
  const podio = cfg.podio || [];
  return ordenadas.map((p, i) => {
    const posicao = i + 1;
    const ft = fatorTempoCasa(p.admissao, ciclo.inicio, ciclo.fim);
    const rA = round2((p.vida / 100) * cfg.teto_assiduidade * ft.fator);
    const rS = p.taxa === null || !maiorTaxa ? 0 : round2(Math.min(cfg.teto_score, (p.taxa / maiorTaxa) * cfg.teto_score));
    const rC = coletiva.percentual === null ? 0 : round2((coletiva.percentual / 100) * cfg.teto_coletiva * ft.fator);
    const rP = round2(Number(podio[i] || 0));
    const soma = round2(rA + rS + rC + rP);
    const total = cfg.teto_total ? Math.min(soma, Number(cfg.teto_total)) : soma;
    const abono = cfg.forma_pagamento === 'abono_consumo';
    const consumo = p.consumo === null || p.consumo === undefined ? null : Number(p.consumo);
    const abonado = abono && consumo !== null ? round2(Math.min(total, consumo)) : null;
    const descontoFolha = abono && consumo !== null ? round2(consumo - abonado) : null;
    const extrato = montarExtrato({ p, posicao, ft, rA, rS, rC, rP, soma, total, consumo, abonado, descontoFolha, maiorTaxa, coletiva, cfg, ciclo });
    return { colaborador_id: p.colaborador_id, nome: p.nome, posicao, fator: ft.fator, vida: p.vida, pontualidade: p.pontualidade,
      taxa: p.taxa, score: p.score, r_assiduidade: rA, r_score: rS, r_coletiva: rC, r_podio: rP, total,
      consumo, abonado, desconto_folha: descontoFolha, extrato };
  });
}

function montarExtrato({ p, posicao, ft, rA, rS, rC, rP, soma, total, consumo, abonado, descontoFolha, maiorTaxa, coletiva, cfg, ciclo }) {
  const fatorTxt = ft.fator < 1 ? ` × ${ft.dias}/${ft.total} (tempo de casa)` : '';
  const blocos = [];
  blocos.push({ chave: 'assiduidade', titulo: 'Assiduidade', valor: rA, cor: 'verde',
    descricao: 'Começa em 100% e cai conforme atrasos e ausências do mês.',
    itens: p.vidaRes.detalhe.descontos.map((d) => d.texto), resumo: p.vidaRes.detalhe.resumo,
    conta: `${fmtPct(p.vida)} de vida × ${fmtBRL(cfg.teto_assiduidade)}${fatorTxt} = ${fmtBRL(rA)}` });
  const pr = p.pontRes;
  blocos.push({ chave: 'pontualidade', titulo: 'Pontualidade', valor: null, cor: 'cinza',
    descricao: cfg.pont_habilitada ? 'No dia em que veio, cumpriu o horário? Não paga: só ordena o ranking.' : 'Desligada.',
    itens: pr.detalhe.filter((d) => d.nota < 100).map((d) => `${fmtData(d.data)} — ${d.motivo}: ${fmtNum(d.nota, 0)} pts`),
    resumo: pr.dias_avaliados ? [`${pr.dias_certos} de ${pr.dias_avaliados} dias inteiramente no horário`,
      ...Object.entries(pr.desvio).filter(([, v]) => v > 0).map(([k, v]) => `${TIPOS_DESVIO[k]}: ${v} min no mês`)] : ['Nenhum dia medido no mês'],
    conta: pr.percentual === null ? 'Pontualidade: — (sem dia medido)' : `Média de ${pr.dias_avaliados} dia(s) = ${fmtPct(pr.percentual)}` });
  blocos.push({ chave: 'score', titulo: 'Score (execução)', valor: rS, cor: 'azul',
    descricao: 'Taxa de execução: rotinas feitas ÷ atribuídas. Quem fez tudo o que recebeu empata com quem fez tudo de uma carga maior.',
    itens: [], resumo: [`${p.scoreRes.feitas} feitas de ${p.scoreRes.atribuidas} atribuídas · ${p.scoreRes.score} pts`],
    conta: p.taxa === null ? 'Nada atribuído no mês: Score — = R$ 0,00'
      : `(${fmtPct(p.taxa)} ÷ ${fmtPct(maiorTaxa)} maior taxa do mês) × ${fmtBRL(cfg.teto_score)} = ${fmtBRL(rS)}` });
  blocos.push({ chave: 'coletiva', titulo: 'Coletiva', valor: rC, cor: 'amarelo',
    descricao: 'Igual para toda a equipe. Perna não lançada sai da média e o peso se redistribui.',
    itens: coletiva.pernas.map((x) => x.medida
      ? `${x.nome}: ${fmtPct(x.valor)} · peso ${fmtNum(x.peso_nominal, 0)}% → efetivo ${fmtNum(x.peso_efetivo, 1)}% · ${x.fonte}`
      : `${x.nome}: não medida · peso ${fmtNum(x.peso_nominal, 0)}% redistribuído`),
    resumo: [],
    conta: coletiva.percentual === null ? 'Nenhuma perna lançada: Coletiva = R$ 0,00'
      : `${fmtPct(coletiva.percentual)} × ${fmtBRL(cfg.teto_coletiva)}${fatorTxt} = ${fmtBRL(rC)}` });
  blocos.push({ chave: 'podio', titulo: 'Pódio', valor: rP, cor: 'vermelho',
    descricao: 'Posição no ranking: Vida, depois Pontualidade, depois taxa de execução.',
    itens: [], resumo: [],
    conta: rP > 0 ? `${posicao}º lugar = ${fmtBRL(rP)}` : `${posicao}º lugar, fora do pódio = R$ 0,00` });
  const pagamento = { forma: cfg.forma_pagamento, consumo, abonado, desconto_folha: descontoFolha, linhas: [] };
  if (soma > total) pagamento.linhas.push(`Soma ${fmtBRL(soma)} limitada ao teto de ${fmtBRL(total)}`);
  if (cfg.forma_pagamento === 'abono_consumo') {
    if (consumo === null) pagamento.linhas.push('Consumo do mês na loja ainda não lançado: abono pendente.');
    else {
      pagamento.linhas.push(`Consumo na loja no mês: ${fmtBRL(consumo)}`);
      pagamento.linhas.push(`Abonado (não descontado do salário): menor entre ${fmtBRL(total)} e ${fmtBRL(consumo)} = ${fmtBRL(abonado)}`);
      pagamento.linhas.push(`Desconto em folha: ${fmtBRL(consumo)} − ${fmtBRL(abonado)} = ${fmtBRL(descontoFolha)}`);
      if (total > abonado) pagamento.linhas.push(`${fmtBRL(round2(total - abonado))} de bônus sem consumo: não vira dinheiro e não acumula.`);
    }
  }
  return {
    ciclo: `${String(ciclo.mes).padStart(2, '0')}/${ciclo.ano}`, colaborador: p.nome, posicao, total,
    composicao: [
      { parte: 'Assiduidade', valor: rA, cor: 'verde' }, { parte: 'Score', valor: rS, cor: 'azul' },
      { parte: 'Coletiva', valor: rC, cor: 'amarelo' }, { parte: 'Pódio', valor: rP, cor: 'vermelho' },
    ],
    metricas: { vida: p.vida, pontualidade: p.pontualidade, taxa: p.taxa, score: p.score, fator: ft.fator },
    blocos, pagamento,
  };
}

// ---------------- 7.8 Sequência sem atraso ----------------
// marcadores: [{data, tipo: 'dia_sem_atraso' | 'dia_com_atraso' | 'dia_com_falta'}]
function calcSequencia(marcadores) {
  const ord = [...marcadores].sort((a, b) => a.data.localeCompare(b.data));
  let atual = 0, maior = 0, total = 0;
  for (const m of ord) {
    if (m.tipo === 'dia_sem_atraso') { atual++; total++; maior = Math.max(maior, atual); } else atual = 0;
  }
  return { atual, maior, total };
}

module.exports = {
  round2, toMin, fmtNum, fmtPct, fmtBRL, ROTULOS, normalizarRotulo, normalizarDia,
  calcVida, calcPontualidade, calcScore, calcColetiva, fatorTempoCasa, compararRanking, calcPremios, calcSequencia, diasEntre,
};
