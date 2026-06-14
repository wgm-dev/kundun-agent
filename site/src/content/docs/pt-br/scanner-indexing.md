---
title: Scanner e Indexação
description: O Kundun-Agent constrói seu índice de código em duas etapas complementares — um scanner incremental e um indexador. Ambos rodam com kundun scan.
---

O Kundun-Agent constrói seu índice de código em duas etapas complementares: um
**scanner incremental**, que descobre quais arquivos mudaram e os mantém
sincronizados com o banco de dados, e um **indexador**, que lê o conteúdo dos
arquivos de texto, divide-os em pedaços (chunks), extrai símbolos e calcula uma
pontuação de importância. Ambos rodam quando você executa `kundun scan`.

```bash
kundun scan            # detecta novos/alterados/removidos e indexa o necessário
kundun scan --force    # reindexa todos os arquivos rastreados
```

Cada execução grava uma linha em `scan_runs` e imprime um resumo com os
contadores `scanned`, `new`, `changed`, `removed`, `skipped` e `indexed`.

## Como o scanner incremental funciona

O scanner percorre a raiz do projeto e decide, para cada caminho, em qual estado
ele está. A decisão é baseada em **hash**, não em data de modificação, o que
torna a detecção confiável mesmo quando timestamps são pouco confiáveis (clones,
checkouts, sincronização de arquivos).

### Detecção de mudanças por hash

Para cada arquivo elegível o scanner calcula um `sha256` do conteúdo e compara
com o hash armazenado na tabela `files`:

- **new** — o caminho ainda não existe em `files`. O arquivo é registrado e
  enviado ao indexador.
- **changed** — o caminho já existe, mas o `sha256` mudou. O arquivo é
  reindexado.
- **removed** — o caminho está em `files`, mas não foi mais encontrado no disco.
  A linha é marcada com `is_deleted=1` (o registro é mantido para que a limpeza
  possa removê-lo depois, conforme a retenção configurada).
- **skipped** — o arquivo foi visto, mas não indexado por algum motivo (veja
  [Motivos de skip](#motivos-de-skip)).
- **indexed** — total de arquivos `new` + `changed` cujo conteúdo foi
  efetivamente processado pelo indexador nesta execução.

Com `--force`, todos os arquivos rastreados são reindexados, ignorando a
comparação de hash. Isso é útil após mudar a configuração de linguagens ou após
uma atualização do indexador.

### Motivos de skip

Quando um arquivo é pulado, o scanner registra o motivo. Os valores possíveis
são:

- `sensitive_file` — arquivo sensível; o conteúdo **nunca** é armazenado (veja
  [Segurança](#seguranca-e-garantias).)
- `excluded` — bate com um padrão de `exclude` da configuração.
- `gitignored` — ignorado pelo `.gitignore` da raiz do projeto.
- `binary` — detectado como binário (com `scanBinaryFiles: false`).
- `too_large` — maior que `maxFileSizeKb` (padrão `512` KB).
- `not_included` — não está coberto por nenhum padrão de `include`.

## Segurança e garantias {#seguranca-e-garantias}

O scanner foi projetado para ser seguro por padrão e nunca sair da raiz do
projeto:

- **Não segue symlinks.** Há uma verificação de symlink por segmento de caminho,
  evitando que um link aponte para fora da raiz.
- **Bloqueia path traversal e escape da raiz.** Caminhos que tentam subir além
  da raiz do projeto são rejeitados.
- **Nunca lê fora da raiz do projeto.**
- **Respeita `include`/`exclude`** (globs da configuração) e o `.gitignore` da
  raiz.
- **Pula binários** e **arquivos maiores que `maxFileSizeKb`**.

### Arquivos sensíveis

Arquivos sensíveis são detectados e pulados com o motivo `sensitive_file`. Uma
linha em `files` (com caminho e hash) **pode** ser rastreada para fins de
controle de deleção, mas o **conteúdo nunca é armazenado** — não há chunks, não
há texto indexado, nada pesquisável.

Os padrões considerados sensíveis incluem, entre outros:

```
.env, .env.*, *.pem, *.key, *.pfx, *.p12, **/secrets/**, *secret*,
*credential*, id_rsa, .aws/credentials, *.tfstate, dumps de banco de dados
```

## Indexador

Após o scanner selecionar os arquivos `new` e `changed`, o indexador processa
**apenas arquivos de texto**. Ele nunca executa código do projeto e foi escrito
para nunca quebrar a indexação: se um extrator de símbolos falhar em um arquivo,
o erro é contido e a indexação continua.

### Detecção de linguagem

A linguagem é detectada pela **extensão** do arquivo. As linguagens suportadas
no MVP1 e suas extensões são:

| Linguagem    | Extensões                                        |
| ------------ | ------------------------------------------------ |
| `php`        | `.php`                                           |
| `go`         | `.go`                                            |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts`                    |
| `javascript` | `.js`, `.jsx`, `.mjs`, `.cjs`                    |
| `csharp`     | `.cs`                                            |
| `cpp`        | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.h`, `.c` |
| `sql`        | `.sql`                                           |

Cada linguagem pode ser habilitada/desabilitada na seção `languages` de
`kundun.config.json` (todas vêm habilitadas por padrão).

### Chunking por intervalo de linhas

O conteúdo é dividido em **chunks por intervalo de linhas** (padrão de 200
linhas por chunk). Cada chunk tem linhas de início e fim **inclusivas e baseadas
em 1** (`start`/`end`), preservando a posição original no arquivo — é por isso
que a busca consegue mostrar `relativePath:line`.

Para cada chunk é calculado um `sha256`. **Chunks idênticos dentro de um mesmo
arquivo são deduplicados**, evitando armazenar repetições do mesmo trecho.

### Extração de símbolos

O indexador extrai símbolos básicos (por exemplo, `function`, `class`) usando
**extratores baseados em regex por linguagem**. Esses extratores:

- **nunca executam código** do projeto;
- **nunca quebram a indexação** — falhas são contidas por arquivo.

Os símbolos extraídos ficam na tabela `symbols` e podem ser consultados com:

```bash
kundun symbol <name> [--language <language>] [--kind <kind>] [--prefix]
```

### Pontuação de importância

Cada arquivo recebe uma **pontuação de importância de 0 a 100**, usada para
priorizar resultados e contexto (por exemplo, no `kundun summary`). A pontuação é
heurística e segue listas de alta e baixa importância:

- **Alta importância:** controllers, services, repositories, routes, middleware,
  migrations, schema SQL, auth, payments, security, domínio (`domain`), testes e
  arquivos de configuração.
- **Baixa importância:** assets, CSS gerado, lockfiles, snapshots, código
  minificado, artefatos de build, cache e logs.

## Índice de busca (FTS5)

Quando o SQLite tem FTS5 disponível, o indexador atualiza a tabela virtual
`chunks_fts` à medida que os chunks são gravados, habilitando busca por texto
completo com ranqueamento bm25. Sem FTS5, a busca recai para um modo `like`. O
modo ativo é mostrado no rodapé da saída de `kundun search`. Veja
[Busca](/pt-br/search/) para detalhes.

## Veja também

- [README da documentação](/pt-br/) — índice de todas as páginas.
- [Configuração](/pt-br/configuration/) — chaves `include`, `exclude`,
  `maxFileSizeKb`, `scanBinaryFiles` e `languages`.
- [Busca](/pt-br/search/) — como consultar os chunks indexados e os modos
  `fts5`/`like`.
