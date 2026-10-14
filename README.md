# Pulse — programa de bonificação gamificado (China in Box Ponta Grossa)

Módulo mensal de bonificação e progressão da equipe. O gestor configura, lança ocorrências, confere e fecha o mês. O colaborador acompanha o ranking, as metas e o extrato, e resgata prêmios no app.

O que o módulo garante é **cálculo auditável**: todo real tem regra e origem visíveis no extrato. Ganho de produtividade, ele não promete.

- Painel do gestor: `/admin/`
- App do colaborador: `/app/` (login com matrícula + PIN)

---

## 1. Decisões tomadas para esta loja

| Tema | O texto de referência dizia | Como ficou aqui | Por quê |
|---|---|---|---|
| Fonte de horário | API, arquivo AFD, manual ou nenhuma | **Lançamento manual** (opção C). O gestor digita as 4 marcações do dia e o sistema grava quem lançou e quando, com histórico de alterações. | Resposta da dona |
| Previsto do dia | Vinha do relógio | Vem da **escala semanal versionada** de cada colaborador. Uma mudança de escala vale a partir de uma data, sem alterar os dias anteriores. Para um dia só, existe a **exceção do dia**. | Sem relógio, a escala é a única fonte do previsto |
| Rotinas (tarefas/checklists) | Existiam no ERP | **Construídas junto**: modelos, grade semanal por pessoa, atribuição diária automática, marcação pelo app e correção pelo gestor. | Não existia sistema; sem isso não há taxa de execução |
| Prêmios | Tetos 100/100/100 + pódio 100/50/25, em dinheiro | Assiduidade **R$ 80**, Score **R$ 80**, Coletiva **R$ 80**, pódio **R$ 60/40/20**. Teto de **R$ 300**. Pagamento por **abono do consumo na loja**. | Versão 2 do programa, aprovada |
| Pagamento | Valor sai no extrato | Abonado = o **menor** entre o bônus e o consumo do mês (já com os 20% de desconto). O restante do consumo é descontado em folha. Bônus sem consumo **não vira dinheiro** e não acumula. | Versão 2 |
| Nota coletiva | Laudo sanitário 40 / plataformas 40 / erros 20 | **iFood 40 / auditoria própria ou Higieniza 40 / erros operacionais 20** | Resposta da dona |
| Atestado | −5% na Vida | Mantido. **Não descontam**: ausência legal (CLT art. 473), acidente de trabalho e afastamento pela gerência por sintoma. | Exceções da versão 2 |
| Saída depois da meia-noite | Limitação conhecida | **Resolvido**: horário mais de 6 h antes da entrada é lido como do dia seguinte | Fechamento às 23h |
| Sequência sem atraso | Só quebra com atraso | Quebra com atraso **ou com falta sem justificativa** | "30 dias seguidos sem atraso" com falta no meio não faz sentido |
| Ciclo vencido | Agendador fecha | O agendador tenta fechar. Se o checklist tiver item `faltando`, o ciclo **fica aberto** e aparece no Dashboard; o mês novo abre do mesmo jeito. | Respeita o bloqueio do checklist |
| Login do app | Identificador pessoal | Matrícula + **PIN** de 4 a 8 dígitos, definido pelo gestor | Só a matrícula não protege nada |
| Extrato público na equipe | Sim | Sim, mas o **consumo e o desconto em folha de colegas ficam ocultos** | Valor de consumo é dado pessoal |

Tudo isto é editável sem deploy, na aba **Configurações**: tetos, pódio, pesos, tolerâncias, pesos da coletiva, XP, moedas, nome do programa, forma de pagamento e fuso. Também são editáveis os níveis, as conquistas e a loja.

## 2. Fórmulas

```
Total R$     = min(teto_total, Assiduidade + Score + Coletiva + Pódio)
Assiduidade  = (vida_% / 100) × teto_assiduidade × fator_tempo_casa
Score        = taxa == null ? 0 : min(teto_score, taxa / maior_taxa_do_ciclo × teto_score)
Coletiva     = (coletiva_% / 100) × teto_coletiva × fator_tempo_casa
Pódio        = 1º, 2º, 3º com valores fixos; demais 0
Abonado      = min(Total, consumo do mês)      Desconto em folha = consumo − Abonado
```

