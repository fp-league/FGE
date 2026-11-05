/**
 * Choosing what the model gets to see.
 *
 * The three editable files come to about 250 KB. A small model handed all
 * of that produces mush, and it would cost more neurons in one call than
 * a day's free allowance. So the Worker picks the parts of the files that
 * look relevant to what was asked and sends only those.
 *
 * This is the piece that decides whether the agent is any good. A model
 * that cannot see `.hero` cannot edit `.hero`; one that is shown the whole
 * stylesheet writes a plausible rule in the wrong place. Everything here
 * is pure so it can be tested on real requests against the real files.
 */

/** Words that say nothing about which part of the code is meant. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'is', 'are', 'was', 'be', 'it', 'its', 'this', 'that', 'these',
  'can', 'you', 'i', 'we', 'please', 'make', 'change', 'set', 'add', 'put',
  'update', 'edit', 'fix', 'do', 'get', 'want', 'need', 'should', 'would',
  'my', 'our', 'me', 'us', 'all', 'some', 'more', 'less', 'bit', 'little',
  'site', 'website', 'page', 'pages',
]);

/**
 * The words worth searching for.
 *
 * Kept in the order they were typed, because an earlier word in a request
 * is usually the subject and a later one the modifier — "make the hero
 * blue" is about the hero.
 */
export function keywords(request) {
  const seen = new Set();
  const out = [];
  for (const raw of String(request || '').toLowerCase().split(/[^a-z0-9-]+/)) {
    const w = raw.trim();
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * Cut a file into pieces that mean something on their own.
 *
 * Blank lines are the boundary, because all three files use them that way
 * — between CSS rules, between functions, between sections of markup. A
 * run with no blank line in it (a long function) is cut at a line limit
 * so one piece cannot swallow the whole budget.
 */
export function chunk(text, path, maxLines = 60) {
  const lines = String(text).split('\n');
  const out = [];
  let start = 0, buf = [];

  const flush = end => {
    if (!buf.length) return;
    const body = buf.join('\n');
    if (body.trim()) out.push({ path, start: start + 1, end, text: body });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const blank = lines[i].trim() === '';
    buf.push(lines[i]);
    if ((blank && buf.length > 4) || buf.length >= maxLines) {
      flush(i + 1);
      start = i + 1;
    }
  }
  flush(lines.length);
  return out;
}

/**
 * How well a chunk answers the request.
 *
 * A word in a CSS selector, a function name or an id counts for more than
 * the same word buried in prose: those are the places a change actually
 * has to be made. Earlier words in the request count for more than later
 * ones.
 */
export function score(chunk, words) {
  const body = chunk.text.toLowerCase();
  let total = 0;

  words.forEach((w, i) => {
    const weight = 1 / (1 + i * 0.35);          // the first word matters most
    const hits = body.split(w).length - 1;
    if (!hits) return;
    total += Math.min(hits, 4) * weight;

    // A declaration of the thing, rather than a mention of it.
    //
    // The prefix matters: FGE names almost everything .nb-card,
    // .cal-title, .hero-sub, so a pattern anchored on the bare word found
    // none of them and "the next race card" scored every chunk about
    // trading cards above the card it meant.
    const declared = new RegExp(
      `(^|\\n)\\s*[.#]?[\\w-]*${w}[\\w-]*\\s*[{:(]|` +    // .nb-card {  #hero:  hero(
      `function\\s+\\w*${w}|` +                             // function renderHero
      `id=["'][\\w-]*${w}|class=["'][^"']*${w}`, 'i');      // id="hero" class="nb-card"
    if (declared.test(chunk.text)) total += 3 * weight;
  });

  return total;
}

/**
 * The slice of the codebase the model gets.
 *
 * `files` is { path: contents }. Returns the chosen chunks, highest
 * scoring first but then put back into file and line order so the model
 * reads them the way they appear on disk.
 */
export function pickContext(files, request, budgetBytes = 6000) {
  const words = keywords(request);
  if (!words.length) return { words, chunks: [], text: '' };

  const scored = [];
  for (const [path, body] of Object.entries(files || {})) {
    const cs = chunk(body, path).map(c => ({ ...c, own: score(c, words) }));

    // Lift a chunk by what sits either side of it.
    //
    // Every section of this codebase opens with a comment — /* ── NEXT
    // RACE BAND ── */ — and that heading is far denser in the words
    // someone types than the rules underneath it. Scored alone, the
    // comment got picked and the code it describes did not, which is
    // exactly backwards. Half a neighbour's score is enough to carry the
    // implementation in with its heading.
    cs.forEach((c, i) => {
      const before = i > 0 ? cs[i - 1].own : 0;
      const after = i < cs.length - 1 ? cs[i + 1].own : 0;
      const lifted = c.own + 0.5 * Math.max(before, after);
      if (lifted > 0) scored.push({ ...c, score: lifted });
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const taken = [];
  let used = 0;
  for (const c of scored) {
    if (used + c.text.length > budgetBytes) continue;   // a smaller one may still fit
    taken.push(c);
    used += c.text.length;
    if (used > budgetBytes * 0.92) break;
  }

  taken.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start));

  const text = taken.map(c =>
    `--- ${c.path} lines ${c.start}-${c.end} ---\n${c.text}`).join('\n\n');

  return { words, chunks: taken, text };
}

/**
 * Check an edit before anyone is shown it.
 *
 * `find` has to appear exactly once in the file. Zero means the model
 * invented it; more than one means applying it is ambiguous and would
 * change the wrong copy. Both are the model's commonest failures and both
 * are caught here, before a human is asked to approve anything.
 */
export function checkEdit(files, edit) {
  const path = String((edit || {}).path || '');
  const find = String((edit || {}).find || '');
  const replace = String((edit || {}).replace == null ? '' : edit.replace);

  if (!Object.prototype.hasOwnProperty.call(files || {}, path)) {
    return { ok: false, why: `${path || 'that file'} is not one the agent may edit` };
  }
  if (!find) return { ok: false, why: 'the edit did not say what to look for' };
  if (find === replace) return { ok: false, why: 'the edit changes nothing' };

  const body = files[path];
  const count = body.split(find).length - 1;
  if (count === 0) {
    return { ok: false, why: `that text is not in ${path} — the model may have invented it` };
  }
  if (count > 1) {
    return { ok: false, why: `that text appears ${count} times in ${path}, so it is not clear which was meant` };
  }

  const at = body.indexOf(find);
  const line = body.slice(0, at).split('\n').length;
  return { ok: true, path, find, replace, line, after: body.replace(find, replace) };
}

/** A unified-ish diff, short enough for a Discord field. */
export function diffOf(edit, limit = 900) {
  const minus = edit.find.split('\n').map(l => '- ' + l);
  const plus = (edit.replace === '' ? [] : edit.replace.split('\n')).map(l => '+ ' + l);
  let body = minus.concat(plus).join('\n');
  if (body.length > limit) body = body.slice(0, limit - 3) + '...';
  return body;
}
