'use strict';
// Valores iniciais. Tudo aqui é editável pela aba Configurações / Níveis / Conquistas / Loja, sem deploy.

const CONFIG = [
  // Identificação
  ['programa_nome', 'Pulse', 'Nome do programa', 'texto', 'Identificação'],
  ['restaurante', 'China in Box Ponta Grossa', 'Nome do restaurante', 'texto', 'Identificação'],
  ['tipo_operacao', 'Salão e delivery', 'Tipo de operação', 'texto', 'Identificação'],
  ['responsaveis', '', 'Responsáveis pelo programa', 'texto', 'Identificação'],
  ['horario_padrao', '11:00–23:00', 'Horário padrão de funcionamento (informativo; o previsto vem da escala)', 'texto', 'Identificação'],
  ['fuso', 'America/Sao_Paulo', 'Fuso horário (IANA)', 'texto', 'Identificação'],
  ['fonte_horario', 'manual', 'Fonte de horário: manual | nenhuma', 'texto', 'Identificação'],

  // Prêmio
  ['forma_pagamento', 'abono_consumo', 'abono_consumo = bônus abate o consumo do mês na loja (sem consumo, não vira dinheiro) | dinheiro', 'texto', 'Prêmio'],
  ['teto_total', 300, 'Teto mensal do bônus por pessoa (R$). No abono de consumo, igual ao teto de consumo.', 'numero', 'Prêmio'],
  ['teto_assiduidade', 80, 'Teto do prêmio de Assiduidade (R$)', 'numero', 'Prêmio'],
  ['teto_score', 80, 'Teto do prêmio de Score/execução (R$)', 'numero', 'Prêmio'],
  ['teto_coletiva', 80, 'Teto do prêmio Coletivo (R$)', 'numero', 'Prêmio'],
  ['podio', [60, 40, 20], 'Bônus de pódio: 1º, 2º, 3º (R$)', 'lista', 'Prêmio'],

  // Vida
  ['vida_desconto_hora', 1, 'Vida: % descontado por hora de atraso acumulada no mês', 'numero', 'Vida'],
  ['vida_desconto_falta', 10, 'Vida: % por falta', 'numero', 'Vida'],
  ['vida_desconto_atestado', 5, 'Vida: % por atestado', 'numero', 'Vida'],
  ['vida_desconto_sancao', 15, 'Vida: % por sanção (advertência, suspensão)', 'numero', 'Vida'],
  ['vida_tolerancia_entrada', 5, 'Vida: tolerância de entrada (min). Acima dela, conta o atraso inteiro (CLT art. 58 §1º).', 'numero', 'Vida'],
  ['vida_tolerancia_intervalo', 0, 'Vida: tolerância de excesso do intervalo (min)', 'numero', 'Vida'],

  // Pontualidade
  ['pont_habilitada', true, 'Pontualidade ligada (ordena o ranking; não paga)', 'booleano', 'Pontualidade'],
  ['pont_peso', 10, 'Pontos perdidos por minuto de desvio', 'numero', 'Pontualidade'],
  ['pont_tol_atraso', 0, 'Tolerância de entrada atrasada (min)', 'numero', 'Pontualidade'],
  ['pont_tol_antecipada', 5, 'Tolerância de entrada antecipada (min)', 'numero', 'Pontualidade'],
  ['pont_tol_intervalo', 2, 'Tolerância do intervalo, nos dois sentidos (min)', 'numero', 'Pontualidade'],
  ['pont_tol_saida', 1, 'Tolerância de saída depois do previsto (min)', 'numero', 'Pontualidade'],

  // Coletiva
  ['coletiva_pesos', { ifood: 40, auditoria: 40, erros: 20 }, 'Pesos nominais das pernas da nota coletiva (%)', 'objeto', 'Coletiva'],
  ['coletiva_penalidade_erro', 2, 'Erros operacionais: pontos perdidos por erro (nota = 100 − erros × N)', 'numero', 'Coletiva'],

  // XP e moedas
  ['xp_tarefa', 5, 'XP por tarefa concluída', 'numero', 'XP e moedas'],
  ['xp_checklist', 10, 'XP por checklist concluído', 'numero', 'XP e moedas'],
  ['xp_avaliacao', 20, 'XP por avaliação positiva', 'numero', 'XP e moedas'],
  ['xp_dia_sem_atraso', 10, 'XP por dia sem atraso', 'numero', 'XP e moedas'],
  ['moedas_raridade', { comum: 50, rara: 150, epica: 400, lendaria: 1000 }, 'Moedas por conquista, por raridade', 'objeto', 'XP e moedas'],
  ['resgates_por_dia', 1, 'Máximo de resgates por colaborador por dia', 'numero', 'XP e moedas'],

  // Agendador
  ['recalculo_hora', 3, 'Hora local do recálculo diário de madrugada (0–23)', 'numero', 'Agendador'],
];

const NOMES_NIVEL = ['Novato'];
for (const n of ['Aprendiz', 'Ajudante', 'Auxiliar', 'Profissional', 'Especialista', 'Mestre', 'Lenda']) {
  for (const r of ['I', 'II', 'III']) NOMES_NIVEL.push(`${n} ${r}`);
}
NOMES_NIVEL.push('Lenda Máxima');
// 23 níveis. xp_min = 40 × (n−1)^2,1 arredondado a dezenas.
const NIVEIS = NOMES_NIVEL.map((nome, i) => [i + 1, nome, i === 0 ? 0 : Math.round(40 * Math.pow(i, 2.1) / 10) * 10]);

