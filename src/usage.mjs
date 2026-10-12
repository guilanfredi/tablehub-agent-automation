/**
 * Limites de uso da assinatura do Claude (sessão de 5 h, semanal, uso extra).
 *
 * Usa o mesmo endpoint interno que o `/usage` do Claude Code consulta (não documentado: pode mudar sem aviso),
 * com o token OAuth que o Claude Code guarda em ~/.claude/.credentials.json. O token NUNCA é renovado aqui:
 * o refresh troca o refresh token e derrubaria o login do Claude Code. Ele só é enviado para api.anthropic.com
 * e nunca é gravado nem registrado em log.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export function credentialsFile() {
  if (process.env.CLAUDE_CREDENTIALS_FILE) return process.env.CLAUDE_CREDENTIALS_FILE;
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
}

/** Token OAuth atual do Claude Code (sem renovar). */
export function readOAuthToken(now = Date.now()) {
  let oauth;
  try { oauth = JSON.parse(readFileSync(credentialsFile(), 'utf8')).claudeAiOauth; } catch { oauth = null; }
  if (!oauth?.accessToken) return { token: null, error: 'login do Claude Code não encontrado' };
  if (oauth.expiresAt && oauth.expiresAt <= now) return { token: null, error: 'login vencido: abra o Claude Code para renovar' };
  return { token: oauth.accessToken, plan: oauth.subscriptionType ?? null };
}

/** Consulta os limites. Retorna { usage } ou { error } (nunca lança). */
export async function fetchUsage(now = Date.now()) {
  const { token, plan, error } = readOAuthToken(now);
  if (!token) return { error };
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'tablehub-agent-automation' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { error: 'login recusado: abra o Claude Code para renovar' };
    if (!res.ok) return { error: `limites indisponíveis (HTTP ${res.status})` };
    return { usage: parseUsage(await res.json()), plan };
  } catch (e) {
    return { error: `limites indisponíveis (${e.name === 'TimeoutError' ? 'sem resposta' : e.message})` };
  }
}

const LABELS = {
  session: 'Sessão (5 h)',
  weekly_all: 'Semanal',
  weekly_opus: 'Semanal Opus',
  weekly_sonnet: 'Semanal Sonnet',
};

/** Converte a resposta do endpoint no formato do monitor/relatório (função pura; testada). */
export function parseUsage(raw) {
  let limits;
  if (Array.isArray(raw?.limits) && raw.limits.length) {
    limits = raw.limits.map((l) => ({
      id: l.kind,
      label: LABELS[l.kind] ?? l.kind,
      percent: Number(l.percent ?? 0),
      resetsAt: l.resets_at ?? null,
      severity: l.severity ?? null,
    }));
  } else {
    limits = [['five_hour', 'session'], ['seven_day', 'weekly_all'], ['seven_day_opus', 'weekly_opus'], ['seven_day_sonnet', 'weekly_sonnet']]
      .filter(([key]) => raw?.[key])
      .map(([key, id]) => ({ id, label: LABELS[id], percent: Number(raw[key].utilization ?? 0), resetsAt: raw[key].resets_at ?? null, severity: null }));
  }
  const x = raw?.extra_usage;
  const scale = 10 ** (x?.decimal_places ?? 2);
  const extra = x?.is_enabled
    ? { used: (x.used_credits ?? 0) / scale, limit: x.monthly_limit == null ? null : x.monthly_limit / scale, currency: x.currency ?? 'USD' }
    : null;
  return { limits, extra };
}

/** Nível de alerta: usa a severidade do servidor ou, sem ela, o percentual. */
export function level(limit) {
  if (limit.severity === 'critical' || limit.percent >= 90) return 'alto';
  if (limit.severity === 'warning' || limit.percent >= 70) return 'medio';
  return 'baixo';
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const pad = (n) => String(n).padStart(2, '0');

function countdown(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h${pad(min % 60)}`;
  return `${Math.floor(min / 1440)} dias`;
}

/** "hoje 14:30 (em 2h05)", "amanhã 04:00 (em 15h20)", "dom 19/10 04:00 (em 6 dias)" — hora local (função pura; testada). */
export function formatReset(iso, now = Date.now()) {
  if (!iso) return 'sem data de reset';
  const at = new Date(iso);
  const today = new Date(now);
  const dayDiff = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86_400_000);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = dayDiff === 0 ? 'hoje' : dayDiff === 1 ? 'amanhã' : `${WEEKDAYS[at.getDay()]} ${pad(at.getDate())}/${pad(at.getMonth() + 1)}`;
  return `${day} ${time} (em ${countdown(at - now)})`;
}

/** "R$ 0,00" */
export function formatMoney(value, currency) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(value);
}
