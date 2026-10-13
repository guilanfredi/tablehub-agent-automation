/**
 * Renderização do relatório: texto (terminal) e Markdown. Funções puras; testadas.
 */
import { formatMoney, formatReset, level, staleNote } from '../usage.mjs';
import { modelLabel } from './collect.mjs';

const nf = new Intl.NumberFormat('pt-BR');
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export const fmtTokens = (n) => (n >= 10_000 ? compact.format(n) : nf.format(n)).replace(/\s/g, ' ');
export const fmtCost = (n) => (n == null ? '—' : usd.format(n).replace(/\s/g, ' '));

export function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });

function dayTitle(day) {
  const [y, m, d] = day.split('-').map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

const OUTCOME_ORDER = ['ok', 'sem-avanço', 'em-andamento', 'erro', 'timeout', 'saída-inesperada', 'falha-ao-iniciar'];
function outcomesText(outcomes) {
  return OUTCOME_ORDER.filter((k) => outcomes[k]).map((k) => `${outcomes[k]} ${k}`).join(' · ') || 'nenhuma';
}

const runTokens = (r) => (r.tokens ? r.tokens.input + r.tokens.cacheWrite + r.tokens.cacheRead + r.tokens.output : 0);
const roleTotal = (t) => t.tokens.input + t.tokens.cacheWrite + t.tokens.cacheRead + t.tokens.output;
const failuresOf = (t) => t.runs - (t.outcomes.ok ?? 0) - (t.outcomes['sem-avanço'] ?? 0) - (t.outcomes['em-andamento'] ?? 0);

function tokensLine(t) {
  return `${fmtTokens(t.total)} (entrada ${fmtTokens(t.input)} · gravação em cache ${fmtTokens(t.cacheWrite)} · leitura de cache ${fmtTokens(t.cacheRead)} · saída ${fmtTokens(t.output)}, raciocínio ${fmtTokens(t.thinking)})`;
}

// ---------------- texto ----------------

const sgr = (code, on) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

function table(headers, rows, align = []) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((cell, i) => (align[i] === 'r' ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i]))).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)];
}

