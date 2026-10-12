# tablehub-agent-automation

Despachante contínuo e monitor dos agentes do Claude Code. Visão geral, configuração e comandos: `README.md`.

## Fluxo de trabalho (obrigatório)
- **Nunca commitar direto na `main`.** Toda mudança vai em branch + PR.
- **Commits e PRs são feitos pela conta bot do GitHub** (`gui-dev-bot`); o dono (@guilanfredi) só revisa e aprova.
  Antes de commitar, confira `git config user.name` / `user.email` e `gh auth status`. Se não estiver configurado, pare e peça ao usuário.
- Este repositório é **público**: nada de tokens, caminhos com dados pessoais ou logs em commits.

## Código
- Node 20+, ES modules (`.mjs`), **sem dependências de produção** (só `vitest` para testes).
- `src/dispatcher/`: `index.mjs` (processo contínuo), `select.mjs` (regras puras de escolha), `project.mjs`
  (`.agents/config.json`), `config.mjs` (`config.local.json`), `github.mjs` (API com ETag), `proc.mjs` (processos no Windows).
- `src/monitor/`: `hook.mjs` (copiado para `~/.claude/monitor/` pelo `install.mjs`; não pode importar nada do repositório),
  `data.mjs`, `dashboard.mjs` (ANSI puro) e `agentes.mjs`.
- Lógica nova vai em funções puras com teste ao lado (`*.test.mjs`). O que depende de Windows/GitHub fica fino em volta delas.
- Nada específico de um projeto no código: o que for do projeto vai para o `.agents/` dele.
- Textos de interface, logs e mensagens de erro em português.

## Comandos
```bash
npm test
npm run despachante:teste    # dry-run contra o GitHub real (só leitura)
npm run agentes -- --texto
```
