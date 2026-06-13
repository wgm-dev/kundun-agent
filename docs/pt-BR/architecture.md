# Arquitetura

Esta página descreve a arquitetura interna do Kundun-Agent em alto nível: as camadas
de código, a raiz de composição que monta tudo, o modelo de armazenamento em SQLite e
o layout dos dados locais em `.kundun/`. O foco é conceitual — para receitas em nível de
código (como adicionar um comando, um extrator de linguagem ou uma migração), consulte o
[`CLAUDE.md`](../../CLAUDE.md) na raiz do repositório.

O Kundun-Agent é _local-first_: tudo roda na sua máquina, todo o estado vive em um único
arquivo SQLite, e nenhum conteúdo do projeto é enviado para serviços externos por padrão.

## Camadas

O código em `src/` é organizado em camadas com dependências que fluem em uma única
direção. Cada camada só conhece as que estão à sua esquerda:

```
utils  ->  config  ->  storage  ->  core  ->  languages  ->  cli
```

- **`utils`** — utilitários puros e sem estado (hashing, caminhos, logging). Não dependem
  de nenhuma outra camada e podem ser usados por todas.
- **`config`** — carrega e valida o `kundun.config.json`. Define o schema (via zod), os
  valores padrão e o _loader_. Um arquivo de config parcial é aceito: chaves ausentes
  recebem os defaults.
- **`storage`** — o acesso ao banco. Abre o SQLite, aplica PRAGMAs, roda migrações e expõe
  os _repositories_ (uma classe por tabela) que encapsulam todo o SQL. Nenhuma regra de
  negócio mora aqui.
- **`core`** — os motores do produto: scanner incremental, indexer/chunker, provedores de
  busca, motor de memória, motor de tarefas, motor de limpeza, importância e resumo do
  projeto. É onde vive a lógica de negócio. O core fala com o banco _somente_ através dos
  repositories.
- **`languages`** — os extratores de símbolos por linguagem (regex, nunca executam código),
  consumidos pelo indexer do core.
- **`cli`** — a casca fina por cima de tudo. Faz o _parsing_ dos comandos e flags, chama o
  core e formata a saída (texto humano ou JSON com `--json`).

Manter o fluxo em uma direção evita ciclos: o `storage` nunca importa do `core`, o `core`
nunca importa da `cli`, e assim por diante.

## A raiz de composição (`container.ts` / `AppContext`)

Toda a montagem acontece em um único lugar: `src/core/container.ts`. A função
`createAppContext(...)` é a **raiz de composição** — ela carrega a config, abre o banco,
roda as migrações e instancia os _repositories_, devolvendo um único objeto `AppContext`.

Conceitualmente o `AppContext` carrega:

- a configuração já validada do projeto;
- a conexão SQLite (com PRAGMAs aplicados e migrações em dia);
- um conjunto de _repositories_ (`Repositories`), um por tabela.

A partir desse contexto, funções fábrica constroem cada motor sob demanda — por exemplo
`buildScanner(ctx)`, `buildIndexer(ctx)`, `buildMemoryEngine(ctx)`, `buildTaskEngine(ctx)`,
`buildCleanupEngine(ctx)` e `buildSearchProvider(ctx)`. Cada comando da CLI cria um
`AppContext`, constrói só os motores de que precisa, executa e encerra.

A vantagem prática: os motores não sabem _como_ o banco foi aberto ou de onde a config veio
— eles recebem tudo pronto pelo `AppContext`. Isso mantém o core testável e desacoplado da
CLI.

## Modelo de armazenamento em SQLite

Todo o estado persistente vive em um único arquivo SQLite (por padrão
`.kundun/kundun.sqlite`, configurável via `databasePath`).

### PRAGMAs

Ao abrir o banco, o `storage` aplica estes PRAGMAs:

| PRAGMA         | Valor    | Por quê                                                |
| -------------- | -------- | ------------------------------------------------------ |
| `journal_mode` | `WAL`    | Leituras concorrentes com escritas; mais robusto.      |
| `foreign_keys` | `ON`     | Integridade referencial e _cascades_ de exclusão.      |
| `busy_timeout` | `5000`   | Espera até 5 s antes de falhar com banco travado.      |
| `synchronous`  | `NORMAL` | Bom equilíbrio entre durabilidade e velocidade no WAL. |

### Versão do schema: `_migrations` é a fonte da verdade

A versão **autoritativa** do schema fica na tabela `_migrations`. A coluna
`project_meta.schema_version` é apenas um **espelho** dela, conveniente para leitura rápida
(por exemplo no comando `kundun summary`). Em caso de divergência, vale o `_migrations`. As
migrações são aplicadas em ordem ao abrir o banco, de forma idempotente.

### As 8 tabelas do MVP1

| Tabela         | O que guarda                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `project_meta` | Metadados do projeto: nome, criação e o espelho de `schema_version`.                                   |
| `files`        | Um registro por arquivo rastreado: caminho, hash `sha256`, e `is_deleted` para arquivos removidos.     |
| `file_chunks`  | Os trechos do código indexado em faixas de linhas (início/fim 1-based inclusivos), com hash por chunk. |
| `symbols`      | Símbolos básicos (funções, classes, etc.) extraídos por linguagem via regex.                           |
| `memories`     | A memória persistente do projeto, incluindo a coluna `archived_at`.                                    |
| `tasks`        | As tarefas: título, prioridade, status, datas e relações (com arquivos/memórias) em JSON.              |
| `scan_runs`    | Um registro de cada execução do `kundun scan` (contagens e tempos).                                    |
| `cleanup_runs` | Um registro de cada execução real do `kundun cleanup`.                                                 |

> Nota: o `kundun cleanup --dry-run` **não** grava uma linha em `cleanup_runs` — ele apenas
> reporta o que seria removido e não altera nada.

### Tabelas virtuais FTS5

Quando o FTS5 está disponível (é o caso na build padrão do `better-sqlite3`), o `storage`
cria duas tabelas virtuais de busca _full-text_:

- `chunks_fts` — indexa o conteúdo de `file_chunks`, usada pela busca de código.
- `memories_fts` — indexa as memórias, usada pela busca de memória.

Se o FTS5 não estiver presente, a busca cai num _fallback_ baseado em `LIKE`. O modo ativo
(`fts5` ou `like`) aparece na saída dos comandos de busca.

## Layout dos dados locais (`.kundun/`)

O `kundun init` cria o diretório `.kundun/` na raiz do projeto. Tudo que o Kundun-Agent
persiste mora aqui — você pode versionar ou ignorar essa pasta conforme sua preferência.

```
.kundun/
  kundun.sqlite     # o banco SQLite (todo o estado persistente)
  config.json       # espelho da configuração
  cache/            # caches internos
  logs/             # logs (limpos pela retenção do cleanup)
  snapshots/        # snapshots
  runtime/          # estado de runtime
```

O `kundun.config.json` em si fica na **raiz do projeto** (não dentro de `.kundun/`); o
`config.json` dentro de `.kundun/` é apenas um espelho.

## Veja também

- [Visão geral da documentação](../README.md)
- [Configuração](configuration.md) — todas as chaves do `kundun.config.json`.
- [Scanner e indexação](scanner-indexing.md) — como `files`, `file_chunks` e `symbols`
  são preenchidos.
