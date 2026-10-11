// 1 · print methods belong to the right objects and are callable
// 2 · the admin can set deadlines on any cycle
const fs = require('fs');
const dir = 'C:/Users/usif-/Downloads/Claude Code/FYP System/FYP-Standalone-NeonRenderMailtrap-v4';
const api = fs.readFileSync(dir + '/api/index.js', 'utf8');
const page = fs.readFileSync(dir + '/public/organizer/index.html', 'utf8');
let p = 0, x = 0;
const ck = (l, c, g) => { c ? p++ : x++; console.log((c ? '  ok   ' : '  FAIL ') + l + (c ? '' : ' -> ' + JSON.stringify(g))); };

// ── object ownership, by brace walking ──
const js = page.slice(page.lastIndexOf('<script>') + 8, page.lastIndexOf('</script>'));
const lines = js.split(/\r?\n/);
let cur = null, depth = 0, start = 0;
const objs = [];
lines.forEach((l, i) => {
  const m = /^const ([A-Za-z]+) = \{/.exec(l);
  if (m && cur === null) { cur = m[1]; depth = 1; start = i; return; }
  if (cur !== null) {
    for (const ch of l) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth <= 0) { objs.push({ name: cur, start: start, end: i }); cur = null; }
  }
});
const ownerOf = needle => {
  const i = lines.findIndex(l => l.trim() === needle);
  if (i < 0) return null;
  const o = objs.find(o => i > o.start && i < o.end);
  return o ? o.name : '(top level)';
};
const printOwners = [];
lines.forEach((l, i) => {
  if (l.trim() === 'print() {') {
    const o = objs.find(o => i > o.start && i < o.end);
    printOwners.push(o ? o.name : '(top level)');
  }
});
ck('exactly two print methods', printOwners.length === 2, printOwners);
ck('StuGroups owns one', printOwners.indexOf('StuGroups') >= 0, printOwners);
ck('Directory owns the other', printOwners.indexOf('Directory') >= 0, printOwners);
ck('no object has two print methods',
  new Set(printOwners).size === printOwners.length, printOwners);
ck('saveDeadlines belongs to AdminPanel', ownerOf('async saveDeadlines(cycleId) {') === 'AdminPanel',
  ownerOf('async saveDeadlines(cycleId) {'));

// the roster print reads StuGroups' own shape
const sgObj = objs.find(o => o.name === 'StuGroups');
const sgSrc = lines.slice(sgObj.start, sgObj.end).join('\n');
ck('roster print uses r.groups', /const r = this\.data;[\s\S]{0,200}r\.groups/.test(sgSrc));
ck('roster print reports to stugroups-sub', sgSrc.indexOf("el('stugroups-sub').textContent") >= 0);
const dirObj = objs.find(o => o.name === 'Directory');
const dirSrc = lines.slice(dirObj.start, dirObj.end).join('\n');
ck('directory print still uses r.campuses', /r\.campuses\.map/.test(dirSrc));
ck('directory print reports to dir-msg', dirSrc.indexOf("setAlert('dir-msg'") >= 0);

// ── the empty-state explanation ──
ck('an empty member list explains itself',
  /the server sent no names/.test(page));
ck('stale note about hidden names is gone',
  !/Student names stay hidden until the allocation is published/.test(page));
ck('new note says students are listed',
  /Students in your programme and campus are listed under each group/.test(page));

