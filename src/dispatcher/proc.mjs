/**
 * Processos no Windows: achar o CLI do Claude Code, verificar e encerrar árvores de processo.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function versionKey(v) {
  return v.split('.').map((n) => String(Number(n) || 0).padStart(6, '0')).join('.');
}

/** CLI do Claude Code: o do PATH (fora do WindowsApps) ou o embutido no app desktop (versão mais nova). */
export function findClaude() {
  try {
    const found = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/WindowsApps/i.test(s) && /\.(exe|cmd)$/i.test(s));
    if (found.length) return found[0];
  } catch { /* não está no PATH */ }
  const base = join(process.env.APPDATA ?? '', 'Claude', 'claude-code');
  if (!existsSync(base)) return null;
  const versions = readdirSync(base).sort((a, b) => versionKey(a).localeCompare(versionKey(b)));
  for (const v of versions.reverse()) {
    for (const build of readdirSync(join(base, v))) {
      const exe = join(base, v, build, 'claude.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

export function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve());
  });
}

function processTable() {
  return new Promise((resolve) => {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString(\'o\') }),$($_.Name)" }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      resolve(out.split(/\r?\n/).filter(Boolean).map((l) => {
        const [pid, ppid, started, name] = l.split(',');
        return { pid: Number(pid), ppid: Number(ppid), started: Date.parse(started), name: (name ?? '').toLowerCase() };
      }));
    });
  });
}

const CHAIN_NAMES = new Set(['node.exe', 'cmd.exe', 'bash.exe', 'sh.exe', 'conhost.exe']);

/**
 * Raiz da cadeia que mantém um servidor de agente vivo (função pura; testada): sobe pelos pais enquanto
 * forem node/cmd/shell, parando antes do claude.exe, do próprio despachante ou de um pai que já morreu.
 * Ex.: npm run dev → cmd → node scripts/dev.mjs → wrangler → workerd. Matar só o workerd não basta: o
 * wrangler o recria.
 */
export function chainRoot(table, pid, selfPid = process.pid) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  let root = pid;
  for (let i = 0; i < 10; i++) {
    const parent = byPid.get(byPid.get(root)?.ppid);
    if (!parent || parent.pid === selfPid || !CHAIN_NAMES.has(parent.name)) break;
    root = parent.pid;
  }
  return root;
}

/** Descendentes de `rootPid` criados depois de `sinceMs` (o Windows reaproveita PIDs; isso evita pegar processos alheios). */
export function descendants(table, rootPid, sinceMs) {
  const found = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    for (const p of table) {
      if (p.ppid === pid && p.started >= sinceMs && !found.includes(p.pid)) { found.push(p.pid); stack.push(p.pid); }
    }
  }
  return found;
}

/**
 * Encerra a árvore da execução, incluindo órfãos que sobreviveram ao claude.exe (servidores
 * de desenvolvimento, Playwright) e ainda prendem as portas da faixa.
 */
export async function killJobTree(rootPid, sinceMs, { killRoot = false } = {}) {
  const table = await processTable();
  const pids = descendants(table, rootPid, sinceMs - 5000);
  // depois que o claude.exe saiu, o PID dele pode já ser de outro processo: só mata a raiz se pedido
  if (killRoot && isAlive(rootPid)) await killTree(rootPid);
  for (const pid of pids) if (isAlive(pid)) await killTree(pid);
  return pids.length;
}

/** Processos escutando nas portas: [{ port, pid, cmd }]. */
export function portListeners(ports) {
  return new Promise((resolve) => {
    if (!ports.length) return resolve([]);
    const script = 'Get-NetTCPConnection -State Listen -LocalPort ' + ports.join(',') + ' -ErrorAction SilentlyContinue | ForEach-Object { '
      + '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"; "$($_.LocalPort)`t$($_.OwningProcess)`t$($p.CommandLine)" }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 }, (err, out) => {
      if (err && !out) return resolve([]);
      resolve(String(out).split(/\r?\n/).filter(Boolean).map((l) => {
        const [port, pid, ...cmd] = l.split('\t');
        return { port: Number(port), pid: Number(pid), cmd: cmd.join('\t') };
      }));
    });
  });
}

/**
 * Donos das portas da faixa que vieram dos worktrees de agentes (função pura; testada).
 * As portas de uma faixa são exclusivas dela: servidor de agente ainda escutando ali é sobra de uma
 * execução anterior, mesmo quando a árvore de processos se quebrou (shell intermediário já encerrado).
 * Processos de fora da pasta dos worktrees nunca entram.
 */
export function strayLaneOwners(listeners, worktreesDir) {
  const norm = (s) => String(s).replaceAll('\\', '/').toLowerCase();
  const dir = `${norm(worktreesDir).replace(/\/+$/, '')}/`;
  return [...new Set(listeners.filter((l) => norm(l.cmd).includes(dir)).map((l) => l.pid))];
}

/** Encerra servidores de agentes que sobraram nas portas da faixa, com a cadeia que os recria; devolve quantos. */
export async function freeLanePorts(ports, worktreesDir) {
  const pids = strayLaneOwners(await portListeners(ports), worktreesDir);
  if (!pids.length) return 0;
  const table = await processTable();
  for (const root of new Set(pids.map((pid) => chainRoot(table, pid)))) await killTree(root);
  return pids.length;
}
