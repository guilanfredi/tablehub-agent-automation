/**
 * Cliente mínimo da API do GitHub para o despachante. Usa o token do `gh` (conta bot) só em memória.
 * A lista de itens abertos é consultada com ETag: "nada mudou" (304) não conta no limite da API.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { normalizeItem } from './select.mjs';

export function findGh() {
  const candidates = ['C:\\Program Files\\GitHub CLI\\gh.exe'];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'gh';
}

// um token só (conta bot) para todos os repositórios
let sharedToken = null;
async function cachedToken(refresh = false) {
  if (!sharedToken || refresh) sharedToken = await ghToken();
  return sharedToken;
}

function ghToken() {
  return new Promise((resolve, reject) => {
    execFile(findGh(), ['auth', 'token'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }, (err, out) => {
      if (err || !out.trim()) return reject(new Error('Não consegui obter o token do gh (rode gh auth status).'));
      resolve(out.trim());
    });
  });
}

export class GitHub {
  constructor(repo) {
    this.repo = repo;
    this.listEtag = null;
    this.listCache = null;
  }

  async request(method, path, { body, etag } = {}) {
    let token = await cachedToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'tablehub-agent-automation',
          ...(etag ? { 'If-None-Match': etag } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 && attempt === 0) { token = await cachedToken(true); continue; }
      return res;
    }
  }

  async json(method, path, opts) {
    const res = await this.request(method, path, opts);
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  /** Todas as páginas de uma lista. */
  async paginate(path, first) {
    const out = [];
    let res = first ?? await this.request('GET', path);
    for (;;) {
      if (!res.ok) throw new Error(`GitHub GET ${path}: HTTP ${res.status}`);
      out.push(...await res.json());
      const next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (!next) return out;
      res = await this.request('GET', next);
    }
  }

  /** Issues e PRs abertos. Retorna { items, changed }. `force` ignora o ETag. */
  async listOpen({ force = false } = {}) {
    const path = `/repos/${this.repo}/issues?state=open&per_page=100`;
    const first = await this.request('GET', path, { etag: force ? null : this.listEtag });
    if (first.status === 304 && this.listCache) return { items: this.listCache, changed: false };
    const etag = first.headers.get('etag');
    const items = (await this.paginate(path, first)).map(normalizeItem);
    this.listEtag = etag;
    this.listCache = items;
    return { items, changed: true };
  }

  getIssue(n) { return this.json('GET', `/repos/${this.repo}/issues/${n}`); }
  addLabel(n, label) { return this.json('POST', `/repos/${this.repo}/issues/${n}/labels`, { body: { labels: [label] } }); }
  comment(n, body) { return this.json('POST', `/repos/${this.repo}/issues/${n}/comments`, { body: { body } }); }

  async removeLabel(n, label) {
    const res = await this.request('DELETE', `/repos/${this.repo}/issues/${n}/labels/${encodeURIComponent(label)}`);
    if (!res.ok && res.status !== 404) throw new Error(`GitHub remover etiqueta ${label} de #${n}: HTTP ${res.status}`);
  }

  async labelAddedAt(n, label) {
    const events = await this.paginate(`/repos/${this.repo}/issues/${n}/events?per_page=100`);
    const last = events.filter((e) => e.event === 'labeled' && e.label?.name === label).at(-1);
    return last ? Date.parse(last.created_at) : 0;
  }

  /** O dono comentou ou revisou depois de `since`? */
  async ownerRepliedAfter(n, since, isPr, owner) {
    const times = [];
    const r = this.repo;
    times.push(...(await this.paginate(`/repos/${r}/issues/${n}/comments?per_page=100`)).filter((c) => c.user?.login === owner).map((c) => c.created_at));
    if (isPr) {
      times.push(...(await this.paginate(`/repos/${r}/pulls/${n}/comments?per_page=100`)).filter((c) => c.user?.login === owner).map((c) => c.created_at));
      times.push(...(await this.paginate(`/repos/${r}/pulls/${n}/reviews?per_page=100`)).filter((c) => c.user?.login === owner && c.submitted_at).map((c) => c.submitted_at));
    }
    return times.some((t) => Date.parse(t) > since);
  }
}
