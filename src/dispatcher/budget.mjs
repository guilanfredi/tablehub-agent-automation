/**
 * Cota da assinatura x uso extra (créditos): decide se o despachante pode abrir agentes novos.
 *
 * Com o uso extra ligado na conta, o Claude Code não falha ao bater o limite: passa a cobrar créditos.
 * Por isso o despachante consulta os limites antes de abrir cada agente e, com créditos desligados
 * para os agentes, para de abrir novos perto do limite e volta sozinho no horário de reset.
 * Agentes já em andamento terminam normalmente.
 */

export const DEFAULT_EXTRA_USAGE = { allowed: false, stopAtPercent: 90 };

/** Valida a política de créditos de config.local.json (função pura; testada). */
export function normalizeExtraUsage(raw) {
  const p = { ...DEFAULT_EXTRA_USAGE, ...(raw ?? {}) };
  if (typeof p.allowed !== 'boolean') throw new Error('"extraUsage.allowed" precisa ser true ou false.');
  if (!(Number.isFinite(p.stopAtPercent) && p.stopAtPercent >= 1 && p.stopAtPercent <= 100)) {
    throw new Error('"extraUsage.stopAtPercent" precisa ser um número de 1 a 100.');
  }
  return { allowed: p.allowed, stopAtPercent: p.stopAtPercent };
}

/** Reset do limite esgotado (≥ 100%) que renova por último, no futuro e em até 8 dias; null se não houver (testada). */
export function exhaustedReset(usage, now = Date.now()) {
  const resets = (usage?.limits ?? [])
    .filter((l) => l.percent >= 100 && l.resetsAt)
    .map((l) => Date.parse(l.resetsAt))
    .filter((t) => t > now && t - now < 8 * 86_400_000);
  return resets.length ? new Date(Math.max(...resets)).toISOString() : null;
}

/**
 * Pode abrir agentes novos? (função pura; testada)
 * - créditos liberados: sempre;
 * - sem dados de limite: sim (não trava para sempre; erros de limite ainda pausam o despachante);
 * - limites com reset já passado são ignorados (dado antigo, de uma janela que já renovou);
 * - sessão (5 h): para em `stopAtPercent`; demais (semanal): param em 100%.
 * Retorna { allowed, until (fim da pausa, ISO), reason }.
 */
export function budgetGate({ usage, policy, now = Date.now() }) {
  if (policy.allowed) return { allowed: true, until: null, reason: 'créditos liberados para os agentes' };
  if (!usage?.limits?.length) return { allowed: true, until: null, reason: 'limites desconhecidos' };
  const blocking = usage.limits.filter((l) => {
    if (l.resetsAt && Date.parse(l.resetsAt) <= now) return false;
    const threshold = l.id === 'session' ? policy.stopAtPercent : 100;
    return l.percent >= threshold;
  });
  if (!blocking.length) return { allowed: true, until: null, reason: 'dentro da cota' };
  // pausa até o último reset entre os limites atingidos (todos precisam renovar)
  const last = blocking.reduce((a, b) => (Date.parse(b.resetsAt ?? 0) > Date.parse(a.resetsAt ?? 0) ? b : a));
  const desc = blocking.map((l) => `${l.label} em ${Math.round(l.percent)}%`).join(', ');
  return { allowed: false, until: last.resetsAt ?? null, reason: `${desc} e créditos desligados para os agentes` };
}
