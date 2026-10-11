// Structural integrity of the organizer page and API.
// These are the checks that caught real bugs: a method landing in the wrong
// object, a function called but never defined, duplicate switch cases, and a
// page/API build mismatch. Run with:  node _tests/integrity.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'api/index.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public/organizer/index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
let p = 0, x = 0;
const ck = (l, c, g) => { c ? p++ : x++; console.log((c ? '  ok   ' : '  FAIL ') + l + (c ? '' : ' -> ' + JSON.stringify(g))); };

// ── the page's inline script ──
const blocks = [...page.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
ck('exactly one inline script block', blocks.length === 1, blocks.length);
const js = blocks.length ? blocks[blocks.length - 1][1] : '';
const lines = js.split(/\r?\n/);

// every top-level object, by brace walking
let cur = null, depth = 0, start = 0;
const objs = [];
lines.forEach((l, i) => {
  const m = /^const ([A-Za-z]+) = \{/.exec(l);
  if (m && cur === null) { cur = m[1]; depth = 1; start = i; return; }
  if (cur !== null) {
    for (const ch of l) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth <= 0) { objs.push({ name: cur, start, end: i }); cur = null; }
  }
});
const names = objs.map(o => o.name);
for (const n of ['Auth', 'Student', 'Ideas', 'Board', 'Settings', 'Assign', 'StuGroups',
                 'Directory', 'Live', 'AdminPanel', 'Group', 'OurIdea', 'Rank', 'Share', 'PrintList'])
  ck('module present: ' + n, names.indexOf(n) >= 0);

// no duplicate keys inside one object (this is how a print() got shadowed)
for (const o of objs) {
  const keys = lines.slice(o.start + 1, o.end)
    .map(l => /^  ([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(l) || /^  (?:async )\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(l))
    .filter(Boolean).map(m => m[1]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  ck('no duplicate methods in ' + o.name, dupes.length === 0, dupes);
}

// every method referenced from an onclick/onchange exists on its object
const handlers = [...new Set([...page.matchAll(/on(?:click|change)="([A-Za-z_]+)\.([A-Za-z_]+)\(/g)]
  .map(m => m[1] + '.' + m[2]))];
const missingHandlers = [];
for (const h of handlers) {
  const [objName, fn] = h.split('.');
  if (['this', 'event', 'window', 'document'].indexOf(objName) >= 0) continue;
  const o = objs.find(o => o.name === objName);
  if (!o) { missingHandlers.push(h + ' (no such object)'); continue; }
  const body = lines.slice(o.start, o.end + 1).join('\n');
  const re = new RegExp('(^|\\s)(async\\s+)?' + fn + '\\s*\\(', 'm');
  if (!re.test(body)) missingHandlers.push(h);
}
ck('every inline handler resolves to a real method',
  missingHandlers.length === 0, missingHandlers);

// every helper called is defined somewhere in the script
const helpers = ['openPrintable', 'fromLocalInput', 'toLocalInput', 'localZoneName',
                 'escHtml', 'setAlert', 'sessionCheck', 'el', 'showScreen', 'api', 'toggleDesc'];
for (const h of helpers)
  ck('helper defined: ' + h, new RegExp('function ' + h + '\\s*\\(').test(js));

// element ids used by the script exist in the markup
const declared = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const used = new Set([...js.matchAll(/\bel\('([^']+)'\)/g)].map(m => m[1]));
ck('no element id is missing',
  [...used].every(u => declared.has(u)), [...used].filter(u => !declared.has(u)));

// every action the page calls exists in the dispatcher, and none is duplicated
const cases = [...api.matchAll(/case '([A-Za-z]+)':/g)].map(m => m[1]);
const dupCases = cases.filter((c, i) => cases.indexOf(c) !== i);
ck('no duplicate switch cases in the API', dupCases.length === 0, dupCases);
const called = [...new Set([...js.matchAll(/api\('([A-Za-z]+)'/g)].map(m => m[1]))];
ck('every action the page calls exists',
  called.every(c => cases.indexOf(c) >= 0), called.filter(c => cases.indexOf(c) < 0));

// ── build stamps must agree, or a half deploy goes unnoticed ──
const apiBuild = (/const API_BUILD = '([^']+)'/.exec(api) || [])[1];
const pageBuild = (/PAGE_BUILD: '([^']+)'/.exec(page) || [])[1];
const stamps = [...new Set(page.match(/v04-\d{2}-\d{2}-\d{4} R\d{2}/g) || [])];
ck('API carries a build stamp', !!apiBuild, apiBuild);
ck('page carries a build stamp', !!pageBuild, pageBuild);
ck('API and page builds agree', apiBuild === pageBuild, { apiBuild, pageBuild });
ck('visible stamps are consistent', stamps.length === 1 && stamps[0] === apiBuild, stamps);
ck('health endpoint reports the build', /build: API_BUILD/.test(server));

// ── printing ──
const printOwners = [];
lines.forEach((l, i) => {
  if (l.trim() === 'print() {') {
    const o = objs.find(o => i > o.start && i < o.end);
    printOwners.push(o ? o.name : '(top level)');
  }
});
ck('print methods sit on StuGroups and Directory',
  printOwners.length === 2 && printOwners.indexOf('StuGroups') >= 0
    && printOwners.indexOf('Directory') >= 0, printOwners);
ck('all print paths use the shared opener',
  (js.match(/^\s+openPrintable\(html,/gm) || []).length === 3,
  (js.match(/^\s+openPrintable\(html,/gm) || []).length);
ck('blocked pop-ups fall back to an iframe', /id = 'print-frame'/.test(js));

// ── rules that have been asked for explicitly ──
ck('a one-student group is allowed',
  /if \(members\.length < 1\)/.test(api) && /A group needs at least one student/.test(api));
ck('CGPA is mandatory', /Please enter a valid CGPA/.test(api));
ck('deadlines must carry a timezone',
  (api.match(/\(Z\|\[\+-\]\\d\{2\}:\?\\d\{2\}\)\$/g) || []).length >= 2);
ck('admin can set deadlines on any cycle', /case 'orgAdminSetDeadline'/.test(api));
ck('supervisors receive student names',
  /members: members\.filter\(m => m\.group_id === g\.id\)/.test(api));

console.log('\n' + p + ' passed, ' + x + ' failed');
process.exit(x ? 1 : 0);
