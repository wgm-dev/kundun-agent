---
title: Busca
description: A busca permite que desenvolvedores e agentes de IA encontrem trechos de código indexados pelo Kundun-Agent sem precisar reler arquivos inteiros.
---

A busca permite que desenvolvedores e agentes de IA encontrem trechos de código
indexados pelo Kundun-Agent sem precisar reler arquivos inteiros. Ela opera sobre os
chunks já gravados no SQLite pelo indexador, então só retorna o que foi escaneado e
indexado (veja [Scanner e indexação](/pt-br/scanner-indexing/)).

Este documento cobre os dois modos de busca (FTS5 e LIKE), como saber qual está ativo,
o comando `kundun search` com `--language`/`--limit`, o formato de um resultado e a
abstração de provedores (incluindo o stub de provedor de embeddings para o futuro).

## Dois modos: FTS5 primário, LIKE como fallback

O Kundun-Agent usa o full-text search nativo do SQLite (**FTS5**) como mecanismo
principal de busca. Quando a build do SQLite expõe o FTS5, as consultas rodam contra as
tabelas virtuais `chunks_fts` e `memories_fts` com ranqueamento por **bm25**, o que dá
resultados mais relevantes no topo.

Quando o FTS5 **não** está disponível, a busca cai automaticamente para um **fallback
com LIKE** sobre os chunks. O fallback funciona em qualquer build do SQLite, mas não tem
o ranqueamento por relevância do FTS5.

> Na build padrão do `better-sqlite3` que acompanha o projeto, o FTS5 vem habilitado
> (SQLite 3.53), então normalmente o modo ativo é `fts5`.

Você não escolhe o modo manualmente — o Kundun-Agent detecta a capacidade do SQLite e
usa o melhor disponível. O modo escolhido é sempre reportado na saída do comando.

## Como saber qual modo está ativo

O rodapé da saída de `kundun search` mostra o modo de busca usado naquela consulta,
`fts5` ou `like`:

```
src/services/auth.service.ts:42
  export class AuthService {
src/routes/auth.routes.ts:8
  router.post('/login', authController.login)

search mode: fts5
```

O modo de busca também aparece em `kundun summary`, na visão geral somente-leitura do
projeto. Se você vir `like` onde esperava `fts5`, é sinal de que o SQLite em uso não foi
compilado com FTS5.

## O comando `kundun search`

```
kundun search <query> [--language <language>] [--limit <n>]
```

Busca nos chunks de código indexados e imprime cada acerto como `relativePath:line`
seguido de um snippet. O rodapé mostra o modo de busca (`fts5` ou `like`).

Exemplo básico:

```
kundun search "authenticate user"
```

### `--language`

Restringe os resultados a uma única linguagem. Use o nome da linguagem, não a extensão.
As linguagens suportadas são: `php`, `go`, `typescript`, `javascript`, `csharp`, `cpp`
e `sql`.

```
kundun search "router.post" --language typescript
```

### `--limit`

Limita o número de resultados retornados:

```
kundun search "select" --language sql --limit 5
```

### Opções globais

As opções globais valem aqui também. Use `--json` para obter JSON limpo em stdout (todos
os logs vão para stderr), útil para agentes que consomem a saída programaticamente; e
`--project-root <path>` para apontar para um projeto fora do diretório atual.

```
kundun search "payment" --language php --limit 10 --json
```

## Como é um resultado

Cada acerto é impresso como o caminho relativo do arquivo e a linha, seguido por um
snippet do chunk correspondente:

```
src/payments/charge.service.ts:128
  async createCharge(input: ChargeInput): Promise<Charge> {
```

- O caminho é **relativo** à raiz do projeto.
- A linha é **1-based** e aponta para o início do chunk relevante (o indexador divide os
  arquivos em chunks por faixa de linhas, com início/fim inclusivos e 1-based).
- Sob `fts5`, os resultados vêm ordenados por relevância (bm25); sob `like`, sem esse
  ranqueamento.
- O rodapé informa o modo de busca.

Lembre-se de que a busca só enxerga conteúdo indexado. Arquivos sensíveis (por exemplo
`.env`, `*.pem`, `*.key`, caminhos `**/secrets/**`) têm o conteúdo **nunca armazenado**,
então jamais aparecem nos resultados — apenas caminho e hash podem ser rastreados.
Rode `kundun scan` para manter o índice atualizado antes de buscar.

## A abstração de provedores

A busca é construída sobre uma abstração de provedores, de modo que o mecanismo concreto
fica desacoplado do comando. No MVP1 existem três provedores:

- **`sqlite-fts-provider`** — provedor primário; usa FTS5 com ranqueamento bm25.
- **`fallback-search-provider`** — usado quando o FTS5 não está disponível; faz a busca
  com LIKE.
- **`future-embedding-provider`** — um **stub** reservado para busca semântica baseada em
  embeddings. Ele **não** está implementado no MVP1.

Essa separação permite que o modo ativo (`fts5` ou `like`) seja escolhido em tempo de
execução conforme a capacidade do SQLite, sem mudar o comando ou o formato da saída.

> **Sem embeddings externos no MVP1.** O Kundun-Agent é local-first e, por padrão, não
> envia conteúdo do projeto para APIs externas. O `future-embedding-provider` é apenas um
> stub; nenhuma busca por embeddings está disponível neste milestone.

## Veja também

- [Scanner e indexação](/pt-br/scanner-indexing/) — como os arquivos são escaneados e divididos
  nos chunks que a busca consulta.
- [Referência da CLI](/pt-br/cli-reference/) — todos os comandos e flags.
- Hub da documentação: [`/pt-br/`](/pt-br/)
