// Runs the REAL orgGetStudentGroups handler against mock data to prove whether
// student names come back to a supervisor.
const dir = 'C:/Users/usif-/Downloads/Claude Code/FYP System/FYP-Standalone-NeonRenderMailtrap-v4';
let p = 0, x = 0;
const ck = (l, c, g) => { c ? p++ : x++; console.log((c ? '  ok   ' : '  FAIL ') + l + (c ? '' : ' -> ' + JSON.stringify(g))); };

const cycle = {
  id: 7, academic_year: '2026-2027', semester: 'Fall',
  program: 'Electric Power and Machines Engineering', campus: 'Debbieh',
  phase: 'RANKING_OPEN', min_group_size: 1, max_group_size: 5,
  deadline_policy: 'open', deadline_delegate: '', ideas_deadline: null, ranking_deadline: null,
};
const groups = [
  { id: 10, cycle_id: 7, group_code: 'EPME-D-G01', created_by_student_id: '201700170',
    proposed_title: 'Smart Grid', proposed_desc: 'A grid monitor.', created_at: '2026-10-01' },
  { id: 11, cycle_id: 7, group_code: 'EPME-D-G02', created_by_student_id: '201700180',
    proposed_title: '', proposed_desc: '', created_at: '2026-10-02' },
];
const members = [
  { id: 1, cycle_id: 7, group_id: 10, student_id: '201700170', student_name: 'Ahmad Mansour', cgpa: '3.50', email: 'a@bau.edu.lb' },
  { id: 2, cycle_id: 7, group_id: 10, student_id: '201700171', student_name: 'Sara Khoury',   cgpa: '3.00', email: '' },
  { id: 3, cycle_id: 7, group_id: 11, student_id: '201700180', student_name: 'Omar Nasr',     cgpa: null,   email: 'o@bau.edu.lb' },
];

function sql(strings) {
  const q = strings.join('?').replace(/\s+/g, ' ').trim();
  if (/^(CREATE|ALTER|DROP|UPDATE)/i.test(q)) return Promise.resolve([]);
  if (q.indexOf('FROM sessions') >= 0)
    return Promise.resolve([{ supervisor_id: 'SUP_008', name: 'Dr. Tarnini', program: cycle.program, is_admin: false }]);
  if (q.indexOf('SELECT * FROM supervisors WHERE supervisor_id') === 0)
    return Promise.resolve([{ supervisor_id: 'SUP_008', name: 'Dr. Tarnini', program: cycle.program, campus: 'Debbieh', email: 'mt@bau.edu.lb' }]);
  if (q.indexOf('SELECT * FROM org_cycles') === 0) return Promise.resolve([cycle]);
  if (q.indexOf('SELECT * FROM org_groups WHERE cycle_id') === 0) return Promise.resolve(groups);
  if (q.indexOf('SELECT * FROM org_group_members WHERE cycle_id') === 0) return Promise.resolve(members);
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
const call = (action, args) => new Promise(res => {
  handler({ method: 'POST', body: { action: action, args: args } },
    { setHeader() {}, status() { return this; }, end() {}, json: d => res(d), headersSent: false });
});

(async () => {
  const r = await call('orgGetStudentGroups', ['tok']);
  console.log('response:', JSON.stringify(r, null, 1).slice(0, 900));
  console.log('');

  ck('call succeeds', r.success === true, r.message);
  ck('two groups returned', (r.groups || []).length === 2, r.groups && r.groups.length);
  const g1 = (r.groups || []).find(g => g.code === 'EPME-D-G01');
  ck('group found', !!g1);
  ck('size is right', g1 && g1.size === 2, g1 && g1.size);
  ck('MEMBERS ARE RETURNED', g1 && Array.isArray(g1.members) && g1.members.length === 2,
    g1 && g1.members);
  ck('names present', g1 && g1.members[0].name === 'Ahmad Mansour', g1 && g1.members[0]);
  ck('ids present', g1 && g1.members[0].id === '201700170');
  ck('cgpa parsed to a number', g1 && g1.members[0].cgpa === 3.5, g1 && g1.members[0].cgpa);
  ck('creator flagged', g1 && g1.members[0].isCreator === true && g1.members[1].isCreator === false);
  ck('missing cgpa stays null', (r.groups.find(g => g.code === 'EPME-D-G02') || {}).members[0].cgpa === null);
  ck('programme returned for the printout', r.program === cycle.program, r.program);
  ck('campus returned', r.campus === 'Debbieh', r.campus);
  ck('term returned', r.semester === 'Fall' && r.academicYear === '2026-2027');

  console.log('\n' + p + ' passed, ' + x + ' failed');
  process.exit(x ? 1 : 0);
})().catch(e => { console.log('ERROR ' + e.message); process.exit(1); });