function bar(percent, width = 10) {
  const full = Math.round(Math.min(100, Math.max(0, percent)) / 100 * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

/** "analista, analista, dev, qa" → "analista×2 → dev → qa" (testada). */
export function rolesFlow(roles) {
  const out = [];
  for (const r of roles) {
    const last = out.at(-1);
    if (last?.role === r) last.n++; else out.push({ role: r, n: 1 });
  }
  return out.map((x) => (x.n > 1 ? `${x.role}×${x.n}` : x.role)).join(' → ');
}

/** Tarefas do dia, concluídas e custo médio por tarefa concluída. */
function tasksLine(byTask) {
  const tasks = Object.values(byTask);
  const done = tasks.filter((t) => t.status === 'concluída');
  const known = tasks.some((t) => t.status);
  if (!known) return `${tasks.length} ${tasks.length === 1 ? 'tarefa' : 'tarefas'} (estado desconhecido: GitHub não consultado)`;
  const avg = done.length ? ` · custo médio por tarefa concluída ${fmtCost(done.reduce((s, t) => s + t.costUsd, 0) / done.length)}` : '';
  return `${tasks.length} ${tasks.length === 1 ? 'tarefa' : 'tarefas'} (${done.length} ${done.length === 1 ? 'concluída' : 'concluídas'}${avg})`;
}

const modelCell = (r) => `${modelLabel(r)}${r.effort ? `/${r.effort}` : ''}`;
const turnsNote = (runs) => (runs.some((r) => r.turns == null && r.costUsd != null) ? ' (algumas execuções não informam turnos)' : '');
const taskName = (t) => `#${t.task}${t.items.filter((n) => n !== t.task).map((n) => ` +#${n}`).join('')}`;

/** Relatório para o terminal. */
export function toText({ day, runs, summary, usage, now = Date.now(), color = false }) {
  const c = { bold: sgr('1', color), dim: sgr('2', color), red: sgr('31', color), green: sgr('32', color), yellow: sgr('33', color) };
  const levelColor = { alto: c.red, medio: c.yellow, baixo: c.green };
  const out = [c.bold(`Relatório dos agentes — ${dayTitle(day)}`), ''];

  out.push(c.bold('Limites da assinatura') + c.dim(staleNote(usage)));
  if (usage?.usage) {
    const labelW = Math.max(9, ...usage.usage.limits.map((l) => l.label.length));
    for (const l of usage.usage.limits) {
      out.push(`  ${l.label.padEnd(labelW)}  ${levelColor[level(l)](bar(l.percent))} ${String(Math.round(l.percent)).padStart(3)}%  renova ${formatReset(l.resetsAt, now)}`);
    }
    const x = usage.usage.extra;
    if (x) out.push(`  ${'Uso extra'.padEnd(labelW)}  ${formatMoney(x.used, x.currency)}${x.limit != null ? ` de ${formatMoney(x.limit, x.currency)}` : ''} no mês`);
  } else {
    out.push(c.dim(`  ${usage?.error ?? 'limites indisponíveis'}`));
  }
  out.push('');

  const t = summary.totals;
  out.push(c.bold('Resumo'));
  if (!t.runs) {
    out.push(c.dim('  Nenhuma execução de agente neste dia.'));
    return out.join('\n');
  }
  out.push(`  Execuções   ${t.runs} (${outcomesText(t.outcomes)})`);
  out.push(`  Tarefas     ${tasksLine(summary.byTask)}`);
  out.push(`  Tempo       ${fmtDuration(t.durationMs)} no total · média ${fmtDuration(t.avgDurationMs)}`);
  out.push(`  Turnos      ${nf.format(t.turns)}${c.dim(turnsNote(runs))}`);
  out.push(`  Tokens      ${tokensLine(t.tokens)}`);
  out.push(`  Custo API   ${fmtCost(t.costUsd)} ${c.dim('(equivalente na API; na assinatura não é cobrado)')}`);
  out.push('');

  const groupRows = (groups) => Object.entries(groups).map(([k, g]) => [k, g.runs, g.outcomes.ok ?? 0, failuresOf(g), fmtDuration(g.durationMs), fmtTokens(roleTotal(g)), fmtCost(g.costUsd)]);
  const groupAlign = ['', 'r', 'r', 'r', 'r', 'r', 'r'];
  const section = (title, head, groups) => {
    out.push(c.bold(title), ...table([head, 'exec', 'ok', 'falhas', 'tempo', 'tokens', 'custo'], groupRows(groups), groupAlign).map((l) => `  ${l}`), '');
  };
  section('Por função', 'função', summary.byRole);
  section('Por modelo', 'modelo', summary.byModel);
  if (Object.keys(summary.byProject).length > 1) section('Por projeto', 'projeto', summary.byProject);

  out.push(c.bold('Por tarefa'));
  const tasks = Object.values(summary.byTask).sort((a, b) => b.costUsd - a.costUsd);
  const taskRows = tasks.map((tk) => [taskName(tk), tk.status ?? '—', tk.runs, fmtDuration(tk.durationMs), fmtCost(tk.costUsd), rolesFlow(tk.roles)]);
  const taskLines = table(['tarefa', 'estado', 'exec', 'tempo', 'custo', 'funções'], taskRows, ['', '', 'r', 'r', 'r', '']);
  out.push(`  ${taskLines[0]}`);
  tasks.forEach((tk, i) => {
    out.push(`  ${taskLines[i + 1]}`);
    if (tk.title) out.push(c.dim(`        ${tk.title.length > 120 ? `${tk.title.slice(0, 119)}…` : tk.title}`));
  });
  out.push('');

  out.push(c.bold('Execuções'));
  const rows = runs.map((r) => [clock(r.startedAt), r.project, r.role, `#${r.number}`, modelCell(r), fmtDuration(r.durationMs), r.turns ?? '—', fmtTokens(runTokens(r)), fmtCost(r.costUsd), r.outcome]);
  const lines = table(['hora', 'projeto', 'função', 'item', 'modelo', 'duração', 'turnos', 'tokens', 'custo', 'resultado'], rows, ['', '', '', 'r', '', 'r', 'r', 'r', 'r', '']);
  out.push(`  ${lines[0]}`);
  runs.forEach((r, i) => {
    const failed = summary.failures.includes(r);
    out.push(`  ${failed ? c.red(lines[i + 1]) : lines[i + 1]}`);
    const note = r.title ? `${r.title}: ${r.summary}` : r.summary;
    if (note) out.push(c.dim(`        ${note.length > 140 ? `${note.slice(0, 139)}…` : note}`));
  });
  return out.join('\n');
}

// ---------------- Markdown ----------------

const mdEscape = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Relatório em Markdown. `repos` mapeia id do projeto → "dono/repositório" (links dos itens). */
export function toMarkdown({ day, runs, summary, usage, repos = {}, now = Date.now() }) {
  const link = (project, n) => (repos[project] ? `[#${n}](https://github.com/${repos[project]}/issues/${n})` : `#${n}`);
  const out = [`# Relatório dos agentes — ${dayTitle(day)}`, '', '## Limites da assinatura', ''];
  if (usage?.stale) out.push(`_${staleNote(usage).slice(3)}_`, '');
  if (usage?.usage) {
    out.push('| Limite | Uso | Renova |', '|---|---:|---|');
    for (const l of usage.usage.limits) out.push(`| ${l.label} | ${Math.round(l.percent)}% | ${formatReset(l.resetsAt, now)} |`);
    const x = usage.usage.extra;
    if (x) out.push('', `Uso extra: ${formatMoney(x.used, x.currency)}${x.limit != null ? ` de ${formatMoney(x.limit, x.currency)}` : ''} no mês.`);
  } else {
    out.push(`_${usage?.error ?? 'limites indisponíveis'}_`);
  }
  out.push('', '## Resumo', '');
  const t = summary.totals;
  if (!t.runs) { out.push('Nenhuma execução de agente neste dia.'); return out.join('\n') + '\n'; }
  const groupTable = (head, groups) => [
    `| ${head} | Execuções | OK | Falhas | Tempo | Tokens | Custo |`, '|---|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(groups).map(([k, g]) => `| ${k} | ${g.runs} | ${g.outcomes.ok ?? 0} | ${failuresOf(g)} | ${fmtDuration(g.durationMs)} | ${fmtTokens(roleTotal(g))} | ${fmtCost(g.costUsd)} |`),
  ];
  out.push(
    `- **Execuções:** ${t.runs} (${outcomesText(t.outcomes)})`,
    `- **Tarefas:** ${tasksLine(summary.byTask)}`,
    `- **Tempo:** ${fmtDuration(t.durationMs)} no total · média ${fmtDuration(t.avgDurationMs)}`,
    `- **Turnos:** ${nf.format(t.turns)}${turnsNote(runs)}`,
    `- **Tokens:** ${tokensLine(t.tokens)}`,
    `- **Custo equivalente na API:** ${fmtCost(t.costUsd)} (na assinatura não é cobrado; serve para comparar)`,
    '', '## Por função', '', ...groupTable('Função', summary.byRole),
    '', '## Por modelo', '', ...groupTable('Modelo', summary.byModel),
  );
  if (Object.keys(summary.byProject).length > 1) out.push('', '## Por projeto', '', ...groupTable('Projeto', summary.byProject));
  out.push('', '## Por tarefa', '', '| Tarefa | Título | Estado | Execuções | Tempo | Custo | Funções |', '|---|---|---|---:|---:|---:|---|');
  for (const tk of Object.values(summary.byTask).sort((a, b) => b.costUsd - a.costUsd)) {
    const items = [tk.task, ...tk.items.filter((n) => n !== tk.task)].map((n) => link(tk.project, n)).join(' + ');
    out.push(`| ${items} | ${mdEscape(tk.title ?? '')} | ${tk.status ?? '—'} | ${tk.runs} | ${fmtDuration(tk.durationMs)} | ${fmtCost(tk.costUsd)} | ${rolesFlow(tk.roles)} |`);
  }
  out.push('', '## Execuções', '', '| Hora | Projeto | Função | Item | Modelo | Duração | Turnos | Tokens | Custo | Resultado | Resumo |', '|---|---|---|---|---|---:|---:|---:|---:|---|---|');
  for (const r of runs) {
    const note = r.summary.length > 160 ? `${r.summary.slice(0, 159)}…` : r.summary;
    out.push(`| ${clock(r.startedAt)} | ${r.project} | ${r.role} | ${link(r.project, r.number)} | ${modelCell(r)} | ${fmtDuration(r.durationMs)} | ${r.turns ?? '—'} | ${fmtTokens(runTokens(r))} | ${fmtCost(r.costUsd)} | ${r.outcome} | ${mdEscape(note)} |`);
  }
  if (summary.failures.length) {
    out.push('', '## Falhas', '');
    for (const r of summary.failures) out.push(`- ${clock(r.startedAt)} ${r.project} \`/${r.role} ${r.number}\` — **${r.outcome}**${r.summary ? `: ${mdEscape(r.summary.slice(0, 300))}` : ''}`);
  }
  return out.join('\n') + '\n';
}