// ── admin deadlines: run the real handler ──
const cycles = [
  { id: 7, academic_year: '2026-2027', semester: 'Fall', program: 'Computer Engineering',
    campus: 'Debbieh', phase: 'IDEAS_OPEN', ideas_deadline: null, ranking_deadline: null,
    deadline_policy: 'open', deadline_delegate: '', min_group_size: 1, max_group_size: 5 },
];
const updates = [];
let session = { supervisor_id: 'A20160170', name: 'Admin', is_admin: true };
function sql(strings) {
  const vals = Array.prototype.slice.call(arguments, 1);
  const q = strings.join('?').replace(/\s+/g, ' ').trim();
  if (/^(CREATE|ALTER|DROP)/i.test(q)) return Promise.resolve([]);
  if (/^UPDATE org_cycles SET min_group_size/i.test(q)) return Promise.resolve([]);
  if (q.indexOf('FROM sessions') >= 0) return Promise.resolve(session ? [session] : []);
  if (q.indexOf('SELECT * FROM org_cycles WHERE id') === 0)
    return Promise.resolve(cycles.filter(c => c.id === vals[0]));
  if (/^UPDATE org_cycles SET ideas_deadline/i.test(q)) { updates.push(['ideas', vals[0]]); return Promise.resolve([]); }
  if (/^UPDATE org_cycles SET ranking_deadline/i.test(q)) { updates.push(['ranking', vals[0]]); return Promise.resolve([]); }
  if (q.indexOf('INSERT INTO org_audit') === 0) return Promise.resolve([]);
  throw new Error('unmocked: ' + q);
}
process.env.MAILTRAP_API_KEY = 'k';
process.env.SENDER_EMAIL = 'x@y.z';
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => sql };
  return origLoad.apply(this, arguments);
};
const handler = require(dir + '/api/index.js');
const call = (a, g) => new Promise(res => handler({ method: 'POST', body: { action: a, args: g } },
  { setHeader() {}, status() { return this; }, end() {}, json: d => res(d), headersSent: false }));

(async () => {
  let r = await call('orgAdminSetDeadline', ['tok', 7, 'ideas', '2026-10-20T07:00:00.000Z']);
  ck('admin sets the idea deadline', r.success === true, r);
  ck('it was written as an instant', updates.length === 1 && updates[0][0] === 'ideas'
    && updates[0][1] instanceof Date, updates);

  r = await call('orgAdminSetDeadline', ['tok', 7, 'ranking', '2026-11-05T21:00:00.000Z']);
  ck('admin sets the ranking deadline', r.success === true, r);
  ck('both deadlines recorded', updates.length === 2, updates.map(u => u[0]));

  r = await call('orgAdminSetDeadline', ['tok', 7, 'ideas', '']);
  ck('a deadline can be cleared', r.success === true && updates[2][1] === null, updates[2]);

  r = await call('orgAdminSetDeadline', ['tok', 7, 'ideas', '2026-10-20T10:00']);
  ck('a value with no timezone is refused', r.success === false && /out of date/.test(r.message), r);

  r = await call('orgAdminSetDeadline', ['tok', 999, 'ideas', '2026-10-20T07:00:00.000Z']);
  ck('an unknown cycle is refused', r.success === false && /Cycle not found/.test(r.message), r);

  r = await call('orgAdminSetDeadline', ['tok', 7, 'nonsense', '2026-10-20T07:00:00.000Z']);
  ck('an unknown deadline type is refused', r.success === false && /Unknown deadline type/.test(r.message), r);

  session = { supervisor_id: 'SUP_008', name: 'Dr. Tarnini', is_admin: false };
  r = await call('orgAdminSetDeadline', ['tok', 7, 'ideas', '2026-10-20T07:00:00.000Z']);
  ck('a supervisor cannot use the admin route', r.success === false && /Only the admin/.test(r.message), r);

  session = null;
  r = await call('orgAdminSetDeadline', ['tok', 7, 'ideas', '2026-10-20T07:00:00.000Z']);
  ck('no session is refused', r.success === false && r.sessionInvalid === true, r);

  // ── admin UI ──
  ck('admin panel has idea deadline inputs', /id="ad-i-\$\{c\.id\}"/.test(page));
  ck('admin panel has ranking deadline inputs', /id="ad-r-\$\{c\.id\}"/.test(page));
  ck('admin save button wired', /AdminPanel\.saveDeadlines\(\$\{c\.id\}\)/.test(page));
  ck('admin send converts to an instant', /fromLocalInput\(el\('ad-i-' \+ cycleId\)\.value\)/.test(page));
  ck('timezone shown to the admin', /Times are in \$\{escHtml\(localZoneName\(\)\)\}/.test(page));
  ck('an unset idea deadline is called out',
    /the list will never open to students/.test(page));
  ck('policy control retained', /AdminPanel\.change\(\$\{c\.id\}\)/.test(page));
  ck('panel subtitle updated', /Set the deadlines for any programme and campus/.test(page));

  console.log('\n' + p + ' passed, ' + x + ' failed');
  process.exit(x ? 1 : 0);
})().catch(e => { console.log('ERROR ' + e.message); process.exit(1); });
