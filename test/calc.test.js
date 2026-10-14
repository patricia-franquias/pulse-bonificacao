'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/engine/calc');
const { CONFIG } = require('../src/defaults');

const cfg = Object.fromEntries(CONFIG.map(([k, v]) => [k, v]));
const prev = { entrada: '16:00', saida: '23:00', intervalo_min: 60 };
const dia = (data, marc, extra = {}) => ({ data, marc, previsto: prev, ...extra });
const ok = { entrada: '16:00', saida_intervalo: '19:00', retorno_intervalo: '20:00', saida: '23:00' };

test('Aceite: 2 faltas + 3 h de atraso → Vida 77%', () => {
  const dias = [
    { data: '2026-10-01', rotulo: 'FALTA', previsto: prev },
    { data: '2026-10-02', rotulo: 'FALTA', previsto: prev },
    dia('2026-10-03', { ...ok, entrada: '17:00' }),
    dia('2026-10-04', { ...ok, entrada: '17:00' }),
    dia('2026-10-05', { ...ok, entrada: '17:00' }),
  ];
  const v = C.calcVida(dias, cfg);
  assert.equal(v.percentual, 77);
  assert.equal(v.faltas, 2);
  assert.equal(v.minutos_atraso, 180);
  assert.equal(v.detalhe.descontos.length, 5); // dias listados
});

test('Aceite: dia útil sem registro e sem rótulo não é falta', () => {
  const v = C.calcVida([{ data: '2026-10-01', previsto: prev }], cfg);
  assert.equal(v.percentual, 100);
  assert.equal(v.faltas, 0);
  const p = C.calcPontualidade([{ data: '2026-10-01', previsto: prev }], cfg);
  assert.equal(p.percentual, null);
});

test('Atraso dentro da tolerância de 5 min não desconta Vida; acima conta inteiro', () => {
  assert.equal(C.calcVida([dia('2026-10-01', { ...ok, entrada: '16:05' })], cfg).minutos_atraso, 0);
  assert.equal(C.calcVida([dia('2026-10-01', { ...ok, entrada: '16:06' })], cfg).minutos_atraso, 6);
});

test('Exceções da versão 2 não descontam Vida', () => {
  for (const r of ['AUSENCIA_LEGAL', 'ACIDENTE_TRABALHO', 'AFASTAMENTO_SINTOMA', 'FOLGA', 'FERIAS']) {
    assert.equal(C.calcVida([{ data: '2026-10-01', rotulo: r, previsto: prev }], cfg).percentual, 100, r);
  }
  assert.equal(C.calcVida([{ data: '2026-10-01', rotulo: 'ATESTADO' }], cfg).percentual, 95);
  assert.equal(C.calcVida([{ data: '2026-10-01', rotulo: 'SANCAO' }], cfg).percentual, 85);
});

test('Sinônimos de rótulo', () => {
  assert.equal(C.normalizarRotulo('licença'), 'ATESTADO');
  assert.equal(C.normalizarRotulo('Suspensão'), 'SANCAO');
  assert.equal(C.normalizarRotulo('ADVERTÊNCIA'), 'SANCAO');
  assert.equal(C.normalizarRotulo('xyz'), null);
});

test('Aceite: pontualidade 16:03 perde 30; 15:52 perde 30', () => {
  const a = C.calcPontualidade([dia('2026-10-01', { ...ok, entrada: '16:03' })], cfg);
  assert.equal(a.detalhe[0].nota, 70);
  const b = C.calcPontualidade([dia('2026-10-01', { ...ok, entrada: '15:52' })], cfg);
  assert.equal(b.detalhe[0].nota, 70);
  assert.match(b.detalhe[0].motivo, /entrada antecipada 3 min/);
});

test('Pontualidade: intervalo nos dois sentidos com tolerância 2; saída tolerância 1', () => {
  const curto = C.calcPontualidade([dia('2026-10-01', { ...ok, retorno_intervalo: '19:55' })], cfg); // 55 min → 5−2 = 3
  assert.equal(curto.detalhe[0].nota, 70);
  const saida = C.calcPontualidade([dia('2026-10-01', { ...ok, saida: '23:02' })], cfg); // 2−1 = 1
  assert.equal(saida.detalhe[0].nota, 90);
  assert.equal(saida.motivo, 'saiu depois 1 min');
});

test('Pontualidade = média dos dias medidos; dias sem entrada saem da média', () => {
  const p = C.calcPontualidade([
    dia('2026-10-01', ok), dia('2026-10-02', { ...ok, entrada: '16:05' }), { data: '2026-10-03', previsto: prev },
  ], cfg);
  assert.equal(p.dias_avaliados, 2);
  assert.equal(p.percentual, 75); // (100 + 50) / 2
  assert.equal(p.dias_certos, 1);
});

