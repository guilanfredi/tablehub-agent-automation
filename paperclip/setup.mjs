/**
 * Configura a empresa de agentes do TableHub no Paperclip local (idempotente: procura pelo nome antes de criar).
 *
 *   node paperclip/setup.mjs --dry-run   mostra o que faria
 *   node paperclip/setup.mjs             aplica (Paperclip precisa estar rodando: scripts/paperclip.ps1)
 *
 * Instruções dos agentes: paperclip/comum.md (parte comum) + paperclip/funcoes.json (parte de cada função).
 * Para mudar o modelo, o esforço ou as portas de um agente, edite TEAM abaixo e rode de novo.
 * Rotinas (ROUTINES) são criadas uma vez; para mudar horário ou pausar depois, use a interface do Paperclip.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:3100/api';
const COMPANY_NAME = process.env.PAPERCLIP_COMPANY ?? 'TableHub';
const TIMEZONE = 'America/Sao_Paulo';
const DRY = process.argv.includes('--dry-run');

async function api(method, path, body) {
  if (DRY && method !== 'GET') { console.log(`[dry-run] ${method} ${path}`, body ? JSON.stringify(body).slice(0, 200) : ''); return {}; }
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}
const list = (x) => (Array.isArray(x) ? x : x.items ?? x.data ?? x.agents ?? x.projects ?? x.routines ?? []);

const companies = list(await api('GET', '/companies'));
const company = companies.find((c) => c.name === COMPANY_NAME);
if (!company) throw new Error(`Empresa "${COMPANY_NAME}" não encontrada no Paperclip (crie no onboarding ou defina PAPERCLIP_COMPANY).`);
const COMPANY = company.id;

const comum = readFileSync(join(HERE, 'comum.md'), 'utf8');
const funcoes = JSON.parse(readFileSync(join(HERE, 'funcoes.json'), 'utf8'));

// faixa N de portas: web 5200+N, worker 8800+N, inspector 9300+N (uma execução por vez por agente)
const lane = (n) => ({ TABLEHUB_WEB_PORT: String(5200 + n), TABLEHUB_WORKER_PORT: String(8800 + n), TABLEHUB_INSPECTOR_PORT: String(9300 + n) });
const TEAM = [
  { key: 'produtor', name: 'Produtor', role: 'ceo', title: 'Produtor (direção e planejamento)', model: 'claude-opus-5-5', effort: 'medium', lane: 6 },
  { key: 'analista', name: 'Analista', role: 'pm', title: 'Analista de regras', model: 'claude-opus-5-5', effort: null, lane: 5 },
  { key: 'dev', name: 'Dev', role: 'engineer', title: 'Desenvolvedor (jogos e melhorias especificadas)', model: 'claude-opus-5-5', effort: null, lane: 1 },
  { key: 'dev-rapido', name: 'Dev Rápido', role: 'engineer', title: 'Desenvolvedor (bugs e melhorias simples)', model: 'claude-sonnet-5-5', effort: null, lane: 2 },
  { key: 'qa', name: 'QA', role: 'qa', title: 'QA (etapa de revisão: testes)', model: 'claude-sonnet-5-5', effort: 'medium', lane: 3 },
  { key: 'designer', name: 'Designer', role: 'designer', title: 'Designer de UI/UX', model: 'claude-sonnet-5-5', effort: null, lane: 7 },
  { key: 'seguranca', name: 'Segurança', role: 'security', title: 'Engenheiro de segurança', model: 'claude-opus-5-5', effort: 'medium', lane: 8 },
  { key: 'revisor', name: 'Revisor', role: 'engineer', title: 'Revisor de código (última etapa de revisão)', model: 'claude-opus-5-5', effort: 'medium', lane: 4 },
  { key: 'release', name: 'Release', role: 'devops', title: 'Release e produção', model: 'claude-sonnet-5-5', effort: 'medium', lane: 9 },
  { key: 'financeiro', name: 'Financeiro', role: 'cfo', title: 'Financeiro (custos e orçamento)', model: 'claude-sonnet-5-5', effort: 'low', lane: 10 },
  { key: 'marketing', name: 'Marketing', role: 'cmo', title: 'Marketing, redes sociais e comunidade', model: 'claude-sonnet-5-5', effort: null, lane: 11 },
];

// rotinas: criam uma issue para o agente no horário (fuso de São Paulo).
// "require_external_activity" pula a execução quando nada aconteceu na empresa desde a última vez (economiza cota).
const ROUTINES = [
  {
    agent: 'seguranca', title: 'Auditoria de segurança mensal', cron: '0 9 1 * *', gate: 'always',
    description: 'Faça a auditoria mensal de segurança descrita nas suas instruções (dependências, protocolo e rotas do worker, segredos, workflows do GitHub). Entregue o relatório por severidade como documento desta issue e crie issues para o Dev Rápido com as correções.',
  },
  {
    agent: 'financeiro', title: 'Relatório financeiro semanal', cron: '0 9 * * 1', gate: 'always',
    description: 'Monte o relatório de custos da semana anterior (segunda a domingo) descrito nas suas instruções e entregue como documento desta issue, com até 3 recomendações.',
  },
  {
    agent: 'marketing', title: 'Plano de conteúdo semanal', cron: '0 10 * * 1', gate: 'always',
    description: 'Monte o plano de conteúdo desta semana (3 a 5 posts) descrito nas suas instruções, com textos finais e imagens anexadas, como documento desta issue. O dono publica.',
  },
  {
    agent: 'release', title: 'Verificação de produção', cron: '0 8 * * *', gate: 'require_external_activity',
    description: 'Verifique os deploys desde a última verificação, rode o smoke test em produção, escreva as notas de versão para jogadores e acione o Marketing, como descrito nas suas instruções. Sem deploy novo: registre isso num comentário e conclua.',
  },
  {
    agent: 'produtor', title: 'Status semanal da empresa', cron: '0 17 * * 5', gate: 'require_external_activity',
    description: 'Escreva o status semanal descrito nas suas instruções (entregue, parado e por quê, riscos, decisões pendentes do dono) como documento desta issue e desbloqueie o que estiver parado.',
  },
];

const adapterConfig = (m) => ({
  model: m.model,
  ...(m.effort ? { effort: m.effort } : {}),
  dangerouslySkipPermissions: true, // escolha do dono: agentes liberados (padrão do Paperclip)
  env: {
    ...lane(m.lane), CLAUDE_AGENT_PROJECT: 'tablehub', CLAUDE_AGENT_TASK: m.key,
    // no Windows o gh guarda a configuração em %APPDATA%\GitHub CLI; o Paperclip procura em ~/.config/gh (padrão Linux)
    GH_CONFIG_DIR: `${process.env.APPDATA}\\GitHub CLI`,
  },
  timeoutSec: 0,
  graceSec: 15,
  maxTurnsPerRun: 1000,
});
const runtimeConfig = {
  heartbeat: { enabled: false, cooldownSec: 10, intervalSec: 300, wakeOnDemand: true, maxConcurrentRuns: 1, skipTimerWhenNoActionableWork: true },
  aiConnection: { mode: 'responsible_user', method: 'subscription', provider: 'anthropic' },
};

// 0. workspaces isolados (recurso experimental): sem isso o Paperclip ignora a política do projeto e os agentes
//    trabalham direto na cópia principal do repositório
await api('PATCH', '/instance/settings/experimental', { enableIsolatedWorkspaces: true, enableIsolatedWorkspacesByDefault: true });
console.log('workspaces isolados: ligados');

// 1. agentes (o Produtor primeiro: os outros respondem a ele)
const existing = list(await api('GET', `/companies/${COMPANY}/agents`));
const ids = {};
for (const m of TEAM) {
  const found = existing.find((a) => a.name === m.name);
  const reportsTo = m.key === 'produtor' ? null : ids.produtor ?? null;
  const body = { name: m.name, role: m.role, title: m.title, reportsTo, adapterType: 'claude_local', adapterConfig: adapterConfig(m), runtimeConfig };
  if (found) {
    await api('PATCH', `/agents/${found.id}`, body);
    ids[m.key] = found.id;
    console.log(`agente atualizado: ${m.name} (${found.id})`);
  } else {
    const created = await api('POST', `/companies/${COMPANY}/agents`, {
      ...body,
      desiredSkills: ['paperclipai/paperclip/paperclip'],
      instructionsBundle: { entryFile: 'AGENTS.md', files: { 'AGENTS.md': `# ${m.name}\n` } },
      permissions: { canCreateAgents: false, canCreateSkills: false },
    });
    ids[m.key] = created.id ?? created.agent?.id ?? `<${m.key}>`;
    console.log(`agente criado: ${m.name} (${ids[m.key]})`);
  }
}

// 2. instruções (AGENTS.md): {{ID_DEV_RAPIDO}} → ids['dev-rapido'] etc.
for (const m of TEAM) {
  const content = comum
    .replaceAll('{{NOME}}', m.name)
    .replace(/\{\{ID_([A-Z_]+)\}\}/g, (_, k) => ids[k.toLowerCase().replaceAll('_', '-')] ?? `<sem id: ${k}>`)
    + funcoes[m.key] + '\n';
  if (DRY) { console.log(`instruções: ${m.name} (${content.length} caracteres)`); continue; }
  // gravação otimista: informa a revisão lida (null se o arquivo ainda não existe)
  let current = null;
  try { current = await api('GET', `/agents/${ids[m.key]}/instructions-bundle/file?path=AGENTS.md`); } catch { /* novo */ }
  if (current?.content === content) { console.log(`instruções já atualizadas: ${m.name}`); continue; }
  await api('PUT', `/agents/${ids[m.key]}/instructions-bundle/file`, {
    path: 'AGENTS.md', content, clearLegacyPromptTemplate: true,
    baseRevisionId: current?.revision?.id ?? null, baseHash: current?.contentHash ?? null,
  });
  console.log(`instruções gravadas: ${m.name} (${content.length} caracteres)`);
}

