# tablehub-agent-automation

Automação local do time de agentes do Claude Code, separada dos projetos que ela atende:

- **Despachante** (`src/dispatcher/`): fica rodando e consulta o GitHub dos projetos a cada 15 s. Quando uma issue/PR
  espera uma função (etiqueta de fase), roda `claude -p "/<função> <n>"` num worktree dedicado, com até 3 execuções
  em paralelo e portas próprias para cada uma. Parado, não gasta cota da assinatura.
- **Monitor** (`src/monitor/`): dashboard de terminal, no estilo `pm2 monit`, com todas as sessões do Claude Code da
  máquina (app desktop, terminal e despachante), alimentado por hooks, e o consumo dos limites da assinatura.
- **Relatório** (`src/report/`): execuções dos agentes num dia, com tokens, tempo, turnos, custo equivalente e falhas.

Hoje atende o [TableHub](https://github.com/guilanfredi/tablehub), mas qualquer projeto com um `.agents/config.json` pode ser incluído.

## Instalação (Windows)
1. **Node 20+**, **GitHub CLI** com a conta bot ativa (`gh auth status`) e **login do Claude Code CLI**. O CLI embutido no
   app desktop tem login próprio; para fazer o login, no PowerShell:
   ```powershell
   & (Get-ChildItem "$env:APPDATA\Claude\claude-code\*\*\claude.exe" | Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1).FullName
   ```
   Dentro dele, rode `/login` e saia com `/exit`.
2. Clone este repositório (ex.: `D:\dev\tablehub-agent-automation`) e rode `npm ci`.
3. Copie `config.example.json` para `config.local.json` e ajuste os caminhos das cópias principais dos projetos.
4. Confira sem executar nada: `npm run despachante:teste`.
5. Instale no Agendador (inicia no logon, reinicia se cair e remove a tarefa antiga "TableHub Agentes"): `npm run agendador:instalar`.
6. Monitor: `npm run monitor:instalar` (hooks em `~/.claude/settings.json`) e depois `npm run agentes`.

## Configuração
**Da máquina** — `config.local.json` (fora do git):

| Campo | Padrão | O que é |
|---|---|---|
| `projects` | — | Caminhos das cópias principais. Pode ser `"D:/dev/X"` ou `{ "path": "...", "branch": "main" }` |
| `maxTotal` | 3 | Execuções em paralelo, somando todos os projetos |
| `pollSeconds` | 15 | Intervalo da consulta ao GitHub (com ETag: "nada mudou" não gasta o limite da API) |

**De cada projeto** — `.agents/` no repositório do projeto, lido de `origin/<branch>`. Só vale o que já foi revisado e
mergeado; a cópia de trabalho não importa. O despachante relê a cada 10 min.

```jsonc
// .agents/config.json
{
  "id": "tablehub",                         // nome curto (logs, estado, monitor)
  "repo": "guilanfredi/tablehub",
  "owner": "guilanfredi",                   // quem aprova e responde dúvidas
  "bot": { "login": "gui-dev-bot", "email": "...@users.noreply.github.com" },
  "labels": { "working": "agente:trabalhando", "waiting": "aguardando-dono" },
  "roles": [                                // ordem = prioridade
    { "name": "revisor", "label": "fase:review", "timeoutMin": 30, "prOnly": true },
    { "name": "dev", "label": "fase:dev", "timeoutMin": 120 }
  ],
  "maxPerRole": { "revisor": 1 },           // opcional
  "worktreesDir": "../TableHub-agents",     // relativo ao projeto
  "addDirs": ["manuals"],                   // pastas extras liberadas para leitura (--add-dir)
  "setup": { "command": "npm ci --no-audit --no-fund", "whenChanged": "package-lock.json" },
  "ports": { "TABLEHUB_WEB_PORT": 5200 }    // variável → base; faixa N recebe base + N
}
```
- `.agents/roles/<função>.json`: permissões do Claude Code da função (passadas com `--settings`). É obrigatório.
- `.agents/prompt.md`: instruções extras do projeto para o modo automático. É opcional.
- O comando é `/<função> <número>`: o projeto precisa ter uma skill com o nome de cada função.

## Como funciona
1. A cada consulta, junta as tarefas de todos os projetos. Em cada projeto, vale a ordem das funções e, dentro da mesma
   fase, vai primeiro o item parado há mais tempo. As vagas são divididas entre os projetos, um de cada por vez.
2. Ignora tarefas com a etiqueta `working`, as que não foram criadas pelo dono ou pelo bot (repositórios públicos), e as com
   `waiting` até o dono comentar.
3. Cada execução tem um worktree `<worktreesDir>/<função>-<n>` (limpo, na branch principal; `setup` quando o arquivo
   observado muda) e uma faixa de portas própria. As faixas são globais, então dois projetos nunca colidem.
4. Marca a etiqueta `working`, roda a função com tempo máximo e, ao terminar, encerra processos que sobraram e
   consulta de novo na hora. Se estourar o tempo, comenta e marca `waiting`.
5. Execução que termina sem avançar a fase espera 10 min antes de tentar de novo. Depois de 3 seguidas, chama o dono.
6. Login expirado pausa novos inícios por 1 h; limite de uso da assinatura, por 30 min.
7. Se o despachante cair, volta a acompanhar as execuções em andamento e remove etiquetas `working` que ficaram sem execução.

As variáveis `CLAUDE_AGENT_TASK` e `CLAUDE_AGENT_PROJECT` identificam a execução no monitor.

## Comandos
```bash
npm run despachante          # em primeiro plano, com o log no terminal (Ctrl+C para parar)
npm run despachante:teste    # o que seria executado agora (--only <função>, --max <n>)
npm run agentes              # dashboard (--texto, --json, --todas para scripts)
npm run relatorio            # relatório de hoje (--ontem, --data AAAA-MM-DD, --markdown, --json)
npm run agendador:instalar   # ou agendador:remover
npm run monitor:instalar     # ou monitor:remover
npm test
```

## Limites da assinatura
O dashboard (`npm run agentes`) mostra numa faixa abaixo do cabeçalho o uso da **sessão de 5 h**, do **semanal** e o
**uso extra** do mês, com data, hora e contagem regressiva até o reset. Ele atualiza a cada 60 s; o `--texto`, o `--json`
e o relatório também trazem esses dados.
- Fonte: o mesmo endpoint que o `/usage` do Claude Code consulta (`api.anthropic.com/api/oauth/usage`), com o token OAuth de
  `~/.claude/.credentials.json`. **É interno e não documentado**: se mudar ou falhar, aparece "limites indisponíveis" e o resto funciona.
- O token **nunca é renovado** aqui (isso derrubaria o login do Claude Code), não é gravado e só vai para `api.anthropic.com`.
  Login vencido → abra o Claude Code, que renova sozinho.
- O semanal na faixa vermelha (≥ 90%) é o sinal para diminuir o `maxTotal`.

## Relatório
`npm run relatorio` mostra as execuções de um dia (hoje, por padrão):
- **limites atuais**;
- **resumo**: execuções por resultado, tempo total e médio, turnos, tokens (entrada, gravação/leitura de cache, saída,
  raciocínio) e custo **equivalente na API** (na assinatura não é cobrado; serve para comparar funções e dias);
- tabelas **por função** e **por projeto**;
- **lista de execuções**, com o resumo da resposta de cada agente, e as **falhas**.

| Opção | O que faz |
|---|---|
| `--ontem` / `--data AAAA-MM-DD` | outro dia |
| `--markdown` | Markdown com links para as issues/PRs |
| `--json` | dados brutos, para scripts ou uma tarefa agendada |

Resultados: `ok`, `sem-avanço` (terminou sem mudar a fase), `erro`, `timeout`, `saída-inesperada`, `falha-ao-iniciar`
e `em-andamento`. Fontes: `state/runs.jsonl` (gravado pelo despachante ao fim de cada execução), os JSON de
`logs/<projeto>/` e os logs do despachante antigo em `<projeto>/automation/logs/`.

## Logs e estado
- `logs/dispatcher.log`: uma linha por decisão. `logs/<projeto>/<data>-<função>-<n>.json`: saída completa de cada execução.
- `state/jobs.json`: execuções em andamento. `state/runs.jsonl`: execuções terminadas (uma linha cada).
  `state/history.json`: tentativas sem avanço. `state/paused-until.txt`: pausa.
- Monitor: `~/.claude/monitor/sessions/`, um JSON por sessão.

## Segurança
- O token do GitHub (conta bot, via `gh auth token`) fica só na memória do processo.
- As permissões de cada função ficam no projeto (`.agents/roles/`). Lá você nega merge, push na `main`, deploy, segredos etc.
- Comentários de terceiros são tratados como dados, não como instruções.