test('Virada da meia-noite: saída 00:30 com previsto 00:30 não é lida como adiantada', () => {
  const pv = { entrada: '16:30', saida: '00:30', intervalo_min: 60 };
  const p = C.calcPontualidade([{ data: '2026-10-01', previsto: pv,
    marc: { entrada: '16:30', saida_intervalo: '20:00', retorno_intervalo: '21:00', saida: '00:30' } }], cfg);
  assert.equal(p.detalhe[0].nota, 100);
  const p2 = C.calcPontualidade([{ data: '2026-10-01', previsto: pv,
    marc: { entrada: '16:30', saida_intervalo: '20:00', retorno_intervalo: '21:00', saida: '00:35' } }], cfg);
  assert.equal(p2.detalhe[0].nota, 60); // 5 − 1 = 4 min
});

test('Aceite: 10/10 e 20/20 têm a mesma taxa e o mesmo Score R$; nada atribuído = — e R$ 0', () => {
  const at = (n, feitas) => Array.from({ length: n }, (_, i) => ({ status: i < feitas ? 'feita' : 'pendente', pontos: 1 }));
  const pessoas = [
    { colaborador_id: 1, nome: 'A', admissao: '2020-01-01', vidaRes: C.calcVida([], cfg), pontRes: C.calcPontualidade([], cfg), scoreRes: C.calcScore(at(10, 10)), consumo: 300 },
    { colaborador_id: 2, nome: 'B', admissao: '2020-01-01', vidaRes: C.calcVida([], cfg), pontRes: C.calcPontualidade([], cfg), scoreRes: C.calcScore(at(20, 20)), consumo: 300 },
    { colaborador_id: 3, nome: 'C', admissao: '2020-01-01', vidaRes: C.calcVida([], cfg), pontRes: C.calcPontualidade([], cfg), scoreRes: C.calcScore([]), consumo: 300 },
  ];
  const col = C.calcColetiva({}, cfg);
  const r = C.calcPremios(pessoas, col, { ano: 2026, mes: 10, inicio: '2026-10-01', fim: '2026-10-31' }, cfg);
  const A = r.find((x) => x.nome === 'A'), B = r.find((x) => x.nome === 'B'), Cc = r.find((x) => x.nome === 'C');
  assert.equal(A.taxa, 100); assert.equal(B.taxa, 100);
  assert.equal(A.r_score, B.r_score);
  assert.equal(Cc.taxa, null); assert.equal(Cc.r_score, 0);
});

test('Aceite: perna ausente redistribui; coletiva não é 0', () => {
  const c = C.calcColetiva({ plataformas: [{ plataforma: 'iFood', nota: 4.8 }], erros: [], errosConfirmados: true }, cfg);
  // iFood 96% peso 40, erros 100% peso 20 → (96×40 + 100×20)/60 = 97,33
  assert.equal(c.percentual, 97.33);
  const aud = c.pernas.find((p) => p.perna === 'auditoria');
  assert.equal(aud.medida, false); assert.equal(aud.peso_efetivo, 0);
  assert.equal(c.pernas.find((p) => p.perna === 'ifood').peso_efetivo, 66.67);
});

test('Zero erros lançados sem confirmação = não medido (não 100)', () => {
  const c = C.calcColetiva({ plataformas: [{ plataforma: 'iFood', nota: 4 }], erros: [] }, cfg);
  assert.equal(c.pernas.find((p) => p.perna === 'erros').medida, false);
  assert.equal(c.percentual, 80);
  assert.equal(C.calcColetiva({}, cfg).percentual, null);
});

test('Aceite: admissão dia 20 de mês de 30 → Assiduidade e Coletiva × 11/30, Score cheio', () => {
  const ft = C.fatorTempoCasa('2026-11-20', '2026-11-01', '2026-11-30');
  assert.equal(ft.dias, 11); assert.equal(ft.total, 30);
  const pessoas = [{ colaborador_id: 1, nome: 'N', admissao: '2026-11-20', vidaRes: C.calcVida([], cfg), pontRes: C.calcPontualidade([], cfg),
    scoreRes: C.calcScore([{ status: 'feita', pontos: 1 }]), consumo: 300 }];
  const col = { percentual: 100, pernas: [] };
  const [r] = C.calcPremios(pessoas, col, { ano: 2026, mes: 11, inicio: '2026-11-01', fim: '2026-11-30' }, cfg);
  assert.equal(r.r_assiduidade, C.round2(80 * 11 / 30));
  assert.equal(r.r_coletiva, C.round2(80 * 11 / 30));
  assert.equal(r.r_score, 80);
  assert.equal(r.r_podio, 60);
});

