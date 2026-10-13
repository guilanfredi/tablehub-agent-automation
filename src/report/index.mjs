#!/usr/bin/env node
/**
 * Relatório das execuções dos agentes num dia, com os limites atuais da assinatura.
 *
 *   npm run relatorio                      hoje, no terminal
 *   npm run relatorio -- --ontem           ontem
 *   npm run relatorio -- --data 2026-10-12 um dia específico
 *   npm run relatorio -- --markdown        em Markdown (para colar ou publicar)
 *   npm run relatorio -- --json            dados brutos (para scripts e tarefas agendadas)
 *   npm run relatorio -- --sem-github      não consulta o GitHub (sem agrupar issue+PR nem estado das tarefas)
 */
import { execFileSync } from 'node:child_process';
import { LOG_DIR, STATE_DIR, loadMachineConfig } from '../dispatcher/config.mjs';
import { GitHub } from '../dispatcher/github.mjs';
import { fetchUsage } from '../usage.mjs';
import { linkTasks, loadRuns, localDay, summarize, taskStatus } from './collect.mjs';
import { toMarkdown, toText } from './render.mjs';

const argv = process.argv.slice(2);
const argValue = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

let day = localDay(new Date().toISOString());
if (argv.includes('--ontem')) day = localDay(new Date(Date.now() - 86_400_000).toISOString());
if (argValue('--data')) {
  day = argValue('--data');
  const [y, m, d] = day.split('-').map(Number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || localDay(new Date(y, m - 1, d).toISOString()) !== day) {
    console.error('Use --data AAAA-MM-DD com uma data válida.');
    process.exit(2);
  }
}

let projects = [];
try { projects = loadMachineConfig().projects; } catch (e) { console.error(`AVISO: ${e.message.split('\n')[0]}`); }

/** id → { repo, done }, lido do .agents/config.json de cada projeto. */
function projectConfigs() {
  const out = {};
  for (const p of projects) {
    try {
      const cfg = JSON.parse(execFileSync('git', ['-C', p.path, 'show', `origin/${p.branch}:.agents/config.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }));
      if (cfg.id && cfg.repo) out[cfg.id] = { repo: cfg.repo, done: cfg.labels?.done ?? null };
    } catch { /* projeto sem configuração legível: sem links nem estado */ }
  }
  return out;
}

/** O que o GitHub diz de cada item: estado, etiquetas e, para PRs, as issues que eles fecham. */
async function githubItems(runs, configs) {
  const items = new Map();
  if (argv.includes('--sem-github')) return items;
  const fetchItems = (gh, id, numbers) => Promise.all(numbers.map(async (n) => {
    try {
      const it = await gh.getIssue(n);
      const info = { state: it.state, labels: it.labels.map((l) => l.name), isPr: Boolean(it.pull_request), linked: [] };
      if (info.isPr) info.linked = (await gh.linkedIssues(n)).map((i) => i.number);
      items.set(`${id}#${n}`, info);
    } catch { /* sem rede ou item apagado: fica sem informação */ }
  }));
  for (const [id, cfg] of Object.entries(configs)) {
    const gh = new GitHub(cfg.repo);
    const numbers = [...new Set(runs.filter((r) => r.project === id).flatMap((r) => [r.number, r.task]))];
    await fetchItems(gh, id, numbers);
    const linked = [...new Set([...items.entries()].filter(([k]) => k.startsWith(`${id}#`)).flatMap(([, v]) => v.linked))]
      .filter((n) => !items.has(`${id}#${n}`));
    await fetchItems(gh, id, linked);
  }
  return items;
}

const configs = projectConfigs();
const loaded = loadRuns({ day, stateDir: STATE_DIR, logDir: LOG_DIR, projectPaths: projects.map((p) => p.path) });
const [items, usage] = await Promise.all([githubItems(loaded, configs), fetchUsage()]);
const runs = linkTasks(loaded, items);
const summary = summarize(runs);
for (const t of Object.values(summary.byTask)) t.status = taskStatus(t, items, configs[t.project]?.done);
const repos = Object.fromEntries(Object.entries(configs).map(([id, c]) => [id, c.repo]));

if (argv.includes('--json')) {
  console.log(JSON.stringify({ day, generatedAt: new Date().toISOString(), limits: usage.usage ?? null, limitsError: usage.error ?? null, summary: { ...summary, failures: undefined }, runs }, null, 2));
} else if (argv.includes('--markdown')) {
  process.stdout.write(toMarkdown({ day, runs, summary, usage, repos }));
} else {
  console.log(toText({ day, runs, summary, usage, color: process.stdout.isTTY }));
}
