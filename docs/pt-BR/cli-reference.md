# Referência da CLI

Esta página é a lista autoritativa de comandos do Kundun-Agent no MVP 1. Para cada
comando você encontra os argumentos e flags exatos, uma invocação de exemplo e
observações sobre as opções globais. Os exemplos usam o binário `kundun`; durante o
desenvolvimento, antes de publicar ou linkar o pacote, invoque os mesmos comandos com
`node dist/cli/index.js ...`.

## Opções globais

As opções abaixo se aplicam a **todos** os comandos e podem aparecer em qualquer posição
da linha de comando:

- `--project-root <path>` — define a raiz do projeto. Por padrão usa o diretório atual
  (`cwd`).
- `--json` — emite JSON legível por máquina em `stdout` (padrão: desativado). Quando
  ativado, o `stdout` contém apenas JSON limpo; todos os logs vão para `stderr`. Use esta
  flag quando um agente de IA precisar consumir a saída de forma programática.
- `-V`, `--version` — mostra a versão.
- `-h`, `--help` — mostra a ajuda.

Exemplo combinando globais com um comando:

```bash
kundun --project-root /caminho/do/projeto --json scan
```

> Nota sobre `--json`: as duas formas de saída (legível por humanos e JSON) descrevem o
> mesmo resultado. Em scripts e integrações com agentes, prefira `--json` e leia apenas o
> `stdout`.

## `kundun init`

Inicializa o Kundun-Agent no projeto. Cria o arquivo `kundun.config.json` (se ainda não
existir), cria a pasta `.kundun/` com os subdiretórios `cache/`, `logs/`, `snapshots/` e
`runtime/`, abre o banco de dados, executa as migrações e grava a linha em `project_meta`.

Flags:

- `--name <name>` — nome do projeto. Por padrão usa o nome do diretório.
- `--force` — reinicializa, sobrescrevendo o `kundun.config.json` existente.

```bash
kundun init --name meu-projeto
```

## `kundun scan`

Percorre o projeto e detecta arquivos novos, alterados e removidos comparando o hash de
cada arquivo. Indexa os arquivos novos e alterados, marca os removidos como excluídos e
registra a execução. Ao final, imprime as contagens de
`scanned`/`new`/`changed`/`removed`/`skipped`/`indexed`.

Flags:

- `--force` — reindexa todos os arquivos rastreados, mesmo os inalterados.

```bash
kundun scan --force
```

## `kundun search`

Busca nos chunks de código já indexados. Usa FTS5 quando disponível (ranqueamento bm25) ou
o fallback `LIKE` caso o FTS5 não esteja disponível. Imprime `relativePath:line` seguido de
um trecho do código; o rodapé indica o modo de busca ativo (`fts5` ou `like`).

Argumentos:

- `<query>` — termo(s) de busca (obrigatório).

Flags:

- `--language <language>` — filtra por linguagem.
- `--limit <n>` — limita o número de resultados.

```bash
kundun search "createUser" --language typescript --limit 20
```

## `kundun symbol`

Encontra símbolos pelo nome exato (ou por prefixo com `--prefix`). Os símbolos são
extraídos durante a indexação por extratores baseados em expressões regulares por
linguagem.

Argumentos:

- `<name>` — nome do símbolo a procurar (obrigatório).

Flags:

- `--language <language>` — filtra por linguagem.
- `--kind <kind>` — filtra por tipo de símbolo, por exemplo `function` ou `class`.
- `--limit <n>` — limita o número de resultados.
- `--prefix` — trata `<name>` como prefixo em vez de nome exato.

```bash
kundun symbol UserService --kind class --prefix
```

## `kundun memory add`

Adiciona uma entrada à memória persistente do projeto.

Flags:

- `--type <type>` — tipo da memória (obrigatório). Os 9 tipos permitidos são:
  `architecture`, `decision`, `bug`, `task`, `convention`, `command`, `risk`,
  `domain_rule`, `user_note`.
- `--title <title>` — título (obrigatório).
- `--content <content>` — conteúdo (obrigatório).
- `--tags <a,b>` — lista de tags separadas por vírgula.
- `--importance <n>` — pontuação de importância de 0 a 100.
- `--source <source>` — origem da memória.

