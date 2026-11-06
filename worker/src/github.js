/**
 * Reading the repository, and opening a pull request against it.
 *
 * Reading needs no credentials — FGE is public, so the raw files come
 * straight off the CDN. Only writing needs the token, and writing only
 * ever happens on a branch: the agent never pushes to main, because Pages
 * deploys from main the moment anything lands there and a bad change
 * would be live before anyone saw it.
 *
 * What the agent may touch is a fixed list, not a parameter. Giving a
 * model a path argument means one day it writes to .github/workflows and
 * disables the checks that were supposed to catch it.
 */

const OWNER = 'fp-league';
const REPO = 'FGE';
const BASE = 'main';

/**
 * What the agent may change, and the two things it may not.
 *
 * It used to be three files. That was too tight to be useful — the admin
 * panel alone is 296 KB of HTML it could not touch. So the rule is now
 * the other way round: everything, except what would let a bad change
 * hide itself.
 *
 *   .github/      the checks. An agent that can edit its own CI can
 *                 switch off the review that was meant to catch it, and
 *                 one careless approval removes every later one too.
 *   migrations/   replayed in full on every migration run, so a dropped
 *                 table is not a bad deploy to roll back, it is the
 *                 league's data gone.
 *
 * Nobody is going to ask a Discord bot to rewrite a workflow from their
 * phone, so excluding these costs nothing and closes the only two doors
 * that do not open again.
 */
