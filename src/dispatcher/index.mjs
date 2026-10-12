#!/usr/bin/env node
/**
 * Despachante contínuo dos agentes do Claude Code.
 *
 * Fica rodando (iniciado no logon pelo Agendador de Tarefas) e consulta o GitHub de cada projeto de
 * config.local.json a cada poucos segundos, com ETag. Quando uma issue/PR espera uma função (etiqueta de
 * fase definida no .agents/config.json do projeto), roda `claude -p "/<função> <n>"` num worktree dedicado,
 * com até `maxTotal` execuções em paralelo (somando todos os projetos), cada uma com portas próprias.
 * Parado, não consome cota da assinatura.
 *
 *   npm run despachante               roda continuamente (Ctrl+C para parar)
 *   npm run despachante:teste         mostra o que seria executado agora e sai (--dry-run)
 *   --only <função>   restringe a uma função          --max <n>   muda o limite de paralelismo
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOG_DIR, MAX_RUNS_WITHOUT_PROGRESS, PROJECT_REFRESH_MIN, RETRY_COOLDOWN_MIN, STATE_DIR, loadMachineConfig,
} from './config.mjs';
import { GitHub, findGh } from './github.mjs';
import { findClaude, isAlive, killJobTree } from './proc.mjs';
import { autoPrompt, lanePorts, normalizeProjectConfig, rolePermissionsFile } from './project.mjs';
import { classifyError, freeSlot, interleave, madeProgress, pickJobs, recordRun } from './select.mjs';

// ---------------- argumentos e configuração ----------------
const argv = process.argv.slice(2);
const argValue = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = argv.includes('--dry-run');
const ONLY = argValue('--only');

let machine;
try { machine = loadMachineConfig(); } catch (e) { console.error(e.message); process.exit(2); }
const MAX = Number(argValue('--max') ?? machine.maxTotal);

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const FILES = {
  daemon: join(STATE_DIR, 'daemon.json'),
  jobs: join(STATE_DIR, 'jobs.json'),
  history: join(STATE_DIR, 'history.json'),
  pause: join(STATE_DIR, 'paused-until.txt'),
};
const RETRY = { cooldownMin: RETRY_COOLDOWN_MIN, maxRuns: MAX_RUNS_WITHOUT_PROGRESS };

// ---------------- utilidades ----------------
function log(msg) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const line = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${msg}`;
  console.log(line);
  try { appendFileSync(join(LOG_DIR, 'dispatcher.log'), line + '\n'); } catch { /* log nunca derruba o despachante */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) { writeFileSync(file, JSON.stringify(data, null, 2)); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kindOf = (isPr) => (isPr ? 'PR' : 'issue');

async function safe(what, fn) {
  try { return await fn(); } catch (e) { log(`AVISO: ${what}: ${e.message}`); return undefined; }
}

// o Bash dos agentes herda este PATH: garante o gh
const ghPath = findGh();
if (ghPath !== 'gh') process.env.Path = `${join(ghPath, '..')};${process.env.Path ?? process.env.PATH ?? ''}`;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.message = `${cmd} ${args.join(' ')}: ${(stderr || err.message).trim().split('\n').at(-1)}`; return reject(err); }
      resolve(stdout);
    });
  });
}

