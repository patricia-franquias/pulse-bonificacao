-- Pulse — programa de bonificação gamificado
-- Todas as tabelas com prefixo pulse_. Idempotente: pode rodar várias vezes.

CREATE TABLE IF NOT EXISTS pulse_configuracoes (
  chave       TEXT PRIMARY KEY,
  valor       JSONB NOT NULL,
  descricao   TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por TEXT
);

-- Usuários do painel (gestor / admin). Colaborador entra pelo app com matrícula + PIN.
CREATE TABLE IF NOT EXISTS pulse_usuarios (
  id          SERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  login       TEXT NOT NULL UNIQUE,
  senha_hash  TEXT NOT NULL,
  perfil      TEXT NOT NULL CHECK (perfil IN ('admin','gestor')),
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pulse_colaboradores (
  id          SERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  matricula   TEXT NOT NULL UNIQUE,
  cargo       TEXT,
  admissao    DATE NOT NULL,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  pin_hash    TEXT,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vínculo colaborador <-> identificador na fonte de horário. Sem vínculo, fica fora do ranking.
CREATE TABLE IF NOT EXISTS pulse_vinculos (
  colaborador_id INT PRIMARY KEY REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  fonte          TEXT NOT NULL DEFAULT 'manual',
  identificador  TEXT NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fonte, identificador)
);

-- Escala semanal versionada: vale a versão com maior vigente_desde <= data.
-- dias = {"0": {"entrada":"11:00","saida":"19:20","intervalo":60} | null, ... "6": ...}  (0 = domingo; null = não trabalha)
-- Mudar a escala cria uma versão nova a partir de uma data: dias anteriores continuam com o previsto antigo.
CREATE TABLE IF NOT EXISTS pulse_escalas (
  id             SERIAL PRIMARY KEY,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  vigente_desde  DATE NOT NULL,
  dias           JSONB NOT NULL,
  criado_por     TEXT NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (colaborador_id, vigente_desde)
);

-- Exceção autorizada do dia: substitui o previsto da escala.
CREATE TABLE IF NOT EXISTS pulse_schedule_overrides (
  colaborador_id   INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  data             DATE NOT NULL,
  previsto_entrada TIME NOT NULL,
  previsto_saida   TIME NOT NULL,
  intervalo_min    INT,
  motivo           TEXT,
  criado_por       TEXT,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (colaborador_id, data)
);

-- Fonte C: lançamento manual das marcações do dia.
CREATE TABLE IF NOT EXISTS pulse_marcacoes (
  colaborador_id    INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  data              DATE NOT NULL,
  entrada           TIME,
  saida_intervalo   TIME,
  retorno_intervalo TIME,
  saida             TIME,
  lancado_por       TEXT NOT NULL,
  lancado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por    TEXT,
  atualizado_em     TIMESTAMPTZ,
  PRIMARY KEY (colaborador_id, data)
);

-- Trilha de auditoria de tudo que é lançado à mão (marcações, rótulos, exceções).
CREATE TABLE IF NOT EXISTS pulse_log_lancamentos (
  id         BIGSERIAL PRIMARY KEY,
  tabela     TEXT NOT NULL,
  chave      TEXT NOT NULL,
  antes      JSONB,
  depois     JSONB,
  autor      TEXT NOT NULL,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ocorrência do dia (falta, atestado, sanção, folga...). Sempre lançamento humano.
CREATE TABLE IF NOT EXISTS pulse_ponto_labels (
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  data           DATE NOT NULL,
  rotulo         TEXT NOT NULL,
  observacao     TEXT,
  lancado_por    TEXT NOT NULL,
  lancado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (colaborador_id, data)
);

CREATE TABLE IF NOT EXISTS pulse_ciclos (
  id          SERIAL PRIMARY KEY,
  ano         INT NOT NULL,
  mes         INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  inicio      DATE NOT NULL,
  fim         DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','fechado')),
  calculado_em TIMESTAMPTZ,
  fechado_em  TIMESTAMPTZ,
  fechado_por TEXT,
  UNIQUE (ano, mes)
);

-- ---------------- Rotinas (tarefas e checklists) ----------------
CREATE TABLE IF NOT EXISTS pulse_rotinas (
  id       SERIAL PRIMARY KEY,
  titulo   TEXT NOT NULL,
  tipo     TEXT NOT NULL CHECK (tipo IN ('tarefa','checklist')),
  itens    JSONB NOT NULL DEFAULT '[]',
  pontos   INT NOT NULL DEFAULT 1,
  ativo    BOOLEAN NOT NULL DEFAULT TRUE
);

-- Grade: quem faz qual rotina em qual dia da semana.
CREATE TABLE IF NOT EXISTS pulse_grade_rotinas (
  id             SERIAL PRIMARY KEY,
  rotina_id      INT NOT NULL REFERENCES pulse_rotinas(id) ON DELETE CASCADE,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  dia_semana     SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  UNIQUE (rotina_id, colaborador_id, dia_semana)
);

CREATE TABLE IF NOT EXISTS pulse_rotinas_atribuidas (
  id              BIGSERIAL PRIMARY KEY,
  rotina_id       INT NOT NULL REFERENCES pulse_rotinas(id) ON DELETE CASCADE,
  colaborador_id  INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  origem          TEXT NOT NULL DEFAULT 'grade',
  status          TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','feita')),
  itens_marcados  JSONB NOT NULL DEFAULT '[]',
  pontos          INT NOT NULL DEFAULT 0,
  feita_em        TIMESTAMPTZ,
  UNIQUE (rotina_id, colaborador_id, data)
);
CREATE INDEX IF NOT EXISTS pulse_rotinas_atribuidas_data ON pulse_rotinas_atribuidas (data);

-- ---------------- Resultados mensais (ciclo aberto: previsão) ----------------
CREATE TABLE IF NOT EXISTS pulse_assiduidade_mensal (
  ciclo_id       INT NOT NULL REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  percentual     NUMERIC(6,2) NOT NULL,
  minutos_atraso INT NOT NULL DEFAULT 0,
  faltas         INT NOT NULL DEFAULT 0,
  atestados      INT NOT NULL DEFAULT 0,
  sancoes        INT NOT NULL DEFAULT 0,
  detalhe        JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (ciclo_id, colaborador_id)
);

CREATE TABLE IF NOT EXISTS pulse_pontualidade_mensal (
  ciclo_id       INT NOT NULL REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  percentual     NUMERIC(6,2),            -- NULL = nenhum dia medido
  dias_avaliados INT NOT NULL DEFAULT 0,
  dias_certos    INT NOT NULL DEFAULT 0,
  desvio         JSONB NOT NULL DEFAULT '{}',
  detalhe        JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (ciclo_id, colaborador_id)
);

CREATE TABLE IF NOT EXISTS pulse_score_mensal (
  ciclo_id       INT NOT NULL REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  score          INT NOT NULL DEFAULT 0,
  atribuidas     INT NOT NULL DEFAULT 0,
  feitas         INT NOT NULL DEFAULT 0,
  taxa           NUMERIC(6,2),            -- NULL = nada atribuído
  PRIMARY KEY (ciclo_id, colaborador_id)
);

CREATE TABLE IF NOT EXISTS pulse_nota_coletiva_mensal (
  ciclo_id         INT PRIMARY KEY REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  percentual_final NUMERIC(6,2),          -- NULL = nenhuma perna medida
  fontes_detalhe   JSONB NOT NULL DEFAULT '[]'
);

-- Pernas da nota coletiva
CREATE TABLE IF NOT EXISTS pulse_plataformas_notas (
  ciclo_id    INT NOT NULL REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  plataforma  TEXT NOT NULL,
  nota        NUMERIC(4,2) NOT NULL CHECK (nota BETWEEN 0 AND 5),
  amostra     INT,
  fonte       TEXT,
  lancado_por TEXT NOT NULL,
  lancado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ciclo_id, plataforma)
);

CREATE TABLE IF NOT EXISTS pulse_auditorias (
  id          SERIAL PRIMARY KEY,
  ciclo_id    INT NOT NULL REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  data        DATE NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'propria' CHECK (tipo IN ('propria','higieniza')),
  nota        NUMERIC(5,2) NOT NULL CHECK (nota BETWEEN 0 AND 100),
  descricao   TEXT,
  lancado_por TEXT NOT NULL,
  lancado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pulse_erros_pedidos (
  id          SERIAL PRIMARY KEY,
  ciclo_id    INT NOT NULL REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  data        DATE NOT NULL,
  descricao   TEXT NOT NULL,
  lancado_por TEXT NOT NULL,
  lancado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Medido sem erros" precisa ser declarado: zero erros lançados = não medido.
CREATE TABLE IF NOT EXISTS pulse_pernas_medidas (
  ciclo_id    INT NOT NULL REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  perna       TEXT NOT NULL,
  confirmado_por TEXT NOT NULL,
  confirmado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ciclo_id, perna)
);

-- Consumo do mês na loja (valor já com o desconto do funcionário), vindo do PDV.
CREATE TABLE IF NOT EXISTS pulse_consumo_mensal (
  ciclo_id       INT NOT NULL REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  consumo        NUMERIC(10,2) NOT NULL CHECK (consumo >= 0),
  lancado_por    TEXT NOT NULL,
  lancado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ciclo_id, colaborador_id)
);

-- Prêmio calculado (previsão) do ciclo aberto.
CREATE TABLE IF NOT EXISTS pulse_premiacao_mensal (
  ciclo_id       INT NOT NULL REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  posicao        INT NOT NULL,
  fator_tempo_casa NUMERIC(6,4) NOT NULL DEFAULT 1,
  r_assiduidade  NUMERIC(10,2) NOT NULL,
  r_score        NUMERIC(10,2) NOT NULL,
  r_coletiva     NUMERIC(10,2) NOT NULL,
  r_podio        NUMERIC(10,2) NOT NULL,
  total          NUMERIC(10,2) NOT NULL,
  consumo        NUMERIC(10,2),
  abonado        NUMERIC(10,2),
  desconto_folha NUMERIC(10,2),
  extrato        JSONB NOT NULL,
  calculado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ciclo_id, colaborador_id)
);