// 3. projeto TableHub, com o repositório e um worktree isolado por issue
const projects = list(await api('GET', `/companies/${COMPANY}/projects`));
let project = projects.find((p) => p.name === 'TableHub');
if (!project) {
  project = await api('POST', `/companies/${COMPANY}/projects`, {
    name: 'TableHub',
    description: 'PWA de jogos de tabuleiro em salas (guilanfredi/tablehub). PRs pela conta bot; o dono aprova e faz merge no GitHub.',
    status: 'in_progress',
    icon: 'code',
    leadAgentId: ids.produtor,
    workspace: { name: 'tablehub', sourceType: 'local_path', cwd: 'D:\\dev\\TableHub', defaultRef: 'main', isPrimary: true },
  });
  console.log(`projeto criado: TableHub (${project.id})`);
} else {
  console.log(`projeto já existe: TableHub (${project.id})`);
}
if (!DRY) {
  const ws = list(await api('GET', `/projects/${project.id}/workspaces`));
  const primary = ws.find((w) => w.isPrimary) ?? ws[0];
  await api('PATCH', `/projects/${project.id}`, {
    leadAgentId: ids.produtor,
    executionWorkspacePolicy: {
      enabled: true,
      defaultMode: 'isolated_workspace',
      allowIssueOverride: true,
      defaultProjectWorkspaceId: primary?.id ?? null,
      workspaceStrategy: {
        type: 'git_worktree',
        baseRef: 'origin/main',
        worktreeParentDir: 'D:\\dev\\TableHub-agents\\paperclip',
        provisionCommand: 'npm ci --no-audit --no-fund',
      },
    },
  });
  console.log(`política de workspace: worktree isolado por issue (workspace ${primary?.id})`);
}