/** git com novas tentativas: agentes em outros worktrees também mexem no .git compartilhado. */
async function git(args) {
  for (let attempt = 1; ; attempt++) {
    try { return await run('git', args); } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

// operações de git do despachante, uma de cada vez
let gitChain = Promise.resolve();
function withGitLock(fn) {
  const p = gitChain.then(fn, fn);
  gitChain = p.catch(() => { });
  return p;
}

function pausedUntil() {
  if (!existsSync(FILES.pause)) return null;
  const until = Date.parse(readFileSync(FILES.pause, 'utf8').trim());
  if (!(until > Date.now())) { try { unlinkSync(FILES.pause); } catch { } return null; }
  return until;
}

// ---------------- projetos ----------------
/** id → { cfg, gh, extraPrompt, waitingCache } */
const projects = new Map();
const projectErrors = new Map();

async function loadProject(entry) {
  const ref = `origin/${entry.branch}`;
  await withGitLock(() => git(['-C', entry.path, 'fetch', '-q', 'origin', entry.branch])).catch((e) => log(`AVISO: git fetch em ${entry.path}: ${e.message}`));
  const raw = JSON.parse(await git(['-C', entry.path, 'show', `${ref}:.agents/config.json`]));
  const cfg = normalizeProjectConfig(raw, entry);
  const extraPrompt = await git(['-C', entry.path, 'show', `${ref}:.agents/prompt.md`]).catch(() => '');
  return { cfg, extraPrompt };
}

async function refreshProjects() {
  for (const entry of machine.projects) {
    try {
      const { cfg, extraPrompt } = await loadProject(entry);
      const prev = projects.get(cfg.id);
      projects.set(cfg.id, {
        cfg, extraPrompt,
        gh: prev?.cfg.repo === cfg.repo ? prev.gh : new GitHub(cfg.repo),
        waitingCache: prev?.waitingCache ?? new Map(),
      });
      if (projectErrors.has(entry.path)) { log(`Projeto ${cfg.id} carregado de novo.`); projectErrors.delete(entry.path); }
    } catch (e) {
      // mantém a última configuração boa; avisa uma vez por erro
      if (projectErrors.get(entry.path) !== e.message) log(`ERRO no projeto ${entry.path}: ${e.message}`);
      projectErrors.set(entry.path, e.message);
    }
  }
}

const labelCfg = (cfg) => ({ owner: cfg.owner, bot: cfg.bot.login, working: cfg.labels.working, waiting: cfg.labels.waiting });
const rolesOf = (cfg) => (ONLY ? cfg.roles.filter((r) => r.name === ONLY) : cfg.roles);

// ---------------- estado ----------------
let running = [];
let history = readJson(FILES.history, {});

const JOB_FIELDS = ['project', 'role', 'number', 'title', 'isPr', 'lane', 'slot', 'pid', 'startedAt', 'timeoutMin', 'logFile', 'labeled', 'status', 'legacy'];
function saveJobs() {
  writeJson(FILES.jobs, running.map((j) => Object.fromEntries(JOB_FIELDS.filter((k) => j[k] !== undefined).map((k) => [k, j[k]]))));
}
function saveHistory() { writeJson(FILES.history, history); }

/** Itens 'aguardando' em que o dono já respondeu (cache pelo updated_at do item). */
async function resolveWaiting(p, items) {
  const { cfg, gh, waitingCache } = p;
  const resolved = new Set();
  for (const it of items) {
    if (!it.labels.includes(cfg.labels.waiting) || !cfg.roles.some((r) => it.labels.includes(r.label))) continue;
    if (it.author !== cfg.owner && it.author !== cfg.bot.login) continue;
    if (waitingCache.get(it.number)?.updatedAt !== it.updatedAt) {
      const since = await gh.labelAddedAt(it.number, cfg.labels.waiting);
      waitingCache.set(it.number, { updatedAt: it.updatedAt, resolved: await gh.ownerRepliedAfter(it.number, since, it.isPr, cfg.owner) });
    }
    if (waitingCache.get(it.number).resolved) resolved.add(it.number);
  }
  return resolved;
}

// ---------------- worktree ----------------
async function prepareWorktree(cfg, roleName, slot) {
  const wt = join(cfg.worktreesDir, `${roleName}-${slot}`);
  const ref = `origin/${cfg.branch}`;
  await withGitLock(async () => {
    if (!existsSync(wt)) {
      mkdirSync(cfg.worktreesDir, { recursive: true });
      await git(['-C', cfg.path, 'worktree', 'prune']);
      await git(['-C', cfg.path, 'fetch', '-q', 'origin']);
      await git(['-C', cfg.path, 'worktree', 'add', '-q', '--detach', wt, ref]);
    }
    await git(['-C', wt, 'fetch', '-q', 'origin']);
    await git(['-C', wt, 'reset', '-q', '--hard']);
    await git(['-C', wt, 'clean', '-q', '-fd']); // sem -x: mantém ignorados (node_modules, build)
    await git(['-C', wt, 'switch', '-q', '--detach', ref]);
    await git(['-C', wt, 'config', 'user.name', cfg.bot.login]);
    await git(['-C', wt, 'config', 'user.email', cfg.bot.email]);
  });
  if (cfg.setup?.command) {
    const watched = cfg.setup.whenChanged ? join(wt, cfg.setup.whenChanged) : null;
    const hash = watched && existsSync(watched) ? createHash('sha256').update(readFileSync(watched)).digest('hex') : 'sempre';
    const marker = join(STATE_DIR, 'setup', `${cfg.id}-${roleName}-${slot}.hash`);
    if (hash === 'sempre' || readJson(marker, null) !== hash) {
      log(`Preparando ${wt}: ${cfg.setup.command}`);
      await run(cfg.setup.command, [], { cwd: wt, shell: true, timeout: 30 * 60_000 });
      mkdirSync(join(STATE_DIR, 'setup'), { recursive: true });
      writeJson(marker, hash);
    }
  }
  return wt;
}

// ---------------- execuções ----------------
const jobName = (j) => `${j.project}: /${j.role} ${j.number}`;

async function startJob(p, role, item) {
  const { cfg, gh } = p;
  const job = {
    project: cfg.id, role: role.name, number: item.number, title: item.title, isPr: item.isPr, timeoutMin: role.timeoutMin,
    lane: freeSlot(running.map((j) => j.lane)),
    slot: freeSlot(running.filter((j) => j.project === cfg.id && j.role === role.name).map((j) => j.slot)),
    startedAt: Date.now(), status: 'preparando', labeled: false,
  };
  running.push(job); // reserva antes de qualquer await: a próxima consulta já vê o item ocupado
  saveJobs();
  log(`Trabalho: ${jobName(job)} (${kindOf(item.isPr)}: ${item.title}) — faixa ${job.lane}, ${running.length}/${MAX} em uso`);
  try {
    if (item.labels.includes(cfg.labels.waiting)) {
      log(`${cfg.id} #${item.number}: @${cfg.owner} respondeu; retomando.`);
      await gh.removeLabel(item.number, cfg.labels.waiting);
    }
    const wt = await prepareWorktree(cfg, role.name, job.slot);
    const permissions = rolePermissionsFile(wt, role.name);
    if (!existsSync(permissions)) throw new Error(`falta ${permissions} (permissões da função).`);
    const claude = findClaude();
    if (!claude) throw new Error('Claude Code CLI não encontrado.');
    const ports = lanePorts(cfg, job.lane);
    await gh.addLabel(item.number, cfg.labels.working);
    job.labeled = true;

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    mkdirSync(join(LOG_DIR, cfg.id), { recursive: true });
    job.logFile = join(LOG_DIR, cfg.id, `${stamp}-${role.name}-${item.number}.json`);
    const promptFile = join(STATE_DIR, `prompt-${job.lane}.txt`);
    writeFileSync(promptFile, autoPrompt(cfg, ports, p.extraPrompt));
    const out = openSync(job.logFile, 'w');
    const err = openSync(`${job.logFile}.err`, 'w');
    const child = spawn(claude, [
      '-p', `/${role.name} ${item.number}`,
      '--settings', permissions,
      '--append-system-prompt-file', promptFile,
      ...cfg.addDirs.flatMap((d) => ['--add-dir', d]),
      '--output-format', 'json',
    ], {
      cwd: wt,
      stdio: ['ignore', out, err],
      windowsHide: true,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, String(v)])),
        CLAUDE_AGENT_TASK: `${role.name} ${item.number}`,
        CLAUDE_AGENT_PROJECT: cfg.id,
      },
    });
    closeSync(out);
    closeSync(err);
    job.pid = child.pid;
    job.startedAt = Date.now();
    job.status = 'rodando';
    saveJobs();
    child.on('exit', () => finalize(job));
    child.on('error', (e) => { log(`ERRO: ${jobName(job)}: ${e.message}`); finalize(job); });
    job.timer = setTimeout(() => timeoutJob(job), role.timeoutMin * 60_000);
  } catch (e) {
    log(`ERRO ao iniciar ${jobName(job)}: ${e.message}`);
    if (job.labeled) await safe('remover etiqueta', () => gh.removeLabel(item.number, cfg.labels.working));
    history[cfg.id] = recordRun(history[cfg.id] ?? {}, item.number, role.name, false, Date.now(), RETRY).history;
    saveHistory();
    running = running.filter((j) => j !== job);
    saveJobs();
  }
}

