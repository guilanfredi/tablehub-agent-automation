/**
 * Espera do CI (funções puras; testadas em ci.test.mjs).
 *
 * Com `ci` no .agents/config.json, as funções listadas em `ci.roles` só pegam um PR depois que os checks
 * exigidos (`ci.checks`) terminaram no último commit. Assim o agente anterior não fica parado esperando
 * o CI (`gh pr checks --watch`) e o seguinte não começa sobre um PR quebrado. Com falha, o PR volta para
 * `ci.failLabel`.
 */

const OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/**
 * Contextos do statusCheckRollup (GraphQL) → [{ name, done, ok, at }].
 * Check runs (Actions) e status de commit (API antiga) no mesmo formato.
 */
export function normalizeContexts(nodes) {
  return (nodes ?? []).filter(Boolean).map((n) => (n.__typename === 'StatusContext'
    ? { name: n.context, done: n.state !== 'PENDING' && n.state !== 'EXPECTED', ok: n.state === 'SUCCESS', at: n.createdAt ?? null }
    : { name: n.name, done: n.status === 'COMPLETED', ok: OK.has(n.conclusion), at: n.startedAt ?? null }));
}

/** O check `name` corresponde ao exigido `wanted`? Aceita os nomes de matriz do Actions: "e2e (1, 2)". */
export function matchesCheck(name, wanted) {
  return name === wanted || name.startsWith(`${wanted} (`);
}

/**
 * Estado dos checks exigidos num commit.
 * - 'failure': algum terminou com falha (não espera os outros);
 * - 'pending': algum ainda roda, ou ainda não apareceu;
 * - 'missing': algum não apareceu nem `missingAfterMin` depois de o despachante ver o commit
 *   (workflow que não disparou): segue sem esperar, para não travar a tarefa;
 * - 'success': todos passaram.
 */
export function ciState(contexts, checks, { firstSeenAt, now, missingAfterMin }) {
  // reexecuções repetem o nome: vale a mais recente
  const latest = new Map();
  for (const c of contexts) {
    const prev = latest.get(c.name);
    if (!prev || String(c.at ?? '') >= String(prev.at ?? '')) latest.set(c.name, c);
  }
  const failed = [];
  const pending = [];
  const missing = [];
  for (const wanted of checks) {
    const runs = [...latest.values()].filter((c) => matchesCheck(c.name, wanted));
    if (!runs.length) { missing.push(wanted); continue; }
    for (const r of runs) {
      if (!r.done) pending.push(r.name);
      else if (!r.ok) failed.push(r.name);
    }
  }
  if (failed.length) return { state: 'failure', failed, pending, missing };
  if (pending.length) return { state: 'pending', failed, pending, missing };
  if (missing.length) {
    const late = now - firstSeenAt >= missingAfterMin * 60_000;
    return { state: late ? 'missing' : 'pending', failed, pending, missing };
  }
  return { state: 'success', failed, pending, missing };
}

/** Função do item que espera o CI (a primeira de `ci.roles` cuja etiqueta o item tem), ou null. */
export function gatedRole(item, cfg) {
  if (!cfg.ci || !item.isPr) return null;
  return cfg.roles.find((r) => cfg.ci.roles.includes(r.name) && item.labels.includes(r.label)) ?? null;
}

/**
 * Decide, para os PRs que esperam o CI, quais ficam de fora agora e quais voltam para a correção.
 * @param {object} p
 * @param {Array} p.items        itens abertos (normalizeItem)
 * @param {Map|null} p.prs       número → { sha, contexts } (null: consulta falhou → todos esperam)
 * @param {object} p.cfg         configuração do projeto (normalizeProjectConfig)
 * @param {Map} p.firstSeen      sha → quando o despachante viu o commit pela primeira vez (ms)
 * @param {number} p.now
 * @returns {{ blocked: Set<number>, failures: Array, states: Array }}
 */
export function ciGate({ items, prs, cfg, firstSeen, now }) {
  const blocked = new Set();
  const failures = [];
  const states = [];
  for (const item of items) {
    const role = gatedRole(item, cfg);
    if (!role || item.labels.includes(cfg.labels.working)) continue;
    const pr = prs?.get(item.number);
    if (!pr) { blocked.add(item.number); states.push({ item, role, state: 'unknown' }); continue; }
    const s = ciState(pr.contexts, cfg.ci.checks, { firstSeenAt: firstSeen.get(pr.sha) ?? now, now, missingAfterMin: cfg.ci.missingAfterMin });
    states.push({ item, role, sha: pr.sha, ...s });
    if (s.state === 'pending') blocked.add(item.number);
    if (s.state === 'failure') {
      blocked.add(item.number);
      // só mexe nas etiquetas de tarefas do dono ou do bot, e não enquanto espera o dono
      const trusted = item.author === cfg.owner || item.author === cfg.bot.login;
      if (cfg.ci.failLabel && trusted && !item.labels.includes(cfg.labels.waiting)) failures.push({ item, role, sha: pr.sha, failed: s.failed });
    }
  }
  return { blocked, failures, states };
}

/** Texto curto do estado, para o log e o dry-run. */
export function describeCi(s) {
  if (s.state === 'unknown') return 'CI desconhecido (consulta falhou); esperando';
  if (s.state === 'failure') return `CI falhou (${s.failed.join(', ')})`;
  if (s.state === 'pending') return `esperando o CI (${[...s.pending, ...s.missing].join(', ')})`;
  if (s.state === 'missing') return `checks ausentes (${s.missing.join(', ')}); seguindo sem o CI`;
  return 'CI verde';
}
