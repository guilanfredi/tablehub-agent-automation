# tablehub-agent-automation

Automação local do time de agentes do Claude Code, separada dos projetos que ela atende.

> **Desde 23/10/2026 o time roda no [Paperclip](https://github.com/paperclipai/paperclip)**, que substituiu o despachante
> (veja a seção "Paperclip" logo abaixo). O despachante continua no repositório, desativado, caso seja preciso voltar.
> Monitor e relatório seguem valendo.

- **Paperclip** (`scripts/paperclip.ps1`, `paperclip/`): inicialização no Windows e configuração do time (agentes,
  modelos, instruções, projeto com worktree isolado por issue).
- **Despachante** (`src/dispatcher/`, **desativado**): consultava o GitHub a cada 15 s e, quando uma issue/PR esperava uma
  função (etiqueta de fase), rodava `claude -p "/<função> <n>"` num worktree dedicado.
- **Monitor** (`src/monitor/`): dashboard de terminal, no estilo `pm2 monit`, com todas as sessões do Claude Code da
  máquina (app desktop, terminal e despachante), alimentado por hooks, e o consumo dos limites da assinatura.
- **Relatório** (`src/report/`): execuções dos agentes num dia, com tokens, tempo, turnos, custo equivalente e falhas.

Hoje atende o [TableHub](https://github.com/guilanfredi/tablehub), mas qualquer projeto com um `.agents/config.json` pode ser incluído.

## Paperclip
O Paperclip roda localmente (servidor Node + Postgres embutido + interface web em http://127.0.0.1:3100) e organiza os
agentes como uma empresa: tarefas são **issues do Paperclip**, cada uma com um responsável e um **worktree isolado** do
repositório; as passagens entre funções usam **etapas de revisão** nativas.

**Instalar** (uma vez, e a cada troca de `$Version`). O instalador gerenciado (`paperclipai install`) falha no Windows
com `spawn npm ENOENT`; use o npm global. Os scripts de instalação que o npm bloqueia não fazem falta: o do Postgres
embutido não faz nada no Windows.
```powershell
npm install -g paperclipai@2026.1023.0
```

**Iniciar** (no Windows ele não roda como serviço: funciona enquanto a janela estiver aberta):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\paperclip.ps1
```
O script põe o Git Bash no PATH só desse processo (o Paperclip usa `sh` para criar os worktrees), usa o `paperclipai`
instalado se for a versão fixada (`$Version`; senão avisa e roda via `npx`), desliga a telemetria e faz `git fetch` dos
projetos a cada 5 min (os worktrees partem do `origin/main`).
Versão nova com migrações do banco: o servidor pergunta antes de aplicar. Faça um backup de
`~/.paperclip/instances/default` com o servidor parado e responda `y`.

**Configurar ou recriar a empresa:** `node paperclip/setup.mjs` (`--dry-run` para conferir). É idempotente. Ele liga os
workspaces isolados (recurso experimental, sem o qual os agentes trabalhariam na cópia principal), cria ou atualiza os
agentes, a hierarquia e as instruções (`paperclip/comum.md` + `paperclip/funcoes.json`), o projeto TableHub e as rotinas.

| Agente | Modelo | Esforço | Faixa | Papel |
|---|---|---|---|---|
| **Produtor** | Opus 5.5 | médio | 6 | direção: transforma metas em tarefas, distribui e acompanha; todos respondem a ele |
| Analista | Opus 5.5 | padrão | 5 | especifica jogo novo / melhoria grande e passa ao Dev |
| Dev | Opus 5.5 | padrão | 1 | implementa jogos e melhorias especificadas |
| Dev Rápido | Sonnet 5.5 | padrão | 2 | bugs e melhorias simples |
| QA | Sonnet 5.5 | médio | 3 | etapa de revisão: testa o PR |
| **Designer** | Sonnet 5.5 | padrão | 7 | UI/UX, sistema visual e arte SVG; etapa de revisão de mudanças de interface |
| **Segurança** | Opus 5.5 | médio | 8 | auditoria mensal; etapa de revisão de mudanças no servidor/protocolo |
| Revisor | Opus 5.5 | médio | 4 | última etapa; aprova e marca o PR `pronto-para-aprovação` |
| **Release** | Sonnet 5.5 | médio | 9 | confere produção depois dos deploys, notas de versão |
| **Financeiro** | Sonnet 5.5 | baixo | 10 | custos, consumo da assinatura e orçamento (só recomenda) |
| **Marketing** | Sonnet 5.5 | padrão | 11 | marketing, redes sociais, comunidade e crescimento (o dono publica) |

Os papéis novos foram adaptados de duas empresas-modelo do catálogo [paperclipai/companies](https://github.com/paperclipai/companies)
(Donchitos Game Studio e Agency Agents), importadas como "Referência - …" no Paperclip, com **todos os agentes pausados**.

**Rotinas** (fuso de São Paulo; pausar ou mudar o horário pela interface do Paperclip):

| Rotina | Agente | Quando | Roda só se houve atividade? |
|---|---|---|---|
| Auditoria de segurança mensal | Segurança | dia 1, 09:00 | não |
| Relatório financeiro semanal | Financeiro | segunda, 09:00 | não |
| Plano de conteúdo semanal | Marketing | segunda, 10:00 | não |
| Verificação de produção | Release | todo dia, 08:00 | sim |
| Status semanal da empresa | Produtor | sexta, 17:00 | sim |

**Fluxo:** dê uma meta ou tarefa ao Produtor, ou atribua direto (jogo novo/melhoria grande → Analista; bug/melhoria simples →
Dev Rápido). O agente trabalha no worktree da issue, abre o PR no GitHub pela conta bot e manda a issue para `in_review`;
ela passa pelas etapas (QA, Designer se for interface, Segurança se for servidor, Revisor). Quem pede mudanças devolve a issue
para quem implementou. No fim, o PR fica `pronto-para-aprovação` no GitHub, e o merge continua sendo seu. Dúvidas dos agentes
aparecem como perguntas na issue do Paperclip. Nada é publicado fora do GitHub sem você (posts do Marketing são rascunhos).

**Pontos de atenção:**
- Agentes rodam **liberados** (`dangerouslySkipPermissions`, padrão do Paperclip): as permissões por função de `.agents/roles`
  não se aplicam mais. As regras (sem merge, sem push na `main`) ficam só nas instruções.
- O Paperclip **não conhece os limites da assinatura** (sessão de 5 h, semanal): a política de créditos do despachante não
  vale mais. Com o uso extra ligado na conta, agentes seguem cobrando depois do limite; use orçamento por agente no
  Paperclip ou desligue o uso extra no claude.ai.
- `GH_CONFIG_DIR` vai no ambiente de cada agente: no Windows o Paperclip procuraria a configuração do `gh` no lugar errado.
- Uma execução por vez por agente (as portas são fixas por agente).

## Instalação do despachante (desativado)
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
| `extraUsage` | `{ "allowed": false, "stopAtPercent": 90 }` | Créditos (uso extra) para os agentes depois do limite; mude com `npm run creditos` (ver abaixo) |

**De cada projeto** — `.agents/` no repositório do projeto, lido de `origin/<branch>`. Só vale o que já foi revisado e
mergeado; a cópia de trabalho não importa. O despachante relê a cada 10 min.

```jsonc
// .agents/config.json
{
  "id": "tablehub",                         // nome curto (logs, estado, monitor)
  "repo": "guilanfredi/tablehub",
  "owner": "guilanfredi",                   // quem aprova e responde dúvidas
  "bot": { "login": "gui-dev-bot", "email": "...@users.noreply.github.com" },
  "labels": { "working": "agente:trabalhando", "waiting": "aguardando-dono", "done": "pronto-para-aprovação" },
  "roles": [                                // ordem = prioridade
    { "name": "revisor", "label": "fase:review", "timeoutMin": 30, "prOnly": true, "model": "claude-opus-5-5", "effort": "medium" },
    { "name": "dev", "label": "fase:dev", "timeoutMin": 120, "model": "claude-opus-5-5",
      "overrides": [{ "labels": ["tipo:bug"], "model": "claude-sonnet-5-5" }] }   // exceção por etiqueta
  ],
  "maxPerRole": { "revisor": 1 },           // opcional
  "ci": { "checks": ["test", "e2e"], "roles": ["qa", "revisor"], "failLabel": "fase:dev" },   // opcional
  "worktreesDir": "../TableHub-agents",     // relativo ao projeto
  "addDirs": ["manuals"],                   // pastas extras liberadas para leitura (--add-dir)
  "setup": { "command": "npm ci --no-audit --no-fund", "whenChanged": "package-lock.json" },
  "ports": { "TABLEHUB_WEB_PORT": 5200 }    // variável → base; faixa N recebe base + N
}
```
- `.agents/roles/<função>.json`: permissões do Claude Code da função (passadas com `--settings`). É obrigatório.
- `.agents/prompt.md`: instruções extras do projeto para o modo automático. É opcional.
- O comando é `/<função> <número>`: o projeto precisa ter uma skill com o nome de cada função.
- **Modelo e esforço** (`model`, `effort`: `low`…`max`) por função, passados com `--model`/`--effort`; sem eles, vale o padrão
  do Claude Code. `overrides` troca modelo/esforço quando o item tem uma das etiquetas. Num PR, contam também as etiquetas
  das issues que ele fecha (`Closes #N`). O `npm run despachante:teste` mostra como cada função rodaria.
- `labels.done`: etiqueta de tarefa concluída (opcional); o relatório usa para o custo por tarefa concluída.
- **Espera do CI** (`ci`, opcional): as funções de `ci.roles` só pegam um PR depois que os checks de `ci.checks` terminaram
  no último commit. Assim o agente anterior entrega sem ficar parado em `gh pr checks --watch`, e o seguinte não começa sobre
  um PR quebrado. Com algum check vermelho, o despachante troca a etiqueta da fase por `ci.failLabel` e comenta (uma vez
  por commit; sem `failLabel`, o PR só fica parado). Os nomes são os dos jobs do Actions; `"e2e"` vale também para a matriz
  (`e2e (1, 2)`…). Os demais checks (ex.: sincronização do quadro) não contam. Check exigido que não aparece em
  `ci.missingAfterMin` (padrão 20) minutos depois de o despachante ver o commit é ignorado, para não travar a tarefa. CI
  instável: reexecute o job no GitHub; o despachante segue quando ele ficar verde.

## Como funciona
1. A cada consulta, junta as tarefas de todos os projetos. Em cada projeto, vale a ordem das funções e, dentro da mesma
   fase, vai primeiro o item parado há mais tempo. As vagas são divididas entre os projetos, um de cada por vez.
2. Ignora tarefas com a etiqueta `working`, as que não foram criadas pelo dono ou pelo bot (repositórios públicos), e as com
   `waiting` até o dono comentar. Um PR do bot que fecha uma issue ainda em execução espera ela terminar: o agente abre o
   PR no meio do trabalho, já com etiqueta de fase, e só no fim troca a etiqueta. Com `ci`, PRs das funções de `ci.roles`
   esperam o CI (e voltam para `ci.failLabel` se ele falhar), mesmo sem vagas livres.
3. Cada execução tem um worktree `<worktreesDir>/<função>-<n>` (limpo, na branch principal; `setup` quando o arquivo
   observado muda) e uma faixa de portas própria. As faixas são globais, então dois projetos nunca colidem.
4. Libera as portas da faixa (servidores de agentes que sobraram de execuções anteriores, com a cadeia que os recria),
   marca a etiqueta `working`, roda a função com tempo máximo e, ao terminar, encerra processos que sobraram (pela árvore e pelas portas) e
   consulta de novo na hora. Se estourar o tempo, comenta e marca `waiting`.
5. Execução que termina sem avançar a fase espera 10 min antes de tentar de novo. Depois de 3 seguidas, chama o dono.
6. Antes de abrir agentes, confere a cota (veja "Créditos"). Login expirado pausa novos inícios por 1 h; agente que falha por limite de
   uso pausa até o reset informado pelo endpoint (ou 30 min, se ele não souber).
7. Se o despachante cair, volta a acompanhar as execuções em andamento e remove etiquetas `working` que ficaram sem execução.

As variáveis `CLAUDE_AGENT_TASK` e `CLAUDE_AGENT_PROJECT` identificam a execução no monitor.

## Comandos
```bash
npm run despachante          # (desativado) em primeiro plano, com o log no terminal (Ctrl+C para parar)
npm run despachante:teste    # o que seria executado agora (--only <função>, --max <n>)
npm run agentes              # dashboard (--texto, --json, --todas para scripts)
npm run relatorio            # relatório de hoje (--ontem, --data AAAA-MM-DD, --markdown, --json)
npm run creditos             # créditos para os agentes: status, -- on, -- off, -- off --parar-em 95
npm run agendador:instalar   # ou agendador:remover
npm run monitor:instalar     # ou monitor:remover
npm test
```

## Limites da assinatura
O dashboard (`npm run agentes`) mostra numa faixa abaixo do cabeçalho o uso da **sessão de 5 h**, do **semanal** e o
**uso extra** do mês, com data, hora e contagem regressiva até o reset. O `--texto`, o `--json` e o relatório também trazem
esses dados.
- O endpoint responde 429 a consultas frequentes: dashboard e relatório compartilham um cache (`state/usage-cache.json`)
  e consultam no máximo a cada 5 min. Se a consulta falhar, mostram o último valor com o horário ("dados de 14:05").
- Fonte: o mesmo endpoint que o `/usage` do Claude Code consulta (`api.anthropic.com/api/oauth/usage`), com o token OAuth de
  `~/.claude/.credentials.json`. **É interno e não documentado**: se mudar ou falhar, aparece "limites indisponíveis" e o resto funciona.
- O token **nunca é renovado** aqui (isso derrubaria o login do Claude Code), não é gravado e só vai para `api.anthropic.com`.
  Login vencido → abra o Claude Code, que renova sozinho.
- O semanal na faixa vermelha (≥ 90%) é o sinal para diminuir o `maxTotal`.

## Créditos (uso extra) para os agentes
Com o uso extra ligado na conta, o Claude Code não falha ao bater o limite: passa a cobrar créditos. O despachante decide
por conta própria se os **agentes** podem fazer isso. O uso extra da conta continua valendo para as suas sessões interativas.

- **Desligado (padrão):** com a sessão de 5 h em `stopAtPercent` (90%) ou o semanal em 100%, não abre agentes novos e
  **volta sozinho no horário de reset** informado pelo endpoint. Agentes já em andamento terminam normalmente (podem
  gastar um pouco de crédito se passarem do limite no meio).
- **Ligado:** segue abrindo agentes depois do limite, cobrando créditos.
- **Mudar a qualquer momento:** `npm run creditos -- on` / `npm run creditos -- off` / `npm run creditos -- off --parar-em 95`.
  `npm run creditos` sozinho mostra a política, a cota e se os agentes estão pausados. O despachante relê a política a cada
  consulta (≈15 s), sem reiniciar. O dashboard também mostra a situação ("Agentes pausados até 20:00").
- Sem dados de limite (endpoint fora do ar e sem cache), o despachante não trava: segue abrindo agentes.

## Relatório
`npm run relatorio` mostra as execuções de um dia (hoje, por padrão):
- **limites atuais**;
- **resumo**: execuções por resultado, tarefas (concluídas e **custo médio por tarefa concluída**), tempo total e médio
  (de relógio), turnos, tokens (entrada, gravação/leitura de cache, saída, raciocínio) e custo **equivalente na API**
  (na assinatura não é cobrado; serve para comparar funções, modelos e dias);
- tabelas **por função**, **por modelo**, **por projeto** e **por tarefa** (issue + PRs que a fecham, com a sequência de
  funções e o estado, consultado no GitHub);
- **lista de execuções**, com o modelo/esforço e o resumo da resposta de cada agente, e as **falhas**.

Tokens e custo vêm do total da sessão (`modelUsage`). Quando o agente usa tarefas em segundo plano, o JSON do `claude -p`
descreve só o último resultado em `usage`/`num_turns`; nesses casos os turnos aparecem como "—".

| Opção | O que faz |
|---|---|
| `--ontem` / `--data AAAA-MM-DD` | outro dia |
| `--markdown` | Markdown com links para as issues/PRs |
| `--json` | dados brutos, para scripts ou uma tarefa agendada |
| `--sem-github` | não consulta o GitHub (sem juntar issue e PR nem estado das tarefas) |

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