async function timeoutJob(job) {
  if (job.finalized || job.timedOut) return;
  job.timedOut = true;
  log(`TIMEOUT: ${jobName(job)} passou de ${job.timeoutMin} min e foi encerrado.`);
  await killJobTree(job.pid, job.startedAt, { killRoot: true });
  if (job.adopted) finalize(job); // sem processo filho, não há evento de saída
}

function readResult(logFile) {
  if (!logFile) return null;
  try { return JSON.parse(readFileSync(logFile, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

async function finalize(job) {
  if (job.finalized) return;
  job.finalized = true;
  clearTimeout(job.timer);
  const name = jobName(job);
  const p = projects.get(job.project);
  try {
    if (job.pid) {
      const leftovers = await killJobTree(job.pid, job.startedAt);
      if (leftovers) log(`${name}: ${leftovers} processo(s) que sobraram encerrados (servidores, navegador).`);
    }
    if (!p) { log(`AVISO: ${name}: projeto não carregado; etiquetas não atualizadas.`); return; }
    const { cfg, gh } = p;
    if (job.timedOut) {
      await safe('comentar timeout', () => gh.comment(job.number, `**[Automação]** A função ${job.role} excedeu ${job.timeoutMin} min e foi interrompida. @${cfg.owner}, veja os logs locais.`));
      await safe('etiqueta aguardando', () => gh.addLabel(job.number, cfg.labels.waiting));
    } else {
      const result = readResult(job.logFile);
      if (result?.is_error) {
        const text = String(result.result ?? '');
        log(`ERRO: ${name}: ${text}`);
        const kind = classifyError(text);
        if (kind) {
          writeFileSync(FILES.pause, new Date(Date.now() + kind.pauseMin * 60_000).toISOString());
          log(`${kind.reason} Pausado por ${kind.pauseMin} min (execuções em andamento continuam).`);
        }
      } else if (result) {
        log(`OK: ${name}: ${result.result}`);
      } else {
        log(`Saída inesperada de ${name}; veja ${job.logFile ?? 'os logs'}`);
      }
    }
    if (job.labeled !== false) await safe('remover etiqueta', () => gh.removeLabel(job.number, cfg.labels.working));

    const role = cfg.roles.find((r) => r.name === job.role);
    const after = await safe(`ler #${job.number}`, () => gh.getIssue(job.number));
    // timeout já chamou o dono; sem conseguir ler o item (ou sem a função na config), não conta como falha
    const progressed = job.timedOut || after === undefined || !role || madeProgress(after, role, cfg.labels.waiting);
    const r = recordRun(history[cfg.id] ?? {}, job.number, job.role, progressed, Date.now(), RETRY);
    history[cfg.id] = r.history;
    saveHistory();
    if (r.escalate) {
      log(`${name}: ${MAX_RUNS_WITHOUT_PROGRESS} execuções seguidas sem avançar; chamando @${cfg.owner}.`);
      await safe('comentar', () => gh.comment(job.number, `**[Automação]** A função ${job.role} rodou ${MAX_RUNS_WITHOUT_PROGRESS} vezes seguidas sem avançar a fase. @${cfg.owner}, veja os logs locais e comente aqui para retomar.`));
      await safe('etiqueta aguardando', () => gh.addLabel(job.number, cfg.labels.waiting));
    } else if (!progressed) {
      log(`${name}: terminou sem avançar a fase; nova tentativa em ${RETRY_COOLDOWN_MIN} min.`);
    }
  } catch (e) {
    log(`ERRO ao finalizar ${name}: ${e.message}`);
  } finally {
    running = running.filter((j) => j !== job);
    saveJobs();
    tick(true); // vaga liberada: consulta de novo, ignorando o ETag (as etiquetas acabaram de mudar)
  }
}

// ---------------- ciclo ----------------
let ticking = false;
let again = false;
let forceNext = false;
const lastErrors = new Map();
let pauseLogged = 0;

function logThrottled(key, msg) {
  // sem rede, GitHub fora etc.: registra uma vez a cada 10 min
  const last = lastErrors.get(key);
  if (last?.msg === msg && Date.now() - last.at < 10 * 60_000) return;
  log(msg);
  lastErrors.set(key, { msg, at: Date.now() });
}

/** Candidatos de cada projeto, já filtrados pelas regras e pelo histórico. */
async function candidatesFor(p, items, freeSlots, runningJobs) {
  const mine = runningJobs.filter((j) => j.project === p.cfg.id);
  return pickJobs({
    items, running: mine, roles: rolesOf(p.cfg), maxTotal: mine.length + freeSlots, maxPerRole: p.cfg.maxPerRole,
    history: history[p.cfg.id] ?? {}, now: Date.now(), cfg: labelCfg(p.cfg), waitingResolved: await resolveWaiting(p, items),
  }).map((c) => ({ ...c, project: p }));
}

async function tick(force = false) {
  if (ticking) { again = true; forceNext ||= force; return; }
  ticking = true;
  try {
    for (const j of running) {
      if (!j.adopted || j.finalized) continue;
      if (!isAlive(j.pid)) finalize(j);
      else if (Date.now() - j.startedAt > j.timeoutMin * 60_000) timeoutJob(j);
    }
    const listed = [];
    for (const p of projects.values()) {
      try {
        listed.push({ p, items: (await p.gh.listOpen({ force })).items });
        lastErrors.delete(p.cfg.id);
      } catch (e) { logThrottled(p.cfg.id, `ERRO na consulta de ${p.cfg.id}: ${e.message}`); }
    }
    const until = pausedUntil();
    if (until) {
      if (pauseLogged !== until) { log(`Pausado até ${new Date(until).toLocaleString('pt-BR')}.`); pauseLogged = until; }
      return;
    }
    const free = MAX - running.length;
    if (free <= 0) return;
    const lists = [];
    for (const { p, items } of listed) {
      try { lists.push(await candidatesFor(p, items, free, running)); } catch (e) { logThrottled(`${p.cfg.id}:waiting`, `ERRO em ${p.cfg.id}: ${e.message}`); }
    }
    for (const c of interleave(lists, free)) startJob(c.project, c.role, c.item);
  } finally {
    ticking = false;
    if (again) {
      const f = forceNext;
      again = false;
      forceNext = false;
      setImmediate(() => tick(f));
    }
  }
}

// ---------------- início ----------------
async function adoptPreviousJobs() {
  const dead = [];
  for (const j of readJson(FILES.jobs, [])) {
    const job = { ...j, adopted: true };
    if (job.pid && isAlive(job.pid)) {
      running.push(job);
      log(`Retomando acompanhamento de ${jobName(job)} (PID ${job.pid}).`);
    } else if (job.pid) {
      running.push(job);
      dead.push(job); // terminou com o despachante desligado
    } else if (job.labeled && projects.has(job.project)) {
      const p = projects.get(job.project);
      await safe('remover etiqueta', () => p.gh.removeLabel(job.number, p.cfg.labels.working));
    }
  }
  // migração: execução em andamento do despachante antigo que ficava dentro do TableHub (dispatcher.ps1)
  for (const p of projects.values()) {
    const legacy = readJson(join(p.cfg.path, 'automation', 'state', 'running.json'), null);
    if (legacy?.pid && isAlive(legacy.pid) && !running.some((j) => j.project === p.cfg.id && j.number === legacy.number)) {
      running.push({
        project: p.cfg.id, role: legacy.role, number: legacy.number, pid: legacy.pid, startedAt: Date.parse(legacy.started),
        timeoutMin: legacy.timeoutMin, lane: freeSlot(running.map((j) => j.lane)), slot: 0, labeled: true, adopted: true, legacy: true,
      });
      log(`Acompanhando execução do despachante antigo: ${p.cfg.id}: /${legacy.role} ${legacy.number} (PID ${legacy.pid}).`);
    }
  }
  saveJobs();
  for (const j of dead) finalize(j);
}

async function clearStaleLabels() {
  for (const p of projects.values()) {
    const { items } = await p.gh.listOpen({ force: true });
    for (const it of items) {
      if (it.labels.includes(p.cfg.labels.working) && !running.some((j) => j.project === p.cfg.id && j.number === it.number)) {
        log(`${p.cfg.id} #${it.number}: etiqueta '${p.cfg.labels.working}' sem execução ativa; removida.`);
        await safe('remover etiqueta', () => p.gh.removeLabel(it.number, p.cfg.labels.working));
      }
    }
  }
}

async function dryRun() {
  await refreshProjects();
  if (!projects.size) { console.log('Nenhum projeto carregado (veja os erros acima).'); process.exitCode = 1; return; }
  const previous = readJson(FILES.jobs, []).filter((j) => isAlive(j.pid));
  const free = Math.max(0, MAX - previous.length);
  const lists = [];
  for (const p of projects.values()) {
    const { items } = await p.gh.listOpen();
    console.log(`${p.cfg.id} (${p.cfg.repo}): ${items.length} itens abertos; funções: ${p.cfg.roles.map((r) => r.name).join(', ')}.`);
    lists.push(await candidatesFor(p, items, free, previous));
  }
  console.log(`${previous.length} execução(ões) em andamento; limite ${MAX}.`);
  const until = pausedUntil();
  if (until) console.log(`Pausado até ${new Date(until).toLocaleString('pt-BR')}.`);
  const picks = interleave(lists, free);
  if (!picks.length) console.log('Nada a executar agora.');
  for (const c of picks) console.log(`Executaria: ${c.project.cfg.id}: /${c.role.name} ${c.item.number} (${kindOf(c.item.isPr)}: ${c.item.title})`);
}

async function main() {
  if (DRY) { await dryRun(); return; }

  const other = readJson(FILES.daemon, null);
  if (other?.pid && other.pid !== process.pid && isAlive(other.pid)) {
    console.log(`Outro despachante já está rodando (PID ${other.pid}).`);
    return;
  }
  writeJson(FILES.daemon, { pid: process.pid, startedAt: new Date().toISOString() });
  const stop = (why) => {
    log(`Despachante encerrado (${why}); execuções em andamento continuam e serão retomadas no próximo início.`);
    try { if (readJson(FILES.daemon, {}).pid === process.pid) unlinkSync(FILES.daemon); } catch { }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('Ctrl+C'));
  process.on('SIGTERM', () => stop('sinal'));
  process.on('SIGBREAK', () => stop('janela fechada'));
  process.on('unhandledRejection', (e) => log(`ERRO inesperado: ${e?.stack ?? e}`));
  process.on('uncaughtException', (e) => { log(`ERRO fatal: ${e.stack ?? e}`); process.exit(1); });

  await refreshProjects();
  await adoptPreviousJobs();
  await safe('limpar etiquetas órfãs', clearStaleLabels);
  const names = [...projects.keys()].join(', ') || 'nenhum';
  log(`Despachante contínuo iniciado (PID ${process.pid}; projetos: ${names}; até ${MAX} em paralelo; consulta a cada ${machine.pollSeconds} s${ONLY ? `; só ${ONLY}` : ''}).`);
  tick(true);
  setInterval(() => tick(false), machine.pollSeconds * 1000);
  setInterval(() => refreshProjects(), PROJECT_REFRESH_MIN * 60_000);
}

main().catch((e) => { log(`ERRO fatal: ${e.stack ?? e.message}`); process.exit(1); });