- **Vida**: começa em 100. Desconta 1% por hora de atraso acumulada, 10% por falta, 5% por atestado e 15% por sanção. Atraso = entrada acima de 5 min (acima da tolerância conta o atraso inteiro, como no CLT art. 58 §1º) + excesso do intervalo.
- **Falta nunca é inferida.** Dia sem registro não é falta; só vira falta, atestado ou sanção se o gestor lançar a ocorrência do dia.
- **Pontualidade**: nota do dia = 100 − minutos de desvio × 10. Desvios: entrada atrasada (tolerância 0), entrada antecipada acima de 5 min, intervalo diferente do previsto nos dois sentidos (tolerância 2) e saída depois do previsto (tolerância 1). A nota do mês é a média dos dias medidos. **Não paga**: só ordena o ranking.
- **Score** = rotinas feitas ÷ atribuídas. Não conta rotina de dia com ausência lançada nem rotina de hoje ainda pendente. Nada atribuído = "—" e R$ 0.
- **Ranking**: Vida ↓, Pontualidade ↓ (vazio conta 100), taxa ↓, pontos ↓. Nunca pelo total em R$.
- **Coletiva**: média ponderada das pernas **lançadas**. Perna sem lançamento sai da média e o peso se redistribui. Zero erros lançados = não medido, até o gestor marcar "o mês foi medido".
- **Tempo de casa**: quem foi admitido depois do dia 1 recebe Assiduidade e Coletiva × dias desde a admissão ÷ dias do mês. Score e pódio vêm cheios. Conquistas de "mês sem falta" e "% de Vida" só contam meses completos.
- **XP**: tarefa 5, checklist 10, avaliação positiva 20, dia sem atraso 10 e, no fechamento, pontos do mês 1:1. O XP é acumulado e nunca zera, com 23 níveis. A gravação é idempotente: há um índice único parcial `(colaborador, origem, referência)`.
- **Moedas**: vêm das conquistas (50/150/400/1000 por raridade) e saem na loja. Todo resgate passa por aprovação, com limite diário, e a aprovação baixa o estoque.
- **Datas**: "hoje" vem do banco, no fuso configurado (`NOW() AT TIME ZONE 'America/Sao_Paulo'`).

## 3. Instalação

Requisitos: Node.js 20+ e PostgreSQL 14+.

```bash
npm install
cp .env.example .env        # preencha DATABASE_URL, SESSION_SECRET, ADMIN_LOGIN, ADMIN_SENHA
npm start                   # cria as tabelas e o primeiro admin na primeira execução
```

Para hospedar: qualquer serviço que rode Node.js com um PostgreSQL gerenciado, ou um servidor próprio.

1. Crie o banco PostgreSQL e copie a URL de conexão.
2. Crie o serviço Node apontando para esta pasta, com comando de início `npm start`.
3. Configure as variáveis do `.env.example`. Use `DATABASE_SSL=true` se o banco exigir SSL.
4. Exija HTTPS. Os cookies de sessão são `Secure`.
5. Mantenha **uma única instância** rodando: o agendador roda dentro do processo, de hora em hora.

Demonstração com dados fictícios (só num banco de teste): `DEMO_CONFIRMA=sim npm run demo`. Ela cria 8 colaboradores, matrículas 101 a 108, todos com PIN 1234.

## 4. Rotina do gestor

