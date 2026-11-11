/**
 * Find identifiers a page uses but never declares.
 *
 * `currentClass.toLowerCase()` sat in manage.html for weeks. It is the
 * name app.js uses; the panel's variable is adminClass. Nothing caught it
 * because it parses perfectly, the function around it is only reached by
 * pressing one button, and the error it throws is swallowed by a catch
 * that turns it into a toast. End Season had therefore never worked.
 *
 * This walks each page's scripts, collects every declaration and every
 * reference, and reports references that resolve to nothing. Anything
 * genuinely global goes in KNOWN below, so the list of what a page is
 * allowed to assume stays written down.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

const KNOWN = new Set([
  // the platform
  'window','document','console','fetch','location','navigator','localStorage',
  'sessionStorage','setTimeout','clearTimeout','setInterval','clearInterval',
  'requestAnimationFrame','cancelAnimationFrame','JSON','Math','Date','Number',
  'String','Boolean','Array','Object','Promise','Map','Set','WeakMap','WeakSet',
  'RegExp','Error','TypeError','RangeError','isNaN','isFinite','parseInt',
  'parseFloat','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
  'Intl','URL','URLSearchParams','FormData','Blob','File','FileReader','Image',
  'Audio','AbortController','TextEncoder','TextDecoder','crypto','atob','btoa',
  'performance','history','screen','alert','confirm','prompt','matchMedia',
  'getComputedStyle','HTMLElement','Element','Node','Event','CustomEvent',
  'IntersectionObserver','ResizeObserver','MutationObserver','DOMParser',
  'Worker','structuredClone','queueMicrotask','globalThis','undefined','NaN',
  'Infinity','arguments','self','top','parent','frames','CanvasRenderingContext2D',
  'OffscreenCanvas','createImageBitmap','ImageData','Headers','Request','Response',
  'BigInt','Symbol','Proxy','Reflect','WebSocket','EventSource','Notification',
  'speechSynthesis','SpeechSynthesisUtterance','visualViewport','scrollTo','print',
  'open','close','postMessage','addEventListener','removeEventListener','caches',
  'indexedDB','process','XMLHttpRequest','FontFace','Intl',
]);

/** Everything a page assigns onto window is reachable by bare name. */
function windowAssignments(src) {
  const out = new Set();
  for (const m of src.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1]);
  return out;
}

function scriptsOf(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (!file.endsWith('.html')) return [{ code: src, module: true }];
  return [...src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(m => !/\bsrc=/.test(m[1]))
    .map(m => ({ code: m[2], module: /type=["']module["']/.test(m[1]) }));
}

/**
 * `groups` is a list of file lists. Files in one group share a scope at
 * runtime — index.html's inline script can call anything app.js declares,
 * because the browser loads them into the same global. Checking them
 * separately reports every cross-file call as undeclared.
 */
export function undeclared(groups) {
  const problems = [];
  for (const group of groups) {
    const blocks = group.flatMap(f => scriptsOf(f).map(b => ({ ...b, file: f })));
    const whole = blocks.map(b => b.code).join('\n');
    const declared = new Set([...windowAssignments(whole)]);
    const used = [];

    for (const { code, module, file } of blocks) {
      let ast;
      try {
        ast = acorn.parse(code, { ecmaVersion: 2023, sourceType: module ? 'module' : 'script',
                                  allowAwaitOutsideFunction: true, locations: true });
      } catch (err) {
        problems.push({ file, name: '(parse error)', line: err.loc ? err.loc.line : 0,
                        why: err.message });
        continue;
      }
      // Declarations anywhere in the file: a page is one shared scope.
      walk.full(ast, node => {
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') declared.add(node.id.name);
        if (node.type === 'FunctionDeclaration' && node.id) declared.add(node.id.name);
        if (node.type === 'ClassDeclaration' && node.id) declared.add(node.id.name);
        if (node.type === 'ImportDefaultSpecifier' || node.type === 'ImportSpecifier' ||
            node.type === 'ImportNamespaceSpecifier') declared.add(node.local.name);
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression') {
          const names = [];
          const collect = pat => {
            if (!pat) return;
            if (pat.type === 'Identifier') names.push(pat.name);
            else if (pat.type === 'ObjectPattern') pat.properties.forEach(pr =>
              collect(pr.value || pr.argument));
            else if (pat.type === 'ArrayPattern') pat.elements.forEach(collect);
            else if (pat.type === 'AssignmentPattern') collect(pat.left);
            else if (pat.type === 'RestElement') collect(pat.argument);
          };
          node.params.forEach(collect);
          names.forEach(n => declared.add(n));
        }
        if (node.type === 'VariableDeclarator' && node.id.type !== 'Identifier') {
          const collect = pat => {
            if (!pat) return;
            if (pat.type === 'Identifier') declared.add(pat.name);
            else if (pat.type === 'ObjectPattern') pat.properties.forEach(pr => collect(pr.value || pr.argument));
            else if (pat.type === 'ArrayPattern') pat.elements.forEach(collect);
            else if (pat.type === 'AssignmentPattern') collect(pat.left);
            else if (pat.type === 'RestElement') collect(pat.argument);
          };
          collect(node.id);
        }
        if (node.type === 'CatchClause' && node.param && node.param.type === 'Identifier') {
          declared.add(node.param.name);
        }
        if (node.type === 'LabeledStatement') declared.add(node.label.name);
      });

      // References: identifiers that are read, not property names or keys.
      walk.ancestor(ast, {
        Identifier(node, _state, ancestors) {
          const parent = ancestors[ancestors.length - 2];
          if (!parent) return;
          if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
          if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
          if (parent.type === 'MethodDefinition' && parent.key === node) return;
          if (parent.type === 'ExportSpecifier' || parent.type === 'ImportSpecifier') return;
          if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
              parent.type === 'ContinueStatement') return;
          used.push({ name: node.name, line: node.loc.start.line, file });
        },
      });
    }

    const seen = new Set();
    for (const { name, line, file } of used) {
      if (declared.has(name) || KNOWN.has(name) || seen.has(name)) continue;
      seen.add(name);
      problems.push({ file, name, line, why: 'never declared on this page' });
    }
  }
  return problems;
}

// manage.html stands alone; the site's page and its script share a global.
export const GROUPS = [['manage.html'], ['index.html', 'app.js']];
if (process.argv[1] && process.argv[1].endsWith('undeclared.mjs')) {
  const found = undeclared(GROUPS);
  if (!found.length) {
    console.log('no undeclared identifiers in ' + GROUPS.flat().join(', '));
    process.exit(0);
  }
  for (const p of found) console.log(`${p.file}:${p.line}  ${p.name} — ${p.why}`);
  console.log(`\n${found.length} problem${found.length === 1 ? '' : 's'}`);
  process.exit(1);
}