-- Fechamento: gravado uma vez, nunca recalculado.
CREATE TABLE IF NOT EXISTS pulse_premiacao_historico (
  ciclo_id       INT NOT NULL REFERENCES pulse_ciclos(id) ON DELETE CASCADE,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  posicao        INT NOT NULL,
  vida           NUMERIC(6,2) NOT NULL,
  pontualidade   NUMERIC(6,2),
  taxa           NUMERIC(6,2),
  score          INT NOT NULL DEFAULT 0,
  faltas         INT NOT NULL DEFAULT 0,
  fator_tempo_casa NUMERIC(6,4) NOT NULL,
  r_assiduidade  NUMERIC(10,2) NOT NULL,
  r_score        NUMERIC(10,2) NOT NULL,
  r_coletiva     NUMERIC(10,2) NOT NULL,
  r_podio        NUMERIC(10,2) NOT NULL,
  total          NUMERIC(10,2) NOT NULL,
  consumo        NUMERIC(10,2),
  abonado        NUMERIC(10,2),
  desconto_folha NUMERIC(10,2),
  xp_convertido  INT NOT NULL DEFAULT 0,
  extrato        JSONB NOT NULL,
  fechado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ciclo_id, colaborador_id)
);

-- ---------------- Progressão ----------------
CREATE TABLE IF NOT EXISTS pulse_xp_historico (
  id             BIGSERIAL PRIMARY KEY,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  origem         TEXT NOT NULL,
  referencia     TEXT,
  xp             INT NOT NULL,
  descricao      TEXT,
  data_ref       DATE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- 7.7 Idempotência: mesma (colaborador, origem, referência) nunca credita duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS pulse_xp_idempotente
  ON pulse_xp_historico (colaborador_id, origem, referencia)
  WHERE referencia IS NOT NULL;

CREATE OR REPLACE VIEW pulse_xp_total AS
  SELECT c.id AS colaborador_id, COALESCE(SUM(x.xp), 0)::INT AS xp_total
  FROM pulse_colaboradores c LEFT JOIN pulse_xp_historico x ON x.colaborador_id = c.id
  GROUP BY c.id;

CREATE TABLE IF NOT EXISTS pulse_niveis (
  nivel   INT PRIMARY KEY,
  nome    TEXT NOT NULL,
  xp_min  INT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS pulse_coins_historico (
  id             BIGSERIAL PRIMARY KEY,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  origem         TEXT NOT NULL,
  referencia     TEXT,
  valor          INT NOT NULL,
  descricao      TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS pulse_coins_idempotente
  ON pulse_coins_historico (colaborador_id, origem, referencia)
  WHERE referencia IS NOT NULL;

CREATE OR REPLACE VIEW pulse_coins_carteira AS
  SELECT c.id AS colaborador_id,
         COALESCE(SUM(h.valor), 0)::INT AS saldo,
         COALESCE(SUM(h.valor) FILTER (WHERE h.valor > 0), 0)::INT AS acumulado
  FROM pulse_colaboradores c LEFT JOIN pulse_coins_historico h ON h.colaborador_id = c.id
  GROUP BY c.id;

CREATE TABLE IF NOT EXISTS pulse_conquistas (
  id        SERIAL PRIMARY KEY,
  codigo    TEXT NOT NULL UNIQUE,
  nome      TEXT NOT NULL,
  descricao TEXT,
  tipo      TEXT NOT NULL,
  meta      NUMERIC(12,2) NOT NULL,
  raridade  TEXT NOT NULL CHECK (raridade IN ('comum','rara','epica','lendaria')),
  ativo     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS pulse_conquistas_desbloqueadas (
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  conquista_id   INT NOT NULL REFERENCES pulse_conquistas(id) ON DELETE CASCADE,
  desbloqueada_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vista          BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (colaborador_id, conquista_id)
);

CREATE TABLE IF NOT EXISTS pulse_avaliacoes (
  id             SERIAL PRIMARY KEY,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  data           DATE NOT NULL,
  positiva       BOOLEAN NOT NULL,
  comentario     TEXT,
  autor          TEXT NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pulse_loja_produtos (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL,
  descricao  TEXT,
  custo      INT NOT NULL CHECK (custo > 0),
  estoque    INT,              -- NULL = sem controle de estoque
  ativo      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS pulse_loja_resgates (
  id             SERIAL PRIMARY KEY,
  colaborador_id INT NOT NULL REFERENCES pulse_colaboradores(id) ON DELETE CASCADE,
  produto_id     INT NOT NULL REFERENCES pulse_loja_produtos(id),
  custo          INT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado','recusado')),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decidido_por   TEXT,
  decidido_em    TIMESTAMPTZ,
  motivo         TEXT
);

-- Controle do agendador
CREATE TABLE IF NOT EXISTS pulse_agendador (
  chave TEXT PRIMARY KEY,
  valor TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