// 4. rotinas (criadas uma vez; se já existe uma com o mesmo título, não mexe)
const routines = list(await api('GET', `/companies/${COMPANY}/routines`));
for (const r of ROUTINES) {
  if (routines.some((x) => x.title === r.title)) { console.log(`rotina já existe: ${r.title}`); continue; }
  const created = await api('POST', `/companies/${COMPANY}/routines`, {
    title: r.title, description: r.description, assigneeAgentId: ids[r.agent], projectId: project.id,
    priority: 'medium', status: 'active', concurrencyPolicy: 'skip_if_active', catchUpPolicy: 'skip_missed',
    activityGatePolicy: r.gate, activityGateScope: 'company',
  });
  if (created.id) await api('POST', `/routines/${created.id}/triggers`, { kind: 'schedule', cronExpression: r.cron, timezone: TIMEZONE, label: r.cron });
  console.log(`rotina criada: ${r.title} (${r.cron}, ${TIMEZONE})`);
}

// 5. tarefa de onboarding padrão: cancelada para o Dev não começá-la sozinho
const issues = list(await api('GET', `/companies/${COMPANY}/issues`));
const onboarding = issues.find((i) => i.originKind === 'onboarding_first_task' && !['done', 'cancelled'].includes(i.status));
if (onboarding) {
  await api('PATCH', `/issues/${onboarding.id}`, { status: 'cancelled', comment: 'Cancelada na configuração da empresa do TableHub.' });
  console.log(`tarefa de onboarding cancelada: ${onboarding.identifier}`);
}
console.log(JSON.stringify({ ids, project: project.id }, null, 1));
