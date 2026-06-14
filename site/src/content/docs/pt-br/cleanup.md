---
title: Limpeza
description: O motor de limpeza mantém o banco do Kundun-Agent enxuto, removendo dados antigos ou órfãos de acordo com uma política de retenção configurável.
---

O motor de limpeza (`cleanup`) mantém o banco do Kundun-Agent enxuto, removendo
dados antigos ou órfãos de acordo com uma **política de retenção** configurável.
Tudo acontece localmente, dentro do SQLite em `.kundun/`, em uma única transação,
de forma segura e previsível.

A limpeza tem dois modos: um modo `--dry-run`, que apenas **relata** o que seria
removido sem mudar absolutamente nada, e o modo real, que aplica as remoções e
registra a execução. Algumas garantias são absolutas: **memórias de alta
importância nunca são apagadas**.

## Como executar

```text
kundun cleanup [--dry-run]
```

O comando aceita as opções globais da CLI, como `--project-root <path>` e
`--json` (que emite JSON limpo no stdout; os logs vão para o stderr).

- Use `kundun cleanup --dry-run` para **inspecionar** o que seria removido, sem
  efeito algum sobre o banco ou os arquivos.
- Use `kundun cleanup` (sem a flag) para **aplicar** a retenção de verdade.

### Quando rodar

A limpeza é uma operação de manutenção. Bons momentos para executá-la:

- Periodicamente, após muitos `scan` e edições, para descartar chunks e símbolos
  órfãos e arquivos já apagados.
- Antes de arquivar ou compartilhar o `.kundun/`, para reduzir o tamanho do banco
  (o `VACUUM` ao final ajuda nisso).
- Sempre que tiver dúvida sobre o impacto, rode primeiro com `--dry-run` e só
  depois sem a flag.

## A política de retenção (`config.cleanup`)

A retenção vem da seção `cleanup` do `kundun.config.json`. Cada chave controla um
alvo de remoção e é medida em dias (exceto a última, que é um booleano). Os
valores abaixo são os **padrões**:

| Chave de config                        | Padrão | Alvo controlado                                                |
| -------------------------------------- | ------ | -------------------------------------------------------------- |
| `deleteDeletedFilesAfterDays`          | `7`    | Arquivos já marcados como removidos (`is_deleted=1`).          |
| `deleteUnusedChunksAfterDays`          | `30`   | Chunks de código órfãos / sem uso.                             |
| `deleteLowImportanceMemoriesAfterDays` | `60`   | Memórias de **baixa importância** já expiradas.                |
| `archiveCompletedTasksAfterDays`       | `30`   | Tarefas concluídas antigas (são **arquivadas**, não apagadas). |
| `deleteLogsAfterDays`                  | `14`   | Arquivos de log antigos em `.kundun/logs/`.                    |
| `vacuumAfterCleanup`                   | `true` | Se deve executar `VACUUM` ao final de uma execução real.       |

Uma configuração parcial é aceita: chaves ausentes assumem os padrões acima.

### Alvos da limpeza

A partir dessas chaves, a limpeza atua sobre:

- **Arquivos removidos antigos** — arquivos marcados como apagados há mais tempo
  que `deleteDeletedFilesAfterDays`. A remoção faz **cascata**: os chunks e
  símbolos associados a esses arquivos também são removidos.
- **Chunks órfãos** — chunks de código que não pertencem mais a nenhum arquivo
  ativo (segundo `deleteUnusedChunksAfterDays`).
- **Símbolos órfãos** — símbolos sem chunk/arquivo correspondente.
- **Memórias de baixa importância expiradas** — memórias já expiradas
  (`expires_at`) cujo `importance_score` está **abaixo** do limite de alta
  importância. Memórias com `importance_score >= 80` **nunca** entram aqui (veja
  a garantia abaixo).
- **Tarefas concluídas antigas** — tarefas `completed` há mais tempo que
  `archiveCompletedTasksAfterDays` são movidas para o status `archived` (não são
  apagadas).
