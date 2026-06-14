# Primeiros Passos

O Kundun-Agent é uma camada de inteligência de projeto local-first para agentes de
programação. Ele indexa o seu código-fonte, guarda memória persistente, acompanha tarefas,
faz limpeza e serve contexto pronto para agentes — tudo localmente, em SQLite, sem enviar o
conteúdo do seu projeto para APIs externas.

Esta página leva você do zero ao primeiro uso: instalar e compilar, entender o que é o
diretório `.kundun/`, executar o primeiro ciclo `init` → `scan` → `search`/`summary`, e ver
um exemplo de sessão completa em um projeto pequeno.

> Esta página cobre o **MVP 1** (o núcleo local). MCP server, diagnósticos, daemon, API local
> e app desktop **não** fazem parte do MVP 1 e não são documentados aqui.

## Pré-requisitos

- **Node.js 20+** (testado até a versão 24).
- O `better-sqlite3` `^12` já vem com um binário pré-compilado (FTS5 habilitado, SQLite 3.53),
  então normalmente não é preciso compilar nada nativo na instalação.

## Instalar e compilar

A partir da raiz do repositório:

```bash
npm install
npm run build
```

O `build` produz o binário `kundun` apontando para `dist/cli/index.js`.

Durante o desenvolvimento, antes de publicar ou vincular o binário, você invoca a CLI assim:

```bash
node dist/cli/index.js <comando> [opções]
```

Depois que o pacote estiver publicado ou vinculado, o comando passa a ser simplesmente
`kundun`. O restante desta documentação mostra a forma `kundun ...`.

## Opções globais da CLI

Estas opções valem para **todos** os comandos:

- `--project-root <path>` — raiz do projeto (o padrão é o diretório atual).
- `--json` — emite JSON legível por máquina no stdout (padrão `false`). O stdout fica com JSON
  limpo; todos os logs vão para o stderr.
- `-V` / `--version`, `-h` / `--help`.

A combinação de `--json` com stdout limpo e logs no stderr é o que permite a um agente
consumir a saída de forma confiável.

## O que é o diretório `.kundun/`

Ao rodar `kundun init`, o Kundun cria um diretório `.kundun/` na raiz do projeto. É ali que
todo o estado local vive — nada sai da sua máquina. O conteúdo é:

- `kundun.sqlite` — o banco de dados SQLite (o coração do produto: arquivos, chunks, símbolos,
  memórias, tarefas e registros de execução).
- `cache/` — cache de trabalho.
- `logs/` — arquivos de log (a limpeza pode removê-los conforme a retenção configurada).
- `snapshots/` — snapshots.
- `runtime/` — estado de runtime. (No MVP 1 **não** há arquivo de token de runtime.)
- `config.json` — um espelho da configuração.

Além disso, `kundun init` cria o arquivo `kundun.config.json` na raiz do projeto (caso ainda
não exista), abre o banco, roda as migrações e grava a linha `project_meta`.

O banco usa as PRAGMAs `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000` e
`synchronous=NORMAL`. A versão do schema é mantida em uma tabela `_migrations`, e
`project_meta.schema_version` espelha esse valor.

## Primeira execução: `init` → `scan` → `search` / `summary`

O fluxo básico tem três passos.

### 1. `kundun init`

```bash
kundun init --name minha-app
```

Cria `kundun.config.json` (se ausente) e o diretório `.kundun/` com seus subdiretórios, abre o
banco, aplica as migrações e grava a linha `project_meta`. O `--name` define o nome do projeto
e, se omitido, assume o nome do diretório. Use `--force` para reinicializar.

### 2. `kundun scan`

```bash
kundun scan
```

Percorre o projeto e detecta arquivos novos, alterados e removidos por hash, indexando os novos
e os alterados. Ele respeita `include`/`exclude` e o `.gitignore` da raiz, não segue links
simbólicos, bloqueia path traversal, pula arquivos binários, arquivos maiores que
`maxFileSizeKb` e arquivos sensíveis (cujo conteúdo **nunca** é armazenado). A saída mostra os
contadores `scanned/new/changed/removed/skipped/indexed`. Use `--force` para reindexar todos os
arquivos rastreados.

### 3. `kundun search` e `kundun summary`

Busque dentro do código indexado:

```bash
kundun search "checkout"
```

