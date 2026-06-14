---
title: Instalação e configuração de clientes MCP
description: Guia para instalar o Kundun-Agent e registrá-lo como servidor MCP no Claude Code, no Codex e no Gemini CLI.
---

Este guia mostra como instalar o Kundun-Agent e registrá-lo como servidor MCP no
Claude Code, no Codex e no Gemini CLI.

## 1. Instalar

```bash
# Instalação global (disponibiliza o comando `kundun` em qualquer pasta):
npm install -g kundun-agent

# Ou use sem instalar, sob demanda:
npx kundun-agent --help
```

> No Windows, o `npm install -g` coloca o binário em
> `%APPDATA%\npm` (já no PATH). Abra um terminal NOVO após instalar para que o
> comando `kundun` seja reconhecido.

## 2. Inicializar o projeto (uma vez por projeto)

O servidor MCP opera sobre um projeto **inicializado e indexado**:

```bash
cd /caminho/do/seu/projeto
kundun init
kundun scan
```

`init` cria `.kundun/` (config + banco SQLite). `scan` indexa o código. Sem esse
passo, o servidor MCP responde com um erro de "não inicializado".

## 3. Registrar como servidor MCP

Todos os exemplos abaixo usam `kundun --project-root <caminho> mcp`. Se o comando
`kundun` não estiver no PATH do cliente, troque por `npx -y kundun-agent` (mostro
a variante em cada caso). Em arquivos JSON/TOML no Windows, escape as barras
invertidas (`\\`).

### Claude Code

Pela CLI (forma mais rápida):

```bash
# Apenas o projeto atual:
claude mcp add kundun-agent -- kundun --project-root "C:\\meu\\projeto" mcp

# Para todos os seus projetos (escopo de usuário):
claude mcp add --scope user kundun-agent -- kundun --project-root "C:\\meu\\projeto" mcp

# Variante npx (não depende do `kundun` no PATH):
claude mcp add kundun-agent -- npx -y kundun-agent --project-root "C:\\meu\\projeto" mcp
```

Tudo depois de `--` é o comando do servidor stdio. Use `--scope project` para
gravar num `.mcp.json` versionado (compartilhado pelo time).

Equivalente em JSON (`.mcp.json` no projeto, ou `~/.claude.json` para usuário):

```json
{
  "mcpServers": {
    "kundun-agent": {
      "type": "stdio",
      "command": "kundun",
      "args": ["--project-root", "C:\\meu\\projeto", "mcp"]
    }
  }
}
```

### Codex (OpenAI Codex CLI)

Pela CLI:

```bash
codex mcp add kundun-agent -- kundun --project-root "C:\\meu\\projeto" mcp
```

Equivalente em TOML (`~/.codex/config.toml`):

```toml
[mcp_servers.kundun-agent]
command = "kundun"
args = ["--project-root", "C:\\meu\\projeto", "mcp"]
```

A tabela é `[mcp_servers.<nome>]`; `command` e `args` são separados. Para a
variante npx use `command = "npx"` e
`args = ["-y", "kundun-agent", "--project-root", "C:\\meu\\projeto", "mcp"]`.

### Gemini CLI (Google)

Pela CLI (atenção: o Gemini **não** usa o separador `--`):

```bash
gemini mcp add kundun-agent kundun --project-root "C:\\meu\\projeto" mcp
```

Equivalente em JSON (`~/.gemini/settings.json` ou `.gemini/settings.json`):

```json
{
  "mcpServers": {
    "kundun-agent": {
      "command": "kundun",
      "args": ["--project-root", "C:\\meu\\projeto", "mcp"],
      "timeout": 600000
    }
  }
}
```

## 4. Verificar

Reinicie o cliente e peça a ele para listar as ferramentas MCP. Você deve ver as
18 ferramentas `kundun.*` (busca de código, memória, tarefas, diagnósticos,
saúde…). Veja o que cada uma faz no guia de
[integração MCP](/pt-br/mcp-integration/).

## Resumo das diferenças

| Cliente     | CLI                                 | Arquivo de config              | Usa `--`? |
| ----------- | ----------------------------------- | ------------------------------ | --------- |
| Claude Code | `claude mcp add nome -- kundun ...` | `.mcp.json` / `~/.claude.json` | Sim       |
| Codex       | `codex mcp add nome -- kundun ...`  | `~/.codex/config.toml`         | Sim       |
| Gemini CLI  | `gemini mcp add nome kundun ...`    | `~/.gemini/settings.json`      | Não       |

## Problemas comuns

- **`'kundun' não é reconhecido`** — você instalou localmente (num projeto), não
  globalmente. Rode `npm install -g kundun-agent` e abra um terminal novo. Ou use
  a variante `npx -y kundun-agent ...` nas configs, que não depende do PATH.
- **O cliente não acha o comando `kundun`** — alguns lançadores têm um PATH
  próprio. Use a variante `npx` (acima) ou aponte para o caminho absoluto do
  binário.
- **"Kundun is not initialized"** — rode `kundun init` e `kundun scan` na raiz do
  projeto antes de iniciar o servidor.
- **Primeira execução lenta com `npx`** — o npx baixa o pacote na primeira vez;
  aumente o timeout do cliente se necessário.

## Veja também

- [Hub de documentação](/pt-br/)
- [Integração MCP (as 18 ferramentas)](/pt-br/mcp-integration/)
- [Dashboard web](/pt-br/dashboard/)
- [Primeiros passos](/pt-br/getting-started/)