const CONQUISTAS = [
  ['primeiros-passos', 'Primeiros passos', 'Somar 100 XP', 'xp_total', 100, 'comum'],
  ['xp-1000', 'Mil de experiência', 'Somar 1.000 XP', 'xp_total', 1000, 'rara'],
  ['xp-10000', 'Veterano', 'Somar 10.000 XP', 'xp_total', 10000, 'lendaria'],
  ['nivel-5', 'Ajudante', 'Chegar ao nível 5', 'nivel', 5, 'comum'],
  ['nivel-11', 'Profissional', 'Chegar ao nível 11', 'nivel', 11, 'epica'],
  ['tarefas-50', 'Mão na massa', 'Concluir 50 tarefas', 'tarefas', 50, 'comum'],
  ['checklists-50', 'Nada passa', 'Concluir 50 checklists', 'checklists', 50, 'rara'],
  ['seq-7', 'Semana em dia', '7 dias seguidos sem atraso', 'dias_seguidos_sem_atraso', 7, 'comum'],
  ['seq-30', 'Relógio suíço', '30 dias seguidos sem atraso', 'dias_seguidos_sem_atraso', 30, 'epica'],
  ['total-100', 'Cem dias no horário', '100 dias sem atraso no total', 'dias_sem_atraso_total', 100, 'rara'],
  ['mes-sem-falta', 'Presença total', 'Fechar um mês sem falta', 'mes_sem_falta', 1, 'comum'],
  ['vida-100', 'Vida cheia', 'Fechar um mês com 100% de Vida', 'vida_pct', 100, 'rara'],
  ['score-200', 'Produtivo', 'Fazer 200 pontos de rotina em um mês', 'score_mes', 200, 'rara'],
  ['moedas-1000', 'Cofrinho', 'Acumular 1.000 moedas', 'moedas_acumuladas', 1000, 'epica'],
  ['resgate-1', 'Primeira troca', 'Fazer o primeiro resgate aprovado', 'resgates', 1, 'comum'],
  ['elogio-5', 'Reconhecido', 'Receber 5 avaliações positivas', 'avaliacoes_positivas', 5, 'rara'],
  ['colecionador-10', 'Colecionador', 'Desbloquear 10 conquistas', 'conquistas_desbloqueadas', 10, 'lendaria'],
];

// Tipos de condição aceitos pelo motor. A legenda da meta muda conforme o tipo.
const TIPOS_CONQUISTA = {
  xp_total: { nome: 'XP total', unidade: 'XP', texto: (m) => `Somar ${m} XP` },
  score_mes: { nome: 'Pontos de rotina em um mês', unidade: 'pts', texto: (m) => `${m} pontos de rotina em um mês` },
  nivel: { nome: 'Nível', unidade: 'níveis', texto: (m) => `Chegar ao nível ${m}` },
  tarefas: { nome: 'Tarefas concluídas', unidade: 'tarefas', texto: (m) => `Concluir ${m} tarefas` },
  checklists: { nome: 'Checklists concluídos', unidade: 'checklists', texto: (m) => `Concluir ${m} checklists` },
  dias_seguidos_sem_atraso: { nome: 'Dias seguidos sem atraso', unidade: 'dias', texto: (m) => `${m} dias seguidos sem atraso` },
  dias_sem_atraso_total: { nome: 'Dias sem atraso no total', unidade: 'dias', texto: (m) => `${m} dias sem atraso no total` },
  mes_sem_falta: { nome: 'Meses fechados sem falta', unidade: 'meses', texto: (m) => `${m} mês(es) fechado(s) sem falta` },
  vida_pct: { nome: '% de Vida num mês fechado', unidade: '%', texto: (m) => `Fechar um mês com ${m}% de Vida ou mais` },
  moedas_acumuladas: { nome: 'Moedas acumuladas', unidade: 'moedas', texto: (m) => `Acumular ${m} moedas` },
  resgates: { nome: 'Resgates aprovados', unidade: 'resgates', texto: (m) => `${m} resgate(s) aprovado(s)` },
  conquistas_desbloqueadas: { nome: 'Conquistas desbloqueadas', unidade: 'conquistas', texto: (m) => `Desbloquear ${m} conquistas` },
  avaliacoes_positivas: { nome: 'Avaliações positivas', unidade: 'avaliações', texto: (m) => `Receber ${m} avaliações positivas` },
};

const LOJA = [
  ['Escolher a folga da semana', 'Você escolhe o dia de folga de uma semana, respeitada a escala mínima da loja.', 300, null],
  ['Bebida ou sobremesa extra no turno', 'Uma bebida ou sobremesa da casa, fora do consumo do mês.', 100, null],
  ['Prioridade na escolha do feriado', 'Primeiro a escolher folga no próximo feriado.', 500, null],
  ['Brinde da marca', 'Brinde da franquia, enquanto houver estoque.', 800, 5],
];

module.exports = { CONFIG, NIVEIS, CONQUISTAS, TIPOS_CONQUISTA, LOJA };
