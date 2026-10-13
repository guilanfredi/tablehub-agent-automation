#!/usr/bin/env node
/**
 * Monitor das instâncias do Claude Code rodando na máquina (dados gravados pelo hook.mjs).
 *
 *   npm run agentes                 dashboard interativo (estilo pm2 monit)
 *   npm run agentes -- --texto      lista simples, uma vez (também quando a saída não é um terminal)
 *   npm run agentes -- --todas      inclui sessões encerradas nas últimas 24 h (texto/json)
 *   npm run agentes -- --json       saída em JSON (para scripts)
 */
import { win32 } from 'node:path';
import { fetchUsage, formatMoney, formatReset, staleNote } from '../usage.mjs';
import { loadSessions, origin, sampleProcesses, untrackedProcesses } from './data.mjs';
import { startDashboard } from './dashboard.mjs';

const args = new Set(process.argv.slice(2));
const ALL = args.has('--todas');
const JSON_OUT = args.has('--json');
const TEXT = args.has('--texto') || !process.stdout.isTTY || !process.stdin.isTTY;

function ago(iso, now) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

async function printOnce() {
  const now = Date.now();
  const sessions = loadSessions(now);
  const tracked = new Set(sessions.filter((s) => s.active).map((s) => s.claudePid));
  const [sample, usage] = await Promise.all([sampleProcesses(), fetchUsage(now)]);
  const untracked = (sample ? untrackedProcesses(sample, tracked) : [])
    .map(({ pid, started, cmd }) => ({ pid, started, cmd }));
  const shown = ALL ? sessions : sessions.filter((s) => s.active);

  if (JSON_OUT) {
    console.log(JSON.stringify({ limits: usage.usage ?? null, limitsError: usage.error ?? null, sessions: shown, untracked }, null, 2));
    return;
  }

  const lines = [];
  if (usage.usage) {
    for (const l of usage.usage.limits) lines.push(`${l.label}: ${Math.round(l.percent)}% · renova ${formatReset(l.resetsAt, now)}`);
    const x = usage.usage.extra;
    if (x) lines.push(`Uso extra: ${formatMoney(x.used, x.currency)}${x.limit != null ? ` de ${formatMoney(x.limit, x.currency)}` : ''} no mês`);
    if (usage.stale) lines.push(`(${staleNote(usage).slice(3)})`);
  } else {
    lines.push(`Limites da assinatura: ${usage.error}`);
  }
  lines.push('', `Claude Code — ${sessions.filter((s) => s.active).length} sessão(ões) ativa(s)`, '');
  if (!shown.length) lines.push('Nenhuma sessão registrada pelo hook. Instalou? npm run monitor:instalar', '');
  for (const s of shown) {
    const name = s.agent ? `${s.project ? `${s.project} ` : ''}/${s.agent}` : win32.basename(s.cwd ?? '?');
    let state = s.state;
    if (s.state === 'executando' && s.toolStartedAt) state += ` há ${ago(s.toolStartedAt, now)}`;
    if (s.stale) state += ` ⚠ sem atividade há ${ago(s.lastEventAt, now)}`;
    lines.push(`${name}  [${origin(s)}]  PID ${s.claudePid ?? '?'}  ${state}  (último evento há ${ago(s.lastEventAt, now)})`);
    const detail = s.state === 'aguardando' ? s.message : s.currentTool;
    if (detail) lines.push(`  › ${detail}`);
    if (s.lastPrompt) lines.push(`  pedido: ${s.lastPrompt}`);
    lines.push(`  ${s.cwd ?? ''}`, '');
  }
  if (untracked.length) {
    lines.push(`Processos do Claude Code sem dados do hook: ${untracked.length}`);
    for (const p of untracked) {
      const prompt = p.cmd.match(/-p\s+"([^"]+)"/)?.[1];
      lines.push(`  PID ${p.pid}  desde ${ago(p.started, now)}  ${prompt ? `-p "${prompt}"` : 'interativa'}`);
    }
  }
  console.log(lines.join('\n'));
}

if (TEXT || JSON_OUT) await printOnce();
else startDashboard();