```bash
kundun memory add --type decision --title "Adotar FTS5" \
  --content "Busca primária via SQLite FTS5 com fallback LIKE." \
  --tags busca,decisao --importance 80
```

## `kundun memory search`

Pesquisa na memória. A recuperação atualiza `last_used_at` e aplica uma promoção limitada
de importância (+10, com teto em 100). Memórias arquivadas são excluídas dos resultados.

Argumentos:

- `[query]` — termo de busca (opcional).

Flags:

- `--type <type>` — filtra por tipo (ver os 9 tipos em `memory add`).
- `--tags <a,b>` — filtra por tags separadas por vírgula.
- `--limit <n>` — limita o número de resultados.

```bash
kundun memory search "busca" --type decision --limit 10
```

## `kundun memory list`

Lista as memórias importantes. Esta operação é somente leitura: **não** aplica promoção de
importância nem atualiza `last_used_at`.

Flags:

- `--limit <n>` — limita o número de resultados.

```bash
kundun memory list --limit 25
```

## `kundun task create`

Cria uma nova tarefa.

Flags:

- `--title <title>` — título (obrigatório).
- `--description <d>` — descrição.
- `--priority <p>` — prioridade: `low`, `medium`, `high` ou `critical`.
- `--files <a,b>` — arquivos relacionados, separados por vírgula.

```bash
kundun task create --title "Corrigir login" --priority high \
  --files src/auth.ts,src/session.ts
```

## `kundun task next`

Imprime a próxima tarefa a ser trabalhada. A ordem de seleção é exatamente:

1. `critical` + `pending`
2. `critical` + `in_progress`
3. `high` + `pending`
4. `high` + `in_progress`
5. `medium` + `pending`
6. `low` + `pending`

Todas as demais combinações (`blocked`, `completed`, `archived`, `medium` + `in_progress`
e `low` + `in_progress`) são excluídas de `next`.

```bash
kundun task next
```

## `kundun task update`

Atualiza uma tarefa existente. Concluir uma tarefa (definir o status como `completed`)
grava `completed_at`.

Argumentos:

- `<id>` — identificador da tarefa (obrigatório).

Flags:

- `--status <s>` — status: `pending`, `in_progress`, `blocked`, `completed` ou `archived`.
- `--priority <p>` — prioridade: `low`, `medium`, `high` ou `critical`.
- `--title <t>` — novo título.
- `--description <d>` — nova descrição.

```bash
kundun task update 42 --status in_progress --priority critical
```

## `kundun task list`

Lista tarefas.

Flags:

- `--status <s>` — filtra por status (ver os valores em `task update`).
- `--limit <n>` — limita o número de resultados.

```bash
kundun task list --status pending --limit 50
```

## `kundun cleanup`

Aplica as políticas de retenção definidas em `config.cleanup`. Remove arquivos excluídos
antigos (em cascata sobre chunks e símbolos), chunks órfãos, símbolos órfãos, memórias
expiradas de baixa importância (nunca remove memórias com pontuação >= 80), arquiva tarefas
concluídas antigas e apaga arquivos de log antigos. Uma execução real faz as mutações no
banco em uma única transação, apaga os logs antigos fora da transação, executa `VACUUM`
(quando `vacuumAfterCleanup` está ativo; se o banco estiver bloqueado, o `VACUUM` é
ignorado, não é fatal) e registra uma linha em `cleanup_runs`.

Flags:

- `--dry-run` — calcula e reporta o que **seria** removido sem alterar nada (nem mesmo
  grava uma linha em `cleanup_runs`).

```bash
kundun cleanup --dry-run
```

## `kundun summary`

Visão geral somente leitura do projeto: linguagens, arquivos importantes, memórias
importantes, tarefas abertas com a próxima tarefa sugerida, último scan, última limpeza,
contagens, modo de busca ativo e comandos sugeridos. Não altera nada.

```bash
kundun summary
```

---

## Veja também

- [Visão geral da documentação](../README.md)
- [Primeiros passos](getting-started.md)
- [Configuração](configuration.md)
