---
title: Segurança
description: O Kundun-Agent é uma camada de inteligência de projeto local-first; esta página descreve o modelo de segurança completo do MVP1.
---

O Kundun-Agent é uma camada de inteligência de projeto **local-first**: ele
indexa seu código, guarda memória persistente e serve contexto para agentes de
codificação, tudo localmente em SQLite. Esta página descreve o modelo de
segurança completo do MVP1 e mostra como **você mesmo** pode verificar a garantia
de que segredos nunca vazam para o índice.

O princípio que orienta todas as decisões abaixo é simples: por padrão, o
Kundun-Agent é conservador. Ele não fala com a rede, não executa nada e não sai
da raiz do projeto.

## Local-first: nada sai para APIs externas por padrão

Por padrão, **nenhum conteúdo do projeto é enviado para APIs externas**. Toda a
indexação, a busca, a memória e as tarefas ficam em um único banco SQLite dentro
de `.kundun/` na raiz do seu projeto.

- A busca usa SQLite FTS5 (ranqueamento bm25) com um fallback `like` — tudo
  local. Não há embeddings externos no MVP1; existe apenas um stub de provedor
  de embeddings futuro (`future-embedding-provider`), inativo.
- Os dados ficam em `.kundun/kundun.sqlite` e nos subdiretórios `cache/`,
  `logs/`, `snapshots/` e `runtime/`.

Como nada é transmitido, sua base de código não é exposta a serviços de terceiros
só por usar o Kundun-Agent.

## Sem execução de código ou de comandos

O Kundun-Agent **não executa código do projeto** e **não executa comandos
arbitrários** em nome de um agente.

- O indexador apenas **lê** arquivos de texto. Os extratores de símbolos são
  baseados em **regex por linguagem** — eles **nunca executam** o código que
  analisam.
- Os extratores também são contidos: se um deles falhar em um arquivo, o erro
  fica isolado naquele arquivo e a indexação continua, sem quebrar.

Em outras palavras, indexar um repositório não roda scripts de build, hooks,
nem nenhum trecho do código analisado.

## Contenção na raiz, bloqueio de traversal e nada de symlinks

O scanner foi projetado para **nunca sair da raiz do projeto**:

- **Nunca lê arquivos fora da raiz do projeto.**
- **Bloqueia path traversal e escape da raiz.** Caminhos que tentam subir acima
  da raiz do projeto são rejeitados.
- **Não segue symlinks.** Há uma verificação de symlink **por segmento de
  caminho**, de modo que um link no meio do caminho não consegue apontar a
  indexação para fora da raiz.
- **Respeita `include`/`exclude`** (globs da configuração) e o `.gitignore` da
  raiz do projeto.

A raiz do projeto é a pasta atual por padrão, ou o valor passado em
`--project-root`:

```bash
kundun scan --project-root /caminho/para/o/projeto
```

## Tratamento de arquivos sensíveis: conteúdo NUNCA armazenado

Esta é a garantia central de segurança. Arquivos sensíveis são detectados e
**pulados** durante a indexação, com o motivo de skip `sensitive_file`.

O que isso significa exatamente:

- Uma linha em `files` **pode** ser registrada para o arquivo sensível,
  contendo apenas o **caminho** e o **hash** — usados para rastrear deleção e
  mudança.
- O **conteúdo nunca é armazenado**: não há chunks em `file_chunks`, não há
  símbolos em `symbols`, não há texto na tabela FTS. Nada do conteúdo fica
  pesquisável.

Os padrões considerados sensíveis incluem, entre outros:

```
.env, .env.*, *.pem, *.key, *.pfx, *.p12, **/secrets/**, *secret*,
*credential*, id_rsa, .aws/credentials, *.tfstate, dumps de banco de dados
```

Para referência, os motivos de skip possíveis do scanner são: `sensitive_file`,
`excluded`, `gitignored`, `binary`, `too_large` e `not_included`.

## Como verificar a garantia você mesmo

Você não precisa confiar na palavra da documentação. Você pode comprovar que o
conteúdo de um arquivo sensível nunca chega ao índice. O roteiro abaixo cria um
`.env` falso com um valor único, roda o scan e mostra que esse valor não aparece
em lugar nenhum do banco.

1. Crie um arquivo sensível com um marcador fácil de buscar, na raiz do projeto:

```bash
echo "API_SECRET=KUNDUN_LEAK_CANARY_123" > .env
```

2. Rode o scan. Use `--force` para garantir que o arquivo seja avaliado:

```bash
kundun scan --force
```

A saída deve contabilizar o `.env` em `skipped`, não em `indexed`.

3. Confirme que o marcador **não** está em nenhum chunk indexado, usando a
   própria busca do Kundun-Agent:

```bash
kundun search "KUNDUN_LEAK_CANARY_123"
```

Não deve haver nenhum resultado: o conteúdo do `.env` nunca foi armazenado.

4. (Opcional) Inspecione o banco diretamente para ter certeza absoluta. O valor
   não deve existir em `file_chunks` (nem na tabela FTS):

```bash
sqlite3 .kundun/kundun.sqlite \
  "SELECT count(*) FROM file_chunks WHERE content LIKE '%KUNDUN_LEAK_CANARY_123%';"
```

O resultado deve ser `0`. Você pode ver que o `.env` aparece em `files` (apenas
caminho e hash), mas sem nenhum chunk associado:

```bash
sqlite3 .kundun/kundun.sqlite \
  "SELECT relative_path FROM files WHERE relative_path = '.env';"
```

5. Limpe o arquivo de teste ao terminar:

```bash
rm .env
kundun scan
```

> Nota: o nome exato das colunas pode variar conforme a versão do esquema; a
> garantia que importa é a do passo 3 — o marcador nunca retorna na busca,
> porque o conteúdo do arquivo sensível nunca é indexado.

## Resumo do modelo de segurança

- **Local-first**: nenhum conteúdo do projeto é enviado a APIs externas por
  padrão.
- **Sem execução**: não roda código do projeto nem comandos arbitrários.
- **Contenção na raiz**: nunca lê fora da raiz, bloqueia path traversal, não
  segue symlinks.
- **Arquivos sensíveis**: pulados na indexação; apenas caminho e hash podem ser
  rastreados, e o **conteúdo nunca é armazenado**.

Para a política de segurança do projeto e como reportar uma vulnerabilidade de
forma privada, consulte [`SECURITY.md`](https://github.com/wgm-dev/kundun-agent/blob/main/SECURITY.md).

## Veja também

- [README da documentação](/pt-br/) — índice de todas as páginas.
- [Scanner e indexação](/pt-br/scanner-indexing/) — motivos de skip, detecção por
  hash e tratamento de arquivos sensíveis em detalhe.
- [Configuração](/pt-br/configuration/) — chaves `include`, `exclude`,
  `maxFileSizeKb` e `scanBinaryFiles`.
