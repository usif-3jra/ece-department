// 1 · supervisors can be edited on a project (admin freely, owner co-only)
// 2 · a group's own proposed idea can be assigned and published
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'api/index.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public/organizer/index.html'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
let p = 0, x = 0;
const ck = (l, c, g) => { c ? p++ : x++; console.log((c ? '  ok   ' : '  FAIL ') + l + (c ? '' : ' -> ' + JSON.stringify(g))); };

// ───────────────────────── shared mock layer ─────────────────────────
const db = {
  projects: [{ project_id: 'PRJ_1', title: 'Old Title', supervisors: 'SUP_008,SUP_009',
               program_type: 'Electric Power and Machines Engineering' }],
  supervisors: [
    { supervisor_id: 'SUP_008', name: 'Dr. Tarnini',  program: 'Electric Power and Machines Engineering', campus: 'Debbieh' },
    { supervisor_id: 'SUP_009', name: 'Dr. Al-Ghali', program: 'Electric Power and Machines Engineering', campus: 'Debbieh' },
    { supervisor_id: 'SUP_010', name: 'Dr. Dankar',   program: 'Electric Power and Machines Engineering', campus: 'Debbieh' },
  ],
  cycle: { id: 7, academic_year: '2026-2027', semester: 'Fall',
           program: 'Electric Power and Machines Engineering', campus: 'Debbieh',
           phase: 'RANKING_CLOSED', min_group_size: 1, max_group_size: 5,
           deadline_policy: 'open', deadline_delegate: '', ideas_deadline: null, ranking_deadline: null },
  groups: [
    { id: 10, cycle_id: 7, group_code: 'EPME-D-G01', created_by_student_id: '201700170',
      proposed_title: 'Solar Water Purifier', proposed_desc: 'A solar unit.', status: 'ranked' },
    { id: 11, cycle_id: 7, group_code: 'EPME-D-G02', created_by_student_id: '201700180',
      proposed_title: '', proposed_desc: '', status: 'ranked' },
  ],
  members: [
    { id: 1, cycle_id: 7, group_id: 10, student_id: '201700170', student_name: 'Ahmad Mansour', cgpa: '3.5', email: 'a@bau.edu.lb' },
    { id: 2, cycle_id: 7, group_id: 11, student_id: '201700180', student_name: 'Omar Nasr', cgpa: '3.1', email: 'o@bau.edu.lb' },
  ],
  ideas: [{ id: 100, cycle_id: 7, supervisor_id: 'SUP_009', title: 'Grid Monitor', description: 'd',
            min_students: 1, max_students: 4, co_supervisor_id: '', status: 'submitted', field: '' }],
  participants: [
    { cycle_id: 7, supervisor_id: 'SUP_008', max_groups: 2, status: 'submitted', expected: true },
    { cycle_id: 7, supervisor_id: 'SUP_009', max_groups: 1, status: 'submitted', expected: true },
    { cycle_id: 7, supervisor_id: 'SUP_010', max_groups: 1, status: 'declared_none', expected: true },
  ],
  allocs: [],
  students: [],
  rankings: [],
};
let session = { supervisor_id: 'A20160170', name: 'Admin', is_admin: true };
const writes = [];