const DENY = [/^\.github\//, /^worker\/migrations\//, /(^|\/)node_modules\//, /^\.git\//];

/** Files worth showing a model: text it can reason about, nothing binary. */
const TEXT = /\.(html?|css|m?js|json|md|txt|sql|toml|ya?ml|svg|xml)$/i;

/** Bigger than this and a single file would eat the whole context budget. */
const MAX_FILE = 400 * 1024;

/**
 * The files most requests are about.
 *
 * Used when nothing in the request names a file, which is most of the
 * time — "make the hero smaller" says nothing about paths.
 */
export const CORE = ['index.html', 'styles.css', 'app.js'];

export const mayEdit = path =>
  typeof path === 'string' && !!path && TEXT.test(path) && !DENY.some(d => d.test(path));

/**
 * Changes that alter how the agent itself is checked.
 *
 * These are not forbidden — asking the agent to improve its own code is
 * reasonable, and every change still goes past a person and through CI.
 * But a diff that quietly moves the guard rails should not look like a
 * diff that changes a colour, so the proposal says so out loud.
 */
const SENSITIVE = [
  /^worker\/src\/(agent|github|context)\.js$/,
  /^tests\//, /^package(-lock)?\.json$/, /^worker\/wrangler\.toml$/,
];
export const isSensitive = path => SENSITIVE.some(r => r.test(String(path)));

const api = (path) => `https://api.github.com/repos/${OWNER}/${REPO}${path}`;

/* ── base64 that survives an em dash ───────────────────
   The files are full of —, ✓ and ·. btoa works a byte at a time, so the
   string has to be UTF-8 encoded first, and in pieces: spreading a
   100 KB array into String.fromCharCode overflows the stack. */

export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

export function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ── Reading ───────────────────────────────────────────── */

/**
 * Every path in the repository the agent is allowed to edit.
 *
 * One API call for the whole tree, cached, so that deciding which files
 * to look at does not cost a request per file.
 */
export async function listTree(env, ttlMs = 10 * 60 * 1000) {
  const key = 'agent/tree';
  if (env.IMAGES_KV) {
    try {
      const hit = await env.IMAGES_KV.get(key, 'json');
      if (hit && Date.now() - hit.at < ttlMs) return hit.paths;
    } catch { /* fall through and fetch */ }
  }

  // Deliberately not gh(): the repository is public, so listing it needs
  // no token, and the agent should still be able to propose changes
  // before anyone has set GITHUB_TOKEN. The token is used when it is
  // there only to get the better rate limit.
  const res = await fetch(api(`/git/trees/${BASE}?recursive=1`), {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'fge-agent',
      ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`could not list the repository: HTTP ${res.status}`);
  const tree = await res.json();
  const paths = (tree.tree || [])
    .filter(e => e.type === 'blob' && (e.size || 0) <= MAX_FILE && mayEdit(e.path))
    .map(e => e.path);

  if (env.IMAGES_KV) {
    try {
      await env.IMAGES_KV.put(key, JSON.stringify({ at: Date.now(), paths }),
                              { expirationTtl: 3600 });
    } catch { /* caching is an optimisation, not a requirement */ }
  }
  return paths;
}

/**
 * Read the named files as they stand on main.
 *
 * Only the shortlist, never the whole repository: a Worker is capped at
 * 50 outbound requests and there are more files than that. Each is cached
 * on its own, so a second question about the same area costs nothing.
 *
 * A cached file can be out of date. That is safe rather than merely
 * tolerable, because writing re-reads the file from GitHub and refuses if
 * the text it meant to replace is no longer there.
 */
export async function readFiles(env, paths = CORE, ttlMs = 5 * 60 * 1000) {
  const want = [...new Set(paths.filter(mayEdit))].slice(0, 12);
  const files = {};
  const now = Date.now();

  await Promise.all(want.map(async path => {
    const key = `agent/file/${path}`;
    if (env.IMAGES_KV) {
      try {
        const hit = await env.IMAGES_KV.get(key, 'json');
        if (hit && now - hit.at < ttlMs) { files[path] = hit.text; return; }
      } catch { /* fall through and fetch */ }
    }
    const res = await fetch(
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BASE}/${path}`,
      { headers: { 'User-Agent': 'fge-agent' }, cf: { cacheTtl: 60 } });
    // One missing file must not sink the whole request: the tree may be
    // a few minutes ahead of what the CDN is serving.
    if (!res.ok) { console.warn(`agent: could not read ${path}: ${res.status}`); return; }
    const text = await res.text();
    files[path] = text;
    if (env.IMAGES_KV) {
      try { await env.IMAGES_KV.put(key, JSON.stringify({ at: now, text }),
                                    { expirationTtl: 3600 }); }
      catch { /* caching is an optimisation */ }
    }
  }));

  if (!Object.keys(files).length) throw new Error('could not read any of those files');
  return files;
}

export const forgetFiles = env =>
  (env.IMAGES_KV ? env.IMAGES_KV.delete('agent/tree').catch(() => {}) : Promise.resolve());

/* ── Writing ───────────────────────────────────────────── */

async function gh(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) {
    throw new Error('no GITHUB_TOKEN is set — run `npx wrangler secret put GITHUB_TOKEN`');
  }
  const res = await fetch(api(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'fge-agent',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = body.message || `HTTP ${res.status}`;
    // The two that will actually happen, named so they are fixable.
    if (res.status === 401) throw new Error('GitHub rejected the token — it may have expired');
    if (res.status === 403) throw new Error(`GitHub refused: ${why} (check the token's permissions)`);
    throw new Error(`GitHub: ${why}`);
  }
  return body;
}

/**
 * Put one or more edits on a branch and open a pull request.
 *
 * Each file is committed separately, which is what the contents API
 * allows without building a tree by hand. Three files would be three
 * commits on one branch — untidy in the history, but the pull request is
 * the unit that gets reviewed and merged, so it does not matter much.
 */
export async function openPullRequest(env, { branch, title, body, edits }) {
  const head = await gh(env, `/git/ref/heads/${BASE}`);
  const baseSha = head.object.sha;

  await gh(env, '/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });

  for (const edit of edits) {
    // The file's blob sha on the branch, which the contents API needs in
    // order to refuse a write over something that changed underneath.
    const current = await gh(env,
      `/contents/${encodeURIComponent(edit.path)}?ref=${branch}`);
    const before = fromBase64(current.content);
    if (!before.includes(edit.find)) {
      throw new Error(`${edit.path} changed on ${BASE} since this was proposed`);
    }
    await gh(env, `/contents/${encodeURIComponent(edit.path)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `${title}\n\n${edit.why || ''}`.trim(),
        content: toBase64(before.replace(edit.find, edit.replace)),
        sha: current.sha,
        branch,
      }),
    });
  }

  const pr = await gh(env, '/pulls', {
    method: 'POST',
    body: JSON.stringify({ title, head: branch, base: BASE, body }),
  });
  return { url: pr.html_url, number: pr.number, branch };
}
