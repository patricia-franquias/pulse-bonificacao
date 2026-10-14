'use strict';
// Popula um banco de DEMONSTRAÇÃO com dados fictícios do mês corrente (não use no banco de produção).
//   DATABASE_URL=... node scripts/demo.js
const db = require('../src/db');
const S = require('../src/engine/servico');
const H = require('../src/engine/horario');
const A = require('../src/auth');

let semente = 42;
const rnd = () => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente / 2147483648; };
const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

(async () => {
  if (process.env.DEMO_CONFIRMA !== 'sim') { console.error('Defina DEMO_CONFIRMA=sim para popular dados fictícios.'); process.exit(1); }
  await db.migrate();
  const cfg = await db.getConfig();
  const { hoje } = await db.agoraLocal(cfg);
  const ciclo = await S.cicloDaData(hoje);
  const pessoas = [
    ['Ana Lima', '101', 'Cozinha', '2024-03-01', 'manha'], ['Bruno Costa', '102', 'Cozinha', '2023-08-15', 'tarde'],
    ['Carla Mendes', '103', 'Atendimento', '2025-01-10', 'manha'], ['Diego Rocha', '104', 'Delivery/expedição', '2024-11-04', 'tarde'],
    ['Elaine Prado', '105', 'Atendimento', '2022-05-20', 'tarde'], ['Fábio Nunes', '106', 'Cozinha', '2025-06-02', 'manha'],
    ['Gabi Torres', '107', 'Caixa', '2024-09-09', 'tarde'], ['Hugo Alves', '108', 'Cozinha', ciclo.inicio.slice(0, 8) + '08', 'manha'],
  ];
  const turnos = { manha: { entrada: '10:30', saida: '18:50', intervalo: 60 }, tarde: { entrada: '15:00', saida: '23:20', intervalo: 60 } };
  const ids = [];
  for (const [i, [nome, mat, cargo, adm, turno]] of pessoas.entries()) {
    const c = await db.one(`INSERT INTO pulse_colaboradores (nome, matricula, cargo, admissao, pin_hash) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (matricula) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`, [nome, mat, cargo, adm, A.hashSenha('1234')]);
    ids.push(c.id);
    await db.q(`INSERT INTO pulse_vinculos VALUES ($1,'manual',$2) ON CONFLICT DO NOTHING`, [c.id, mat]);
    const dias = {}; const folga = (i % 6) + 1; // escala 6x1, folga em dias diferentes
    for (let d = 0; d < 7; d++) dias[d] = d === folga ? null : turnos[turno];
    await db.q(`INSERT INTO pulse_escalas (colaborador_id, vigente_desde, dias, criado_por) VALUES ($1,'2022-01-01',$2,'demo') ON CONFLICT DO NOTHING`, [c.id, JSON.stringify(dias)]);
  }
  // Rotinas e grade
  const rot = async (titulo, tipo, itens, pontos) => (await db.one(`INSERT INTO pulse_rotinas (titulo, tipo, itens, pontos) VALUES ($1,$2,$3,$4) RETURNING id`, [titulo, tipo, JSON.stringify(itens), pontos])).id;
  const abertura = await rot('Checklist de abertura da cozinha', 'checklist', ['Conferir temperatura das câmaras', 'Higienizar bancadas', 'Separar mise en place', 'Conferir validade dos insumos'], 3);
  const fechamento = await rot('Checklist de fechamento', 'checklist', ['Limpar chapa e fritadeira', 'Etiquetar sobras', 'Retirar lixo', 'Desligar equipamentos'], 3);
  const salao = await rot('Repor embalagens do delivery', 'tarefa', [], 1);
  const esponja = await rot('Trocar esponjas (Higieniza)', 'tarefa', [], 1);
  for (const [i, id] of ids.entries()) {
    const turno = pessoas[i][4];
    for (let d = 0; d < 7; d++) {
      await db.q('INSERT INTO pulse_grade_rotinas (rotina_id, colaborador_id, dia_semana) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [turno === 'manha' ? abertura : fechamento, id, d]);
      if (i % 2 === 0) await db.q('INSERT INTO pulse_grade_rotinas (rotina_id, colaborador_id, dia_semana) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [salao, id, d]);
      if (d === 1 && i < 4) await db.q('INSERT INTO pulse_grade_rotinas (rotina_id, colaborador_id, dia_semana) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [esponja, id, d]);
    }
  }
  // Dias passados do mês: marcações, ocorrências e execução
  for (let d = ciclo.inicio; d < hoje; d = H.addDias(d, 1)) {
    await S.gerarAtribuicoes(d);
    for (const [i, id] of ids.entries()) {
      const adm = pessoas[i][3]; if (d < adm) continue;
      const t = turnos[pessoas[i][4]]; const folga = (i % 6) + 1;
      if (H.diaSemana(d) === folga) continue;
      const x = rnd();
      if (x < 0.03) { await db.q(`INSERT INTO pulse_ponto_labels (colaborador_id, data, rotulo, lancado_por) VALUES ($1,$2,'FALTA','demo') ON CONFLICT DO NOTHING`, [id, d]); continue; }
      if (x < 0.05) { await db.q(`INSERT INTO pulse_ponto_labels (colaborador_id, data, rotulo, lancado_por) VALUES ($1,$2,'ATESTADO','demo') ON CONFLICT DO NOTHING`, [id, d]); continue; }
      const [eh, em] = t.entrada.split(':').map(Number); const base = eh * 60 + em;
      const atraso = rnd() < 0.18 ? Math.round(rnd() * 25) : (rnd() < 0.2 ? -Math.round(rnd() * 8) : 0);
      const si = base + 240; const ri = si + 60 + (rnd() < 0.12 ? Math.round(rnd() * 10) - 3 : 0);
      const [sh, sm] = t.saida.split(':').map(Number); const sai = sh * 60 + sm + (rnd() < 0.15 ? Math.round(rnd() * 6) : 0);
      await db.q(`INSERT INTO pulse_marcacoes (colaborador_id, data, entrada, saida_intervalo, retorno_intervalo, saida, lancado_por) VALUES ($1,$2,$3,$4,$5,$6,'demo') ON CONFLICT DO NOTHING`,
        [id, d, hhmm(base + atraso), hhmm(si), hhmm(ri), hhmm(sai)]);
      const feitaProb = 0.75 + (i % 4) * 0.07;
      const ats = await db.many(`SELECT a.id, r.tipo, r.itens FROM pulse_rotinas_atribuidas a JOIN pulse_rotinas r ON r.id = a.rotina_id WHERE a.colaborador_id = $1 AND a.data = $2`, [id, d]);
      for (const a of ats) if (rnd() < feitaProb) {
        await db.q(`UPDATE pulse_rotinas_atribuidas SET status = 'feita', itens_marcados = $2, feita_em = NOW() WHERE id = $1`, [a.id, JSON.stringify(a.itens.map((_, k) => k))]);
      }
    }
  }
  await db.q(`INSERT INTO pulse_plataformas_notas (ciclo_id, plataforma, nota, amostra, fonte, lancado_por) VALUES ($1,'iFood',4.7,312,'nota pública na página da loja','demo') ON CONFLICT DO NOTHING`, [ciclo.id]);
  await db.q(`INSERT INTO pulse_auditorias (ciclo_id, data, tipo, nota, descricao, lancado_por) VALUES ($1,$2,'propria',82,'Auditoria da cozinha (foco: organização)','demo')`, [ciclo.id, H.addDias(ciclo.inicio, 6)]);
  for (const [k, desc] of ['Pedido saiu sem hashi', 'Troca de molho no pedido', 'Yakisoba sem legumes extras pedidos'].entries())
    await db.q(`INSERT INTO pulse_erros_pedidos (ciclo_id, data, descricao, lancado_por) VALUES ($1,$2,$3,'demo')`, [ciclo.id, H.addDias(ciclo.inicio, 2 + k * 3), desc]);
  await db.q(`INSERT INTO pulse_avaliacoes (colaborador_id, data, positiva, comentario, autor) VALUES ($1,$2,TRUE,'Resolveu sozinha a falta de embalagem no pico','demo')`, [ids[0], H.addDias(ciclo.inicio, 4)]);
  await S.recalcularCiclo(ciclo.id);
  console.log(`Demo pronta: ${ids.length} colaboradores. App: matrícula 101..108, PIN 1234.`);
  await db.getPool().end();
})().catch((e) => { console.error(e); process.exit(1); });
