/**
 * Coleta de dados do monitor: sessões gravadas pelo hook, processos (CPU/memória) e transcripts.
 */
import { execFile } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { SESSIONS_DIR } from './hook.mjs';

const KEEP_MS = 24 * 3600_000;
export const STALE_MS = 10 * 60_000;

function isAlive(pid) {
  if (!pid) return null; // desconhecido
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function origin(s) {
  if (s.agent) return 'despachante';
  if (s.entrypoint === 'claude-desktop') return 'desktop';
  if (s.entrypoint === 'cli') return 'terminal';
  if (s.entrypoint?.startsWith('sdk')) return 'headless';
  return s.entrypoint || '?';
}

/** Sessões registradas pelo hook, ativas primeiro. Apaga as terminadas há mais de 24 h. */
export function loadSessions(now = Date.now()) {
  let files = [];
  try { files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const sessions = [];
  for (const f of files) {
    const file = join(SESSIONS_DIR, f);
    let s;
    try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const alive = isAlive(s.claudePid);
    const finished = s.state === 'encerrada' || alive === false;
    if (finished && s.state !== 'encerrada') s.state = 'morta';
    if (finished && now - Date.parse(s.lastEventAt) > KEEP_MS) { try { unlinkSync(file); } catch { } continue; }
    s.active = !finished;
    s.stale = s.active && ['pensando', 'executando'].includes(s.state) && now - Date.parse(s.lastEventAt) > STALE_MS;
    sessions.push(s);
  }
  return sessions.sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt));
}

// ---------------- transcript ----------------

const TAIL_BYTES = 512 * 1024;
const transcriptCache = new Map();

function oneLine(text, max = 400) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function toolLabel(name, input = {}) {
  const i = input ?? {};
  const detail = i.description || i.command || (i.file_path && win32.basename(String(i.file_path))) || i.skill || i.pattern || i.url || i.query || '';
  return detail ? `${name}: ${oneLine(detail, 160)}` : name;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? '').join(' ');
  return '';
}

/**
 * Converte linhas JSONL do transcript em eventos legíveis (função pura; testada).
 * kind: prompt | texto | ferramenta | erro
 */
export function parseTranscript(lines) {
  const out = { events: [], title: null, model: null, contextTokens: null, outputTokens: 0 };
  for (const line of lines) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'custom-title' && j.customTitle) out.title = j.customTitle;
    else if (j.type === 'agent-name' && j.agentName && !out.title) out.title = j.agentName;
    if (j.isSidechain) continue;
    const ts = j.timestamp;
    const content = j.message?.content;
    if (j.type === 'user') {
      if (typeof content === 'string') {
        // mensagens internas (comandos, lembretes do sistema) começam com tags
        if (!content.trimStart().startsWith('<')) out.events.push({ ts, kind: 'prompt', text: oneLine(content) });
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && !String(c.text).trimStart().startsWith('<')) out.events.push({ ts, kind: 'prompt', text: oneLine(c.text) });
          if (c.type === 'tool_result' && c.is_error) out.events.push({ ts, kind: 'erro', text: oneLine(resultText(c.content), 200) });
        }
      }
    } else if (j.type === 'assistant' && Array.isArray(content)) {
      if (j.requestedModel || j.message?.model) out.model = j.message?.model || j.requestedModel;
      const u = j.message?.usage;
      if (u) {
        out.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      }
      for (const c of content) {
        if (c.type === 'text' && c.text?.trim()) out.events.push({ ts, kind: 'texto', text: oneLine(c.text) });
        if (c.type === 'tool_use') out.events.push({ ts, kind: 'ferramenta', text: toolLabel(c.name, c.input) });
      }
    }
  }
  return out;
}

/** Lê o fim do transcript (com cache pelo tamanho do arquivo). */
export function readTranscript(path) {
  if (!path) return null;
  let size;
  try { size = statSync(path).size; } catch { return null; }
  const cached = transcriptCache.get(path);
  if (cached && cached.size === size) return cached.data;
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift(); // primeira linha pode estar cortada
  const data = parseTranscript(lines.filter(Boolean));
  // título e modelo não mudam quando saem da janela lida
  if (cached) { data.title ??= cached.data.title; data.model ??= cached.data.model; }
  transcriptCache.set(path, { size, data });
  return data;
}

// ---------------- processos ----------------

const PS_SCRIPT = [
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '  $cmd = if ($_.Name -eq "claude.exe") { $_.CommandLine } else { "" }',
  '  [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; m = $_.WorkingSetSize;',
  '    c = [int64]$_.UserModeTime + [int64]$_.KernelModeTime; s = if ($_.CreationDate) { $_.CreationDate.ToString("o") } else { "" }; cmd = $cmd }',
  '} | ConvertTo-Json -Compress',
].join('\n');

/** Uma amostra de todos os processos (assíncrona, ~0,5–1 s no Windows). */
export function sampleProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const list = JSON.parse(stdout);
          const procs = new Map();
          for (const p of list) procs.set(p.p, { pid: p.p, ppid: p.pp, name: p.n, mem: p.m, cpu: p.c, started: p.s, cmd: p.cmd });
          resolve({ at: Date.now(), procs });
        } catch { resolve(null); }
      });
  });
}

/** Soma memória e tempo de CPU do processo e de todos os descendentes (testes, servidores…). */
export function treeTotals(procs, rootPid) {
  const children = new Map();
  for (const p of procs.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  let mem = 0, cpu = 0, count = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid) || !procs.has(pid)) continue;
    seen.add(pid);
    const p = procs.get(pid);
    mem += p.mem; cpu += p.cpu; count++;
    // o Windows reaproveita PIDs: filho "mais velho" que o pai é órfão de outro processo
    for (const c of children.get(pid) ?? []) if (!(Date.parse(procs.get(c).started) < Date.parse(p.started))) stack.push(c);
  }
  return { mem, cpu, count };
}

/** Processos do Claude Code (exclui os processos internos do app desktop Electron). */
export function claudeProcesses(sample) {
  if (!sample) return [];
  return [...sample.procs.values()].filter((p) => p.name?.toLowerCase() === 'claude.exe' && p.cmd && !/WindowsApps/i.test(p.cmd));
}

/**
 * Processos do Claude Code que o hook ainda não registrou. Ignora os recém-abertos (o primeiro evento
 * do hook leva alguns segundos) e os filhos de uma sessão já monitorada.
 */
export function untrackedProcesses(sample, trackedPids, minAgeMs = 20_000) {
  return claudeProcesses(sample).filter((p) => !trackedPids.has(p.pid) && !trackedPids.has(p.ppid) &&
    !(sample.at - Date.parse(p.started) < minAgeMs));
}
