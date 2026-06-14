---
title: Configuração
description: O Kundun-Agent é configurado por um único arquivo kundun.config.json na raiz do projeto. Este documento descreve todas as chaves, seus padrões e significado.
---

O Kundun-Agent é configurado por um único arquivo `kundun.config.json` na raiz do
projeto. Este documento descreve **todas** as chaves, seus valores padrão e seu
significado, além de um exemplo completo. Algumas chaves já existem no esquema, mas
são **reservadas para marcos futuros** — elas são aceitas e validadas, porém os
recursos que as utilizam ainda não fazem parte do MVP1.

O arquivo é criado por `kundun init`. Você pode editá-lo manualmente a qualquer
momento; ele é validado com [zod] na próxima execução de qualquer comando.

## Onde fica o arquivo

`kundun init` cria `kundun.config.json` na raiz do projeto (a menos que ele já
exista; use `--force` para reinicializar). O comando também cria o diretório
`.kundun/` com os subdiretórios `cache/`, `logs/`, `snapshots/` e `runtime/`, abre
o banco SQLite, executa as migrações e grava a linha `project_meta`.

```bash
kundun init --name meu-projeto
```

> Uma cópia espelho da configuração também é gravada em `.kundun/config.json`. O
> arquivo autoritativo é o `kundun.config.json` na raiz do projeto.

## Configuração parcial

Um arquivo de configuração **parcial é aceito**: qualquer chave ausente recebe o
valor padrão documentado abaixo (a validação é feita com zod). Você só precisa
declarar as chaves que quer alterar — na prática, muitos projetos só ajustam
`projectName`, `include` e `exclude`.

## Referência das chaves

A tabela abaixo lista cada chave de nível raiz, seu padrão e uma descrição curta.
As chaves reservadas para marcos futuros estão marcadas com **(reservado)**.

| Chave                 | Padrão                                                                                                | Significado                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `projectName`         | (obrigatório)                                                                                         | Nome do projeto exibido em resumos e metadados.                 |
| `databasePath`        | `".kundun/kundun.sqlite"`                                                                             | Caminho do banco SQLite, relativo à raiz.                       |
| `include`             | `["src","app","database","routes","config","docs"]`                                                   | Diretórios/globs a indexar.                                     |
| `exclude`             | `["node_modules","vendor",".git",".next","dist","build","coverage","storage","logs","tmp",".kundun"]` | Diretórios/globs a ignorar.                                     |
| `maxFileSizeKb`       | `512`                                                                                                 | Arquivos maiores que isto são ignorados (motivo `too_large`).   |
| `scanBinaryFiles`     | `false`                                                                                               | Se `true`, tenta varrer arquivos binários (padrão: ignorá-los). |
| `enableDiagnostics`   | `true`                                                                                                | **(reservado)** Diagnósticos heurísticos não existem no MVP1.   |
| `enableAutoCleanup`   | `true`                                                                                                | Permite que a limpeza por retenção seja aplicada.               |
| `allowRestartFromMcp` | `false`                                                                                               | **(reservado)** MCP não existe no MVP1.                         |
| `autoScan`            | `{ enabled:false, intervalMinutes:10 }`                                                               | **(reservado)** Daemon de auto-scan não existe no MVP1.         |
| `cleanup`             | (ver abaixo)                                                                                          | Políticas de retenção da limpeza.                               |
| `desktop`             | (ver abaixo)                                                                                          | **(reservado)** App desktop / API local não existem no MVP1.    |
| `languages`           | (ver abaixo)                                                                                          | Liga/desliga cada linguagem suportada.                          |

### `projectName` (obrigatório)

Nome do projeto, em texto. É a única chave obrigatória. O `kundun init` usa o nome
do diretório como padrão quando você não passa `--name`.

### `databasePath`

Caminho do arquivo SQLite, relativo à raiz do projeto. O padrão
`.kundun/kundun.sqlite` mantém todos os dados locais dentro de `.kundun/`.

### `include` e `exclude`

Estas duas listas controlam **o que o scanner percorre**:

- `include` — diretórios (ou globs) que o scanner visita. Apenas caminhos cobertos
  por `include` são considerados; um arquivo fora deles é ignorado com o motivo
  `not_included`.
- `exclude` — diretórios (ou globs) que o scanner pula mesmo que estejam dentro de
  `include`. Arquivos correspondentes são ignorados com o motivo `excluded`.

Além dessas listas, o scanner também respeita o `.gitignore` da raiz (arquivos
ignorados por ele recebem o motivo `gitignored`). A ordem efetiva é: um caminho
precisa estar em `include`, não pode estar em `exclude` e não pode ser ignorado
pelo `.gitignore`.

Os padrões já cobrem os casos comuns: `include` aponta para código-fonte e docs
(`src`, `app`, `database`, `routes`, `config`, `docs`), enquanto `exclude` remove
diretórios de dependências e artefatos (`node_modules`, `vendor`, `dist`, `build`,
`coverage`, `.git`, `.next`, `storage`, `logs`, `tmp` e o próprio `.kundun`).

> Mesmo dentro de `include`, arquivos **sensíveis** (como `.env`, `*.pem`, `*.key`,
> `**/secrets/**`, `id_rsa`, entre outros) são sempre ignorados com o motivo
> `sensitive_file`, e seu **conteúdo nunca é armazenado**. Veja
> [Scanner e indexação](/pt-br/scanner-indexing/).

### `maxFileSizeKb`

Tamanho máximo, em KB, de um arquivo elegível à indexação. Arquivos maiores são
ignorados com o motivo `too_large`. O padrão é `512`.

### `scanBinaryFiles`

