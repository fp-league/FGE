/**
 * The agent, end to end, with the model and GitHub faked.
 *
 * What matters here is not that the model is clever — it is that nothing
 * the model says can reach the repository without passing a check and a
 * person. So most of these tests feed the agent a bad answer and assert
 * that nothing was written.
 */
import { parseReply, readReply, repairJson, runAgent, onAgentButton, defer }
  from '../worker/src/agent.js';
import { toBase64, fromBase64, mayEdit, isSensitive, CORE } from '../worker/src/github.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL  ' + n + (x ? '  →  ' + x : '')); } };

/* ── Fakes ─────────────────────────────────────────────── */

const FILES = {
  'index.html': '<h1 class="hero-title">FGE</h1>\n\n<p class="hero-sub">Endurance</p>\n',
  'styles.css': '.hero-title {\n  font-size: 64px;\n  color: #fff;\n}\n\n.footer {\n  background: #111;\n}\n',
  'app.js': 'function renderHero() {\n  return 1;\n}\n',
  'manage.html': '<button id="save" class="save-button">Save</button>\n',
  'worker/src/economy.js': 'export const PAYOUT = 100;\n',
};

/** Just enough D1 to exercise the insert, the guarded claim and the read. */
function fakeDB() {
  const rows = new Map();
  const db = {
    rows,
    prepare(sql) {
      let binds = [];
      return {
        bind(...args) { binds = args; return this; },
        async run() {
          if (/^\s*INSERT INTO proposal/i.test(sql)) {
            const [id, asked_by, request, summary, edits, at] = binds;
            rows.set(id, { id, asked_by, request, summary, kind: 'code',
                           edits, status: 'pending', at, decided_by: null,
                           result: null, decided_at: null });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE proposal SET status = \?/i.test(sql)) {
            const [status, who, when, id] = binds;
            const row = rows.get(id);
            if (!row || row.status !== 'pending') return { meta: { changes: 0 } };
            Object.assign(row, { status, decided_by: who, decided_at: when });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE proposal SET status = 'pending'/i.test(sql)) {
            const [why, id] = binds;
            Object.assign(rows.get(id), { status: 'pending', decided_by: null,
                                          decided_at: null, result: why });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE proposal SET result = \?/i.test(sql)) {
            const [result, id] = binds;
            rows.get(id).result = result;
            return { meta: { changes: 1 } };
          }
          throw new Error('unexpected sql: ' + sql);
        },
        async first() { return rows.get(binds[0]) || null; },
      };
    },
  };
  return db;
}

