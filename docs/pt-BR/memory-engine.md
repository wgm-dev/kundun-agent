# Motor de Memória

O motor de memória é a camada de **memória persistente de projeto** do
Kundun-Agent. Ele guarda conhecimento sobre o seu projeto — decisões de
arquitetura, bugs conhecidos, convenções, comandos úteis, riscos — de forma
que agentes de IA e desenvolvedores possam recuperar esse contexto mais tarde,
em vez de redescobri-lo a cada sessão. Tudo fica armazenado localmente em
SQLite, dentro de `.kundun/`.

Diferente do índice de código (que é derivado do scanner e pode ser
reconstruído a qualquer momento), as memórias são **escritas por você** (ou por
um agente) e representam intenção e contexto que não estão no código-fonte.

## O que é uma memória

Cada memória é um registro com um `type`, um `title` e um `content`, mais
metadados opcionais (tags, fonte, importância). As memórias são recuperáveis por
busca textual e por tipo, e o motor mantém o controle de quando cada memória foi
usada pela última vez para ajustar sua relevância ao longo do tempo.

### Os 9 tipos de memória

O campo `type` só aceita um destes 9 valores (use exatamente estes nomes):

| `type`         | Quando usar                                                     |
| -------------- | --------------------------------------------------------------- |
| `architecture` | Estrutura do sistema, camadas, limites entre módulos.           |
| `decision`     | Uma decisão tomada e o porquê (substituindo um ADR informal).   |
| `bug`          | Um bug conhecido, sua causa ou seu contorno.                    |
| `task`         | Um lembrete ou nota de trabalho a ser feito.                    |
| `convention`   | Convenções de código, nomenclatura ou estilo do projeto.        |
| `command`      | Um comando útil (build, teste, deploy) que vale a pena lembrar. |
| `risk`         | Um risco técnico ou operacional a ser monitorado.               |
| `domain_rule`  | Uma regra de negócio ou do domínio que o código deve respeitar. |
| `user_note`    | Uma nota livre do usuário que não se encaixa nas outras.        |

### Campos de uma memória

Cada memória armazena os seguintes campos:

- `type` — um dos 9 tipos acima.
- `title` — título curto e descritivo.
- `content` — o corpo da memória.
- `tags` — lista de etiquetas para filtrar e agrupar.
- `source` — de onde a memória veio (ex.: um agente, um documento, uma reunião).
- `confidence` — o grau de confiança na informação.
- `importance_score` — pontuação de importância de 0 a 100 (veja abaixo).
- `created_at` — quando foi criada.
- `updated_at` — quando foi atualizada pela última vez.
- `last_used_at` — quando foi recuperada pela última vez.
- `expires_at` — quando a memória deve expirar (opcional).
- `archived_at` — quando a memória foi arquivada (opcional).

## Comandos

O motor de memória é exposto por três subcomandos: `memory add`, `memory search`
e `memory list`. Todos respeitam as opções globais (`--project-root`, `--json`).

### Adicionar uma memória — `memory add`

```text
kundun memory add --type <type> --title <title> --content <content> \
  [--tags <a,b>] [--importance <n>] [--source <source>]
```

- `--type` e `--title` e `--content` são obrigatórios.
- `--type` precisa ser um dos 9 tipos válidos.
- `--tags` recebe uma lista separada por vírgulas.
- `--importance` é um número de 0 a 100.
- `--source` registra a origem da memória.

Exemplo:

```text
kundun memory add \
  --type decision \
  --title "Usar SQLite com WAL" \
  --content "Banco local-first; WAL melhora concorrência de leitura/escrita." \
  --tags storage,sqlite \
  --importance 85 \
  --source arquitetura
```

### Buscar memórias — `memory search`

```text
kundun memory search [query] [--type <type>] [--tags <a,b>] [--limit <n>]
```

A busca aceita um termo opcional e pode ser filtrada por `--type` e por `--tags`.
O `--limit` controla quantos resultados retornar. Memórias **arquivadas** não
aparecem nos resultados.

```text
kundun memory search "sqlite" --type decision --limit 5
```

### Listar memórias — `memory list`

```text
kundun memory list [--limit <n>]
```

Lista as memórias mais relevantes (uma visão de "memórias importantes"). Essa
operação é **somente leitura**: ela não altera a pontuação de importância nem
o `last_used_at` (veja a seção sobre promoção, abaixo).

## Importância (0..100) e promoção na recuperação

Cada memória tem um `importance_score` entre **0 e 100**. Você define um valor
inicial via `--importance` ao criar a memória; se não informar, ele recebe um
valor padrão.

O motor aplica uma **promoção na recuperação, com limite**: sempre que uma
memória é recuperada por `get` ou por `memory search`, o motor

- atualiza o `last_used_at` para o momento atual, e
- aumenta o `importance_score` em **+10**, com **teto fixo (clamp) em 100**.

Ou seja, memórias que você consulta com frequência sobem em importância
naturalmente, mas a pontuação nunca passa de 100. Esse comportamento existe para
que o conhecimento realmente útil "flutue" para o topo ao longo do tempo.

> **Importante:** `memory list` (a listagem de memórias importantes) é
> **somente leitura**. Ela **não** promove a importância e **não** atualiza
> `last_used_at`. Apenas a recuperação efetiva (`get` / `memory search`)
> dispara a promoção.

## Arquivamento

Arquivar uma memória define o campo `archived_at`. Uma memória arquivada é
**excluída da busca** (`memory search`) e da **listagem de importantes**
(`memory list`). O arquivamento não apaga a memória — ela continua no banco,
apenas deixa de aparecer nas operações de recuperação. Use o arquivamento para
aposentar conhecimento que ficou obsoleto, sem perdê-lo de vez.

## Expiração

Memórias temporárias podem expirar automaticamente por meio do campo
`expires_at`. Isso é útil para notas de curta duração (por exemplo, um lembrete
relevante só durante uma migração). Quando uma memória expira, ela se torna
candidata à remoção pelo motor de limpeza, segundo a retenção configurada.

## Garantia: memórias de alta importância nunca são apagadas

O motor define um limite de alta importância,
`HIGH_IMPORTANCE_THRESHOLD`, igual a **80**. Memórias com
`importance_score >= 80` são consideradas de alta importância e **nunca são
apagadas automaticamente** pela limpeza, mesmo que estejam expiradas ou
configuradas como de baixa importância na retenção.

Em outras palavras: se um conhecimento for crítico, atribua a ele uma
importância de 80 ou mais (ou deixe a promoção na recuperação elevá-lo até lá),
e ele ficará protegido contra remoção automática. A limpeza só remove
automaticamente memórias **de baixa importância e expiradas** — nunca as de
score `>= 80`.

## Veja também

- [Hub da documentação](../README.md)
- [Motor de tarefas](task-engine.md) — tarefas podem se relacionar a memórias.
- [Limpeza](cleanup.md) — retenção e remoção automática de memórias.
