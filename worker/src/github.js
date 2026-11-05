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

/** The only files the agent may change. */
export const EDITABLE = ['index.html', 'styles.css', 'app.js'];

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
 * The editable files as they stand on main.
 *
 * Cached in KV for a few minutes: the agent reads all three on every
 * request and they change a few times a week, so going to the CDN each
 * time is three round trips to learn nothing new.
 */
export async function readFiles(env, ttlMs = 5 * 60 * 1000) {
  const key = 'agent/files';
  if (env.IMAGES_KV) {
    try {
      const hit = await env.IMAGES_KV.get(key, 'json');
      if (hit && Date.now() - hit.at < ttlMs) return hit.files;
    } catch { /* fall through and fetch */ }
  }

  const files = {};
  await Promise.all(EDITABLE.map(async path => {
    const res = await fetch(
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BASE}/${path}`,
      { headers: { 'User-Agent': 'fge-agent' }, cf: { cacheTtl: 60 } });
    if (!res.ok) throw new Error(`could not read ${path}: ${res.status}`);
    files[path] = await res.text();
  }));

  if (env.IMAGES_KV) {
    try {
      await env.IMAGES_KV.put(key, JSON.stringify({ at: Date.now(), files }),
                              { expirationTtl: 3600 });
    } catch { /* caching is an optimisation, not a requirement */ }
  }
  return files;
}

export const forgetFiles = env =>
  (env.IMAGES_KV ? env.IMAGES_KV.delete('agent/files').catch(() => {}) : Promise.resolve());

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
