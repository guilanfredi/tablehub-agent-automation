/**
 * Dashboard de terminal (estilo `pm2 monit`) das instâncias do Claude Code. ANSI puro, sem dependências.
 *
 *   ┌ Sessões ──────┐┌ Atividade · <sessão selecionada> ─────────┐
 *   │ ● /dev 10     ││ 10:42:01 › pedido                          │
 *   │ ○ desktop     ││ 10:42:05 ▸ Bash: Roda os testes            │
 *   └───────────────┘└────────────────────────────────────────────┘
 *   ┌ Detalhes ─────┐┌ Métricas ──────────────────────────────────┐
 *   └───────────────┘└────────────────────────────────────────────┘
 */
import { totalmem } from 'node:os';
import { loadSessions, untrackedProcesses, origin, readTranscript, sampleProcesses, treeTotals } from './data.mjs';

// ---------------- texto e cores ----------------

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const sgr = (code) => (s) => `${ESC}${code}m${s}${RESET}`;
const c = {
  dim: sgr('2'), bold: sgr('1'), inverse: sgr('7'),
  red: sgr('31'), green: sgr('32'), yellow: sgr('33'), blue: sgr('34'), magenta: sgr('35'), cyan: sgr('36'), gray: sgr('90'),
};
const TOKEN = /\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu;

function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 32 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

/** Largura visível (ignora códigos ANSI; emoji e CJK ocupam 2 colunas). */
export function visibleWidth(s) {
  let w = 0;
  for (const t of String(s).match(TOKEN) ?? []) if (t[0] !== '\x1b') w += charWidth(t);
  return w;
}

/** Corta e completa com espaços para ocupar exatamente `w` colunas, preservando as cores. */
export function fit(s, w) {
  const cut = visibleWidth(s) > w;
  const limit = cut ? w - 1 : w;
  let out = '', used = 0, colored = false;
  for (const t of String(s).match(TOKEN) ?? []) {
    if (t[0] === '\x1b') { out += t; colored = true; continue; }
    const cw = charWidth(t);
    if (used + cw > limit) break;
    out += t; used += cw;
  }
  if (cut && w > 0) { out += '…'; used++; }
  return out + (colored ? RESET : '') + ' '.repeat(Math.max(0, w - used));
}

/** Quebra texto simples em linhas de até `w` colunas. */
export function wrap(text, w) {
  if (w <= 0) return [];
  const lines = [];
  let line = '', lw = 0;
  for (const word of String(text).split(' ')) {
    const ww = visibleWidth(word);
    if (lw && lw + 1 + ww > w) { lines.push(line); line = ''; lw = 0; }
    if (ww > w) {
      for (const ch of word) {
        const cw = charWidth(ch);
        if (lw + cw > w) { lines.push(line); line = ''; lw = 0; }
        line += ch; lw += cw;
      }
      continue;
    }
    line += (lw ? ' ' : '') + word; lw += (lw ? 1 : 0) + ww;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');

function ago(iso, now) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour12: false }) : '--:--:--');
const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const SPARK = '▁▂▃▄▅▆▇█';
/** Mini gráfico; sem `max`, usa a escala mínimo→máximo da janela (bom para memória). */
export function sparkline(values, width, max) {
  const vals = values.slice(-width);
  if (!vals.length) return '';
  const lo = max === undefined ? Math.min(...vals) : 0;
  const hi = max ?? Math.max(...vals);
  if (hi <= lo) return SPARK[max === undefined ? 3 : 0].repeat(vals.length);
  return vals.map((v) => SPARK[Math.min(7, Math.max(0, Math.round(((v - lo) / (hi - lo)) * 7)))]).join('');
}

function bar(fraction, width, color) {
  const f = Math.min(1, Math.max(0, fraction));
  const full = Math.round(f * width);
  return color('█'.repeat(full)) + c.gray('░'.repeat(width - full));
}

// ---------------- painéis ----------------

function panel(w, h, title, lines, focused) {
  const border = focused ? c.cyan : c.gray;
  const t = title ? ` ${title} ` : '';
  const top = border('┌─') + c.bold(fit(t, Math.min(visibleWidth(t), w - 4))) +
    border('─'.repeat(Math.max(0, w - 3 - Math.min(visibleWidth(t), w - 4))) + '┐');
  const out = [top];
  for (let i = 0; i < h - 2; i++) out.push(border('│') + fit(lines[i] ?? '', w - 2) + border('│'));
  out.push(border('└' + '─'.repeat(w - 2) + '┘'));
  return out;
}