- **Logs antigos** — arquivos de log mais velhos que `deleteLogsAfterDays`.

## Garantia: memórias de alta importância nunca são apagadas

Memórias com `importance_score >= 80` (o limite `HIGH_IMPORTANCE_THRESHOLD`) são
de **alta importância** e **nunca são removidas automaticamente** pela limpeza —
mesmo que estejam expiradas ou configuradas como de baixa importância na
retenção. A limpeza só remove automaticamente memórias **de baixa importância e
expiradas**.

Ou seja: se um conhecimento for crítico, garanta a ele uma importância de 80 ou
mais e ele ficará protegido contra remoção automática.

## `--dry-run` vs. execução real

A diferença entre os dois modos é fundamental e deliberada.

### `--dry-run` não muda NADA

Com `--dry-run`, o motor apenas **calcula as contagens** do que seria removido e
as relata. Ele **não altera nada**:

- nenhuma linha do banco é apagada, atualizada ou arquivada;
- nenhum arquivo de log é apagado;
- nenhum `VACUUM` é executado;
- **nem mesmo** uma linha em `cleanup_runs` é registrada.

Em resumo, `--dry-run` é totalmente seguro e sem efeitos colaterais — serve para
você inspecionar o impacto antes de aplicar.

### A execução real

Sem a flag, a limpeza aplica de fato a retenção:

1. Faz **todas as mutações no banco em uma única transação** (remoção de arquivos
   antigos com cascata, chunks e símbolos órfãos, memórias de baixa importância
   expiradas e arquivamento de tarefas concluídas antigas).
2. Apaga os arquivos de log antigos **fora da transação** (operação de sistema de
   arquivos).
3. Executa `VACUUM` **somente se** `vacuumAfterCleanup` for `true` (e nunca em
   `--dry-run`), **após o commit** e **fora de qualquer transação**.
4. Registra a execução em uma linha de `cleanup_runs`.

## Comportamento do `VACUUM`

O `VACUUM` compacta o arquivo do banco, recuperando espaço deixado pelos dados
removidos. Suas regras:

- Roda apenas quando `vacuumAfterCleanup` é `true` **e** a execução **não** é
  `--dry-run`.
- Roda **depois do commit** da transação e **fora de qualquer transação**.
- Se o banco estiver **bloqueado** no momento, o `VACUUM` é **simplesmente
  pulado** — isso **não é um erro fatal** e a limpeza é considerada bem-sucedida
  do mesmo jeito.

## Exemplo: `--dry-run`

Inspeção segura, sem efeitos colaterais:

```text
kundun cleanup --dry-run
```

Saída ilustrativa:

```text
Cleanup (dry-run) — nothing was changed
  deleted files (cascade):   3
  orphan chunks:            42
  orphan symbols:           18
  expired low-importance memories: 5
  completed tasks to archive:      2
  old log files:             4
  vacuum: skipped (dry-run)
No cleanup_runs row recorded.
```

Nenhuma linha foi apagada e **nenhuma** linha em `cleanup_runs` foi gravada.

## Exemplo: execução real

Aplicando a retenção de fato:

```text
kundun cleanup
```

Saída ilustrativa:

```text
Cleanup completed
  deleted files (cascade):   3
  orphan chunks:            42
  orphan symbols:           18
  expired low-importance memories: 5
  completed tasks archived:        2
  old log files removed:     4
  vacuum: done
  recorded cleanup_runs row #7
```

Desta vez as mutações foram aplicadas em uma transação, os logs antigos foram
removidos, o `VACUUM` rodou (porque `vacuumAfterCleanup` é `true` e o banco não
estava bloqueado) e a execução ficou registrada em `cleanup_runs`.

## Veja também

- [Hub da documentação](/pt-br/)
- [Motor de memória](/pt-br/memory-engine/) — importância, expiração e a proteção de
  memórias de alta importância.
- [Motor de tarefas](/pt-br/task-engine/) — tarefas concluídas antigas são arquivadas
  pela limpeza.