function sql(strings) {
  const vals = Array.prototype.slice.call(arguments, 1);
  const q = (typeof strings === 'string' ? strings : strings.join('?')).replace(/\s+/g, ' ').trim();

  if (typeof strings === 'string') {           // the parameterised UPDATE projects call
    writes.push({ q, vals: vals[0] });
    if (/^UPDATE projects SET/.test(q)) {
      const cols = q.replace('UPDATE projects SET ', '').split(' WHERE')[0].split(', ')
        .map(s => s.split(' = ')[0]);
      cols.forEach((c, i) => { db.projects[0][c] = vals[0][i]; });
    }
    return Promise.resolve([]);
  }
  if (/^(CREATE|ALTER|DROP)/i.test(q)) return Promise.resolve([]);
  if (/^UPDATE org_cycles SET min_group_size/i.test(q)) return Promise.resolve([]);
  if (q.indexOf('FROM sessions') >= 0) return Promise.resolve(session ? [session] : []);
  if (q.indexOf('SELECT supervisors FROM projects') === 0) return Promise.resolve(db.projects);
  if (q.indexOf('SELECT supervisor_id, name FROM supervisors WHERE supervisor_id = ANY') === 0)
    return Promise.resolve(db.supervisors.filter(s => (vals[0] || []).indexOf(s.supervisor_id) >= 0));
  if (q.indexOf('SELECT program FROM supervisors WHERE supervisor_id') === 0)
    return Promise.resolve(db.supervisors.filter(s => s.supervisor_id === vals[0]));
  if (q.indexOf('SELECT name FROM supervisors WHERE supervisor_id') === 0)
    return Promise.resolve(db.supervisors.filter(s => s.supervisor_id === vals[0]));
  if (q.indexOf('SELECT supervisor_id, name FROM supervisors WHERE supervisor_id =') === 0)
    return Promise.resolve(db.supervisors.filter(s => s.supervisor_id === vals[0]
      && s.program === vals[1] && s.campus === vals[2]));
  if (q.indexOf('SELECT supervisor_id, name FROM supervisors WHERE program') === 0)
    return Promise.resolve(db.supervisors);
  if (q.indexOf('SELECT * FROM supervisors WHERE supervisor_id') === 0)
    return Promise.resolve(db.supervisors.filter(s => s.supervisor_id === vals[0]));
  if (q.indexOf('SELECT * FROM org_cycles') === 0) return Promise.resolve([db.cycle]);
  if (q.indexOf('SELECT * FROM org_groups WHERE id') === 0)
    return Promise.resolve(db.groups.filter(g => g.id === vals[0]));
  if (q.indexOf('SELECT * FROM org_groups WHERE cycle_id') === 0) return Promise.resolve(db.groups);
  if (q.indexOf('SELECT * FROM org_group_members WHERE group_id') === 0)
    return Promise.resolve(db.members.filter(m => m.group_id === vals[0]));
  if (q.indexOf('SELECT group_id, student_id, cgpa FROM org_group_members') === 0)
    return Promise.resolve(db.members);
  if (q.indexOf('SELECT * FROM org_ideas WHERE id') === 0)
    return Promise.resolve(db.ideas.filter(i => i.id === vals[0]));
  if (q.indexOf('SELECT i.*, s.name AS supervisor_name FROM org_ideas i') === 0)
    return Promise.resolve(db.ideas.map(i => ({ ...i,
      supervisor_name: (db.supervisors.find(s => s.supervisor_id === i.supervisor_id) || {}).name })));
  if (q.indexOf('SELECT * FROM org_participants') === 0) return Promise.resolve(db.participants);
  if (q.indexOf('FROM org_rankings r JOIN org_groups g') >= 0) return Promise.resolve(db.rankings);
  if (q.indexOf('SELECT rank FROM org_rankings') === 0) return Promise.resolve([]);
  if (q.indexOf('SELECT * FROM org_allocations') === 0) return Promise.resolve(db.allocs);
  if (q.indexOf('SELECT a.group_id, g.group_code FROM org_allocations a') === 0) return Promise.resolve([]);
  if (q.indexOf('SELECT title FROM projects') === 0) return Promise.resolve([]);
  if (q.indexOf('SELECT student_id, student_name FROM students') === 0) return Promise.resolve([]);
  if (q.indexOf('INSERT INTO org_allocations') === 0) {
    const own = q.indexOf('TRUE') >= 0;
    db.allocs = db.allocs.filter(a => a.group_id !== vals[1]);
    db.allocs.push({ id: db.allocs.length + 1, cycle_id: vals[0], group_id: vals[1],
      idea_id: own ? null : vals[2], assigned_rank: own ? 0 : vals[3],
      assigned_by: own ? vals[3] : vals[4], status: 'draft',
      own_idea: own, own_supervisor_id: own ? vals[4] : '' });
    return Promise.resolve([]);
  }
  if (q.indexOf('INSERT INTO org_audit') === 0) return Promise.resolve([]);
  if (q.indexOf('DELETE FROM org_allocations') === 0) {
    db.allocs = db.allocs.filter(a => a.group_id !== vals[1]); return Promise.resolve([]);
  }
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
const handler = require(path.join(root, 'api/index.js'));
const call = (a, g) => new Promise(res => handler({ method: 'POST', body: { action: a, args: g } },
  { setHeader() {}, status() { return this; }, end() {}, json: d => res(d), headersSent: false }));

(async () => {
  // ═══ 1 · editing supervisors ═══
  console.log('— supervisors on a project —');
  let r = await call('updateProject', ['tok', 'PRJ_1', { supervisors: ['SUP_010', 'SUP_008'] }]);
  ck('admin can replace the main supervisor', r.success === true, r);
  ck('the new list was written', db.projects[0].supervisors === 'SUP_010,SUP_008',
    db.projects[0].supervisors);
  ck('programme follows the new lead', db.projects[0].program_type === 'Electric Power and Machines Engineering');

  db.projects[0].supervisors = 'SUP_008,SUP_009';
  session = { supervisor_id: 'SUP_008', name: 'Dr. Tarnini', is_admin: false };

  r = await call('updateProject', ['tok', 'PRJ_1', { supervisors: ['SUP_008', 'SUP_010'] }]);
  ck('an owner can swap a co-supervisor', r.success === true, r);
  ck('the change was written', db.projects[0].supervisors === 'SUP_008,SUP_010',
    db.projects[0].supervisors);

  r = await call('updateProject', ['tok', 'PRJ_1', { supervisors: ['SUP_008'] }]);
  ck('an owner can drop all co-supervisors', r.success === true, r);

  r = await call('updateProject', ['tok', 'PRJ_1', { supervisors: ['SUP_010', 'SUP_008'] }]);
  ck('an owner cannot change the main supervisor',
    r.success === false && /Only the admin can change the main supervisor/.test(r.message), r);

  r = await call('updateProject', ['tok', 'PRJ_1', { supervisors: [] }]);
  ck('an empty list is refused', r.success === false && /at least one supervisor/.test(r.message), r);

  r = await call('updateProject', ['tok', 'PRJ_1', { supervisors: ['SUP_008', 'SUP_008'] }]);
  ck('duplicates are refused', r.success === false && /more than once/.test(r.message), r);

  r = await call('updateProject', ['tok', 'PRJ_1', { supervisors: ['SUP_008', 'NOPE'] }]);
  ck('an unknown supervisor is refused', r.success === false && /Unknown supervisor/.test(r.message), r);

  session = { supervisor_id: 'SUP_099', name: 'Outsider', is_admin: false };
  r = await call('updateProject', ['tok', 'PRJ_1', { supervisors: ['SUP_099'] }]);
  ck('a non-supervisor cannot edit the project',
    r.success === false && /only edit projects you supervise/.test(r.message), r);

  // ═══ 2 · a group's own idea ═══
  console.log('— a group keeping its own idea —');
  session = { supervisor_id: 'SUP_008', name: 'Dr. Tarnini', is_admin: false };

  r = await call('orgGetAssignmentBoard', ['tok']);
  ck('board loads', r.success === true, r.message);
  const g1 = (r.groups || []).find(g => g.code === 'EPME-D-G01');
  ck('the own idea is offered to its group', g1 && g1.ownTitle === 'Solar Water Purifier', g1 && g1.ownTitle);
  const g2 = (r.groups || []).find(g => g.code === 'EPME-D-G02');
  ck('a group without one offers nothing', g2 && g2.ownTitle === '', g2 && g2.ownTitle);
  ck('the supervisor list is supplied for the picker',
    (r.supervisors || []).length === 3, r.supervisors && r.supervisors.length);
  ck('supervisors are named, not just ids',
    (r.supervisors || []).every(s => s.name && s.name.indexOf('SUP_') !== 0), r.supervisors);

  r = await call('orgSetAssignment', ['tok', 10, 'own']);
  ck('own idea without a supervisor is refused',
    r.success === false && /which supervisor will take/.test(r.message), r);

  r = await call('orgSetAssignment', ['tok', 11, 'own', 'SUP_008']);
  ck('a group with no proposal cannot keep one',
    r.success === false && /has not proposed an idea/.test(r.message), r);

  r = await call('orgSetAssignment', ['tok', 10, 'own', 'SUP_099']);
  ck('a supervisor outside the programme is refused',
    r.success === false && /from this programme and campus/.test(r.message), r);

  r = await call('orgSetAssignment', ['tok', 10, 'own', 'SUP_008']);
  ck('the own idea is assigned', r.success === true && r.ownIdea === true, r);
  ck('stored with no idea_id and the chosen supervisor',
    db.allocs.length === 1 && db.allocs[0].idea_id === null
      && db.allocs[0].own_idea === true && db.allocs[0].own_supervisor_id === 'SUP_008', db.allocs);

  r = await call('orgGetAssignmentBoard', ['tok']);
  const after = (r.groups || []).find(g => g.code === 'EPME-D-G01');
  ck('the board shows it as assigned', after && after.ownAssigned === true, after);
  ck('the assigned title is the proposal', after && after.assignedTitle === 'Solar Water Purifier',
    after && after.assignedTitle);
  ck('it counts towards the supervisor load',
    (r.overloaded || []).length === 0, r.overloaded);
  ck('it no longer counts as unassigned', r.unassigned === 1, r.unassigned);

  // publishing
  r = await call('orgDryRunPublish', ['tok']);
  ck('the pre-flight accepts the own idea', r.success === true, r.message);
  const row = (r.plan || []).find(pl => pl.code === 'EPME-D-G01');
  ck('the plan uses the proposal as the title', row && row.title === 'Solar Water Purifier', row);
  ck('the plan uses the chosen supervisor',
    row && row.supervisorIds.join(',') === 'SUP_008', row && row.supervisorIds);

  // a missing supervisor on an own-idea row is caught
  db.allocs[0].own_supervisor_id = '';
  r = await call('orgDryRunPublish', ['tok']);
  ck('an own idea with no supervisor blocks publishing',
    (r.blockers || []).some(b => /no supervisor is attached/.test(b)), r.blockers);

  // ═══ UI wiring ═══
  console.log('— wiring —');
  ck('own-idea option in the dropdown', /value="own"\$\{g\.ownAssigned/.test(page));
  ck('dropdown routes through pick()', /Assign\.pick\(\$\{g\.id\}, this\.value\)/.test(page));
  ck('supervisor picker rendered', /id="ownsupsel-\$\{g\.id\}"/.test(page));
  ck('picker hidden unless chosen', /g\.ownAssigned \? '' : 'display:none;'/.test(page));
  ck('setOwn sends own plus the supervisor',
    /orgSetAssignment', Auth\.token, groupId, 'own', sel\.value/.test(page));

  ck('edit modal has a supervisors block', /id="edit-sup-rows"/.test(idx));
  ck('add co-supervisor button', /Reg\.addEditSupRow\(\)/.test(idx));
  ck('rows built on open', /this\._renderEditSupRows\(p\)/.test(app));
  ck('main supervisor locked for non-admins', /const locked = isPrimary && !isAdmin;/.test(app));
  ck('supervisors sent on save', /^\s+supervisors,$/m.test(app));
  ck('client guards an empty list', /A project needs at least one supervisor\./.test(app));

  console.log('\n' + p + ' passed, ' + x + ' failed');
  process.exit(x ? 1 : 0);
})().catch(e => { console.log('ERROR ' + e.message + '\n' + e.stack); process.exit(1); });