| Quando | Onde | O quê |
|---|---|---|
| Implantação | Colaboradores → Vínculos → Rotinas | Cadastrar cada pessoa com admissão, **escala** e PIN. Vincular. Criar os modelos de rotina e a grade semanal. |
| Todo dia | Ponto | Lançar as 4 marcações de quem trabalhou e a ocorrência do dia: falta, atestado, folga etc. |
| Toda semana | Rotinas / Dashboard | Conferir o que ficou pendente e os "dias de escala sem marcação nem ocorrência" no checklist. |
| Fim do mês | Registros | Lançar a nota pública do iFood (com nº de avaliações e a fonte), as auditorias do mês e os erros, ou marcar "o mês foi medido". |
| Fim do mês | Consumo | Lançar o consumo de cada pessoa, tirado do PDV (valor já com desconto; 0 para quem não consumiu). |
| 1º dia útil | Dashboard | Ver o checklist e **fechar o ciclo**. O fechamento grava valores e extratos, que não mudam mais. |
| Folha | Fora do sistema | Lançar o desconto em folha de cada pessoa (coluna da aba Consumo / Histórico). |

**Antes do primeiro pagamento, confira o extrato de um colaborador real, ocorrência por ocorrência.**

## 5. Estrutura

```
server.js                 Express: rotas, arquivos estáticos, agendador
db/schema.sql             Todas as tabelas pulse_* (idempotente)
src/defaults.js           Configurações, níveis, conquistas e loja iniciais
src/engine/calc.js        Motor puro: Vida, Pontualidade, Score, Coletiva, prêmio e extrato
src/engine/horario.js     Adaptador da fonte de horário (manual; ponto de troca para API/AFD)
src/engine/servico.js     Recálculo, marcadores, conquistas, checklist, fechamento
src/agendador.js          Processo de hora em hora
src/rotas/painel.js       API do gestor (perfis admin/gestor validados no servidor)
src/rotas/app.js          API do colaborador
public/admin/index.html   Painel (SPA em arquivo único)
public/app/index.html     App do colaborador (mobile-first)
test/                     17 testes do motor + teste de integração com PostgreSQL real
```

Para trocar a fonte de horário (relógio com API ou arquivo AFD), escreva outro adaptador em `horario.js` que devolva o mesmo registro diário: `{ data, entrada, saida_intervalo, retorno_intervalo, saida, previsto_entrada, previsto_saida }`. O resto do sistema não muda.

## 6. Testes

```bash
npm test                                                     # motor (sem banco)
TEST_DATABASE_URL=postgres://.../banco_descartavel npm test  # + integração (APAGA o banco informado)
```

Os critérios de aceite do texto de referência estão cobertos:

- 2 faltas + 3 h de atraso = Vida de 77%.
- Dia sem registro não é falta.
- 16:03 e 15:52 perdem 30 pontos cada.
- 10/10 e 20/20 dão o mesmo Score.
- Nada atribuído = "—" e R$ 0.
- Perna ausente redistribui o peso.
- Folga no meio não quebra a sequência.
- Recálculo 3 vezes dá o mesmo resultado.
- Admissão no dia 20 = fator 11/30.
- Ciclo fechado não muda com novo teto.

Também foram testados: abono de consumo, conquistas sem efeito para novato e virada da meia-noite.

## 7. Limitações e pendências

- **Lançamento manual depende de disciplina.** Marcação esquecida não vira falta: aparece como alerta no checklist. Para o horário ter força de prova, o ideal é migrar para o relógio (adaptador A ou B).
- **Consumo vem do PDV digitado à mão**, sem integração com o sistema da GCOM.
- **Sem integração com WhatsApp e sem notificação push.** O app avisa conquistas e subida de nível quando é aberto.
- **Folha de pagamento fica fora**: o sistema calcula o abono e o desconto, e o lançamento na folha segue o processo atual.
- **Questões trabalhistas a validar com o contador** antes do primeiro fechamento:
  - a natureza do abono de consumo (prêmio em bens, CLT art. 457 §§ 2º e 4º);
  - a autorização de desconto em folha (art. 462);
  - o −5% por atestado comum, sobre o qual a jurisprudência é dividida.
- Quem volta cedo do intervalo e bate o ponto na hora certa não aparece no cálculo.
- Corrigir um dia passado regrava o marcador daquele dia. Ciclos já fechados não recebem marcador retroativo.
- Conquistas concedidas antes de uma mudança de regra não são revogadas automaticamente.
- As fontes do visual (Poppins, Press Start 2P, VT323) vêm do Google Fonts. Sem internet, o navegador usa fontes do sistema.
