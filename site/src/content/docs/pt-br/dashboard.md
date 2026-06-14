---
title: Dashboard Web
description: O Kundun Control Center é uma pequena interface web para o daemon local — arquivos estáticos servidos pela própria API HTTP local, sem framework nem build.
---

O **Kundun Control Center** é uma pequena interface web para o daemon local. São
arquivos estáticos (HTML, CSS e JavaScript puro — sem framework, sem etapa de
build) empacotados junto com o produto e servidos pela própria API HTTP local, de
modo que você tem uma UI sem precisar de nenhuma ferramenta adicional.

A casca da interface é pública; os **dados** que ela exibe continuam exigindo o
token da API. Você cola o token na página uma vez e a UI o envia como cabeçalho
`Bearer` em cada requisição de dados (e como `?token=` no fluxo de eventos via
WebSocket).

## Início rápido

1. **Inicie o daemon** a partir da raiz do seu projeto:

   ```bash
   kundun daemon
   ```

   O daemon imprime a URL da API e a URL do dashboard:

   ```text
   Kundun daemon listening on http://127.0.0.1:37373
   Dashboard: http://127.0.0.1:37373/
   Paste the token from .kundun/runtime/token in the UI to unlock data.
   pid 12345 — Ctrl+C to stop
   ```

2. **Abra o dashboard** no navegador:
   [http://127.0.0.1:37373/](http://127.0.0.1:37373/)

   A porta padrão é `37373` (configurável via `desktop.localApiPort`).

3. **Cole o token.** Abra `.kundun/runtime/token` no seu projeto, copie o token
   (uma única linha) e cole no campo no topo do dashboard. O token é gerado na
   primeira execução do daemon e armazenado com permissões restritas; ele nunca é
   registrado em log. Com o token preenchido, os painéis de dados são liberados.

## O que o dashboard mostra

- **Saúde (health)** — o status de saúde calculado e os eventos de saúde
  recentes.
- **Sessões** — as sessões de agentes/ferramentas registradas e seu estado.
- **Métricas** — o último snapshot de métricas do projeto.
- **Eventos ao vivo** — um fluxo de eventos enviados pelo WebSocket (`/events`) à
  medida que scans, limpezas e mudanças de saúde acontecem.
- **Ações** — botões protegidos por token para disparar um scan, uma limpeza ou um
  diagnóstico, e para reiniciar o servidor MCP no próprio processo.

## Notas de segurança

- A API local (e, portanto, o dashboard) escuta apenas em loopback (`127.0.0.1` /
  `::1`). Ela se recusa a escutar em qualquer outro endereço.
- A origem loopback é exigida em toda requisição e em todo upgrade de WebSocket,
  antes da autenticação.
- O dashboard estático é isolado (sandbox) em seu próprio diretório: path
  traversal, escapes absolutos e bytes NUL são rejeitados, não há listagem de
  diretórios e apenas `GET`/`HEAD` são servidos. `/` serve o `index.html`.
- Os endpoints de leitura são públicos, exceto `/logs`; todas as ações que alteram
  estado e o WebSocket exigem o token.

## Executando sem o dashboard

Se você quiser apenas a API e não a UI estática, inicie o daemon com
`--no-dashboard`:

```bash
kundun daemon --no-dashboard
```

O serviço de arquivos estáticos fica então totalmente desativado e as rotas da API
continuam funcionando normalmente.

## Veja também

- [Documentação do Kundun-Agent (hub)](/pt-br/)
- [Primeiros passos](/pt-br/getting-started/)
- [Configuração](/pt-br/configuration/)
- [Segurança](/pt-br/security/)