Imprime `relativePath:line` mais um trecho, com um rodapé indicando o modo de busca (`fts5` ou
`like`). O Kundun usa FTS5 (com ranking bm25) quando disponível e cai para `LIKE` caso
contrário.

Ou veja a visão geral somente-leitura do projeto:

```bash
kundun summary
```

O `summary` reúne linguagens, arquivos importantes, memórias importantes, tarefas abertas mais a
próxima tarefa, último scan, última limpeza, contagens, modo de busca e comandos sugeridos — sem
alterar nada.

## Quickstart copiável

Cole este bloco a partir da raiz do seu projeto. Ele compila o Kundun, inicializa, indexa e
mostra a visão geral. (Troque para `kundun ...` quando o binário já estiver disponível.)

```bash
# 1. instalar e compilar o Kundun (a partir do checkout do Kundun-Agent)
npm install
npm run build

# 2. a partir da raiz do SEU projeto, inicializar e indexar
node dist/cli/index.js init --name minha-app
node dist/cli/index.js scan

# 3. consultar
node dist/cli/index.js search "checkout"
node dist/cli/index.js summary
```

## Exemplo de sessão completa

Suponha um projeto pequeno com um arquivo `src/checkout.ts`. Veja um ciclo de uso de ponta a
ponta — inicializar, indexar, buscar, registrar uma decisão na memória e criar uma tarefa.

```bash
# inicializar o projeto (cria kundun.config.json + .kundun/)
kundun init --name loja-demo

# indexar o código
kundun scan
#   scanned=42 new=42 changed=0 removed=0 skipped=6 indexed=42

# buscar por uma função e por um símbolo
kundun search "applyDiscount"
#   src/checkout.ts:88  function applyDiscount(cart, coupon) {
#   (search mode: fts5)

kundun symbol applyDiscount --kind function
#   src/checkout.ts:88  function  applyDiscount

# registrar uma decisão de arquitetura na memória persistente
kundun memory add \
  --type decision \
  --title "Cupons aplicados antes do imposto" \
  --content "applyDiscount roda antes do cálculo de imposto em checkout.ts" \
  --tags checkout,pricing \
  --importance 70

# listar e buscar memórias
kundun memory list --limit 5
kundun memory search "imposto" --type decision

# criar uma tarefa e pedir a próxima
kundun task create \
  --title "Cobrir applyDiscount com testes" \
  --priority high \
  --files src/checkout.ts

kundun task next
#   [high] Cobrir applyDiscount com testes  (pending)

# visão geral somente-leitura do estado do projeto
kundun summary
```

Os tipos de memória permitidos são os nove: `architecture`, `decision`, `bug`, `task`,
`convention`, `command`, `risk`, `domain_rule`, `user_note`. As prioridades de tarefa são
`low`, `medium`, `high`, `critical`, e os status são `pending`, `in_progress`, `blocked`,
`completed`, `archived`.

Para JSON consumível por agente, acrescente `--json` a qualquer comando:

```bash
kundun summary --json
```

## Dashboard web

O Kundun-Agent inclui uma pequena interface web, o **Kundun Control Center**,
servida pelo daemon local — sem necessidade de ferramentas adicionais. Inicie o
daemon e abra o dashboard:

```bash
kundun daemon
```

Em seguida, abra [http://127.0.0.1:37373/](http://127.0.0.1:37373/) no navegador
(a porta padrão é `37373`). Cole o token de `.kundun/runtime/token` no campo no
topo da página para liberar os painéis de dados — saúde, sessões, métricas, um
fluxo de eventos ao vivo e ações protegidas por token (scan, limpeza,
diagnóstico, reinício do MCP). A casca da interface é pública, mas todos os dados
exigem o token, que a página envia como cabeçalho `Bearer`. Para executar o
daemon sem a UI, use `kundun daemon --no-dashboard`. Veja a página
[Dashboard web](dashboard.md) para mais detalhes.

## Próximos passos

- Ajuste o que é indexado e a retenção em [Configuração](configuration.md).
- Veja todos os comandos e flags na [Referência da CLI](cli-reference.md).
- Entenda como os arquivos viram chunks e símbolos em
  [Scanner e indexação](scanner-indexing.md).
- Aprofunde-se em busca e memória em [Busca](search.md) e
  [Motor de memória](memory-engine.md).

## Veja também

- [Documentação do Kundun-Agent (hub)](../README.md)
- [Referência da CLI](cli-reference.md)
- [Configuração](configuration.md)
