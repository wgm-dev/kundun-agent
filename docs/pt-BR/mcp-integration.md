# Integração MCP (Claude Code, Codex, Cursor…)

O Kundun-Agent inclui um **servidor MCP** para que agentes de programação
compatíveis com MCP possam chamar seus recursos de indexação, busca, memória,
tarefas, diagnósticos e resumo como ferramentas (tools). O servidor fala o
Model Context Protocol via **stdio**.

## 1. Compile o projeto

```bash
npm install
npm run build
```

Isso gera a CLI em `dist/cli/index.js`. O servidor MCP é iniciado pelo
subcomando `kundun mcp`.

## 2. Inicialize seu projeto uma vez

O servidor MCP opera sobre um projeto **inicializado** (precisa do diretório
`.kundun/` e do banco SQLite). No projeto que você quer indexar:

```bash
node /caminho/abs/para/kundun-agent/dist/cli/index.js --project-root . init
node /caminho/abs/para/kundun-agent/dist/cli/index.js --project-root . scan
```

(Se você rodar `npm link` no pacote, pode usar `kundun init` / `kundun scan`.)

## 3. Adicione ao Claude Code

Adicione uma entrada na configuração de servidores MCP. O servidor roda via
stdio, então o comando é `node <dist/cli/index.js> mcp`. Aponte o
`--project-root` para o projeto sobre o qual o Kundun deve operar:

```json
{
  "mcpServers": {
    "kundun-agent": {
      "command": "node",
      "args": [
        "/caminho/abs/para/kundun-agent/dist/cli/index.js",
        "--project-root",
        "/caminho/abs/para/seu/projeto",
        "mcp"
      ]
    }
  }
}
```

No Windows, use barras invertidas escapadas no JSON:

```json
{
  "mcpServers": {
    "kundun-agent": {
      "command": "node",
      "args": [
        "E:\\github-project\\kundun-agent\\dist\\cli\\index.js",
        "--project-root",
        "C:\\caminho\\para\\seu\\projeto",
        "mcp"
      ]
    }
  }
}
```

> A flag global `--project-root` deve vir **antes** do subcomando `mcp`, como
> mostrado. Se omitida, o servidor usa o diretório de trabalho atual.

Depois de salvar a configuração, reinicie o Claude Code. O servidor
`kundun-agent` deve conectar e expor suas ferramentas.

## 4. Ferramentas disponíveis

O servidor registra **18 ferramentas** (veja a
[especificação completa](../../README.md) §18 para os formatos de entrada):

| Ferramenta                       | Finalidade                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `kundun.scan_project`            | Escaneia e indexa arquivos novos/alterados                                            |
| `kundun.search_code`             | Busca no código indexado (FTS5 ou LIKE)                                               |
| `kundun.get_file_context`        | Metadados do arquivo + chunks + símbolos + memórias/tarefas/diagnósticos relacionados |
| `kundun.find_symbol`             | Encontra classes/funções/métodos por nome                                             |
| `kundun.add_memory`              | Armazena uma memória do projeto                                                       |
| `kundun.search_memory`           | Busca memórias                                                                        |
| `kundun.list_important_memories` | Lista as memórias mais importantes                                                    |
| `kundun.create_task`             | Cria uma tarefa                                                                       |
| `kundun.next_task`               | Retorna a próxima tarefa acionável                                                    |
| `kundun.update_task`             | Atualiza uma tarefa                                                                   |
| `kundun.run_diagnostics`         | Executa diagnósticos heurísticos                                                      |
| `kundun.cleanup`                 | Aplica a política de retenção (suporta `dryRun`)                                      |
| `kundun.project_summary`         | Visão geral do projeto                                                                |
| `kundun.get_sessions`            | Sessões (vazio até um milestone futuro)                                               |
| `kundun.get_health`              | Snapshot de saúde calculado                                                           |
| `kundun.get_metrics`             | Métricas calculadas a partir das contagens atuais                                     |
| `kundun.get_recent_events`       | Eventos recentes em memória                                                           |
| `kundun.restart_daemon`          | Desativado a menos que `allowRestartFromMcp` seja true                                |

## 5. Resources disponíveis

O servidor também expõe **8 resources** (somente leitura):

```
kundun://project/summary
kundun://project/memories
kundun://project/tasks
kundun://project/diagnostics
kundun://project/recent-changes
kundun://project/sessions
kundun://project/health
kundun://project/metrics
```

## 6. Observações e solução de problemas

- **A stdout é reservada para o protocolo.** Todos os logs vão para a stderr;
  nunca redirecione a stdout do servidor para outro lugar que não seja o cliente
  MCP.
- **"Kundun is not initialized"** — rode `init` e `scan` na raiz do projeto
  (passo 2) antes de iniciar o servidor.
- **Nada sai da sua máquina.** O servidor é local-first; arquivos sensíveis são
  ignorados e seu conteúdo nunca é armazenado nem retornado.
- **Algumas ferramentas são placeholders** (`get_sessions`, partes de
  `get_metrics`) até o milestone de daemon/health/métricas; elas retornam
  payloads vazios seguros com uma nota, em vez de falhar.

## Veja também

- [Hub de documentação](../README.md)
- [Referência da CLI](cli-reference.md)
- [Segurança](security.md)