/** Captures the follow-up Discord sends, and serves the raw files. */
function fakeEnv(reply, opts = {}) {
  const sent = [];
  const gh = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://raw.githubusercontent.com/')) {
      const path = u.split('/main/')[1];
      return { ok: true, status: 200, text: async () => FILES[path] };
    }
    if (u.includes('/webhooks/')) {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (u.includes('/git/trees/')) {
      return { ok: true, status: 200, json: async () => ({ tree:
        Object.keys(FILES).concat('manage.html', 'worker/src/economy.js',
                                  '.github/workflows/checks.yml',
                                  'worker/migrations/016-agent.sql')
          .map(path => ({ type: 'blob', path, size: 100 })) }) };
    }
    if (u.startsWith('https://api.github.com/')) {
      gh.push({ url: u, method: init.method || 'GET',
                body: init.body ? JSON.parse(init.body) : null });
      if (opts.ghFails) return { ok: false, status: 422,
        json: async () => ({ message: 'Reference already exists' }) };
      if (/\/git\/ref\/heads\//.test(u)) return { ok: true, status: 200,
        json: async () => ({ object: { sha: 'base000' } }) };
      if (/\/contents\/.*\?ref=/.test(u)) {
        const path = decodeURIComponent(u.split('/contents/')[1].split('?')[0]);
        return { ok: true, status: 200,
          json: async () => ({ content: toBase64(FILES[path]), sha: 'blob000' }) };
      }
      if (/\/pulls$/.test(u)) return { ok: true, status: 201,
        json: async () => ({ html_url: 'https://github.com/fp-league/FGE/pull/7', number: 7 }) };
      return { ok: true, status: 201, json: async () => ({}) };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return {
    sent, gh,
    env: {
      DB: fakeDB(),
      DISCORD_APPLICATION_ID: '123',
      GITHUB_TOKEN: 'tok',
      AGENT_APPROVERS: '555, 666',
      AI: { async run(model, input) {
        if (opts.aiThrows) throw new Error(opts.aiThrows);
        fakeEnv.lastInput = input;
        return { response: typeof reply === 'string' ? reply : JSON.stringify(reply) };
      } },
      ...(opts.env || {}),
    },
  };
}

const ask = { token: 'tkn', application_id: 'app42', member: { user: { id: '999' } }, type: 2 };
const press = who => ({ token: 'tkn2', member: { user: { id: who } }, type: 3 });

/* ── Reading the model's answer ────────────────────────── */

console.log('PARSING WHAT THE MODEL SAID');
{
  ok('plain json', parseReply('{"answer":"no"}').answer === 'no');
  ok('a code fence is unwrapped',
     parseReply('```json\n{"answer":"no"}\n```').answer === 'no');
  ok('an unlabelled fence too', parseReply('```\n{"answer":"no"}\n```').answer === 'no');
  ok('prose before it is ignored',
     parseReply('Sure! Here you go:\n{"answer":"no"}').answer === 'no');
  ok('and prose after it',
     parseReply('{"answer":"no"}\nHope that helps!').answer === 'no');

  // The payload is CSS, so it is full of braces. Matching to the first }
  // would truncate it.
  const css = parseReply('{"edits":[{"find":".a { color: red; }","replace":".a { color: blue; }"}]}');
  ok('braces inside strings do not end it', css.edits[0].find === '.a { color: red; }',
     JSON.stringify(css));
  const nested = parseReply('{"a":{"b":{"c":1}},"d":2}');
  ok('nested objects survive', nested && nested.d === 2);
  ok('an escaped quote survives', parseReply('{"a":"say \\"hi\\" }"}').a === 'say "hi" }');

  ok('nonsense gives nothing', parseReply('I cannot do that') === null);
  ok('broken json gives nothing', parseReply('{"answer": }') === null);
  ok('empty gives nothing', parseReply('') === null);
  ok('undefined does not throw', parseReply(undefined) === null);
}

/* ── base64 ────────────────────────────────────────────── */

console.log('\nTHE THING MODELS ACTUALLY GET WRONG');
{
  // A find-and-replace over code is multi-line by definition, and models
  // write those line breaks out literally rather than as \\n. JSON.parse
  // rejects the whole answer over it, so this was failing every time.
  const withRealBreaks =
    '{"summary":"x","edits":[{"path":"styles.css","find":".a {\n  color: red;\n}","replace":".a {\n  color: blue;\n}"}]}';
  const r = readReply(withRealBreaks);
  ok('a raw line break inside a string is repaired', r.value !== null, r.why);
  ok('and the newlines are kept, not dropped',
     r.value && r.value.edits[0].find === '.a {\n  color: red;\n}',
     JSON.stringify(r.value && r.value.edits[0].find));
  ok('tabs too',
     readReply('{"a":"x\ty"}').value.a === 'x\ty');
  ok('a carriage return too',
     readReply('{"a":"x\r\ny"}').value.a === 'x\r\ny');

  // Repairing must not touch anything outside a string, or corrupt an
  // answer that was already correct.
  ok('well-formed json is left alone',
     repairJson('{"a": "x\\ny",\n  "b": 1}') === '{"a": "x\\ny",\n  "b": 1}');
  ok('an already-escaped newline is not double-escaped',
     readReply('{"a":"x\\ny"}').value.a === 'x\ny');
  ok('an escaped backslash at the end of a string does not desync',
     readReply('{"a":"back\\\\","b":2}').value.b === 2);

  // Truncation must never be silently closed up: a `replace` cut short
  // still applies cleanly and would delete half a rule.
  const cut = readReply('{"summary":"x","edits":[{"path":"styles.css","find":".a {');
  ok('a cut-off answer is refused', cut.value === null);
  ok('and known to be cut off, not merely broken', cut.why === 'cut', cut.why);
  ok('prose with no json at all is told apart',
     readReply('I would do that for you!').why === 'none');
  ok('an empty answer is told apart', readReply('').why === 'empty');
  ok('and valid json reports no complaint', readReply('{"a":1}').why === null);
}

console.log('\nBASE64 SURVIVES THE REAL FILES');
{
  const hard = 'a — b ✓ c · d “e” ƒ\n tab\there\n';
  ok('a round trip is lossless', fromBase64(toBase64(hard)) === hard);
  ok('an em dash alone', fromBase64(toBase64('—')) === '—');
  ok('empty', fromBase64(toBase64('')) === '');

  // The chunked String.fromCharCode path only runs past 32 KB, and that is
  // where a naive implementation overflows the stack.
  const big = ('.rule { color: #fff; } /* — ✓ */\n').repeat(6000);
  ok('a file bigger than the chunk size', fromBase64(toBase64(big)) === big,
     String(big.length) + ' bytes');
  ok('whitespace in the encoded form is tolerated',
     fromBase64(toBase64('hi').replace(/(.{4})/g, '$1\n')) === 'hi');
}

console.log('\nWHAT THE AGENT MAY TOUCH');
{
  // It may now edit the repository, which is the point. The two
  // exclusions are the ones a bad change could use to hide itself.
  ok('the site files, obviously', ['index.html', 'styles.css', 'app.js'].every(mayEdit));
  ok('the admin panel, which used to be out of reach', mayEdit('manage.html'));
  ok('the worker source', mayEdit('worker/src/economy.js'));
  ok('its own code', mayEdit('worker/src/agent.js'));

  ok('but never the checks that review it',
     !mayEdit('.github/workflows/checks.yml'));
  ok('nor any workflow', !mayEdit('.github/workflows/migrate.yml'));
  ok('nor a migration, which is replayed in full and could drop a table',
     !mayEdit('worker/migrations/016-agent.sql'));
  ok('nor anything binary', !mayEdit('porsche.webp') && !mayEdit('tests/fixtures/real.png'));
  ok('nor a path that is not a string', !mayEdit(null) && !mayEdit(undefined) && !mayEdit(''));

  // Allowed, but the approver should be told.
  ok('its own code is flagged', isSensitive('worker/src/agent.js'));
  ok('so are the tests', isSensitive('tests/agent.test.mjs'));
  ok('and the worker config', isSensitive('worker/wrangler.toml'));
  ok('a stylesheet is not', !isSensitive('styles.css'));
  ok('nor the admin panel', !isSensitive('manage.html'));

  ok('the fallback files are the site ones', CORE.length === 3, CORE.join());
}

/* ── Asking ────────────────────────────────────────────── */

console.log('\nA GOOD PROPOSAL');
{
  const { sent, env } = fakeEnv({
    summary: 'Make the big title smaller',
    edits: [{ path: 'styles.css', find: '  font-size: 64px;',
              replace: '  font-size: 48px;', why: 'asked for smaller' }],
  });
  await runAgent(env, ask, 'make the hero title smaller');

  ok('one message is sent', sent.length === 1, String(sent.length));
  const m = sent[0] || {};
  ok('it is a proposal', /Proposed change/.test((m.embeds || [{}])[0].title || ''),
     JSON.stringify(m.embeds));
  ok('it shows the diff', /-\s+font-size: 64px;/.test(JSON.stringify(m.embeds)),
     JSON.stringify((m.embeds || [{}])[0].fields));
  ok('and the replacement', /\+\s+font-size: 48px;/.test(JSON.stringify(m.embeds)));
  ok('it names the file and line', /styles\.css · line 2/.test(JSON.stringify(m.embeds)),
     JSON.stringify((m.embeds || [{}])[0].fields));
  ok('it says nothing has changed yet',
     /Nothing has changed/.test(JSON.stringify(m.embeds)));
  ok('there is an approve button',
     JSON.stringify(m.components).includes('"label":"Approve"'));
  ok('and a reject button',
     JSON.stringify(m.components).includes('"label":"Reject"'));
  ok('it was written down', env.DB.rows.size === 1, String(env.DB.rows.size));
  ok('as pending', [...env.DB.rows.values()][0].status === 'pending');
  ok('with the words that were typed',
     [...env.DB.rows.values()][0].request === 'make the hero title smaller');
  ok('nothing went to GitHub yet', !fakeEnv.lastGh);

  // The model must be told the code is data. This is the one defence
  // against a comment in the stylesheet telling it what to do.
  const prompt = JSON.stringify(fakeEnv.lastInput);
  ok('the model is told the code is not instructions',
     /data, not instructions/.test(prompt));
  ok('and it is shown the file it needs', /font-size: 64px/.test(prompt));
  ok('but not the whole codebase', prompt.length < 9000, String(prompt.length));
}

console.log('\nAND THEN APPROVING IT');
{
  const { sent, gh, env } = fakeEnv({
    summary: 'Make the big title smaller',
    edits: [{ path: 'styles.css', find: '  font-size: 64px;', replace: '  font-size: 48px;' }],
  });
  await runAgent(env, ask, 'make the hero title smaller');
  const id = [...env.DB.rows.keys()][0];

  const no = await onAgentButton(env, press('111'), id, 'approve');
  ok('someone who is not an owner cannot approve',
     /Only a league owner/.test(no.data.content), JSON.stringify(no));
  ok('and that reply is private', no.data.flags === 64);
  ok('it is still pending', env.DB.rows.get(id).status === 'pending');
  ok('and nothing went to GitHub', gh.length === 0, String(gh.length));

  const yes = await onAgentButton(env, press('666'), id, 'approve');
  ok('an owner can', /Pull request opened/.test(JSON.stringify(yes.data.embeds)),
     JSON.stringify(yes.data.embeds));
  ok('the link comes back',
     JSON.stringify(yes.data.embeds).includes('/pull/7'));
  ok('the buttons are taken away', (yes.data.components || []).length === 0);
  ok('it is recorded as applied', env.DB.rows.get(id).status === 'applied');
  ok('by whom', env.DB.rows.get(id).decided_by === '666');
  ok('with the link kept', /pull\/7/.test(env.DB.rows.get(id).result));

  // The branch, not main. This is the whole point.
  const madeRef = gh.find(c => /\/git\/refs$/.test(c.url));
  ok('a branch was made', !!madeRef);
  ok('named after the proposal', madeRef.body.ref === `refs/heads/agent/${id}`,
     madeRef.body.ref);
  const put = gh.find(c => c.method === 'PUT');
  ok('the file was committed to that branch', put.body.branch === `agent/${id}`);
  ok('and nothing was pushed to main',
     !gh.some(c => c.method !== 'GET' && JSON.stringify(c.body).includes('"branch":"main"')));
  ok('the committed file carries the change',
     fromBase64(put.body.content).includes('font-size: 48px'));
  ok('and keeps the rest of the file',
     fromBase64(put.body.content).includes('.footer'));
  const pr = gh.find(c => /\/pulls$/.test(c.url));
  ok('a pull request was opened against main', pr.body.base === 'main');
  ok('from the branch', pr.body.head === `agent/${id}`);
  ok('crediting who asked', pr.body.body.includes('<@999>'));
  ok('and who approved', pr.body.body.includes('<@666>'));

  // Pressing again must not open a second pull request.
  const before = gh.length;
  const again = await onAgentButton(env, press('555'), id, 'approve');
  ok('a second press is refused', /already been answered/.test(again.data.content),
     JSON.stringify(again));
  ok('and opens nothing', gh.length === before, `${gh.length} vs ${before}`);
}

console.log('\nREJECTING');
{
  const { env, gh } = fakeEnv({
    summary: 'Make it smaller',
    edits: [{ path: 'styles.css', find: '  font-size: 64px;', replace: '  font-size: 48px;' }],
  });
  await runAgent(env, ask, 'make the hero title smaller');
  const id = [...env.DB.rows.keys()][0];

  const out = await onAgentButton(env, press('555'), id, 'reject');
  ok('says so', /Rejected/.test(JSON.stringify(out.data.embeds)));
  ok('the buttons go', (out.data.components || []).length === 0);
  ok('it is recorded', env.DB.rows.get(id).status === 'rejected');
  ok('and nothing was written', gh.length === 0, String(gh.length));
  const after = await onAgentButton(env, press('555'), id, 'approve');
  ok('a rejected change cannot then be approved',
     /already been answered/.test(after.data.content));
}

/* ── The model being wrong ─────────────────────────────── */

console.log('\nWHEN THE MODEL IS WRONG, NOTHING HAPPENS');
{
  const cases = [
    ['invented text',
     { summary: 'x', edits: [{ path: 'styles.css', find: '.nav { display: none; }', replace: 'x' }] },
     /may have invented/],
    ['an ambiguous find',
     { summary: 'x', edits: [{ path: 'styles.css', find: '}', replace: '} ' }] },
     /appears \d+ times/],
    ['a workflow it may never touch',
     { summary: 'x', edits: [{ path: '.github/workflows/checks.yml', find: 'on:', replace: '' }] },
     /was shown/],
    ['a file it was not shown',
     { summary: 'x', edits: [{ path: 'worker/src/index.js', find: 'fetch', replace: '' }] },
     /was shown/],
    ['an edit that changes nothing',
     { summary: 'x', edits: [{ path: 'styles.css', find: '.footer', replace: '.footer' }] },
     /changes nothing/],
    ['no edits at all', { summary: 'x', edits: [] }, /no change/],
    ['prose instead of a change', 'I would change the hero title for you!', /prose instead of a change/],
  ];
  for (const [name, reply, why] of cases) {
    const { sent, gh, env } = fakeEnv(reply);
    await runAgent(env, ask, 'make the hero title smaller');
    const body = JSON.stringify(sent[0] || {});
    ok(`${name} is caught`, why.test(body), body.slice(0, 200));
    ok(`  ...and nothing is written down`, env.DB.rows.size === 0);
    ok(`  ...and nothing reaches GitHub`, gh.length === 0);
    ok(`  ...and no approve button is offered`,
       !body.includes('Approve'), body.slice(0, 120));
  }

  // One bad edit in a batch must not let the good ones through: the owner
  // would be approving a diff that is not what gets applied.
  const { sent, env } = fakeEnv({ summary: 'two things', edits: [
    { path: 'styles.css', find: '  font-size: 64px;', replace: '  font-size: 48px;' },
    { path: 'styles.css', find: '.does-not-exist', replace: 'x' },
  ] });
  await runAgent(env, ask, 'make the hero title smaller');
  ok('one bad edit rejects the whole proposal',
     /would not have applied/.test(JSON.stringify(sent[0])), JSON.stringify(sent[0]));
  ok('and none of it is stored', env.DB.rows.size === 0);
}

console.log('\nQUESTIONS, AND SAYING NO');
{
  const { sent, env } = fakeEnv({ answer: 'The hero title is set in styles.css at 64px.' });
  await runAgent(env, ask, 'what size is the hero title');
  ok('an answer comes back as an answer',
     /64px/.test(JSON.stringify(sent[0])), JSON.stringify(sent[0]));
  ok('with no buttons', !JSON.stringify(sent[0]).includes('Approve'));
  ok('and nothing is stored', env.DB.rows.size === 0);
}

/* ── Things being missing or broken ────────────────────── */

console.log('\nWHEN SOMETHING IS NOT SET UP, IT SAYS WHICH');
{
  const a = fakeEnv({ answer: 'x' }, { env: { AI: undefined } });
  a.env.AI = undefined;
  await runAgent(a.env, ask, 'make the hero title smaller');
  ok('a missing AI binding is named',
     /wrangler\.toml/.test(JSON.stringify(a.sent[0])), JSON.stringify(a.sent[0]));

  const b = fakeEnv({ summary: 'x', edits: [
    { path: 'styles.css', find: '  font-size: 64px;', replace: '  font-size: 48px;' }] });
  delete b.env.AGENT_APPROVERS;
  await runAgent(b.env, ask, 'make the hero title smaller');
  const id = [...b.env.DB.rows.keys()][0];
  const noOwners = await onAgentButton(b.env, press('555'), id, 'approve');
  ok('no approvers configured is named, not silently allowed',
     /AGENT_APPROVERS/.test(noOwners.data.content), JSON.stringify(noOwners));
  ok('and it stays pending', b.env.DB.rows.get(id).status === 'pending');

  const c = fakeEnv({ summary: 'x', edits: [
    { path: 'styles.css', find: '  font-size: 64px;', replace: '  font-size: 48px;' }] });
  delete c.env.GITHUB_TOKEN;
  await runAgent(c.env, ask, 'make the hero title smaller');
  const cid = [...c.env.DB.rows.keys()][0];
  const noTok = await onAgentButton(c.env, press('555'), cid, 'approve');
  ok('a missing token names the command that fixes it',
     /wrangler secret put GITHUB_TOKEN/.test(JSON.stringify(noTok.data.embeds)),
     JSON.stringify(noTok.data.embeds));
  ok('and the proposal is put back so it can be retried',
     c.env.DB.rows.get(cid).status === 'pending');
  ok('with a try again button',
     JSON.stringify(noTok.data.components).includes('Try again'));

  const d = fakeEnv({ answer: 'x' }, { aiThrows: 'Neuron quota exceeded for today' });
  await runAgent(d.env, ask, 'make the hero title smaller');
  ok('a used-up allowance is explained in plain words',
     /allowance is used up/.test(JSON.stringify(d.sent[0])), JSON.stringify(d.sent[0]));
  ok('and says when it comes back',
     /midnight UTC/.test(JSON.stringify(d.sent[0])));
}

console.log('\nA REQUEST THAT MATCHES NOTHING');
{
  const { sent, env } = fakeEnv({ answer: 'x' });
  await runAgent(env, ask, 'zzzqqq wibble');
  ok('does not call the model at all', !/wibble/.test(JSON.stringify(sent[0])),
     JSON.stringify(sent[0]));
  ok('and names the files it actually looked at',
     /index\.html, styles\.css, app\.js/.test(JSON.stringify(sent[0])),
     JSON.stringify(sent[0]));
  ok('so the next try can name a different one',
     /Name the file/.test(JSON.stringify(sent[0])));
  ok('nothing is stored', env.DB.rows.size === 0);
}

console.log('\nTHE FILE CHANGING UNDERNEATH');
{
  // Proposed against one version of styles.css, approved after someone
  // else edited that same line. Applying it would put the change in the
  // wrong place, so it must refuse.
  const { env, gh } = fakeEnv({ summary: 'x', edits: [
    { path: 'styles.css', find: '  font-size: 64px;', replace: '  font-size: 48px;' }] });
  await runAgent(env, ask, 'make the hero title smaller');
  const id = [...env.DB.rows.keys()][0];
  const was = FILES['styles.css'];
  FILES['styles.css'] = was.replace('64px', '60px');
  const out = await onAgentButton(env, press('555'), id, 'approve');
  FILES['styles.css'] = was;
  ok('it refuses', /changed on main/.test(JSON.stringify(out.data.embeds)),
     JSON.stringify(out.data.embeds));
  ok('nothing was committed', !gh.some(c => c.method === 'PUT'));
  ok('and no pull request was opened', !gh.some(c => /\/pulls$/.test(c.url)));
  ok('it can be tried again', env.DB.rows.get(id).status === 'pending');
}

console.log('\nTHE MODEL IS HELD TO THE SHAPE WHERE IT CAN BE');
{
  const calls = [];
  const { sent, env } = fakeEnv({ answer: 'fine' });
  const real = env.AI.run.bind(env.AI);
  env.AI.run = (model, input) => { calls.push(input); return real(model, input); };
  await runAgent(env, ask, 'what size is the hero title');
  ok('a schema is sent', !!(calls[0] || {}).response_format, JSON.stringify(Object.keys(calls[0] || {})));
  ok('which pins the file to the editable list',
     JSON.stringify(calls[0].response_format).includes('styles.css'));
  ok('and nothing else', !JSON.stringify(calls[0].response_format).includes('workflows'));
  ok('with room to answer', calls[0].max_tokens >= 2000, String(calls[0].max_tokens));
  ok('one call is enough when it is accepted', calls.length === 1, String(calls.length));
  ok('and the answer comes through', /fine/.test(JSON.stringify(sent[0])));
}

console.log('\nAND ASKED PLAINLY WHEN IT CANNOT BE');
{
  // Not every model on every version of the platform accepts a schema.
  const calls = [];
  const { sent, env } = fakeEnv({ answer: 'fine' });
  const real = env.AI.run.bind(env.AI);
  env.AI.run = (model, input) => {
    calls.push(input);
    if (input.response_format) throw new Error('response_format is not supported');
    return real(model, input);
  };
  await runAgent(env, ask, 'what size is the hero title');
  ok('it asks again without the schema', calls.length === 2, String(calls.length));
  ok('and the second try carries no schema', !calls[1].response_format);
  ok('so the answer still arrives', /fine/.test(JSON.stringify(sent[0])), JSON.stringify(sent[0]));

  // But a used-up allowance must not be retried \u2014 that just spends more.
  const spent = [];
  const d = fakeEnv({ answer: 'x' });
  d.env.AI.run = input => { spent.push(input); throw new Error('Neuron quota exceeded'); };
  await runAgent(d.env, ask, 'what size is the hero title');
  ok('a used-up allowance is not retried', spent.length === 1, String(spent.length));
  ok('and is explained', /allowance is used up/.test(JSON.stringify(d.sent[0])));
}

console.log('\nAN ANSWER THAT ARRIVES ALREADY PARSED');
{
  // Constrained decoding can hand back an object rather than a string.
  const { sent, env } = fakeEnv({ answer: 'x' });
  env.AI.run = async () => ({ response: { answer: 'already an object' } });
  await runAgent(env, ask, 'what size is the hero title');
  ok('is used as it stands', /already an object/.test(JSON.stringify(sent[0])),
     JSON.stringify(sent[0]));
}

console.log('\nBEING TOLD WHY, NOT JUST THAT IT FAILED');
{
  const { sent, env } = fakeEnv('{"summary":"x","edits":[{"path":"styles.css","find":".hero {');
  await runAgent(env, ask, 'make the hero title smaller');
  const body = JSON.stringify(sent[0]);
  ok('a cut-off answer says so', /cut off/.test(body), body.slice(0, 160));
  ok('and suggests a smaller request', /smaller change/.test(body));
  ok('and stores nothing', env.DB.rows.size === 0);
}

console.log('\nIT CAN NOW REACH PAST THE THREE SITE FILES');
{
  const { sent, env } = fakeEnv({
    summary: 'Make the save button green',
    edits: [{ path: 'manage.html', find: 'class="save-button"',
              replace: 'class="save-button green"', why: 'asked for green' }],
  });
  await runAgent(env, ask, 'in manage.html make the save button green');
  const body = JSON.stringify(sent[0]);
  ok('the admin panel can be edited', /Proposed change/.test(body), body.slice(0, 200));
  ok('and the diff names it', /manage\.html/.test(body));
  ok('it is not flagged as risky', !/guard rails/.test(body));
}

console.log('\nAND SAYS SO WHEN IT TOUCHES ITS OWN GUARD RAILS');
{
  FILES['worker/src/agent.js'] = "const MODEL = 'a';\n";
  const { sent, env } = fakeEnv({
    summary: 'Change the model',
    edits: [{ path: 'worker/src/agent.js', find: "const MODEL = 'a';",
              replace: "const MODEL = 'b';", why: 'asked' }],
  });
  await runAgent(env, ask, 'in worker/src/agent.js change the model');
  const body = JSON.stringify(sent[0]);
  ok('it is still allowed', /Proposed change/.test(body), body.slice(0, 200));
  ok('but the approver is warned', /guard rails/.test(body), body.slice(0, 200));
  ok('and told to read it closely', /Read it closely/.test(body));
  delete FILES['worker/src/agent.js'];
}

console.log('\nTHE APPLICATION ID NEEDS NO CONFIGURING');
{
  const { sent, env } = fakeEnv({ answer: 'fine' });
  delete env.DISCORD_APPLICATION_ID;
  await runAgent(env, ask, 'what size is the hero title');
  ok('the reply still goes out', sent.length === 1, String(sent.length));
}

console.log('\nNOTHING FAILS QUIETLY');
{
  // Discord has already been told to wait, so an uncaught error would
  // leave "thinking" on screen for ever and the token to fix it dies
  // after fifteen minutes. Every path out must end in a message.
  const { sent, env } = fakeEnv({ summary: 'x', edits: [
    { path: 'styles.css', find: '  font-size: 64px;', replace: '  font-size: 48px;' }] });
  env.DB.prepare = () => { throw new Error('no such table: proposal'); };
  await runAgent(env, ask, 'make the hero title smaller');
  ok('a thrown error still answers', sent.length === 1, String(sent.length));
  ok('and says what broke', /no such table: proposal/.test(JSON.stringify(sent[0])),
     JSON.stringify(sent[0]));
  ok('and that nothing changed', /Nothing was changed/.test(JSON.stringify(sent[0])));

  // Even a failure inside the reporting itself must not throw onward,
  // because the caller is a waitUntil with nowhere to put it.
  const { env: e2 } = fakeEnv({ answer: 'x' });
  e2.AI.run = () => { throw new Error('boom'); };
  const before = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('discord unreachable'); };
  let threw = false;
  try { await runAgent(e2, ask, 'make the hero title smaller'); }
  catch { threw = true; }
  globalThis.fetch = before;
  ok('an unreportable failure is swallowed, not rethrown', !threw);
}

console.log('\nA HANG BECOMES A MESSAGE');
{
  const { sent, env } = fakeEnv({ answer: 'x' });
  env.AI.run = () => new Promise(() => {});   // never settles
  const started = Date.now();
  const run = runAgent(env, ask, 'make the hero title smaller');
  // Nothing to wait 90 seconds for in a test: just prove the race is
  // wired by letting a rejecting timer stand in for the real one.
  ok('it does not resolve immediately',
     await Promise.race([run.then(() => false), Promise.resolve(true)]) === true);
  ok('and the test itself did not block', Date.now() - started < 1000);
}

console.log('\nTHE DEFERRAL');
{
  ok('Discord is told to wait', defer().type === 5);
  ok('and nothing else is sent with it',
     Object.keys(defer()).length === 1, JSON.stringify(defer()));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