Quando `false` (padrão), arquivos binários são ignorados com o motivo `binary`. O
indexador trabalha apenas com arquivos de texto, então deixe esta chave em `false`
salvo um caso muito específico.

### `enableDiagnostics` (reservado)

Existe no esquema, mas os diagnósticos heurísticos **não estão implementados no
MVP1**. O valor não tem efeito nesta versão.

### `enableAutoCleanup`

Quando `true` (padrão), as políticas de retenção definidas em `cleanup` podem ser
aplicadas. O comando `kundun cleanup` é sempre explícito; veja [Limpeza](/pt-br/cleanup/).

### `allowRestartFromMcp` (reservado)

Existe no esquema, mas o **servidor MCP não faz parte do MVP1**. Sem efeito nesta
versão.

### `autoScan` (reservado)

Objeto `{ enabled, intervalMinutes }`, padrão `{ enabled:false, intervalMinutes:10 }`.
O **daemon de auto-scan não faz parte do MVP1** — no MVP1 você dispara a varredura
manualmente com `kundun scan`. Sem efeito nesta versão.

### `cleanup`

Objeto com as políticas de retenção usadas por `kundun cleanup`. Padrões:

| Subchave                               | Padrão | Significado                                                                       |
| -------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| `deleteDeletedFilesAfterDays`          | `7`    | Remove arquivos marcados como deletados após N dias (cascata em chunks/símbolos). |
| `deleteUnusedChunksAfterDays`          | `30`   | Remove chunks órfãos após N dias.                                                 |
| `deleteLowImportanceMemoriesAfterDays` | `60`   | Remove memórias de baixa importância expiradas após N dias.                       |
| `archiveCompletedTasksAfterDays`       | `30`   | Arquiva tarefas concluídas após N dias.                                           |
| `deleteLogsAfterDays`                  | `14`   | Remove arquivos de log antigos após N dias.                                       |
| `vacuumAfterCleanup`                   | `true` | Executa `VACUUM` após uma limpeza real (nunca em `--dry-run`).                    |

> Memórias de **alta importância** (score >= 80) **nunca** são removidas
> automaticamente pela limpeza, independentemente do tempo. Detalhes em
> [Motor de memória](/pt-br/memory-engine/) e [Limpeza](/pt-br/cleanup/).

### `desktop` (reservado)

Objeto `{ enabled, minimizeToTray, startWithWindows, localApiHost, localApiPort }`,
padrões `{ enabled:true, minimizeToTray:true, startWithWindows:false,
localApiHost:"127.0.0.1", localApiPort:37373 }`. O **app desktop e a API local não
fazem parte do MVP1**. Sem efeito nesta versão.

### `languages`

Objeto que liga/desliga cada linguagem suportada para indexação. Todas vêm como
`true` por padrão:

| Linguagem    | Extensões                                        |
| ------------ | ------------------------------------------------ |
| `php`        | `.php`                                           |
| `go`         | `.go`                                            |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts`                    |
| `javascript` | `.js`, `.jsx`, `.mjs`, `.cjs`                    |
| `csharp`     | `.cs`                                            |
| `cpp`        | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.h`, `.c` |
| `sql`        | `.sql`                                           |

Defina uma linguagem como `false` para que arquivos com aquelas extensões não sejam
indexados.

## Exemplo completo

O exemplo abaixo lista **todas** as chaves com seus valores padrão. Você não precisa
de um arquivo tão completo — lembre-se de que uma configuração parcial é válida e as
chaves ausentes recebem estes mesmos padrões. As chaves reservadas estão presentes
para referência, mas não têm efeito no MVP1.

```json
{
  "projectName": "meu-projeto",
  "databasePath": ".kundun/kundun.sqlite",
  "include": ["src", "app", "database", "routes", "config", "docs"],
  "exclude": [
    "node_modules",
    "vendor",
    ".git",
    ".next",
    "dist",
    "build",
    "coverage",
    "storage",
    "logs",
    "tmp",
    ".kundun"
  ],
  "maxFileSizeKb": 512,
  "scanBinaryFiles": false,
  "enableDiagnostics": true,
  "enableAutoCleanup": true,
  "allowRestartFromMcp": false,
  "autoScan": {
    "enabled": false,
    "intervalMinutes": 10
  },
  "cleanup": {
    "deleteDeletedFilesAfterDays": 7,
    "deleteUnusedChunksAfterDays": 30,
    "deleteLowImportanceMemoriesAfterDays": 60,
    "archiveCompletedTasksAfterDays": 30,
    "deleteLogsAfterDays": 14,
    "vacuumAfterCleanup": true
  },
  "desktop": {
    "enabled": true,
    "minimizeToTray": true,
    "startWithWindows": false,
    "localApiHost": "127.0.0.1",
    "localApiPort": 37373
  },
  "languages": {
    "php": true,
    "go": true,
    "typescript": true,
    "javascript": true,
    "csharp": true,
    "cpp": true,
    "sql": true
  }
}
```

Um exemplo **mínimo** equivalente, apenas com o que difere dos padrões:

```json
{
  "projectName": "meu-projeto",
  "include": ["src", "app", "tests"],
  "languages": {
    "php": false
  }
}
```

## Veja também

- [Visão geral / Documentação](/pt-br/) — índice da documentação.
- [Primeiros passos](/pt-br/getting-started/) — instalação e primeiro `kundun init`.
- [Scanner e indexação](/pt-br/scanner-indexing/) — como `include`/`exclude`, arquivos
  sensíveis e linguagens afetam a varredura.
- [Limpeza](/pt-br/cleanup/) — como as políticas de `cleanup` são aplicadas.
