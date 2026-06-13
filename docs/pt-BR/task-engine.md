# Motor de Tarefas

O motor de tarefas do Kundun-Agent mantém uma lista de trabalho persistente do
projeto, armazenada localmente no SQLite. Ele permite criar tarefas, consultá-las,
atualizar seu andamento e — o mais importante para agentes de IA — descobrir
qual é a **próxima** tarefa a executar, seguindo uma ordem de prioridade
determinística.

Tudo é local: nenhuma tarefa sai da sua máquina.

## Ciclo de vida de uma tarefa

Uma tarefa nasce no status `pending` e avança pelos estados conforme o trabalho
progride. As operações disponíveis são `create`, `list`, `search`, `next`,
`update`, `complete`, `archive` e o relacionamento com arquivos e memórias.

Concluir uma tarefa (status `completed`) registra o instante da conclusão em
`completed_at`.

## Status e prioridades

São cinco status possíveis:

- `pending` — criada, ainda não iniciada.
- `in_progress` — em execução.
- `blocked` — impedida por alguma dependência.
- `completed` — finalizada (preenche `completed_at`).
- `archived` — arquivada (sai das listagens de trabalho ativo).

São quatro prioridades possíveis:

- `low`
- `medium`
- `high`
- `critical`

## Comandos

Todos os comandos aceitam as opções globais da CLI, como `--project-root <path>`
e `--json` (que emite JSON limpo no stdout; os logs vão para o stderr).

### Criar uma tarefa

```
kundun task create --title <title> [--description <d>] [--priority <p>] [--files <a,b>]
```

- `--title` é obrigatório.
- `--priority` aceita `low|medium|high|critical`.
- `--files` recebe uma lista de arquivos relacionados, separados por vírgula.

Exemplo:

```
kundun task create --title "Corrigir validação de login" --priority high \
  --files src/auth/login.ts,src/auth/session.ts
```

### Próxima tarefa

```
kundun task next
```

Retorna a única tarefa a ser executada agora, seguindo a ordem de prioridade
descrita abaixo. Se nenhuma tarefa for elegível, nada é retornado.

### Atualizar uma tarefa

```
kundun task update <id> [--status <s>] [--priority <p>] [--title <t>] [--description <d>]
```

Use para mudar o status (por exemplo, de `pending` para `in_progress`), ajustar a
prioridade ou editar o título e a descrição.

Exemplo:

```
kundun task update 12 --status in_progress
```

### Listar tarefas

```
kundun task list [--status <s>] [--limit <n>]
```

Filtra por `--status` e limita a quantidade de resultados com `--limit`.

## A ordem EXATA de `next()`

O comando `kundun task next` aplica esta ordem de seleção, **exatamente** nesta
sequência:

1. `critical` + `pending`
2. `critical` + `in_progress`
3. `high` + `pending`
4. `high` + `in_progress`
5. `medium` + `pending`
6. `low` + `pending`

Todo o resto é **excluído** de `next()`, ou seja, nunca será escolhido:
`blocked`, `completed`, `archived`, `medium` + `in_progress` e
`low` + `in_progress`.

### Exemplo passo a passo

Suponha que o projeto tenha as seguintes tarefas abertas:

| id  | priority   | status        |
| --- | ---------- | ------------- |
| 1   | `critical` | `in_progress` |
| 2   | `high`     | `pending`     |
| 3   | `critical` | `blocked`     |
| 4   | `medium`   | `pending`     |
| 5   | `low`      | `pending`     |

Aplicando a ordem de `next()`:

- A tarefa `3` é `critical`, mas está `blocked` — portanto **excluída**.
- Não há nenhuma `critical` + `pending`, então o nível 1 não tem candidatos.
- A tarefa `1` é `critical` + `in_progress` (nível 2). É a primeira posição da
  ordem que tem um candidato, então **`next()` escolhe a tarefa `1`**.

As tarefas `2`, `4` e `5` só seriam consideradas se nenhuma `critical` estivesse
elegível. Note que a `3` jamais seria retornada por `next()` enquanto estivesse
`blocked`, mesmo sendo `critical`.

## Relacionar tarefas a arquivos e memórias

Uma tarefa pode ser relacionada a arquivos e a memórias do projeto. Esses
relacionamentos são armazenados como JSON junto da tarefa. Arquivos relacionados
podem ser informados já na criação, via `--files`:

```
kundun task create --title "Revisar migração de schema" \
  --files database/migrations/2026_user_roles.sql
```

Relacionar tarefas a memórias conecta o trabalho ao conhecimento persistente do
projeto (decisões de arquitetura, convenções, bugs conhecidos etc.), ajudando
agentes a recuperar contexto relevante ao retomar uma tarefa.

## Veja também

- [Voltar ao índice da documentação](../README.md)
- [Motor de memória](memory-engine.md)
- [Referência da CLI](cli-reference.md)