const STATE = {
  executando: { color: c.green, dot: '●', short: 'executando' },
  pensando: { color: c.cyan, dot: '●', short: 'pensando' },
  iniciando: { color: c.cyan, dot: '●', short: 'iniciando' },
  aguardando: { color: c.yellow, dot: '●', short: 'aguardando' },
  ocioso: { color: c.gray, dot: '○', short: 'ocioso' },
  encerrada: { color: c.gray, dot: '·', short: 'encerrada' },
  morta: { color: c.red, dot: '✗', short: 'morta' },
  'sem hook': { color: c.magenta, dot: '?', short: 'sem hook' },
};

function itemName(it, transcript) {
  if (it.untracked) {
    const prompt = it.cmd?.match(/-p\s+"([^"]+)"/)?.[1];
    return prompt ? `-p ${prompt}` : `PID ${it.pid}`;
  }
  if (it.agent) return `${it.project ? `${it.project} ` : ''}/${it.agent}`;
  if (transcript?.title) return transcript.title;
  const cwd = String(it.cwd ?? '?').replace(/[\\/]+$/, '');
  return cwd.split(/[\\/]/).pop();
}

// ---------------- estado do dashboard ----------------

const HISTORY = 120;

export function startDashboard() {
  const out = process.stdout;
  const stdin = process.stdin;
  const ui = { selectedId: null, showAll: false, logScroll: 0, sessions: [], items: [], sample: null, prevSample: null, metrics: new Map(), sampling: false };

  function refreshSessions() {
    ui.sessions = loadSessions();
    const shown = ui.showAll ? ui.sessions : ui.sessions.filter((s) => s.active);
    const tracked = new Set(ui.sessions.filter((s) => s.active).map((s) => s.claudePid));
    const untracked = untrackedProcesses(ui.sample, tracked)
      .map((p) => ({ untracked: true, id: `pid-${p.pid}`, pid: p.pid, claudePid: p.pid, cmd: p.cmd, startedAt: p.started, state: 'sem hook', active: true }));
    ui.items = [...shown.map((s) => ({ ...s, id: s.sessionId })), ...untracked];
    if (!ui.items.some((i) => i.id === ui.selectedId)) ui.selectedId = ui.items[0]?.id ?? null;
  }

  async function refreshProcesses() {
    if (ui.sampling) return;
    ui.sampling = true;
    const sample = await sampleProcesses();
    ui.sampling = false;
    if (!sample) return;
    ui.prevSample = ui.sample;
    ui.sample = sample;
    for (const it of ui.items) {
      if (!it.claudePid || !sample.procs.has(it.claudePid)) continue;
      const now = treeTotals(sample.procs, it.claudePid);
      const m = ui.metrics.get(it.id) ?? { cpu: [], mem: [], last: null };
      if (m.last && sample.at > m.last.at) {
        // CPU em 100 ns → ms; % de um núcleo (pode passar de 100%, como no top/pm2)
        const pct = Math.max(0, ((now.cpu - m.last.cpu) / 1e4) / (sample.at - m.last.at) * 100);
        m.cpu = [...m.cpu, pct].slice(-HISTORY);
      }
      m.mem = [...m.mem, now.mem].slice(-HISTORY);
      m.last = { at: sample.at, cpu: now.cpu };
      m.procCount = now.count;
      ui.metrics.set(it.id, m);
    }
    render();
  }

  function selected() { return ui.items.find((i) => i.id === ui.selectedId) ?? null; }

  // ---------------- desenho ----------------

  function listLines(w, h, transcripts) {
    const lines = [];
    const idx = Math.max(0, ui.items.findIndex((i) => i.id === ui.selectedId));
    const start = Math.max(0, Math.min(idx - Math.floor(h / 2), ui.items.length - h));
    for (const it of ui.items.slice(start, start + h)) {
      const st = STATE[it.state] ?? STATE.ocioso;
      const right = (it.stale ? '⚠ ' : '') + st.short;
      const name = clean(itemName(it, transcripts.get(it.id)));
      const nameW = Math.max(4, w - 3 - visibleWidth(right) - 1);
      let line = ` ${st.color(st.dot)} ${fit(name, nameW)} ${(it.stale ? c.red : st.color)(right)}`;
      if (it.id === ui.selectedId) line = c.inverse(fit(` ${st.dot} ${fit(name, nameW)} ${right}`, w));
      lines.push(line);
    }
    if (!ui.items.length) lines.push(c.dim(' nenhuma sessão'), c.dim(' instale os hooks:'), c.dim(' npm run'), c.dim(' monitor:instalar'));
    return lines;
  }

  function logLines(it, transcript, w, h) {
    if (!it) return [];
    if (it.untracked) return [c.dim('Esta instância não está mandando dados pelo hook.'), c.dim('Ela aparece no próximo evento; se não aparecer, reinicie-a.'), '', c.dim(clean(it.cmd))];
    if (!transcript) return [c.dim('Transcript ainda não disponível.')];
    const icon = { prompt: c.yellow('›'), texto: '•', ferramenta: c.cyan('▸'), erro: c.red('✗') };
    const color = { prompt: c.yellow, texto: (s) => s, ferramenta: c.cyan, erro: c.red };
    const textW = w - 11;
    const all = [];
    for (const e of transcript.events) {
      const parts = wrap(clean(e.text), textW);
      parts.forEach((p, i) => all.push(i === 0 ? `${c.gray(clock(e.ts))} ${icon[e.kind]} ${color[e.kind](p)}` : `           ${color[e.kind](p)}`));
    }
    ui.logScroll = Math.min(ui.logScroll, Math.max(0, all.length - h));
    const end = all.length - ui.logScroll;
    return all.slice(Math.max(0, end - h), end);
  }

  function detailLines(it, transcript, w, now) {
    if (!it) return [];
    const kv = (k, v) => `${c.gray(k.padEnd(9))}${v}`;
    const m = ui.metrics.get(it.id);
    const lines = [];
    const st = STATE[it.state] ?? STATE.ocioso;
    let state = st.color(it.state);
    if (it.state === 'executando' && it.toolStartedAt) state += c.dim(` há ${ago(it.toolStartedAt, now)}`);
    if (it.stale) state += c.red(` ⚠ sem atividade há ${ago(it.lastEventAt, now)}`);
    lines.push(kv('Estado', state));
    if (it.state === 'aguardando' && it.message) lines.push(kv('Aviso', c.yellow(clean(it.message))));
    else if (it.currentTool) lines.push(kv('Agora', clean(it.currentTool)));
    lines.push(kv('Origem', `${it.untracked ? 'desconhecida' : origin(it)}${it.permissionMode ? c.dim(` · modo ${it.permissionMode}`) : ''}`));
    lines.push(kv('PID', `${it.claudePid ?? '?'}${m?.procCount > 1 ? c.dim(` · ${m.procCount} processos na árvore`) : ''}`));
    if (transcript?.model) lines.push(kv('Modelo', transcript.model));
    lines.push(kv('Tempo', `${it.source || it.untracked ? 'aberta' : 'monitorada'} há ${ago(it.startedAt, now)}${it.lastEventAt ? c.dim(` · último evento há ${ago(it.lastEventAt, now)}`) : ''}`));
    if (it.cwd) {
      const cwd = clean(it.cwd);
      const max = w - 11;
      lines.push(kv('Pasta', visibleWidth(cwd) > max ? '…' + cwd.slice(-(max - 1)) : cwd));
    }
    if (it.lastPrompt) lines.push(kv('Pedido', clean(it.lastPrompt)));
    return lines;
  }

  function metricLines(it, transcript, w, now) {
    if (!it) return [];
    const m = ui.metrics.get(it.id);
    const kv = (k, v) => `${c.gray(k.padEnd(12))}${v}`;
    const barW = Math.max(8, Math.min(24, Math.floor((w - 14) / 3)));
    const sparkW = Math.max(0, w - 2 - 12 - barW - 11);
    const lines = [];
    if (m?.cpu.length) {
      const cpu = m.cpu.at(-1);
      lines.push(kv('CPU', `${bar(cpu / 100, barW, cpu > 80 ? c.red : c.green)} ${`${cpu.toFixed(0)}%`.padStart(5)}    ${c.green(sparkline(m.cpu, sparkW, Math.max(100, ...m.cpu.slice(-sparkW))))}`));
    } else lines.push(kv('CPU', c.dim('medindo…')));
    if (m?.mem.length) {
      const mem = m.mem.at(-1);
      lines.push(kv('Memória', `${bar(mem / totalmem(), barW, c.blue)} ${mb(mem).padStart(7)}  ${c.blue(sparkline(m.mem, sparkW))}`));
    } else lines.push(kv('Memória', c.dim('medindo…')));
    lines.push('');
    if (transcript?.contextTokens) lines.push(kv('Contexto', `${kTokens(transcript.contextTokens)} tokens`));
    if (it.toolCount) lines.push(kv('Ferramentas', `${it.toolCount} chamadas`));
    if (['pensando', 'executando'].includes(it.state) && it.turnStartedAt) lines.push(kv('Turno', `rodando há ${ago(it.turnStartedAt, now)}`));
    else if (it.state === 'ocioso') lines.push(kv('Turno', c.dim(`parada há ${ago(it.lastEventAt, now)}`)));
    return lines;
  }

  let lastFrame = '';
  function render() {
    const cols = Math.max(60, out.columns || 120);
    const rows = Math.max(20, out.rows || 40);
    const now = Date.now();
    const transcripts = new Map(ui.items.map((it) => [it.id, it.untracked ? null : readTranscript(it.transcriptPath)]));
    const it = selected();
    const tr = it ? transcripts.get(it.id) : null;

    const bodyH = rows - 2;
    const bottomH = Math.min(11, Math.max(9, Math.floor(bodyH * 0.35)));
    const topH = bodyH - bottomH;
    const leftW = Math.max(28, Math.min(46, Math.floor(cols * 0.3)));
    const rightW = cols - leftW;
    // embaixo, detalhes e métricas dividem a largura meio a meio
    const detailW = Math.max(36, Math.floor(cols / 2));
    const metricW = cols - detailW;

    const active = ui.sessions.filter((s) => s.active).length;
    const working = ui.sessions.filter((s) => s.active && ['pensando', 'executando'].includes(s.state)).length;
    const waiting = ui.sessions.filter((s) => s.active && s.state === 'aguardando').length;
    const headerText = ` TableHub · Monitor do Claude Code   ${active} ativa(s) · ${working} trabalhando · ${waiting} aguardando você`;
    const time = `${new Date(now).toLocaleTimeString('pt-BR', { hour12: false })} `;
    const header = c.inverse(fit(headerText, cols - visibleWidth(time)) + time);

    const name = it ? clean(itemName(it, tr)) : '';
    const scrollInfo = ui.logScroll ? c.yellow(` ↑${ui.logScroll}`) : '';
    const top = [
      panel(leftW, topH, `Sessões (${ui.items.length})`, listLines(leftW - 2, topH - 2, transcripts), true),
      panel(rightW, topH, `Atividade${name ? ' · ' + name : ''}${scrollInfo}`, logLines(it, tr, rightW - 2, topH - 2), false),
    ];
    const bottom = [
      panel(detailW, bottomH, 'Detalhes', detailLines(it, tr, detailW - 2, now), false),
      panel(metricW, bottomH, 'Métricas', metricLines(it, tr, metricW - 2, now), false),
    ];
    const keys = ` ${c.bold('↑↓')} sessão  ${c.bold('PgUp/PgDn')} rolar atividade  ${c.bold('End')} acompanhar  ${c.bold('t')} ${ui.showAll ? 'só ativas' : 'incluir encerradas'}  ${c.bold('q')} sair`;
    const lines = [header];
    for (let i = 0; i < topH; i++) lines.push(top[0][i] + top[1][i]);
    for (let i = 0; i < bottomH; i++) lines.push(bottom[0][i] + bottom[1][i]);
    lines.push(fit(c.gray(keys), cols - 1));
    const frame = `${ESC}H` + lines.join('\r\n');
    if (frame !== lastFrame) { out.write(frame); lastFrame = frame; }
  }

  // ---------------- teclado e ciclo de vida ----------------

  function move(delta) {
    const idx = ui.items.findIndex((i) => i.id === ui.selectedId);
    const next = ui.items[Math.min(ui.items.length - 1, Math.max(0, idx + delta))];
    if (next && next.id !== ui.selectedId) { ui.selectedId = next.id; ui.logScroll = 0; }
    render();
  }

  let timers = [];
  function quit(code = 0, err) {
    timers.forEach(clearInterval);
    out.write(`${ESC}?25h${ESC}?1049l`);
    if (stdin.isTTY) stdin.setRawMode(false);
    if (err) console.error(err);
    process.exit(code);
  }

  out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  process.on('uncaughtException', (e) => quit(1, e));
  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));
  out.on('resize', () => { lastFrame = ''; out.write(`${ESC}2J`); render(); });

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', (key) => {
    const page = Math.max(1, (out.rows || 40) - 16);
    if (key === 'q' || key === '\x03' || key === '\x1b') return quit(0);
    if (key === '\x1b[A' || key === 'k') return move(-1);
    if (key === '\x1b[B' || key === 'j') return move(1);
    if (key === '\x1b[5~') { ui.logScroll += page; return render(); }
    if (key === '\x1b[6~') { ui.logScroll = Math.max(0, ui.logScroll - page); return render(); }
    if (key === '\x1b[F' || key === '\x1b[4~' || key === 'G') { ui.logScroll = 0; return render(); }
    if (key === 't') { ui.showAll = !ui.showAll; refreshSessions(); return render(); }
  });

  refreshSessions();
  render();
  refreshProcesses().then(() => { refreshSessions(); refreshProcesses(); });
  timers = [
    setInterval(() => { refreshSessions(); render(); }, 1000),
    setInterval(refreshProcesses, 2000),
  ];
}