test('Exemplo do texto com tetos 80: Vida 92%, taxa 90/100, coletiva 95%, fora do pódio', () => {
  const vida = { percentual: 92, detalhe: { descontos: [], resumo: [] } };
  const base = { admissao: '2020-01-01', pontRes: C.calcPontualidade([], cfg), consumo: null };
  const pessoas = [
    { ...base, colaborador_id: 9, nome: 'Z', vidaRes: vida, scoreRes: { atribuidas: 10, feitas: 9, score: 9, taxa: 90 } },
    ...[1, 2, 3].map((i) => ({ ...base, colaborador_id: i, nome: 'T' + i, vidaRes: { percentual: 100, detalhe: { descontos: [], resumo: [] } },
      scoreRes: { atribuidas: 10, feitas: 10, score: 10, taxa: 100 } })),
  ];
  const r = C.calcPremios(pessoas, { percentual: 95, pernas: [] }, { ano: 2026, mes: 10, inicio: '2026-10-01', fim: '2026-10-31' }, cfg);
  const z = r.find((x) => x.nome === 'Z');
  assert.equal(z.posicao, 4);
  assert.equal(z.r_assiduidade, 73.6); assert.equal(z.r_score, 72); assert.equal(z.r_coletiva, 76); assert.equal(z.r_podio, 0);
  assert.equal(z.total, 221.6);
  assert.match(z.extrato.blocos[0].conta, /92,0% de vida × R\$ 80,00 = R\$ 73,60/);
});

test('Abono de consumo: menor entre bônus e consumo; sobra não vira dinheiro; teto R$ 300', () => {
  const v100 = { percentual: 100, detalhe: { descontos: [], resumo: [] } };
  const mk = (id, consumo) => ({ colaborador_id: id, nome: 'P' + id, admissao: '2020-01-01', vidaRes: v100,
    pontRes: C.calcPontualidade([], cfg), scoreRes: { atribuidas: 1, feitas: 1, score: 1, taxa: 100 }, consumo });
  const r = C.calcPremios([mk(1, 120), mk(2, 500), mk(3, null)], { percentual: 100, pernas: [] },
    { ano: 2026, mes: 10, inicio: '2026-10-01', fim: '2026-10-31' }, cfg);
  const p1 = r.find((x) => x.colaborador_id === 1); // 1º: 80+80+80+60 = 300
  assert.equal(p1.total, 300); assert.equal(p1.abonado, 120); assert.equal(p1.desconto_folha, 0);
  assert.ok(p1.extrato.pagamento.linhas.some((l) => /não vira dinheiro/.test(l)));
  const p2 = r.find((x) => x.colaborador_id === 2); // 2º: 280
  assert.equal(p2.total, 280); assert.equal(p2.abonado, 280); assert.equal(p2.desconto_folha, 220);
  const p3 = r.find((x) => x.colaborador_id === 3);
  assert.equal(p3.abonado, null);
});

test('Ranking: Vida, depois pontualidade (null = 100), depois taxa; não pelo total', () => {
  const s = [
    { nome: 'a', vida: 100, pontualidade: 90, taxa: 100, score: 0 },
    { nome: 'b', vida: 100, pontualidade: null, taxa: 50, score: 0 },
    { nome: 'c', vida: 99, pontualidade: 100, taxa: 100, score: 0 },
  ].sort(C.compararRanking).map((x) => x.nome);
  assert.deepEqual(s, ['b', 'a', 'c']);
});

test('Aceite: escala 6x1 com folga no meio não quebra a sequência; atraso quebra', () => {
  const seq = C.calcSequencia([
    { data: '2026-10-01', tipo: 'dia_sem_atraso' }, { data: '2026-10-02', tipo: 'dia_sem_atraso' },
    // 03 = folga: sem marcador
    { data: '2026-10-04', tipo: 'dia_sem_atraso' },
  ]);
  assert.equal(seq.atual, 3);
  const q = C.calcSequencia([{ data: '2026-10-01', tipo: 'dia_sem_atraso' }, { data: '2026-10-02', tipo: 'dia_com_atraso' }, { data: '2026-10-03', tipo: 'dia_sem_atraso' }]);
  assert.deepEqual(q, { atual: 1, maior: 1, total: 2 });
});
