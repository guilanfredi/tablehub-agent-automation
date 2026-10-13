/**
 * Regras de escolha do despachante (funções puras; testadas em select.test.mjs).
 */

/** Item da API de issues do GitHub → formato interno. */
export function normalizeItem(it) {
  return {
    number: it.number,
    title: it.title,
    isPr: Boolean(it.pull_request),
    author: it.user?.login,
    labels: (it.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    updatedAt: it.updated_at,
    closes: closingRefs(it.pull_request ? it.body : ''),
  };
}

/** Números citados com palavra de fechamento ("Closes #22", "fixes #3") no corpo de um PR (testada). */
export function closingRefs(body) {
  const refs = new Set();
  for (const m of String(body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi)) refs.add(Number(m[1]));
  return [...refs];
}

/**
 * PRs do bot que fecham um item ainda em execução (função pura; testada).
 *
 * Um agente costuma abrir o PR no meio do trabalho, já com a etiqueta de fase, e só no fim troca a
 * etiqueta (ex.: fase:dev → fase:qa) ou pede decisão do dono. Com vagas livres, o despachante pegaria
 * esse PR antes da hora e abriria um segundo agente à toa. O PR espera a execução da issue terminar.
 */
export function waitingForParentRun(items, running, bot) {
  const runningNumbers = new Set(running.map((j) => j.number));
  return new Set(items.filter((it) => it.author === bot && it.closes?.some((n) => runningNumbers.has(n))).map((it) => it.number));
}

const historyKey = (number, role) => `${number}:${role}`;

/**
 * Escolhe as próximas execuções, em ordem de prioridade (função, depois o item parado há mais tempo).
 * @param {object} p
 * @param {Array} p.items            itens abertos (normalizeItem)
 * @param {Array} p.running          execuções em andamento ({ number, role })
 * @param {Array} p.roles            ROLES (ordem = prioridade)
 * @param {number} p.maxTotal
 * @param {object} [p.maxPerRole]
 * @param {Set<number>} p.waitingResolved  itens 'aguardando-dono' em que o dono já respondeu
 * @param {object} p.history         { "<n>:<função>": { cooldownUntil } }
 * @param {number} p.now
 * @param {object} p.cfg             { owner, bot, working, waiting }
 * @param {Set<number>} [p.blocked]  itens ocupados por outra coisa (ex.: despachante antigo)
 */
export function pickJobs({ items, running, roles, maxTotal, maxPerRole = {}, waitingResolved, history, now, cfg, blocked = new Set() }) {
  let free = maxTotal - running.length;
  if (free <= 0) return [];
  const busy = new Set([...running.map((j) => j.number), ...blocked]);
  const perRole = {};
  for (const j of running) perRole[j.role] = (perRole[j.role] ?? 0) + 1;

  const byAge = [...items].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const picked = [];
  for (const role of roles) {
    for (const it of byAge) {
      if (free <= 0) return picked;
      if ((perRole[role.name] ?? 0) >= (maxPerRole[role.name] ?? Infinity)) break;
      if (!it.labels.includes(role.label)) continue;
      if (role.prOnly && !it.isPr) continue;
      if (busy.has(it.number)) continue;
      if (it.labels.includes(cfg.working)) continue;
      // segurança (repositório público): só tarefas do dono ou do bot
      if (it.author !== cfg.owner && it.author !== cfg.bot) continue;
      if (it.labels.includes(cfg.waiting) && !waitingResolved.has(it.number)) continue;
      const h = history[historyKey(it.number, role.name)];
      if (h?.cooldownUntil && now < Date.parse(h.cooldownUntil)) continue;
      picked.push({ role, item: it });
      busy.add(it.number);
      perRole[role.name] = (perRole[role.name] ?? 0) + 1;
      free--;
    }
  }
  return picked;
}

/**
 * A execução avançou a tarefa? Sim se a etiqueta de fase da função saiu, se o item fechou
 * ou se a função pediu decisão do dono.
 */
export function madeProgress(itemAfter, role, waitingLabel) {
  if (!itemAfter || itemAfter.state === 'closed') return true;
  const labels = (itemAfter.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  return !labels.includes(role.label) || labels.includes(waitingLabel);
}

/**
 * Atualiza o histórico depois de uma execução. Retorna { history, escalate }:
 * escalate = true quando a tarefa rodou N vezes seguidas sem avançar (hora de chamar o dono).
 */
export function recordRun(history, number, roleName, progressed, now, { cooldownMin, maxRuns }) {
  const key = historyKey(number, roleName);
  const next = { ...history };
  if (progressed) { delete next[key]; return { history: next, escalate: false }; }
  const runs = (history[key]?.runs ?? 0) + 1;
  if (runs >= maxRuns) { delete next[key]; return { history: next, escalate: true }; }
  next[key] = { runs, cooldownUntil: new Date(now + cooldownMin * 60_000).toISOString() };
  return { history: next, escalate: false };
}

/**
 * Junta as listas de candidatos de vários projetos alternando entre eles (um de cada por vez),
 * para que um projeto com muitas tarefas não ocupe todas as vagas.
 */
export function interleave(lists, n) {
  const out = [];
  const queues = lists.map((l) => [...l]);
  while (out.length < n && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && out.length < n) out.push(q.shift());
  }
  return out;
}

/** Menor número livre a partir de 1 (faixas de porta e worktrees por função). */
export function freeSlot(used) {
  const set = new Set(used);
  let n = 1;
  while (set.has(n)) n++;
  return n;
}

/** Classifica o erro de uma execução para decidir a pausa. */
export function classifyError(text) {
  if (/authenticat|login|OAuth/i.test(text)) return { pauseMin: 60, reason: 'Login do Claude Code expirado: rode o CLI e faça /login.' };
  if (/limit|quota|usage/i.test(text)) return { pauseMin: 30, reason: 'Limite de uso da assinatura atingido.' };
  return null;
}
