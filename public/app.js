'use strict';

// ── Utilities ─────────────────────────────────────────────────────────

const Toast = {
  _el: null, _bs: null,
  init() {
    this._el = document.getElementById('appToast');
    this._bs = bootstrap.Toast.getOrCreateInstance(this._el, { delay: 4000 });
  },
  show(msg, type = 'success') {
    document.getElementById('toastMsg').textContent = msg;
    this._el.className = `toast align-items-center border-0 text-bg-${type === 'success' ? 'success' : type === 'error' ? 'danger' : 'warning'}`;
    this._bs.show();
  },
};

const Spinner = {
  show() { document.getElementById('spinner-overlay').classList.remove('d-none'); },
  hide() { document.getElementById('spinner-overlay').classList.add('d-none'); },
};

// Sends every call as a POST to the Vercel API route
async function gsr(fn, ...args) {
  const res = await fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: fn, args }),
  });
  if (!res.ok) throw new Error('Server error ' + res.status);
  return res.json();
}

// Authenticated gsr — prepends session token automatically
function gsrAuth(fn, ...args) {
  return gsr(fn, Auth.sessionToken || '', ...args);
}

// Escapes HTML special characters to prevent XSS in innerHTML insertions
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _showWeightTotal(elId, total, label) {
  const el = document.getElementById(elId);
  if (!el) return;
  const t = Math.round(total * 10) / 10;
  const ok = Math.round(total) === 100;
  el.innerHTML = `${label ? label + ': ' : ''}Total weight: <strong class="${ok ? 'text-success' : 'text-danger'}">${t} / 100</strong>`;
}

// ── Auth ──────────────────────────────────────────────────────────────

const Auth = {
  supervisor:   null,
  sessionToken: null,

  async login() {
    const id  = document.getElementById('login-id').value.trim();
    const pwd = document.getElementById('login-pwd').value;
    const err = document.getElementById('login-err');
    if (!id || !pwd) { err.textContent = 'Please enter your Supervisor ID and password.'; err.classList.remove('d-none'); return; }
    err.classList.add('d-none');

    const btn = document.getElementById('btn-login');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" style="width:1rem;height:1rem;border-width:.15em;vertical-align:-.125em;"></span>Signing in…';

    try {
      const res = await gsr('loginSupervisor', id, pwd);
      if (!res.success) {
        err.textContent = res.message;
        err.classList.remove('d-none');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt me-2"></i>Sign In';
        return;
      }
      this.supervisor   = res.supervisor;
      this.sessionToken = res.sessionToken;
      document.getElementById('login-overlay').style.display = 'none';
      document.getElementById('app-body').classList.remove('d-none');
      document.getElementById('header-sup-name').textContent = res.supervisor.name;
      document.getElementById('header-sup-prog').textContent = res.supervisor.program;
      Toast.init();
      App._applyAdminMode(res.supervisor.isAdmin);
      await App.afterLogin();
    } catch (e) {
      err.textContent = 'Server error: ' + e.message;
      err.classList.remove('d-none');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-sign-in-alt me-2"></i>Sign In';
    }
  },

  logout() {
    InactivityTimer.stop();
    if (this.sessionToken) gsr('logoutSession', this.sessionToken).catch(() => {});
    this.supervisor   = null;
    this.sessionToken = null;
    document.getElementById('app-body').classList.add('d-none');
    document.getElementById('login-overlay').style.display = '';
    document.getElementById('login-id').value  = '';
    document.getElementById('login-pwd').value = '';
    document.getElementById('login-err').classList.add('d-none');
    document.getElementById('btn-login').disabled = false;
    document.getElementById('btn-login').innerHTML = '<i class="fas fa-sign-in-alt me-2"></i>Sign In';
  },

  togglePwd(inputId, btn) {
    const inp = document.getElementById(inputId);
    if (inp.type === 'password') {
      inp.type = 'text';
      btn.innerHTML = '<i class="fas fa-eye-slash"></i>';
    } else {
      inp.type = 'password';
      btn.innerHTML = '<i class="fas fa-eye"></i>';
    }
  },

  async changePassword() {
    const current  = document.getElementById('pwd-current').value;
    const newPwd   = document.getElementById('pwd-new').value;
    const confirm  = document.getElementById('pwd-confirm').value;
    const errEl    = document.getElementById('pwd-err');
    errEl.classList.add('d-none');

    if (!current || !newPwd || !confirm) { errEl.textContent = 'All fields are required.'; errEl.classList.remove('d-none'); return; }
    if (newPwd !== confirm)              { errEl.textContent = 'New passwords do not match.'; errEl.classList.remove('d-none'); return; }
    if (newPwd.length < 6)              { errEl.textContent = 'Password must be at least 6 characters.'; errEl.classList.remove('d-none'); return; }

    Spinner.show();
    try {
      const res = await gsrAuth('changePassword', current, newPwd);
      if (!res.success) { errEl.textContent = res.message; errEl.classList.remove('d-none'); return; }
      bootstrap.Modal.getInstance(document.getElementById('modalChangePwd')).hide();
      ['pwd-current','pwd-new','pwd-confirm'].forEach(id => document.getElementById(id).value = '');
      Toast.show('Password updated successfully.');
    } catch (e) { errEl.textContent = 'Error: ' + e.message; errEl.classList.remove('d-none'); }
    finally { Spinner.hide(); }
  },
};

// ── Inactivity Timer ──────────────────────────────────────────────────

const InactivityTimer = {
  WARN_MS:   30 * 60 * 1000,
  LOGOUT_MS:  5 * 60 * 1000,
  _warnT:    null,
  _interval: null,
  _active:   false,
  _warned:   false,

  start() {
    this._active = true;
    const events = ['mousemove','keydown','click','scroll','touchstart'];
    events.forEach(ev => document.addEventListener(ev, this._onActivity.bind(this), { passive: true }));
    this._schedule();
  },

  stop() {
    this._active = false;
    clearTimeout(this._warnT);
    clearInterval(this._interval);
    this._warned = false;
    const modal = bootstrap.Modal.getInstance(document.getElementById('modalInactivity'));
    if (modal) modal.hide();
  },

  _onActivity() {
    if (!this._active || this._warned) return;
    this._schedule();
  },

  _schedule() {
    clearTimeout(this._warnT);
    this._warnT = setTimeout(() => this._showWarning(), this.WARN_MS);
  },

  _showWarning() {
    this._warned = true;
    let remaining = Math.floor(this.LOGOUT_MS / 1000);
    const el = document.getElementById('inactivity-countdown');
    if (el) el.textContent = this._fmt(remaining);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalInactivity')).show();
    this._interval = setInterval(() => {
      remaining--;
      if (el) el.textContent = this._fmt(remaining);
      if (remaining <= 0) {
        clearInterval(this._interval);
        bootstrap.Modal.getInstance(document.getElementById('modalInactivity'))?.hide();
        Auth.logout();
      }
    }, 1000);
  },

  stayLoggedIn() {
    clearInterval(this._interval);
    this._warned = false;
    bootstrap.Modal.getInstance(document.getElementById('modalInactivity'))?.hide();
    this._schedule();
  },

  _fmt(s) {
    return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  },
};

// ── App ───────────────────────────────────────────────────────────────

const App = {
  _applyAdminMode(isAdmin) {
    const manageBtn  = document.getElementById('btn-manage-users');
    if (manageBtn)   manageBtn.classList.toggle('d-none', !isAdmin);
    const progSel    = document.getElementById('res-filter-program');
    if (progSel)     progSel.classList.toggle('d-none', !isAdmin);
    const distBtn    = document.getElementById('btn-export-distribution');
    if (distBtn)     distBtn.classList.toggle('d-none', !isAdmin);


    if (!isAdmin) {
      ['cfg-tw-weight','cfg-peer-weight','cfg-sup-weight'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('readonly', true);
      });
      ['btn-save-group-rubric','btn-save-indiv-rubric','btn-save-rubric'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('d-none');
      });
      document.querySelectorAll('.admin-only-field').forEach(el => el.classList.add('d-none'));

      const configNavItem = document.getElementById('tw-config-nav-item');
      if (configNavItem) configNavItem.classList.add('d-none');

      const configPane = document.getElementById('tw-config');
      const gradePane  = document.getElementById('tw-grade');
      const configBtn  = document.getElementById('tw-config-tab-btn');
      const gradeBtn   = document.getElementById('tw-grade-tab-btn');
      if (configPane) { configPane.classList.remove('show', 'active'); }
      if (gradePane)  { gradePane.classList.add('show', 'active'); }
      if (configBtn)  { configBtn.classList.remove('active'); }
      if (gradeBtn)   { gradeBtn.classList.add('active'); }
    }

    const muModal = document.getElementById('modalManageUsers');
    if (muModal) {
      muModal.addEventListener('show.bs.modal', () => Admin.loadUsers());
    }
  },

  async afterLogin() {
    await Promise.all([
      App.loadKPIs(),
      Reg.init(),
      TW.init(),
      Ex.loadProjects(),
    ]);
    if (Auth.supervisor && Auth.supervisor.isAdmin) FeedbackInbox.checkUnread();
    document.querySelector('[data-bs-target="#tab-ex"]').addEventListener('shown.bs.tab', () => Ex.loadProjects());
    document.querySelector('[data-bs-target="#tab-tw"]').addEventListener('shown.bs.tab', () => TW.refreshProjectList());
    document.querySelector('[data-bs-target="#tab-tw"]').addEventListener('hide.bs.tab', () => TW.stopPolling());
    document.querySelector('[data-bs-target="#tab-tasks"]').addEventListener('shown.bs.tab', () => Tasks.load());
    InactivityTimer.start();
    Tasks.load();
  },

  async loadKPIs() {
    try {
      const d = await gsrAuth('getKPIs');
      document.getElementById('val-fyp1').textContent = d.fyp1;
      document.getElementById('val-fyp2').textContent = d.fyp2;
      document.getElementById('val-stu').textContent  = d.students;
      document.getElementById('val-proj').textContent = d.projects;
    } catch (e) { console.warn('KPI load failed', e); }
  },

  showProjects(type) {
    const projects = Reg._projectsCache.filter(p => p.Type === type);
    document.getElementById('kpiProjectsTitle').innerHTML =
      `<i class="fas fa-folder-open me-2"></i>${type} Projects <span class="badge bg-${type === 'FYP1' ? 'primary' : 'success'} ms-2">${projects.length}</span>`;
    const tbody = document.getElementById('kpiProjectsList');
    if (!projects.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">No ${type} projects found.</td></tr>`;
    } else {
      tbody.innerHTML = projects.map((p, i) => {
        const supIds   = (p.Supervisors || '').split(',').map(x => x.trim()).filter(Boolean);
        const supNames = supIds.map(sid => {
          const s = Reg.allSupervisors.find(x => x.id === sid);
          return s ? s.name : sid;
        }).join(', ') || '—';
        const cnt = Reg._studentsCache.filter(s => s.ProjectID === p.ProjectID).length;
        const programs = [...new Set(supIds.map(sid => {
          const s = Reg.allSupervisors.find(x => x.id === sid);
          return s ? s.program : '';
        }).filter(Boolean))].join(', ') || p.ProgramType || '—';
        return `<tr>
          <td class="text-muted ps-3">${i + 1}</td>
          <td class="fw-medium">${escHtml(p.Title)}</td>
          <td class="small">${escHtml(supNames)}</td>
          <td class="text-center"><span class="badge bg-secondary">${cnt}</span></td>
          <td class="small text-muted">${escHtml(programs)}</td>
        </tr>`;
      }).join('');
    }
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalKPIProjects')).show();
  },

  showStudents() {
    const students = [...Reg._studentsCache].sort((a, b) => a.StudentName.localeCompare(b.StudentName));
    document.getElementById('kpiStudentsTitle').innerHTML =
      `<i class="fas fa-users me-2"></i>Active Students <span class="badge bg-secondary ms-2">${students.length}</span>`;
    const tbody = document.getElementById('kpiStudentsList');
    if (!students.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No students found.</td></tr>';
    } else {
      tbody.innerHTML = students.map((s, i) => {
        const proj = Reg._projectsCache.find(p => p.ProjectID === s.ProjectID);
        return `<tr>
          <td class="text-muted ps-3">${i + 1}</td>
          <td>${escHtml(s.StudentName)}</td>
          <td class="font-monospace small text-muted">${escHtml(s.StudentID)}</td>
          <td class="small">${proj ? escHtml(proj.Title) : '—'}</td>
        </tr>`;
      }).join('');
    }
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalKPIStudents')).show();
  },

};

// ── Tab 1: Registration ───────────────────────────────────────────────

const Reg = {
  programs: [],
  allSupervisors: [],
  studentCount: 0,
  _projectsCache: [],
  _studentsCache: [],
  _submitting: false,

  async init() {
    this._buildYears();
    this._setSemesterField();
    await this._loadMasterData();
    this._initFirstSupRow();
    document.getElementById('studentRows').innerHTML = '';
    this.studentCount = 0;
    this.addStudentRow();
    this.loadProjects();

    document.getElementById('ms-program').innerHTML =
      this.programs.map(p => `<option>${p}</option>`).join('');

    document.getElementById('formRegister').addEventListener('submit', e => {
      e.preventDefault(); Reg.submit();
    });
  },

  _currentSemester() {
    const m = new Date().getMonth() + 1; // 1-12
    return (m >= 9 || m === 1) ? 'Fall' : 'Spring';
  },

  _setSemesterField() {
    const el = document.getElementById('f-semester');
    if (el) el.value = this._currentSemester();
  },

  _buildYears() {
    const sel = document.getElementById('f-year');
    sel.innerHTML = '';
    const START = 2025;
    for (let i = 0; i < 10; i++) {
      const y1 = START + i, y2 = y1 + 1;
      const val = `${y1}-${y2}`;
      sel.innerHTML += `<option value="${val}">${val}</option>`;
    }
  },

  async _loadMasterData() {
    try {
      [this.programs, this.allSupervisors] = await Promise.all([
        gsr('getPrograms'),
        gsrAuth('getAllSupervisors'),
      ]);
    } catch (e) { console.warn('_loadMasterData failed', e); }
  },

  _initFirstSupRow() {
    const first = document.querySelector('#supervisorRows .sup-row');
    if (first) this._populateProgDrop(first.querySelector('.prog-select'));
  },

  _populateProgDrop(sel) {
    sel.innerHTML = '<option value="">Select program…</option>' +
      this.programs.map(p => `<option value="${p}">${p}</option>`).join('');
    sel.addEventListener('change', () => this._onProgChange(sel));
  },

  _onProgChange(progSel) {
    const row    = progSel.closest('.sup-row');
    const supSel = row.querySelector('.sup-select');
    const list   = this.allSupervisors.filter(s => s.program === progSel.value);
    supSel.innerHTML = '<option value="">Select supervisor…</option>' +
      list.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  },

  addSupRow() {
    const container = document.getElementById('supervisorRows');
    const div = document.createElement('div');
    div.className = 'sup-row row g-2 mb-2 align-items-end';
    div.innerHTML = `
      <div class="col-md-4">
        <label class="form-label">Program Type <span class="req">*</span></label>
        <select class="form-select prog-select" required><option value="">Select program…</option></select>
      </div>
      <div class="col-md-5">
        <label class="form-label">Supervisor Name <span class="req">*</span></label>
        <select class="form-select sup-select" required><option value="">Select supervisor…</option></select>
      </div>
      <div class="col-auto">
        <button type="button" class="btn btn-outline-danger btn-sm" onclick="Reg.removeSupRow(this)"><i class="fas fa-trash"></i></button>
      </div>`;
    container.appendChild(div);
    this._populateProgDrop(div.querySelector('.prog-select'));
  },

  removeSupRow(btn) {
    const rows = document.querySelectorAll('#supervisorRows .sup-row');
    if (rows.length <= 1) { Toast.show('At least one supervisor is required.', 'warning'); return; }
    btn.closest('.sup-row').remove();
  },

  addStudentRow() {
    const container = document.getElementById('studentRows');
    const div = document.createElement('div');
    div.className = 'stu-row row g-2 mb-2 align-items-end';
    div.innerHTML = `
      <div class="col-md-3">
        <label class="form-label">Student Name <span class="req">*</span></label>
        <input type="text" class="form-control stu-name" placeholder="Full name" maxlength="100" required/>
      </div>
      <div class="col-md-2">
        <label class="form-label">Student ID <span class="req">*</span></label>
        <input type="text" class="form-control stu-id" placeholder="e.g. 202100123" maxlength="9" pattern="20[0-9]{7}" title="9 digits starting with 20" required/>
      </div>
      <div class="col-md-3">
        <label class="form-label">Email</label>
        <input type="email" class="form-control stu-email" placeholder="student@university.edu" maxlength="100"/>
      </div>
      <div class="col-auto">
        <button type="button" class="btn btn-outline-danger btn-sm" onclick="Reg.removeStudentRow(this)"><i class="fas fa-trash"></i></button>
      </div>`;
    container.appendChild(div);
    this.studentCount++;
  },

  removeStudentRow(btn) {
    const rows = document.querySelectorAll('#studentRows .stu-row');
    if (rows.length <= 1) { Toast.show('At least one student is required.', 'warning'); return; }
    btn.closest('.stu-row').remove();
  },

  _gatherSupervisors() {
    const seen = new Set(), result = [];
    document.querySelectorAll('#supervisorRows .sup-row').forEach(row => {
      const id = row.querySelector('.sup-select').value;
      if (!id) return;
      if (seen.has(id)) throw new Error('Duplicate supervisor selected.');
      seen.add(id);
      const sup = this.allSupervisors.find(s => s.id === id);
      result.push({ id, name: sup ? sup.name : '' });
    });
    return result;
  },

  _gatherStudents() {
    return [...document.querySelectorAll('#studentRows .stu-row')].map(row => ({
      name:  row.querySelector('.stu-name').value.trim(),
      id:    row.querySelector('.stu-id').value.trim(),
      email: row.querySelector('.stu-email').value.trim(),
    }));
  },

  async submit() {
    if (this._submitting) return;
    this._submitting = true;
    const btn = document.getElementById('btnRegister');
    btn.disabled = true; Spinner.show();
    try {
      const supervisors = this._gatherSupervisors();
      if (!supervisors.length) throw new Error('Select at least one supervisor.');

      const students = this._gatherStudents();
      if (!students.length || students.some(s => !s.name || !s.id))
        throw new Error('All student rows must have a name and ID.');
      const _idFmt = /^20\d{7}$/;
      const _badId = students.find(s => !_idFmt.test(s.id));
      if (_badId) throw new Error(`Invalid Student ID "${_badId.id}" — must be exactly 9 digits starting with 20 (e.g. 20210123).`);

      const payload = {
        title:    document.getElementById('f-title').value.trim(),
        type:     document.getElementById('f-type').value,
        semester: document.getElementById('f-semester').value,
        year:     document.getElementById('f-year').value,
        programType: document.querySelector('#supervisorRows .prog-select').value,
        supervisors, students,
        disableNotifications: !document.getElementById('f-enableNotif').checked,
      };
      if (!payload.title || !payload.type || !payload.semester || !payload.year)
        throw new Error('Please fill all required project fields.');

      // ── Duplicate checks against in-memory cache (before hitting the DB) ──

      // 1. Duplicate project title
      const titleNorm = payload.title.toLowerCase().trim();
      const dupTitle = this._projectsCache.find(p => p.Title.toLowerCase().trim() === titleNorm);
      if (dupTitle) throw new Error(`A project named "${payload.title}" already exists in the system.`);

      // 2. Duplicate student IDs / names within this form
      const formIdSet   = new Set();
      const formNameSet = new Set();
      for (const s of students) {
        const idKey   = s.id.toLowerCase();
        const nameKey = s.name.toLowerCase().trim();
        if (formIdSet.has(idKey))   throw new Error(`Student ID "${s.id}" is entered more than once in this form.`);
        if (formNameSet.has(nameKey)) throw new Error(`Student name "${s.name}" is entered more than once in this form.`);
        formIdSet.add(idKey);
        formNameSet.add(nameKey);
      }

      // 3. Student ID or name already registered in the system
      for (const s of students) {
        const byId = this._studentsCache.find(cs => cs.StudentID === s.id);
        if (byId) {
          const proj = this._projectsCache.find(p => p.ProjectID === byId.ProjectID);
          throw new Error(`Student ID "${s.id}" is already registered${proj ? ` under project "${proj.Title}"` : ''}.`);
        }
        const byName = this._studentsCache.find(cs => cs.StudentName.toLowerCase().trim() === s.name.toLowerCase().trim());
        if (byName) {
          const proj = this._projectsCache.find(p => p.ProjectID === byName.ProjectID);
          throw new Error(`Student "${s.name}" is already registered${proj ? ` under project "${proj.Title}"` : ''}.`);
        }
      }

      const res = await gsrAuth('registerProject', payload);
      if (!res.success) throw new Error(res.message);

      Toast.show('Project registered! ID: ' + res.projectId);
      document.getElementById('formRegister').reset();
      this._buildYears();
      this._setSemesterField();
      this._initFirstSupRow();
      document.getElementById('studentRows').innerHTML = '';
      this.studentCount = 0;
      this.addStudentRow();
      this.loadProjects();
      App.loadKPIs();
      TW.refreshProjectList();
      Ex.loadProjects();
    } catch (e) { Toast.show(e.message || e.toString(), 'error'); }
    finally { btn.disabled = false; Spinner.hide(); this._submitting = false; }
  },

  async loadProjects() {
    try {
      const [projects, students] = await Promise.all([
        gsrAuth('getProjectsFiltered'),
        gsrAuth('getStudents'),
      ]);
      this._projectsCache = projects;
      this._studentsCache = students;
      const tbody = document.getElementById('tbProjects');
      if (!projects.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">No projects registered yet.</td></tr>';
        return;
      }
      const isAdmin = Auth.supervisor && Auth.supervisor.isAdmin;
      const myId    = Auth.supervisor && Auth.supervisor.id;
      tbody.innerHTML = projects.map(p => {
        const cnt    = students.filter(s => s.ProjectID === p.ProjectID).length;
        const supIds = (p.Supervisors || '').split(',').map(x => x.trim()).filter(Boolean);
        const supNames = supIds.map(sid => {
          const s = this.allSupervisors.find(x => x.id === sid);
          return s ? s.name : sid;
        }).join(', ');
        const programs = [...new Set(supIds.map(sid => {
          const s = this.allSupervisors.find(x => x.id === sid);
          return s ? s.program : '';
        }).filter(Boolean))].join(', ') || escHtml(p.ProgramType);
        const canEdit = isAdmin || supIds.includes(myId);
        const actions = canEdit
          ? `<button class="btn btn-sm btn-outline-primary me-1 py-0 px-1" onclick="Reg.editProject('${escHtml(p.ProjectID)}')" title="Edit"><i class="fas fa-edit"></i></button>
             ${isAdmin ? `<button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="Reg.deleteProject('${escHtml(p.ProjectID)}')" title="Delete"><i class="fas fa-trash"></i></button>` : ''}`
          : '';
        return `<tr>
          <td class="fw-medium">${escHtml(p.Title)}</td>
          <td><span class="badge ${p.Type === 'FYP1' ? 'bg-primary' : 'bg-success'}">${escHtml(p.Type)}</span></td>
          <td>${escHtml(p.Semester)}</td><td>${escHtml(p.Year)}</td>
          <td class="small">${escHtml(programs)}</td>
          <td class="small">${escHtml(supNames)}</td>
          <td><span class="badge bg-secondary">${cnt} student${cnt !== 1 ? 's' : ''}</span></td>
          <td class="text-nowrap">${actions}</td>
        </tr>`;
      }).join('');
    } catch (e) { console.warn('loadProjects', e); }
    App.loadKPIs().catch(() => {});
  },

  editProject(id) {
    const p = this._projectsCache.find(x => x.ProjectID === id);
    if (!p) return;
    document.getElementById('edit-project-id').value = id;
    document.getElementById('edit-title').value       = p.Title;
    document.getElementById('edit-type').value        = p.Type;
    document.getElementById('edit-semester').value    = p.Semester;
    document.getElementById('edit-enableNotif').checked = p.DisableNotifications !== 'TRUE';
    document.getElementById('edit-err').classList.add('d-none');
    const yearSel = document.getElementById('edit-year');
    yearSel.innerHTML = '';
    const years = new Set();
    for (let i = 0; i < 10; i++) { const y = 2024 + i; years.add(`${y}-${y + 1}`); }
    if (p.Year) years.add(p.Year);
    [...years].sort().forEach(v => {
      yearSel.innerHTML += `<option value="${v}"${v === p.Year ? ' selected' : ''}>${v}</option>`;
    });
    const container = document.getElementById('edit-student-rows');
    container.innerHTML = '';
    this._studentsCache
      .filter(s => s.ProjectID === id)
      .forEach(s => container.appendChild(this._renderEditStudentRow(s, true)));
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalEditProject')).show();
  },

  _renderEditStudentRow(s, isExisting) {
    const row = document.createElement('div');
    row.className = 'row g-1 mb-2 align-items-center edit-student-row';
    if (isExisting) row.dataset.existingId = s.StudentID;
    row.innerHTML = `
      <div class="col-md-4">
        <input type="text" class="form-control form-control-sm edit-stu-name" placeholder="Full Name *" value="${escHtml(s.StudentName || '')}" maxlength="100" required/>
      </div>
      <div class="col-md-3">
        <input type="text" class="form-control form-control-sm edit-stu-id" placeholder="Student ID *" value="${escHtml(s.StudentID || '')}"${isExisting ? ' readonly style="background:#f8fafc;color:#64748b;"' : ' maxlength="9" pattern="20[0-9]{7}" title="9 digits starting with 20"'} required/>
      </div>
      <div class="col-md-4">
        <input type="email" class="form-control form-control-sm edit-stu-email" placeholder="Email" value="${escHtml(s.Email || '')}" maxlength="100"/>
      </div>
      <div class="col-auto">
        <button type="button" class="btn btn-outline-danger btn-sm py-0 px-1" onclick="this.closest('.edit-student-row').remove()" title="Remove student">
          <i class="fas fa-trash"></i>
        </button>
      </div>`;
    return row;
  },

  addEditStudentRow() {
    document.getElementById('edit-student-rows')
      .appendChild(this._renderEditStudentRow({ StudentID: '', StudentName: '', Email: '' }, false));
  },

  async saveEditProject() {
    const id    = document.getElementById('edit-project-id').value;
    const title = document.getElementById('edit-title').value.trim();
    const errEl = document.getElementById('edit-err');
    errEl.classList.add('d-none');
    if (!title) { errEl.textContent = 'Title is required.'; errEl.classList.remove('d-none'); return; }

    const students = [];
    let studsValid = true;
    document.querySelectorAll('#edit-student-rows .edit-student-row').forEach(row => {
      const name  = row.querySelector('.edit-stu-name').value.trim();
      const sid   = row.querySelector('.edit-stu-id').value.trim();
      const email = row.querySelector('.edit-stu-email').value.trim();
      if (!name || !sid) { studsValid = false; return; }
      students.push({ studentId: sid, studentName: name, email, isExisting: !!row.dataset.existingId });
    });
    if (!studsValid) { errEl.textContent = 'All student rows must have a name and ID.'; errEl.classList.remove('d-none'); return; }
    const _idFmt2 = /^20\d{7}$/;
    const _newBad = students.find(s => !s.isExisting && !_idFmt2.test(s.studentId));
    if (_newBad) { errEl.textContent = `Invalid Student ID "${_newBad.studentId}" — must be exactly 9 digits starting with 20.`; errEl.classList.remove('d-none'); return; }

    Spinner.show();
    try {
      const res = await gsrAuth('updateProject', id, {
        title,
        type:                 document.getElementById('edit-type').value,
        semester:             document.getElementById('edit-semester').value,
        year:                 document.getElementById('edit-year').value,
        disableNotifications: !document.getElementById('edit-enableNotif').checked,
        students,
      });
      if (!res.success) { errEl.textContent = res.message; errEl.classList.remove('d-none'); return; }
      bootstrap.Modal.getInstance(document.getElementById('modalEditProject')).hide();
      Toast.show('Project updated.');
      this.loadProjects();
      App.loadKPIs();
    } catch (e) { errEl.textContent = 'Error: ' + e.message; errEl.classList.remove('d-none'); }
    finally { Spinner.hide(); }
  },

  async deleteProject(id) {
    const p = this._projectsCache.find(x => x.ProjectID === id);
    if (!confirm(`Delete "${p ? p.Title : id}" and all its grades?\n\nThis cannot be undone.`)) return;
    Spinner.show();
    try {
      const res = await gsrAuth('deleteProject', id);
      if (!res.success) { Toast.show(res.message, 'error'); return; }
      Toast.show('Project deleted.');
      this.loadProjects();
      App.loadKPIs();
      TW.refreshProjectList();
      Ex.loadProjects();
    } catch (e) { Toast.show('Error: ' + e.message, 'error'); }
    finally { Spinner.hide(); }
  },

  async saveSupervisorToSystem() {
    const name     = document.getElementById('ms-name').value.trim();
    const program  = document.getElementById('ms-program').value;
    const email    = document.getElementById('ms-email').value.trim();
    const password = document.getElementById('ms-password').value.trim();
    if (!name || !program) { Toast.show('Name and program are required.', 'warning'); return; }
    Spinner.show();
    try {
      const res = await gsrAuth('addSupervisorToSystem', name, program, email, password || 'fyp2025');
      if (!res.success) throw new Error(res.message);
      Toast.show(`Supervisor added. Password: ${password || 'fyp2025'}`);
      await this._loadMasterData();
      document.getElementById('ms-password').value = '';
      bootstrap.Modal.getInstance(document.getElementById('modalAddSupervisor')).hide();
    } catch (e) { Toast.show(e.message, 'error'); }
    finally { Spinner.hide(); }
  },
};

// ── My Tasks Tab ───────────────────────────────────────────────────────

const Tasks = {
  _data: null,

  async load() {
    try {
      const res = await gsrAuth('getMyPendingTasks');
      if (!res || !res.success) return;
      this._data = res;
      this._render();
    } catch (e) { /* non-critical */ }
  },

  _render() {
    const { twTasks = [], examTasks = [], week14Label = '', semEndLabel = '' } = this._data || {};
    const total = twTasks.length + examTasks.length;

    // Tab icon: green check when clear, amber exclamation when pending
    const tabIcon = document.getElementById('tasks-tab-icon');
    if (tabIcon) {
      if (total === 0) {
        tabIcon.className = 'fas fa-check-circle me-2';
        tabIcon.style.color = '#22c55e';
      } else {
        tabIcon.className = 'fas fa-exclamation-circle me-2';
        tabIcon.style.color = '#f59e0b';
      }
    }

    const allGoodEl   = document.getElementById('tasks-all-good');
    const pendingEl   = document.getElementById('tasks-pending-list');
    if (!allGoodEl || !pendingEl) return;

    if (total === 0) {
      allGoodEl.classList.remove('d-none');
      pendingEl.classList.add('d-none');
      pendingEl.innerHTML = '';
      return;
    }
    allGoodEl.classList.add('d-none');
    pendingEl.classList.remove('d-none');

    const fmtDate = iso => {
      if (!iso) return '';
      try { return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return iso; }
    };
    const daysLeft = iso => {
      if (!iso) return null;
      try { return Math.ceil((new Date(iso) - Date.now()) / 86400000); } catch { return null; }
    };

    let html = '';

    if (twTasks.length) {
      const dl      = daysLeft(week14Label);
      const dlHtml  = dl !== null
        ? dl <= 0
          ? `<span class="badge bg-danger ms-2" style="font-size:10px;">Deadline passed</span>`
          : `<span class="badge bg-secondary ms-2" style="font-size:10px;">Week 14: ${fmtDate(week14Label)} (${dl}d left)</span>`
        : '';
      html += `<div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;padding:8px 20px 6px;background:#f9fafb;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:6px;">
        <i class="fas fa-users-cog text-warning"></i>Teamwork Grading${dlHtml}</div>`;
      twTasks.forEach(t => {
        const isProg = t.status === 'in_progress';
        const pct    = t.total > 0 ? Math.round((t.graded / t.total) * 100) : 0;
        const statusBadge = isProg
          ? `<span class="badge ms-2" style="background:#fef3c7;color:#92400e;font-size:11px;">In Progress</span>`
          : `<span class="badge bg-danger ms-2" style="font-size:11px;">Not Started</span>`;
        const detail = isProg
          ? `<span class="text-muted" style="font-size:12px;">${t.graded} of ${t.total} grade entries filled</span>
             <div class="progress mt-1" style="height:4px;max-width:220px;border-radius:4px;background:#e5e7eb;">
               <div class="progress-bar" style="width:${pct}%;background:#f59e0b;"></div></div>`
          : `<span class="text-muted" style="font-size:12px;">No grades entered yet</span>`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid #f3f4f6;gap:12px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:4px;">
              <span class="badge ${t.type === 'FYP2' ? 'bg-info' : 'bg-primary'}" style="font-size:10px;">${escHtml(t.type)}</span>
              <strong style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;display:inline-block;" title="${escHtml(t.title)}">${escHtml(t.title)}</strong>
              ${statusBadge}
            </div>
            ${detail}
          </div>
          <button class="btn btn-sm btn-outline-primary flex-shrink-0" style="white-space:nowrap;" onclick="Tasks._goToTW('${escHtml(t.projectId)}')">
            <i class="fas fa-edit me-1"></i>Grade Now
          </button>
        </div>`;
      });
    }

    if (examTasks.length) {
      const dl      = daysLeft(semEndLabel);
      const dlHtml  = dl !== null
        ? dl <= 0
          ? `<span class="badge bg-danger ms-2" style="font-size:10px;">Deadline passed</span>`
          : `<span class="badge bg-secondary ms-2" style="font-size:10px;">Pres. deadline: ${fmtDate(semEndLabel)} (${dl}d left)</span>`
        : '';
      html += `<div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;padding:8px 20px 6px;background:#f9fafb;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:6px;">
        <i class="fas fa-user-tie text-warning"></i>Examiner Grading${dlHtml}</div>`;
      examTasks.forEach(t => {
        const missingStr  = t.missing.join(' &amp; ');
        const statusBadge = t.status === 'ReportSubmitted'
          ? `<span class="badge ms-2" style="background:#fef3c7;color:#92400e;font-size:11px;">Report Done — Pres. Pending</span>`
          : `<span class="badge bg-danger ms-2" style="font-size:11px;">Not Started</span>`;
        const reportBtn   = t.reportLink
          ? `<a class="btn btn-sm btn-outline-secondary flex-shrink-0" href="${escHtml(t.reportLink)}" target="_blank" rel="noopener" title="Open project report"><i class="fas fa-file-pdf me-1"></i>Report</a>`
          : '';
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid #f3f4f6;gap:12px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:4px;">
              <span class="badge bg-secondary" style="font-size:10px;">${escHtml(t.examinerType)}</span>
              <strong style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;display:inline-block;" title="${escHtml(t.projectTitle)}">${escHtml(t.projectTitle)}</strong>
              ${statusBadge}
            </div>
            <span class="text-muted" style="font-size:12px;">Supervisor(s): ${escHtml(t.supervisorNames)} &nbsp;&bull;&nbsp; Missing: <em>${missingStr}</em></span>
          </div>
          <div style="display:flex;gap:8px;flex-shrink:0;align-items:center;">
            ${reportBtn}
            <a class="btn btn-sm btn-warning flex-shrink-0" href="examiner.html?token=${encodeURIComponent(t.token)}" target="_blank" rel="noopener" style="white-space:nowrap;">
              <i class="fas fa-external-link-alt me-1"></i>Open Grading Portal
            </a>
          </div>
        </div>`;
      });
    }

    pendingEl.innerHTML = html;
  },

  _goToTW(projectId) {
    const twTabBtn = document.querySelector('[data-bs-target="#tab-tw"]');
    if (twTabBtn) bootstrap.Tab.getOrCreateInstance(twTabBtn).show();
    setTimeout(() => {
      const gradeBtn = document.getElementById('tw-grade-tab-btn');
      if (gradeBtn) bootstrap.Tab.getOrCreateInstance(gradeBtn).show();
    }, 50);
    let attempts = 0;
    const trySelect = () => {
      const sel = document.getElementById('tw-project-sel');
      if (!sel) return;
      const opt = [...sel.options].find(o => o.value === projectId);
      if (opt) { sel.value = projectId; TW.loadGradingUI(); return; }
      if (++attempts < 20) setTimeout(trySelect, 150);
    };
    setTimeout(trySelect, 200);
  },
};

// ── Tab 2: Teamwork & Peer Eval ───────────────────────────────────────

const TW = {
  groupRubric:      [],
  individualRubric: [],
  supervisorProjects: [],
  qrInstance:       null,
  _week14Date:      '',
  _twLocked:        false,

  async init() {
    try {
      const cfg = await gsr('getTeamworkConfig');
      document.getElementById('cfg-tw-weight').value     = cfg.teamwork_weight     || 35;
      document.getElementById('cfg-report-weight').value = cfg.report_weight       || 35;
      document.getElementById('cfg-pres-weight').value   = cfg.presentation_weight || 30;
      document.getElementById('cfg-peer-weight').value   = cfg.peer_eval_weight    || 20;
      document.getElementById('cfg-sup-weight').value    = cfg.supervisor_weight   || 80;
      const semEndEl = document.getElementById('cfg-semester-end');
      if (semEndEl) semEndEl.value = cfg.semester_end_date || '';
      const w14El = document.getElementById('cfg-week14-date');
      if (w14El) w14El.value = cfg.week14_date || '';
      this._week14Date = cfg.week14_date || '';
      this._twLocked = cfg.tw_locked === 'true';
      const lockToggle = document.getElementById('cfg-tw-locked');
      const lockBadge  = document.getElementById('tw-lock-badge');
      if (lockToggle) lockToggle.checked = this._twLocked;
      if (lockBadge) { lockBadge.textContent = this._twLocked ? 'Locked' : 'Unlocked'; lockBadge.className = `badge ${this._twLocked ? 'bg-danger' : 'bg-success'}`; }

      this._refreshMainWeightTotal();
      ['cfg-tw-weight', 'cfg-report-weight', 'cfg-pres-weight'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', () => this._refreshMainWeightTotal());
      });

      this._updateCountdown(cfg.semester_end_date || '');

      this.individualRubric = await gsr('getIndividualRubric');
      this._renderTWRubric('twIndivRubricList', this.individualRubric);
      this._refreshTWTotal('individual');

      const indivEl = document.getElementById('twIndivRubricList');
      if (indivEl) {
        indivEl.addEventListener('input',  () => this._refreshTWTotal('individual'));
        indivEl.addEventListener('change', () => this._refreshTWTotal('individual'));
      }

      await this._loadPeerConfig();

      const isAdmin = Auth.supervisor && Auth.supervisor.isAdmin;
      if (!isAdmin) {
        document.querySelectorAll('#tw-config input, #tw-config select, #tw-config button.btn-primary, #tw-config button.btn-outline-primary').forEach(el => {
          el.disabled = true;
        });
      }

      if (Auth.supervisor) {
        document.getElementById('tw-grading-as').textContent = Auth.supervisor.name;
      }
      await this.refreshProjectList();
    } catch (e) { console.warn('TW.init error', e); }
  },

  async _loadPeerConfig() {
    const questions = await gsr('getPeerEvalConfig');
    this._renderPeerQuestions(questions);
    this._refreshPeerTotal();
    const peerList = document.getElementById('peerQsList');
    if (peerList) {
      peerList.addEventListener('input',  () => this._refreshPeerTotal());
      peerList.addEventListener('change', () => this._refreshPeerTotal());
    }
  },

  _renderPeerQuestions(questions) {
    const isAdmin = Auth.supervisor && Auth.supervisor.isAdmin;
    const c = document.getElementById('peerQsList');
    c.innerHTML = '';
    questions.forEach(q => {
      const row = document.createElement('div');
      row.className = 'peer-q-row';
      const aOpts = ['','1a','2a','2b','3a','3b','4a','5a','5b','7a'].map(o =>
        `<option value="${o}" ${String(q.AbetOutcome||'') === o ? 'selected' : ''}>${o || 'None'}</option>`
      ).join('');
      row.innerHTML = `
        <input type="text"   class="form-control form-control-sm pq-text"   value="${q.QuestionText || ''}" placeholder="Question text" ${isAdmin ? '' : 'readonly'}/>
        <input type="number" class="form-control form-control-sm pq-max"    value="${q.MaxGrade || 10}" min="1" max="100" title="Max Grade" ${isAdmin ? '' : 'readonly'}/>
        <input type="number" class="form-control form-control-sm pq-weight" value="${q.Weight   || 20}" min="1" max="100" title="Weight %" ${isAdmin ? '' : 'readonly'}/>
        <select class="form-select form-select-sm pq-abet" title="ABET Outcome" ${isAdmin ? '' : 'disabled'}>${aOpts}</select>
        ${isAdmin ? '<button type="button" class="btn btn-outline-danger btn-sm" onclick="this.closest(\'.peer-q-row\').remove()"><i class="fas fa-times"></i></button>' : '<span></span>'}`;
      c.appendChild(row);
    });
  },

  addPeerQuestion() {
    if (!Auth.supervisor || !Auth.supervisor.isAdmin) { Toast.show('Only admins can add questions.', 'warning'); return; }
    const row = document.createElement('div');
    row.className = 'peer-q-row';
    const aOpts = ['','1a','2a','2b','3a','3b','4a','5a','5b','7a'].map(o => `<option value="${o}">${o || 'None'}</option>`).join('');
    row.innerHTML = `
      <input type="text"   class="form-control form-control-sm pq-text"   placeholder="Question text"/>
      <input type="number" class="form-control form-control-sm pq-max"    value="10" min="1" max="100" title="Max Grade"/>
      <input type="number" class="form-control form-control-sm pq-weight" value="20" min="1" max="100" title="Weight %"/>
      <select class="form-select form-select-sm pq-abet" title="ABET Outcome">${aOpts}</select>
      <button type="button" class="btn btn-outline-danger btn-sm" onclick="this.closest('.peer-q-row').remove()"><i class="fas fa-times"></i></button>`;
    document.getElementById('peerQsList').appendChild(row);
    this._refreshPeerTotal();
  },

  _refreshMainWeightTotal() {
    const tw = parseFloat(document.getElementById('cfg-tw-weight').value)     || 0;
    const rp = parseFloat(document.getElementById('cfg-report-weight').value) || 0;
    const pr = parseFloat(document.getElementById('cfg-pres-weight').value)   || 0;
    _showWeightTotal('main-weight-total', tw + rp + pr);
  },

  _updateCountdown(endDateStr) {
    const el = document.getElementById('header-countdown');
    const txt = document.getElementById('header-countdown-text');
    if (!el || !txt || !endDateStr) return;
    const now = new Date();
    const end = new Date(endDateStr);
    const m = now.getMonth() + 1;
    const semester = (m >= 9 || m === 1) ? 'Fall' : 'Spring';
    const year = now.getFullYear();
    const diffMs = end - now;
    if (diffMs <= 0) {
      txt.textContent = `${semester} ${year} — Semester ended`;
    } else {
      const totalDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      const weeks = Math.floor(totalDays / 7);
      const days  = totalDays % 7;
      txt.textContent = `${weeks}W:${days}D remaining · ${semester} ${year}`;
    }
    el.classList.remove('d-none');
  },

  _refreshPeerTotal() {
    const total = [...document.querySelectorAll('#peerQsList .pq-weight')].reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
    _showWeightTotal('peer-weight-total', total);
  },

  _refreshTWTotal(type) {
    const listId = type === 'group' ? 'twGroupRubricList' : 'twIndivRubricList';
    const elId   = type === 'group' ? 'group-weight-total' : 'indiv-weight-total';
    const total  = [...document.querySelectorAll(`#${listId} .tw-weight`)].reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
    _showWeightTotal(elId, total);
  },

  async saveConfig() {
    Spinner.show();
    try {
      const res = await gsrAuth('saveTeamworkConfig', {
        teamwork_weight:     document.getElementById('cfg-tw-weight').value,
        report_weight:       document.getElementById('cfg-report-weight').value,
        presentation_weight: document.getElementById('cfg-pres-weight').value,
        peer_eval_weight:    document.getElementById('cfg-peer-weight').value,
        supervisor_weight:   document.getElementById('cfg-sup-weight').value,
      });
      if (res && !res.success) { Toast.show(res.message || 'Failed to save weights.', 'warning'); return; }
      Toast.show('Grade weights saved.');
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },

  async saveSemesterEndDate() {
    if (!Auth.supervisor || !Auth.supervisor.isAdmin) { Toast.show('Only admins can set the semester end date.', 'warning'); return; }
    const date = document.getElementById('cfg-semester-end').value;
    if (!date) { Toast.show('Please select a date first.', 'warning'); return; }
    Spinner.show();
    try {
      const res = await gsrAuth('saveSemesterEndDate', date);
      if (!res.success) throw new Error(res.message);
      Toast.show('Semester end date saved. Presentation tab will unlock for examiners after ' + date + '.');
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },

  async savePeerConfig() {
    const questions = [];
    document.querySelectorAll('.peer-q-row').forEach(row => {
      const text   = row.querySelector('.pq-text').value.trim();
      const max    = parseFloat(row.querySelector('.pq-max').value)    || 10;
      const weight = parseFloat(row.querySelector('.pq-weight').value) || 20;
      const abet   = row.querySelector('.pq-abet').value || '';
      if (text) questions.push({ text, maxGrade: max, weight, abetOutcome: abet });
    });
    if (!questions.length) { Toast.show('Add at least one question.', 'warning'); return; }
    const peerTotal = questions.reduce((s, q) => s + q.weight, 0);
    if (Math.round(peerTotal) !== 100) {
      Toast.show(`Peer question weights must sum to 100 (currently ${peerTotal}).`, 'warning');
      return;
    }
    Spinner.show();
    try {
      await gsrAuth('savePeerEvalConfig', questions);
      Toast.show('Peer evaluation questions saved.');
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },

  _pollInterval: null,

  onPeerTabShown() {
    this.generateQR();
    this.refreshPeerStatus();
    if (this._pollInterval) clearInterval(this._pollInterval);
    this._pollInterval = setInterval(() => this.refreshPeerStatus(), 20000);
  },

  stopPolling() {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
  },

  async generateQR() {
    Spinner.show();
    try {
      const url = await gsrAuth('getPeerEvalURL');
      document.getElementById('peer-url').value = url;
      const container = document.getElementById('qrcode');
      container.innerHTML = '';
      this.qrInstance = null;
      this.qrInstance = new QRCode(container, {
        text: url, width: 220, height: 220,
        colorDark: '#1e3a5f', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      });
    } catch (e) { Toast.show('Error generating QR: ' + e, 'error'); }
    finally { Spinner.hide(); }
  },

  copyPeerURL() {
    const val = document.getElementById('peer-url').value;
    if (!val) { Toast.show('Generate the QR first.', 'warning'); return; }
    navigator.clipboard.writeText(val).then(() => Toast.show('Link copied to clipboard.'));
  },

  async refreshPeerStatus() {
    const c = document.getElementById('peerStatusContainer');
    c.innerHTML = '<div class="text-muted small"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div>';
    try {
      const statuses = await gsrAuth('getPeerEvalStatus');
      if (!statuses.length) {
        c.innerHTML = '<p class="text-muted small">No projects found for your account.</p>';
        return;
      }
      c.innerHTML = statuses.map(proj => {
        const headerBadge = proj.allSubmitted
          ? `<span class="badge-all-done"><i class="fas fa-check me-1"></i>All Submitted</span>`
          : `<span class="badge-pending"><i class="fas fa-clock me-1"></i>Pending</span>`;
        const rows = proj.students.map(s => `
          <div class="student-status-row">
            <span><i class="fas fa-user me-2 text-muted"></i>${escHtml(s.name)} <small class="text-muted">(${escHtml(s.id)})</small></span>
            ${s.submitted
              ? '<span class="status-icon-done"><i class="fas fa-check-circle"></i> Submitted</span>'
              : '<span class="status-icon-pending"><i class="fas fa-circle-notch fa-spin"></i> Pending</span>'}
          </div>`).join('');
        return `
          <div class="peer-status-card">
            <div class="peer-status-header">
              <span class="project-name"><i class="fas fa-folder-open me-2 text-primary"></i>${escHtml(proj.projectTitle)}</span>
              ${headerBadge}
            </div>
            <div class="peer-status-body">
              ${rows || '<p class="text-muted small mb-0">No students in this project.</p>'}
            </div>
          </div>`;
      }).join('');
    } catch (e) { c.innerHTML = '<p class="text-danger small">Error loading status: ' + e.message + '</p>'; }
  },

  async refreshProjectList() {
    if (!Auth.supervisor) return;
    const sel    = document.getElementById('tw-project-sel');
    const notice = document.getElementById('tw-debug-notice');
    try {
      const projects = (await gsrAuth('getSupervisedProjectsForGrading')) || [];
      this.supervisorProjects = projects;

      if (!projects.length) {
        sel.innerHTML = '<option value="">— no projects assigned to you —</option>';
        if (notice) {
          notice.innerHTML = `<i class="fas fa-info-circle me-1"></i>
            No projects found for supervisor ID <strong>${Auth.supervisor.id}</strong>.
            Make sure you selected yourself as a supervisor when registering the project.`;
          notice.classList.remove('d-none');
        }
        return;
      }

      if (notice) notice.classList.add('d-none');
      sel.innerHTML = '<option value="">— choose a project —</option>' +
        projects.map(p =>
          `<option value="${p.ProjectID}">${p.Title} (${p.Type})</option>`
        ).join('');
      const area = document.getElementById('twGradingArea');
      if (area) area.classList.add('d-none');
    } catch (e) {
      sel.innerHTML = `<option value="">— error loading projects —</option>`;
      if (notice) { notice.textContent = 'Error: ' + e.message; notice.classList.remove('d-none'); }
    }
  },

  async loadGradingUI() {
    const pid  = document.getElementById('tw-project-sel').value;
    const area = document.getElementById('twGradingArea');
    if (!pid) { area.classList.add('d-none'); return; }

    const project = this.supervisorProjects.find(p => p.ProjectID === pid);
    if (!project) return;

    const dateLocked = this._week14Date && new Date() > (() => { const d = new Date(this._week14Date); d.setHours(23,59,59,999); return d; })();
    const isLocked = this._twLocked || dateLocked;

    const lockNotice = document.getElementById('tw-locked-notice');
    if (lockNotice) lockNotice.classList.toggle('d-none', !isLocked);

    const saveBtn   = document.getElementById('btn-tw-save-draft');
    const submitBtn = document.getElementById('btn-tw-submit');
    if (saveBtn)   saveBtn.classList.toggle('d-none', isLocked);
    if (submitBtn) submitBtn.disabled = isLocked;

    this._renderIndividualMatrix(project.studentList || [], isLocked);
    area.classList.remove('d-none');
    await this.loadSavedGrades(pid);
  },

  async loadSavedGrades(pid) {
    try {
      const grades = await gsrAuth('getTeamworkGrades', pid);
      grades.forEach(g => {
        const inp = document.querySelector(`.ind-grade[data-criterion="${CSS.escape(g.criterion)}"][data-student="${CSS.escape(g.studentId)}"]`);
        if (!inp) return;
        inp.value = g.grade;
        const label = inp.parentElement.querySelector('.graded-by-label');
        if (label) {
          label.textContent = g.isMe ? 'You graded' : `By: ${g.gradedBy}`;
          label.className   = `graded-by-label d-block ${g.isMe ? 'text-success' : 'text-warning'}`;
        }
      });
    } catch (e) { console.warn('loadSavedGrades', e); }
  },

  _twLegend() {
    return `<div class="grade-scale-legend mb-3">
      <span class="gs-label">Scale:</span>
      <span class="gs-badge gs-unsat">Beginning 45–59</span>
      <span class="gs-badge gs-dev">Developing 60–75</span>
      <span class="gs-badge gs-meets">Accomplished 76–89</span>
      <span class="gs-badge gs-exceeds">Exemplary 90–100</span>
    </div>`;
  },

  _renderIndividualMatrix(students, isLocked = false) {
    const c = document.getElementById('indGradeMatrix');
    if (!students.length) { c.innerHTML = '<p class="text-muted">No students in this project.</p>'; return; }

    const w14Str = this._week14Date
      ? new Date(this._week14Date).toLocaleDateString('en-GB', { year:'numeric', month:'long', day:'numeric' })
      : '';
    const deadlineBanner = (!isLocked && w14Str)
      ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#856404;">
           <i class="fas fa-clock me-1"></i><strong>Note:</strong> You can edit teamwork grades until <strong>${w14Str}</strong>. After this date the system will automatically finalize all grades and editing will be disabled.
         </div>`
      : '';

    const headerCells = students.map(s =>
      `<th>${s.StudentName}<br/><small class="fw-normal opacity-75">${s.StudentID}</small></th>`
    ).join('');
    const rows = this.individualRubric.map(r => {
      const cells = students.map(s =>
        `<td><input type="number" class="ind-grade"
              data-criterion="${r.criterion}" data-student="${s.StudentID}"
              min="0" max="${r.maxGrade}" step="0.5" placeholder="0–${r.maxGrade}"
              ${isLocked ? 'disabled' : ''}/>
          <small class="graded-by-label d-block text-muted"></small></td>`
      ).join('');
      return `<tr><td>${r.criterion} <small class="text-muted">(Max: ${r.maxGrade})</small></td>${cells}</tr>`;
    }).join('');

    c.innerHTML = `
      ${deadlineBanner}
      ${this._twLegend()}
      <table class="matrix-table">
        <thead><tr><th>Criterion</th>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    if (!c._gradeClampSetup) {
      c._gradeClampSetup = true;
      c.addEventListener('change', e => {
        const inp = e.target;
        if (!inp.classList.contains('ind-grade') || inp.disabled) return;
        const v = parseFloat(inp.value), max = parseFloat(inp.max);
        if (isNaN(v) || inp.value === '') return;
        const minAllowed = max * 0.45;
        if (v < minAllowed) {
          inp.value = minAllowed;
          inp.style.outline = '';
          Toast.show(`Grade automatically set to minimum ${minAllowed} — values below ${minAllowed} (Beginning level, 45% of ${max}) are not accepted.`, 'warning');
        } else if (v > max) {
          inp.value = max;
          inp.style.outline = '';
          Toast.show(`Grade automatically capped to maximum ${max}.`, 'warning');
        } else {
          inp.style.outline = '';
        }
      });
    }
  },

  async submitGrades() {
    const pid = document.getElementById('tw-project-sel').value;
    if (!pid) { Toast.show('Select a project first.', 'warning'); return; }

    // Auto-correct grades outside allowed range before submitting
    [...document.querySelectorAll('.ind-grade')].forEach(inp => {
      if (inp.disabled || inp.value === '') return;
      const v = parseFloat(inp.value), m = parseFloat(inp.max);
      if (isNaN(v)) return;
      if (v < m * 0.45) inp.value = m * 0.45;
      else if (v > m) inp.value = m;
      inp.style.outline = '';
    });

    const confirmed = await new Promise(resolve => {
      const modal = document.getElementById('modalConfirmTWSubmit');
      if (!modal) { resolve(true); return; }
      const yesBtn = document.getElementById('btn-confirm-tw-yes');
      const handler = () => { modal.removeEventListener('hidden.bs.modal', cancelHandler); resolve(true); };
      const cancelHandler = () => { yesBtn.removeEventListener('click', handler); resolve(false); };
      yesBtn.addEventListener('click', handler, { once: true });
      modal.addEventListener('hidden.bs.modal', cancelHandler, { once: true });
      bootstrap.Modal.getOrCreateInstance(modal).show();
    });
    if (!confirmed) return;

    const indGrades = [...document.querySelectorAll('.ind-grade')].map(inp => ({
      criterion: inp.dataset.criterion, studentId: inp.dataset.student, grade: parseFloat(inp.value) || 0,
    }));

    Spinner.show();
    try {
      const res = await gsrAuth('submitTeamworkGrades', pid, [], indGrades);
      if (!res.success) throw new Error(res.message);
      Toast.show('Teamwork grades submitted successfully.');
      await this.loadSavedGrades(pid);
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },

  async saveWeek14Date() {
    if (!Auth.supervisor || !Auth.supervisor.isAdmin) { Toast.show('Only admins can set the Week 14 date.', 'warning'); return; }
    const date = document.getElementById('cfg-week14-date').value;
    Spinner.show();
    try {
      const res = await gsrAuth('saveWeek14Date', date);
      if (!res.success) throw new Error(res.message);
      this._week14Date = date;
      Toast.show('Week 14 lock date saved.');
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },

  async setLock(locked) {
    if (!Auth.supervisor || !Auth.supervisor.isAdmin) { Toast.show('Only admins can lock/unlock TW grading.', 'warning'); return; }
    try {
      const res = await gsrAuth('setTWLock', locked);
      if (!res.success) throw new Error(res.message);
      this._twLocked = locked;
      const badge = document.getElementById('tw-lock-badge');
      if (badge) { badge.textContent = locked ? 'Locked' : 'Unlocked'; badge.className = `badge ${locked ? 'bg-danger' : 'bg-success'}`; }
      Toast.show(`Teamwork grading ${locked ? 'locked' : 'unlocked'}.`, locked ? 'warning' : 'success');
    } catch (e) {
      Toast.show(e.message || e, 'error');
      const toggle = document.getElementById('cfg-tw-locked');
      if (toggle) toggle.checked = this._twLocked;
    }
  },

  async saveDraft() {
    const pid = document.getElementById('tw-project-sel').value;
    if (!pid) { Toast.show('Select a project first.', 'warning'); return; }

    const indGrades = [...document.querySelectorAll('.ind-grade')]
      .filter(inp => inp.value !== '' && !isNaN(parseFloat(inp.value)))
      .map(inp => ({ criterion: inp.dataset.criterion, studentId: inp.dataset.student, grade: parseFloat(inp.value) }));

    if (!indGrades.length) { Toast.show('No grades entered to save.', 'warning'); return; }

    const btn = document.getElementById('btn-tw-save-draft');
    const label = '<i class="fas fa-save me-2"></i>Save Grades';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm" style="width:1rem;height:1rem;border-width:.15em;vertical-align:-.125em;"></span>'; }
    try {
      const res = await gsrAuth('saveTeamworkDraft', pid, indGrades);
      if (!res.success) throw new Error(res.message);
      Toast.show('Grades saved. You can return and edit them until the grading period closes.');
      await this.loadSavedGrades(pid);
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  },

  _renderTWRubric(containerId, criteria) {
    const c = document.getElementById(containerId);
    if (!c) return;
    const isAdmin = Auth.supervisor && Auth.supervisor.isAdmin;
    const dis = isAdmin ? '' : 'disabled';
    const ro  = isAdmin ? '' : 'readonly';
    c.innerHTML = (criteria || []).map(cr => {
      const sel = ['','1a','2a','2b','3a','3b','4a','5a','5b','7a'].map(o =>
        `<option value="${o}" ${String(cr.abetOutcome||'') === o ? 'selected' : ''}>${o || 'None'}</option>`
      ).join('');
      return `<div class="tw-rubric-row">
        <input type="text"   class="form-control form-control-sm tw-criterion" value="${cr.criterion}" placeholder="Criterion name" ${ro} style="flex:1;min-width:140px;"/>
        <input type="number" class="form-control form-control-sm tw-max"    value="${cr.maxGrade}" min="1" max="1000" title="Max Grade" ${ro} style="width:72px;"/>
        <input type="number" class="form-control form-control-sm tw-weight" value="${cr.weight}"   min="0" max="100"  title="Weight %" ${ro} style="width:68px;"/>
        <select class="form-select form-select-sm tw-abet" title="ABET Outcome" ${dis} style="width:110px;">${sel}</select>
        ${isAdmin ? `<button type="button" class="btn btn-outline-danger btn-sm px-2" onclick="this.closest('.tw-rubric-row').remove()"><i class="fas fa-times"></i></button>` : '<span style="width:32px;flex-shrink:0;"></span>'}
      </div>`;
    }).join('');
  },

  addTWRubricRow(type) {
    if (!Auth.supervisor || !Auth.supervisor.isAdmin) { Toast.show('Only admins can add rows.', 'warning'); return; }
    const c = document.getElementById(type === 'group' ? 'twGroupRubricList' : 'twIndivRubricList');
    const row = document.createElement('div');
    row.className = 'tw-rubric-row';
    const aOpts = ['','1a','2a','2b','3a','3b','4a','5a','5b','7a'].map(o => `<option value="${o}">${o || 'None'}</option>`).join('');
    row.innerHTML = `
      <input type="text"   class="form-control form-control-sm tw-criterion" placeholder="Criterion name" style="flex:1;min-width:140px;"/>
      <input type="number" class="form-control form-control-sm tw-max"    value="25" min="1" max="1000" title="Max Grade" style="width:72px;"/>
      <input type="number" class="form-control form-control-sm tw-weight" value="25" min="0" max="100"  title="Weight %" style="width:68px;"/>
      <select class="form-select form-select-sm tw-abet" title="ABET Outcome" style="width:110px;">${aOpts}</select>
      <button type="button" class="btn btn-outline-danger btn-sm px-2" onclick="this.closest('.tw-rubric-row').remove()"><i class="fas fa-times"></i></button>`;
    c.appendChild(row);
    this._refreshTWTotal(type);
  },

  async saveTWRubric(type) {
    if (!Auth.supervisor || !Auth.supervisor.isAdmin) { Toast.show('Only admins can save.', 'warning'); return; }
    const listId   = type === 'group' ? 'twGroupRubricList' : 'twIndivRubricList';
    const criteria = [];
    document.querySelectorAll(`#${listId} .tw-rubric-row`).forEach(row => {
      const name = row.querySelector('.tw-criterion').value.trim();
      if (!name) return;
      criteria.push({
        criterion:   name,
        maxGrade:    parseFloat(row.querySelector('.tw-max').value)    || 25,
        weight:      parseFloat(row.querySelector('.tw-weight').value) || 25,
        abetOutcome: row.querySelector('.tw-abet').value || '',
      });
    });
    if (criteria.length) {
      const total = criteria.reduce((s, c) => s + c.weight, 0);
      if (Math.round(total) !== 100) {
        Toast.show(`${type === 'group' ? 'Group' : 'Individual'} rubric weights must sum to 100 (currently ${total}).`, 'warning');
        return;
      }
    }
    Spinner.show();
    try {
      await gsrAuth('saveTWRubric', type, criteria);
      if (type === 'group') this.groupRubric = criteria;
      else this.individualRubric = criteria;
      Toast.show((type === 'group' ? 'Group' : 'Individual') + ' rubric saved.');
    } catch(e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },
};

// ── Tab 3: Examiner Assignment ────────────────────────────────────────

const Ex = {
  assignments:  [],
  allProjects:  [],
  programs:     [],
  allSupsCache: [],

  async loadProjects() {
    try {
      [this.allProjects, this.programs, this.allSupsCache] = await Promise.all([
        gsrAuth('getAllProjectsSummary'),
        gsr('getPrograms'),
        gsrAuth('getAllSupervisors'),
      ]);
      const all = this.allProjects || [];
      const sel = document.getElementById('ex-project-sel');
      const cur = sel.value;
      sel.innerHTML = '<option value="">— choose a project —</option>' +
        all.map(p =>
          `<option value="${p.ProjectID}"${p.ProjectID === cur ? ' selected' : ''}>${p.Title} (${p.Type})</option>`
        ).join('');
      if (!document.querySelector('#rubricListFYP1 .rubric-row')) {
        const criteria = (await gsrAuth('getExaminerConfig')) || [];
        this._renderRubric(criteria);
        if (!document.querySelector('#examinerRows .ex-row')) this.addRow();
      }
    } catch (e) { console.warn('Ex.loadProjects', e); }
  },

  addRow() {
    const c = document.getElementById('examinerRows');
    const row = document.createElement('div');
    row.className = 'ex-row';
    row.innerHTML = `
      <div class="row g-2 align-items-center">
        <div class="col-md-6">
          <label class="form-label mb-1 small fw-medium">Examiner Type <span class="req">*</span></label>
          <select class="form-select form-select-sm ex-type-sel" onchange="Ex.onTypeChange(this)">
            <option value="">Select type…</option>
            <option value="Inside University">Inside University (Internal)</option>
            <option value="Industry">Industry (Presentation only)</option>
            <option value="Outside the Program/University">Outside the Program/University</option>
          </select>
        </div>
        <div class="col-auto align-self-end">
          <button type="button" class="btn btn-outline-danger btn-sm" onclick="this.closest('.ex-row').remove()"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <div class="ex-type-fields mt-2 d-none" data-for="Inside University">
        <div class="row g-2">
          <div class="col-md-6">
            <label class="form-label mb-1 small">Program</label>
            <select class="form-select form-select-sm ex-int-prog"></select>
          </div>
          <div class="col-md-6">
            <label class="form-label mb-1 small">Examiner</label>
            <select class="form-select form-select-sm ex-int-sup"></select>
          </div>
        </div>
      </div>
      <div class="ex-type-fields mt-2 d-none" data-for="external">
        <div class="row g-2">
          <div class="col-md-4">
            <label class="form-label mb-1 small">Full Name <span class="req">*</span></label>
            <input type="text" class="form-control form-control-sm ex-ext-name" placeholder="Examiner's Name"/>
          </div>
          <div class="col-md-5">
            <label class="form-label mb-1 small">Email <span class="req">*</span></label>
            <input type="email" class="form-control form-control-sm ex-ext-email" placeholder="name@organization.com"/>
          </div>
        </div>
      </div>`;

    const progSel = row.querySelector('.ex-int-prog');
    progSel.innerHTML = '<option value="">Select program…</option>' +
      this.programs.map(p => `<option>${p}</option>`).join('');
    progSel.addEventListener('change', () => this._onIntProgChange(progSel));

    row.querySelector('.ex-ext-email').addEventListener('blur', () => this._checkExternalInput(row));
    row.querySelector('.ex-ext-name').addEventListener('blur',  () => this._checkExternalInput(row));

    c.appendChild(row);
  },

  _checkExternalInput(row) {
    const typeSel = row.querySelector('.ex-type-sel');
    const type = typeSel.value;
    if (type !== 'Industry' && type !== 'Outside the Program/University') return;
    const emailVal = (row.querySelector('.ex-ext-email').value || '').trim().toLowerCase();
    const nameVal  = (row.querySelector('.ex-ext-name').value  || '').trim().toLowerCase();
    if (!emailVal && !nameVal) return;
    const match = this.allSupsCache.find(s =>
      (emailVal && s.email.toLowerCase() === emailVal) ||
      (nameVal && nameVal.includes(' ') && s.name.toLowerCase() === nameVal)
    );
    if (!match) return;
    if (type === 'Industry') {
      typeSel.value = 'Outside the Program/University';
      this.onTypeChange(typeSel);
      Toast.show(`"${match.name}" is an internal faculty member — type automatically changed to "Outside the Program/University".`, 'warning');
    } else {
      Toast.show(`"${match.name}" is an internal faculty member — use "Inside University" type for this person.`, 'warning');
    }
  },

  onTypeChange(sel) {
    const row      = sel.closest('.ex-row');
    const intDiv   = row.querySelector('[data-for="Inside University"]');
    const extDiv   = row.querySelector('[data-for="external"]');
    intDiv.classList.add('d-none');
    extDiv.classList.add('d-none');
    if (sel.value === 'Inside University')  intDiv.classList.remove('d-none');
    else if (sel.value)                     extDiv.classList.remove('d-none');
  },

  _onIntProgChange(progSel) {
    const row    = progSel.closest('.ex-row');
    const supSel = row.querySelector('.ex-int-sup');

    // Block the logged-in supervisor AND all co-supervisors of the selected project
    const selfId     = Auth.supervisor && Auth.supervisor.id;
    const pid        = document.getElementById('ex-project-sel').value;
    const project    = this.allProjects.find(p => p.ProjectID === pid);
    const projSupIds = project
      ? (project.Supervisors || '').split(',').map(x => x.trim()).filter(Boolean)
      : [];
    const blocked = new Set([selfId, ...projSupIds].filter(Boolean));

    const sups = this.allSupsCache.filter(s => s.program === progSel.value && !blocked.has(s.id));
    supSel.innerHTML = '<option value="">Select supervisor…</option>' +
      sups.map(s => `<option value="${s.id}" data-email="${s.email}" data-name="${s.name}">${s.name}</option>`).join('');
  },

  onProjectChange() {
    this.assignments = [];
    this.refreshStatus();
  },

  _gatherExaminers() {
    const result = [];
    document.querySelectorAll('#examinerRows .ex-row').forEach(row => {
      const type    = row.querySelector('.ex-type-sel').value;
      if (!type) return;

      if (type === 'Inside University') {
        const supSel = row.querySelector('.ex-int-sup');
        const opt    = supSel.options[supSel.selectedIndex];
        if (!opt || !opt.value) return;
        result.push({ name: opt.dataset.name, email: opt.dataset.email, type });
      } else {
        const name  = row.querySelector('.ex-ext-name').value.trim();
        const email = row.querySelector('.ex-ext-email').value.trim();
        if (!name || !email) return;
        result.push({ name, email, type });
      }
    });
    return result;
  },

  async assign() {
    const pid        = document.getElementById('ex-project-sel').value;
    const reportLink = document.getElementById('ex-report-link').value.trim();
    if (!pid) { Toast.show('Select a project first.', 'warning'); return; }
    const examiners = this._gatherExaminers();
    if (!examiners.length) { Toast.show('Add at least one complete examiner row.', 'warning'); return; }

    // Block all supervisors of this project (self + co-supervisors) from being assigned as examiners
    const project    = this.allProjects.find(p => p.ProjectID === pid);
    const projSupIds = project
      ? (project.Supervisors || '').split(',').map(x => x.trim()).filter(Boolean)
      : [];
    const projSupEmails = new Map(
      this.allSupsCache
        .filter(s => projSupIds.includes(s.id) || (Auth.supervisor && s.id === Auth.supervisor.id))
        .map(s => [s.email.toLowerCase(), s.name])
    );
    const blocked = examiners.find(e => projSupEmails.has(e.email.toLowerCase()));
    if (blocked) {
      const isSelf = Auth.supervisor && blocked.email.toLowerCase() === Auth.supervisor.email.toLowerCase();
      Toast.show(
        isSelf
          ? 'You cannot assign yourself as an examiner.'
          : `"${projSupEmails.get(blocked.email.toLowerCase())}" is already a supervisor of this project and cannot be assigned as an examiner.`,
        'error'
      );
      return;
    }

    // Block external/industry examiners from being internal users
    const allSupEmailsSet = new Set(this.allSupsCache.map(s => s.email.toLowerCase()));
    const extConflict = examiners.find(e =>
      (e.type === 'Outside the Program/University' || e.type === 'Industry') &&
      allSupEmailsSet.has(e.email.toLowerCase())
    );
    if (extConflict) {
      Toast.show(`"${extConflict.name || extConflict.email}" is an internal faculty member and cannot be assigned as an External or Industry examiner. Use "Inside University" type instead.`, 'error');
      return;
    }

    const hasInternal = examiners.some(e => e.type === 'Inside University' || e.type === 'Outside the Program/University');
    if (!hasInternal) {
      Toast.show('At least one Internal examiner must be assigned to ensure the Report component is graded.', 'error'); return;
    }

    Spinner.show();
    try {
      const res = await gsrAuth('assignExaminers', pid, examiners, reportLink);
      if (!res.success) throw new Error(res.message);
      this.assignments = res.assignments;

      if (res.warnings && res.warnings.length) {
        const names = res.warnings.map(w => `${w.name} <${w.email}>`).join(', ');
        Toast.show(`Already assigned & emailed — kept in list: ${names}`, 'warning');
      }

      if (this.assignments.length) {
        Toast.show('Examiners assigned. Use the "Send All Pending Emails" button in the Examiner Status table to send invitations.');
      } else {
        Toast.show('No new examiners to email — all were already invited.');
      }
      this.refreshStatus();
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },

  async sendAllEmails() {
    const pid = document.getElementById('ex-project-sel').value;
    if (!pid) { Toast.show('Select a project first.', 'warning'); return; }
    Spinner.show();
    try {
      const res = await gsrAuth('sendPendingExaminerEmails', pid);
      if (!res.success) throw new Error(res.message);
      Toast.show(res.sent > 0 ? `Invitation emails sent to ${res.sent} examiner(s).` : 'All examiners have already been emailed.');
      await this.refreshStatus();
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },

  async refreshStatus() {
    const pid = document.getElementById('ex-project-sel').value;
    const c   = document.getElementById('examinerStatusTable');
    if (!pid) { c.innerHTML = '<p class="text-muted small">Select a project to see examiner status.</p>'; return; }
    const sendAllBtn = document.getElementById('btnSendAllEmails');
    try {
      const examiners = await gsrAuth('getExaminersForProject', pid);
      const hasPending = examiners.some(e => (e.Status || 'Assigned') === 'Assigned');
      if (sendAllBtn) sendAllBtn.classList.toggle('d-none', !hasPending);
      if (!examiners.length) { c.innerHTML = '<p class="text-muted small">No examiners assigned yet.</p>'; return; }
      const emailSent  = st => st !== 'Assigned';
      const gradeCell  = v => v
        ? `<span class="badge bg-success"><i class="fas fa-check"></i></span>`
        : `<span class="text-muted small">—</span>`;
      c.innerHTML = `
        <table class="table table-sm table-bordered mb-0">
          <thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Report</th><th>Presentation</th><th>Email Status</th><th></th></tr></thead>
          <tbody>${examiners.map(e => {
            const st = e.Status || 'Assigned';
            const sent = emailSent(st);
            const badge = sent
              ? `<span class="badge bg-info text-white">Email Sent</span>`
              : `<span class="badge bg-warning text-dark">Not Emailed</span>`;
            const sendBtn = !sent
              ? `<button class="btn btn-outline-primary btn-sm py-0 px-1 ms-1" onclick="Ex.resendEmail('${escHtml(e.AssignmentID)}')" title="Send Email"><i class="fas fa-envelope"></i></button>`
              : '';
            const removeBtn = st === 'Assigned'
              ? `<button class="btn btn-outline-danger btn-sm py-0 px-1" onclick="Ex.removeExaminer('${escHtml(e.AssignmentID)}','${escHtml(pid)}')" title="Remove"><i class="fas fa-trash"></i></button>`
              : '';
            return `<tr>
              <td>${escHtml(e.ExaminerName || '—')}</td>
              <td>${escHtml(e.ExaminerEmail)}</td>
              <td>${escHtml(e.ExaminerType)}</td>
              <td class="text-center">${gradeCell(e.HasReport)}</td>
              <td class="text-center">${gradeCell(e.HasPresentation)}</td>
              <td>${badge}${sendBtn}</td>
              <td class="text-center">${removeBtn}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>`;
    } catch (err) {
      if (sendAllBtn) sendAllBtn.classList.add('d-none');
      console.warn(err);
    }
  },

  async removeExaminer(assignmentId, pid) {
    if (!confirm('Remove this examiner? This cannot be undone.')) return;
    Spinner.show();
    try {
      const res = await gsrAuth('removeExaminer', assignmentId);
      if (!res.success) { Toast.show(res.message, 'error'); return; }
      Toast.show('Examiner removed.');
      await this.refreshStatus();
    } catch (e) { Toast.show('Error: ' + e.message, 'error'); }
    finally { Spinner.hide(); }
  },

  async resendEmail(assignmentId) {
    if (!confirm('Send invitation email to this examiner?')) return;
    Spinner.show();
    try {
      const res = await gsrAuth('resendExaminerEmail', assignmentId);
      if (!res.success) throw new Error(res.message);
      Toast.show('Invitation email sent.');
      await this.refreshStatus();
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },

  _renderRubric(criteria) {
    this._renderRubricSection('rubricListFYP1', criteria.filter(c => !c.ProjectType || c.ProjectType === 'FYP1'));
    this._renderRubricSection('rubricListFYP2', criteria.filter(c => c.ProjectType === 'FYP2'));
    this._refreshRubricTotals();
    ['rubricListFYP1','rubricListFYP2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input',  () => this._refreshRubricTotals());
        el.addEventListener('change', () => this._refreshRubricTotals());
      }
    });
  },

  _refreshRubricTotals() {
    const groups = {
      'FYP1-Report': 0, 'FYP1-Presentation': 0,
      'FYP2-Report': 0, 'FYP2-Presentation': 0,
    };
    [['rubricListFYP1','FYP1'],['rubricListFYP2','FYP2']].forEach(([listId, fyp]) => {
      document.querySelectorAll(`#${listId} .rubric-row:not(:first-child)`).forEach(row => {
        const nameEl = row.querySelector('.rc-name');
        if (!nameEl || !nameEl.value.trim()) return;
        const cat = row.querySelector('.rc-cat').value;
        const w   = parseFloat(row.querySelector('.rc-weight').value) || 0;
        groups[`${fyp}-${cat}`] += w;
      });
    });
    const el = document.getElementById('rubric-weight-totals');
    if (!el) return;
    el.innerHTML = Object.entries(groups).map(([key, t]) => {
      const t2 = Math.round(t * 10) / 10;
      const ok = Math.round(t) === 100;
      return `<span class="me-3">${key.replace('-', ' ')}: <strong class="${ok ? 'text-success' : 'text-danger'}">${t2}/100</strong></span>`;
    }).join('');
  },

  _renderRubricSection(containerId, criteria) {
    const isAdmin = Auth.supervisor && Auth.supervisor.isAdmin;
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.className = 'rubric-row';
    hdr.innerHTML = `<strong>Category</strong><strong>Criterion</strong><strong>Graded By</strong><strong>Max</strong><strong>Weight%</strong><strong>ABET</strong><span></span>`;
    c.appendChild(hdr);
    criteria.forEach(cr => {
      const scope = cr.GradingScope || 'Group';
      const abet  = String(cr.ABETOutcome || '');
      const row   = document.createElement('div');
      row.className = 'rubric-row';
      const dis = isAdmin ? '' : 'disabled';
      const abetOpts = ['','1a','2a','2b','3a','3b','4a','5a','5b','7a'].map(o =>
        `<option value="${o}" ${abet === o ? 'selected' : ''}>${o || 'None'}</option>`
      ).join('');
      row.innerHTML = `
        <select class="form-select form-select-sm rc-cat" ${dis}>
          <option ${cr.Category === 'Report'       ? 'selected' : ''}>Report</option>
          <option ${cr.Category === 'Presentation' ? 'selected' : ''}>Presentation</option>
        </select>
        <input type="text"   class="form-control form-control-sm rc-name"   value="${cr.CriterionName}" placeholder="Criterion" ${isAdmin ? '' : 'readonly'}/>
        <select class="form-select form-select-sm rc-scope" ${dis}>
          <option value="Group"      ${scope === 'Group'      ? 'selected' : ''}>Group</option>
          <option value="Individual" ${scope === 'Individual' ? 'selected' : ''}>Per Student</option>
        </select>
        <input type="number" class="form-control form-control-sm rc-max"    value="${cr.MaxGrade}" min="1" max="1000" ${isAdmin ? '' : 'readonly'}/>
        <input type="number" class="form-control form-control-sm rc-weight" value="${cr.Weight}"   min="1" max="100"  ${isAdmin ? '' : 'readonly'}/>
        <select class="form-select form-select-sm rc-abet" title="ABET Outcome" ${dis}>${abetOpts}</select>
        ${isAdmin ? '<button type="button" class="btn btn-outline-danger btn-sm" onclick="this.closest(\'.rubric-row\').remove()"><i class="fas fa-trash"></i></button>' : '<span></span>'}`;
      c.appendChild(row);
    });
  },

  addRubricRow(fypType) {
    if (!Auth.supervisor || !Auth.supervisor.isAdmin) { Toast.show('Only admins can add rubric rows.', 'warning'); return; }
    const id  = fypType === 'FYP2' ? 'rubricListFYP2' : 'rubricListFYP1';
    const c   = document.getElementById(id);
    const row = document.createElement('div');
    row.className = 'rubric-row';
    const aOpts = ['','1a','2a','2b','3a','3b','4a','5a','5b','7a'].map(o => `<option value="${o}">${o || 'None'}</option>`).join('');
    row.innerHTML = `
      <select class="form-select form-select-sm rc-cat"><option>Report</option><option>Presentation</option></select>
      <input type="text"   class="form-control form-control-sm rc-name"   placeholder="Criterion name"/>
      <select class="form-select form-select-sm rc-scope">
        <option value="Group" selected>Group</option>
        <option value="Individual">Per Student</option>
      </select>
      <input type="number" class="form-control form-control-sm rc-max"    value="100" min="1" max="1000"/>
      <input type="number" class="form-control form-control-sm rc-weight" value="25"  min="1" max="100"/>
      <select class="form-select form-select-sm rc-abet" title="ABET Outcome">${aOpts}</select>
      <button type="button" class="btn btn-outline-danger btn-sm" onclick="this.closest('.rubric-row').remove()"><i class="fas fa-trash"></i></button>`;
    c.appendChild(row);
    this._refreshRubricTotals();
  },

  async saveRubric() {
    if (!Auth.supervisor || !Auth.supervisor.isAdmin) { Toast.show('Only admins can save rubrics.', 'warning'); return; }
    const criteria = [];
    [['rubricListFYP1','FYP1'],['rubricListFYP2','FYP2']].forEach(([listId, fypType]) => {
      document.querySelectorAll(`#${listId} .rubric-row:not(:first-child)`).forEach(row => {
        const nameEl = row.querySelector('.rc-name');
        if (!nameEl) return;
        const name = nameEl.value.trim();
        if (!name) return;
        criteria.push({
          projectType:   fypType,
          category:      row.querySelector('.rc-cat').value,
          criterionName: name,
          gradingScope:  row.querySelector('.rc-scope').value,
          maxGrade:      parseFloat(row.querySelector('.rc-max').value)    || 100,
          weight:        parseFloat(row.querySelector('.rc-weight').value) || 25,
          abetOutcome:   row.querySelector('.rc-abet') ? row.querySelector('.rc-abet').value : '',
        });
      });
    });
    const rubricGroups = [
      { label: 'FYP1 Report',       items: criteria.filter(c => c.projectType === 'FYP1' && c.category === 'Report') },
      { label: 'FYP1 Presentation', items: criteria.filter(c => c.projectType === 'FYP1' && c.category === 'Presentation') },
      { label: 'FYP2 Report',       items: criteria.filter(c => c.projectType === 'FYP2' && c.category === 'Report') },
      { label: 'FYP2 Presentation', items: criteria.filter(c => c.projectType === 'FYP2' && c.category === 'Presentation') },
    ];
    for (const g of rubricGroups) {
      if (!g.items.length) continue;
      const total = g.items.reduce((s, c) => s + c.weight, 0);
      if (Math.round(total) !== 100) {
        Toast.show(`${g.label} weights must sum to 100 (currently ${total}).`, 'warning');
        return;
      }
    }
    Spinner.show();
    try {
      await gsrAuth('saveExaminerConfig', criteria);
      Toast.show('Examiner rubric saved for FYP1 and FYP2.');
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },
};

// ── Tab 4: Final Results ──────────────────────────────────────────────

const Res = {
  allResults:  [],
  abetByType:  {},
  statsByType: {},

  _setExportEnabled(enabled) {
    const btn = document.getElementById('btn-export-pdf');
    if (btn) btn.disabled = !enabled;
  },

  async load() {
    this._setExportEnabled(false);
    Spinner.show();
    try {
      const res = await gsrAuth('getFinalResults');
      if (!res.success) {
        if (res.incomplete) {
          this._showIncomplete(res.incompleteByType || {});
        } else {
          Toast.show(res.message || 'Failed to load results.', 'error');
        }
        return;
      }
      this.allResults  = res.results;
      this.abetByType  = res.abetByType  || {};
      this.statsByType = res.statsByType || {};
      this._populateProgramFilter();
      this.applyFilter();

      // Blocking warning for locked types that are not yet fully complete
      if (res.incompleteByType && Object.keys(res.incompleteByType).length) {
        this._showIncomplete(res.incompleteByType);
      } else {
        const warn = document.getElementById('res-incomplete-warning');
        if (warn) { warn.innerHTML = ''; warn.classList.add('d-none'); }
      }

      // Soft warning for unlocked types with individually-pending projects
      if (res.partialPendingByType && Object.keys(res.partialPendingByType).length) {
        this._showPartialPending(res.partialPendingByType);
      }

      // Outlier note if any grade was adjusted
      const anyOutliers = res.results.some(r => r.outliersDetected);
      const done = (res.completeTypes || []).join(' & ') || 'results';
      const partial = res.partialPendingByType && Object.keys(res.partialPendingByType).length ? ' (partial — unlock mode)' : '';
      Toast.show(`Results loaded — ${res.results.length} student(s) (${done}${partial}).${anyOutliers ? ' ⚠ Outlier adjustment applied.' : ''}`);
    } catch (e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },

  applyFilter() {
    const type    = document.getElementById('res-filter-type').value;
    const program = document.getElementById('res-filter-program').value;
    let filtered = this.allResults;
    if (type) filtered = filtered.filter(r => r.projectType === type);
    if (program) filtered = filtered.filter(r => {
      if (r.projectProgram === program) return true;
      const proj = Reg._projectsCache.find(p => p.Title === r.projectTitle);
      if (!proj) return false;
      const supIds = (proj.Supervisors || '').split(',').map(x => x.trim()).filter(Boolean);
      return supIds.some(sid => {
        const sup = Reg.allSupervisors.find(s => s.id === sid);
        return sup && sup.program === program;
      });
    });
    this._render(filtered);
    this._renderSummary(this.abetByType, program ? this._computeStats(filtered) : this.statsByType);
    this._setExportEnabled(filtered.length > 0);
  },

  _computeStats(data) {
    const byType = {};
    for (const pt of ['FYP1', 'FYP2']) {
      const grades = data
        .filter(r => r.projectType === pt && r.finalGrade != null)
        .map(r => parseFloat(r.finalGrade))
        .filter(v => !isNaN(v));
      if (!grades.length) continue;
      const count = grades.length;
      const mean  = grades.reduce((a, b) => a + b, 0) / count;
      const sd    = Math.sqrt(grades.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / count);
      byType[pt]  = { count, mean: mean.toFixed(2), sd: parseFloat(sd.toFixed(2)) };
    }
    return byType;
  },

  _populateProgramFilter() {
    const sel = document.getElementById('res-filter-program');
    if (!sel) return;
    const programs = new Set();
    this.allResults.forEach(r => {
      if (r.projectProgram) programs.add(r.projectProgram);
      const proj = Reg._projectsCache.find(p => p.Title === r.projectTitle);
      if (proj) {
        (proj.Supervisors || '').split(',').map(x => x.trim()).filter(Boolean).forEach(sid => {
          const sup = Reg.allSupervisors.find(s => s.id === sid);
          if (sup && sup.program) programs.add(sup.program);
        });
      }
    });
    const sorted = [...programs].sort();
    const current = sel.value;
    sel.innerHTML = '<option value="">All Programs</option>' + sorted.map(p => `<option${p === current ? ' selected' : ''}>${escHtml(p)}</option>`).join('');
  },

  _showIncomplete(incompleteByType) {
    const warn  = document.getElementById('res-incomplete-warning');
    const tbody = document.getElementById('tbResults');

    const sections = Object.entries(incompleteByType).map(([type, projs]) => {
      const items = projs.map(p => {
        const bullets = p.missing.map(m => `<li>${escHtml(m)}</li>`).join('');
        return `<li class="mb-1"><strong>${escHtml(p.title)}</strong><ul class="mb-0">${bullets}</ul></li>`;
      }).join('');
      return `<p class="mb-1 fw-semibold">${escHtml(type)} — incomplete:</p><ul class="mb-2 small">${items}</ul>`;
    }).join('');

    if (warn) {
      warn.innerHTML = `
        <div class="alert alert-warning d-flex align-items-start gap-3 mb-3">
          <i class="fas fa-exclamation-triangle fa-lg mt-1 flex-shrink-0"></i>
          <div>
            <strong>Some results not yet available</strong>
            <p class="mb-2 mt-1 small">The following project types have incomplete grading and are excluded from results:</p>
            ${sections}
          </div>
        </div>`;
      warn.classList.remove('d-none');
    }
    if (!this.allResults || !this.allResults.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="text-center text-muted py-4">Grading incomplete — see warning above.</td></tr>';
    }
  },

  _showPartialPending(partialPendingByType) {
    const warn = document.getElementById('res-incomplete-warning');
    if (!warn) return;
    const sections = Object.entries(partialPendingByType).map(([type, projs]) => {
      const items = projs.map(p => {
        const bullets = p.missing.map(m => `<li>${escHtml(m)}</li>`).join('');
        return `<li class="mb-1"><strong>${escHtml(p.title)}</strong><ul class="mb-0">${bullets}</ul></li>`;
      }).join('');
      return `<div class="mb-2"><strong>${type}</strong> — pending projects:<ul class="mb-0 mt-1">${items}</ul></div>`;
    }).join('');
    warn.className = 'alert alert-warning py-2 small mb-3';
    warn.innerHTML = `<i class="fas fa-exclamation-triangle me-1"></i>
      <strong>Partial results shown (unlock mode active).</strong> The following projects are still pending and not yet included:
      <div class="mt-2">${sections}</div>`;
    warn.classList.remove('d-none');
  },

  _render(data) {
    const tbody = document.getElementById('tbResults');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="text-center text-muted py-5">No results available.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map((r, i) => {
      const lc = r.letterGrade.replace('+', '-plus').replace(/-$/, '-minus');
      const outlierTip = r.outliersDetected
        ? ` <span title="Outlier detected &amp; excluded: ${(r.outlierDetails||[]).map(o=>o.criterion+' ('+o.score+')').join(', ')}" style="cursor:help;color:#d97706;">&#9888;</span>`
        : '';
      const boostedGrade = r.finalGrade + (r.boosted ? 1 : 0);
      return `<tr>
        <td>${i + 1}</td>
        <td class="fw-medium">${escHtml(r.studentName)}${outlierTip}</td>
        <td><code>${escHtml(r.studentId)}</code></td>
        <td>${escHtml(r.projectTitle)}</td>
        <td><span class="badge ${r.projectType === 'FYP1' ? 'bg-primary' : 'bg-success'}">${escHtml(r.projectType)}</span></td>
        <td>${r.teamworkPct}%${r.peerWarning ? ' <span title="No peer evaluations received — peer component counted as 0%" style="cursor:help;color:#d97706;font-weight:bold;">&#9888;</span>' : ''}</td>
        <td>${r.reportPct}%</td>
        <td>${r.presPct}%</td>
        <td>${r.finalGrade}%</td>
        <td class="fw-bold">${boostedGrade}%${r.boosted ? ' <span class="badge bg-warning text-dark ms-1" title="Grade boundary boost applied" style="font-size:10px;">↑</span>' : ''}</td>
        <td class="text-center"><span class="grade-${escHtml(lc)} px-2 py-1 rounded">${escHtml(r.letterGrade)}</span></td>
      </tr>`;
    }).join('');
  },

  _renderSummary(abetByType, statsByType) {
    const c = document.getElementById('summaryCards');
    if (!c) return;
    const html = ['FYP1','FYP2'].map(pt => {
      const stats = statsByType[pt];
      const abet  = abetByType[pt];
      if (!stats || stats.count === 0) return '';
      return this._summaryCard(pt, stats, abet);
    }).join('');
    c.innerHTML = html || '<p class="text-muted small">No summary data available.</p>';
    document.getElementById('resultsSummary').classList.remove('d-none');
  },

  _summaryCard(pt, stats, abet) {
    const mean = parseFloat(stats.mean) || 0;
    const sd   = parseFloat(stats.sd)   || 0;
    const meanOk    = mean >= 75 && mean <= 90;
    const meanColor = meanOk ? '#16a34a' : mean < 75 ? '#dc2626' : '#d97706';
    const meanBadge = meanOk
      ? `<span class="badge bg-success ms-2"><i class="fas fa-check-circle me-1"></i>Within Range (75–90)</span>`
      : mean < 75
        ? `<span class="badge bg-danger ms-2"><i class="fas fa-exclamation-triangle me-1"></i>Below 75 — Action Required</span>`
        : `<span class="badge bg-warning text-dark ms-2"><i class="fas fa-exclamation-circle me-1"></i>Above 90 — Review Grading</span>`;
    const sdOk    = sd >= 5 && sd <= 15;
    const sdColor = sdOk ? '#16a34a' : sd < 5 ? '#d97706' : '#dc2626';
    const sdBadge = sdOk
      ? `<span class="badge bg-success ms-2"><i class="fas fa-check-circle me-1"></i>Normal Range (5–15)</span>`
      : sd < 5
        ? `<span class="badge bg-warning text-dark ms-2"><i class="fas fa-compress-arrows-alt me-1"></i>Too Uniform (SD &lt; 5)</span>`
        : `<span class="badge bg-danger ms-2"><i class="fas fa-expand-arrows-alt me-1"></i>High Variance (SD &gt; 15)</span>`;
    const sdPct   = Math.min(100, (sd / 30) * 100);
    const m5pct   = ((5  / 30) * 100).toFixed(2);
    const m15pct  = ((15 / 30) * 100).toFixed(2);
    const abetKeys   = ['abet1a','abet2a','abet2b','abet3a','abet3b','abet4a','abet5a','abet5b','abet7a'];
    const abetLabels = { abet1a:'1a', abet2a:'2a', abet2b:'2b', abet3a:'3a', abet3b:'3b', abet4a:'4a', abet5a:'5a', abet5b:'5b', abet7a:'7a' };
    const lvlColors  = ['','#fee2e2','#fef3c7','#dbeafe','#d1fae5'];
    const lvlLabels  = ['','Level 1','Level 2','Level 3','Level 4'];
    // Only render outcomes that have criteria linked for this FYP type (null = not applicable)
    const abetRows   = abet
      ? abetKeys.map(k => {
          const v = abet[k];
          if (!v) return null;
          if (v.notMeasured) return `<div class="d-flex align-items-center justify-content-between py-2 border-bottom" style="font-size:13px;">
            <span class="fw-medium">Outcome ${abetLabels[k]}</span>
            <div class="d-flex align-items-center gap-2">
              <span class="text-muted small fst-italic">Not measured for this year</span>
            </div>
          </div>`;
          const bg  = lvlColors[v.level] || '#f3f4f6';
          const lbl = lvlLabels[v.level] || '—';
          return `<div class="d-flex align-items-center justify-content-between py-2 border-bottom" style="font-size:13px;">
            <span class="fw-medium">Outcome ${abetLabels[k]}</span>
            <div class="d-flex align-items-center gap-2">
              <span class="fw-bold">${v.pct}%</span>
              <span style="background:${bg};padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700;">${lbl}</span>
            </div>
          </div>`;
        }).filter(Boolean).join('')
      : null;
    const ptBadge = pt === 'FYP1'
      ? '<span class="badge bg-primary px-3 py-2 fs-6">FYP1</span>'
      : '<span class="badge bg-success px-3 py-2 fs-6">FYP2</span>';
    return `
      <div class="card mb-4">
        <div class="card-header d-flex align-items-center gap-3 py-3">
          ${ptBadge}
          <span class="fw-bold">${pt} Summary</span>
          <small class="text-muted ms-auto">${stats.count} student${stats.count !== 1 ? 's' : ''}</small>
        </div>
        <div class="card-body">
          <div class="row g-4 mb-4">
            <div class="col-md-6">
              <div class="d-flex align-items-center flex-wrap gap-1 mb-2">
                <span class="fw-semibold">Average Grade</span>${meanBadge}
              </div>
              <div class="mb-2"><span class="fw-bold fs-5" style="color:${meanColor};">${mean.toFixed(1)}%</span></div>
              <div class="position-relative mb-4" style="height:20px;">
                <div class="progress" style="height:20px;border-radius:10px;">
                  <div class="progress-bar" style="width:${Math.min(100,mean)}%;background:${meanColor};transition:width .4s;"></div>
                </div>
                <div style="position:absolute;top:0;left:75%;width:2px;height:20px;background:#374151;opacity:.7;"></div>
                <div style="position:absolute;top:22px;left:75%;transform:translateX(-50%);font-size:10px;color:#6b7280;">75</div>
                <div style="position:absolute;top:0;left:90%;width:2px;height:20px;background:#374151;opacity:.7;"></div>
                <div style="position:absolute;top:22px;left:90%;transform:translateX(-50%);font-size:10px;color:#6b7280;">90</div>
              </div>
              <small class="text-muted">Accepted range: 75 – 90</small>
            </div>
            <div class="col-md-6">
              <div class="d-flex align-items-center flex-wrap gap-1 mb-2">
                <span class="fw-semibold">Standard Deviation</span>${sdBadge}
              </div>
              <div class="mb-2"><span class="fw-bold fs-5" style="color:${sdColor};">${sd.toFixed(2)}</span></div>
              <div class="position-relative mb-4" style="height:20px;">
                <div class="progress" style="height:20px;border-radius:10px;">
                  <div class="progress-bar" style="width:${sdPct}%;background:${sdColor};transition:width .4s;"></div>
                </div>
                <div style="position:absolute;top:0;left:${m5pct}%;width:2px;height:20px;background:#374151;opacity:.7;"></div>
                <div style="position:absolute;top:22px;left:${m5pct}%;transform:translateX(-50%);font-size:10px;color:#6b7280;">5</div>
                <div style="position:absolute;top:0;left:${m15pct}%;width:2px;height:20px;background:#374151;opacity:.7;"></div>
                <div style="position:absolute;top:22px;left:${m15pct}%;transform:translateX(-50%);font-size:10px;color:#6b7280;">15</div>
              </div>
              <small class="text-muted">Accepted range: 5 – 15 | Scale: 0 – 30</small>
            </div>
          </div>
          ${abetRows ? `<div>
            <h6 class="fw-bold mb-3"><i class="fas fa-graduation-cap me-2 text-primary"></i>ABET Outcomes (Aggregate)</h6>
            ${abetRows}
          </div>` : ''}
        </div>
      </div>`;
  },

  async exportPDF() {
    Spinner.show();
    try {
      const res = await gsrAuth('getDetailedResults');
      if (!res.success) { Toast.show(res.message || 'Failed to load data.', 'error'); return; }
      if (!res.projects || !res.projects.length) { Toast.show('No projects to export.', 'warning'); return; }

      // Apply program filter from UI
      const selProgram = document.getElementById('res-filter-program');
      const programFilter = selProgram ? selProgram.value : '';
      let exportProjects = res.projects;
      if (programFilter) exportProjects = exportProjects.filter(p => (p.program || '') === programFilter);
      if (!exportProjects.length) { Toast.show('No projects for selected program.', 'warning'); return; }

      // Apply type filter from UI (respects dropdown selection)
      const typeFilter = document.getElementById('res-filter-type')?.value || '';
      const fypTypesToExport = typeFilter ? [typeFilter] : ['FYP1', 'FYP2'].filter(pt => this.allResults.some(r => r.projectType === pt));

      // Load university logo (preserve aspect ratio — single fetch, get both dataUrl and dims)
      const logoUrl = 'https://usif-3jra.github.io/epme-study-plan/assets/logo_w.png';
      const loadImg = async url => {
        try {
          return await new Promise(resolve => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); resolve({ dataUrl: c.toDataURL('image/png'), w: img.width, h: img.height }); };
            img.onerror = () => resolve(null);
            img.src = url;
          });
        } catch { return null; }
      };
      const logoData = await loadImg(logoUrl);

      const { jsPDF } = window.jspdf;
      const W = 210, margin = 14, cW = W - 2 * margin;
      const navy   = [30, 58, 95];
      const blue   = [37, 99, 235];
      const green  = [22, 163, 74];
      const dkBlue = [50, 90, 140];
      const lvlLbl = ['', 'Level 1 — Beginning', 'Level 2 — Developing', 'Level 3 — Accomplished', 'Level 4 — Exemplary'];
      const abetKeys = ['abet1a','abet2a','abet2b','abet3a','abet3b','abet4a','abet5a','abet5b','abet7a'];
      const abetLbl  = { abet1a:'1a', abet2a:'2a', abet2b:'2b', abet3a:'3a', abet3b:'3b', abet4a:'4a', abet5a:'5a', abet5b:'5b', abet7a:'7a' };
      const meta = res.meta || {};
      const genDate = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
      const yr   = (meta.year || String(new Date().getFullYear())).replace('–','-');
      const sem  = meta.semester ? `_S${meta.semester}` : '';

      // ── Shared helpers ────────────────────────────────────────────────────
      const drawHdr = (doc, subtitle) => {
        doc.setFillColor(...navy);
        doc.rect(0, 0, W, 27, 'F');
        let textX = W / 2, textMaxW = cW - 36;
        if (logoData) {
          const lw = 32, lh = lw * (logoData.h / logoData.w);
          doc.addImage(logoData.dataUrl, 'PNG', margin, (27 - lh) / 2, lw, lh);
          const logoRight = margin + lw + 4;
          textX = (logoRight + (W - margin)) / 2;
          textMaxW = (W - margin) - logoRight;
        }
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        const subFontSz = subtitle.length > 80 ? 8 : subtitle.length > 60 ? 9.5 : subtitle.length > 45 ? 11 : 12.5;
        doc.setFontSize(subFontSz);
        doc.text(subtitle, textX, 10, { align: 'center', maxWidth: textMaxW });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
        doc.text(`Beirut Arab University  ·  Faculty of Engineering  ·  ${meta.department || 'ECE'} Department`, W / 2, 17, { align: 'center' });
        doc.text(`Academic Year ${meta.year || ''}${meta.semester ? '  ·  Semester: ' + meta.semester : ''}`, W / 2, 22.5, { align: 'center' });
        doc.setTextColor(0, 0, 0);
        return 30;
      };

      const sectionLabel = (doc, y, text) => {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(50, 50, 50);
        doc.text(text, margin, y + 3.5);
        doc.setTextColor(0, 0, 0);
        return y + 5;
      };

      // Draw a per-examiner table (Report or Presentation)
      const drawExamTable = (doc, y, label, table, hdrColor, hdrSub, anonymize = false) => {
        if (!table || !table.rows.length) return y;
        y = sectionLabel(doc, y, label);
        const examHeaders = anonymize
          ? table.examiners.map((_, i) => `Examiner ${i + 1}`)
          : table.examiners;
        const nEx  = examHeaders.length;
        const numW = 7, maxW = 15, weiW = 15;
        const exW  = Math.max(18, Math.min(32, (cW - numW - maxW - weiW - 40) / Math.max(nEx, 1)));
        const critW = cW - numW - maxW - weiW - exW * nEx;
        const colSty = { 0: { cellWidth: numW, halign: 'center' }, 1: { cellWidth: critW } };
        for (let i = 0; i < nEx; i++) colSty[2 + i] = { cellWidth: exW, halign: 'center' };
        colSty[2 + nEx]     = { cellWidth: maxW, halign: 'center' };
        colSty[2 + nEx + 1] = { cellWidth: weiW, halign: 'center' };
        doc.autoTable({
          startY: y, margin: { left: margin, right: margin }, theme: 'grid',
          headStyles: { fillColor: hdrColor, textColor: 255, fontSize: 7.5, fontStyle: 'bold', cellPadding: 1.8, halign: 'center' },
          bodyStyles: { fontSize: 7.5, cellPadding: 1.8 },
          footStyles: { fillColor: [230, 240, 255], textColor: [...navy], fontSize: 7.5, fontStyle: 'bold', cellPadding: 1.8 },
          columnStyles: colSty,
          head: [['#', 'Criterion', ...examHeaders, 'Max', 'Wt%']],
          body: table.rows.map(r => [r.num, r.criterion + (r.scope === 'Group' ? ' [G]' : ''), ...r.scores.map(s => s !== null ? s : '—'), r.maxGrade, `${r.weight}%`]),
          foot: [[{ content: hdrSub + ' Grade', colSpan: 2 + nEx, styles: { halign: 'right' } }, { content: `${table.pct}%`, colSpan: 2, styles: { halign: 'center' } }]],
        });
        return doc.lastAutoTable.finalY + 3;
      };

      const isAdminUser = Auth.supervisor && Auth.supervisor.isAdmin;

      if (!isAdminUser) {
        // ── Supervisor: one summary PDF ──────────────────────────────────────
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        let ys = drawHdr(doc, 'FYP Assessment — Grade Summary');
        ys = sectionLabel(doc, ys, 'Student Grade Summary');
        for (const fypType of fypTypesToExport) {
          const typeProjects = res.projects.filter(p => p.type === fypType);
          if (!typeProjects.length) continue;
          const rows = typeProjects.flatMap(proj =>
            proj.students.map(s => [
              s.studentName, s.studentId, proj.title,
              `${s.summary.teamworkPct}%`, `${s.summary.reportPct}%`, `${s.summary.presPct}%`,
              `${s.summary.finalGrade}%`,
              `${s.summary.finalGrade + (s.summary.boosted ? 1 : 0)}%${s.summary.boosted ? ' (+1)' : ''}`,
              s.summary.letterGrade,
            ])
          );
          if (!rows.length) continue;
          ys = sectionLabel(doc, ys + 2, fypType);
          doc.autoTable({
            startY: ys, margin: { left: margin, right: margin }, theme: 'grid',
            headStyles: { fillColor: navy, textColor: 255, fontSize: 7.5, fontStyle: 'bold', cellPadding: 2, halign: 'center' },
            bodyStyles: { fontSize: 7.5, cellPadding: 2 },
            columnStyles: { 0: { cellWidth: cW*0.21 }, 1: { cellWidth: cW*0.10, halign:'center' }, 2: { cellWidth: cW*0.22 }, 3:{cellWidth:cW*0.077,halign:'center'}, 4:{cellWidth:cW*0.077,halign:'center'}, 5:{cellWidth:cW*0.077,halign:'center'}, 6:{cellWidth:cW*0.077,halign:'center'}, 7:{cellWidth:cW*0.09,halign:'center',fontStyle:'bold'}, 8:{cellWidth:cW*0.077,halign:'center',fontStyle:'bold'} },
            head: [['Student Name', 'Student ID', 'Project', `TW (${meta.weights?.tw??35}%)`, `Report (${meta.weights?.report??35}%)`, `Pres (${meta.weights?.pres??30}%)`, 'Weight', 'Final Grade', 'Letter']],
            body: rows,
          });
          ys = doc.lastAutoTable.finalY + 6;
        }
        // ABET
        const abetKeys2 = ['abet1a','abet2a','abet2b','abet3a','abet3b','abet4a','abet5a','abet5b','abet7a'];
        const abetLbl2  = { abet1a:'1a', abet2a:'2a', abet2b:'2b', abet3a:'3a', abet3b:'3b', abet4a:'4a', abet5a:'5a', abet5b:'5b', abet7a:'7a' };
        const lvlLbl2   = ['','Level 1 — Beginning','Level 2 — Developing','Level 3 — Accomplished','Level 4 — Exemplary'];
        for (const fypType of ['FYP1','FYP2']) {
          const tAbet = res.abet && res.abet[fypType];
          if (!tAbet) continue;
          const abetRows = abetKeys2.map(k => { const v=tAbet[k]; if(!v) return null; if(v.notMeasured) return [`Outcome ${abetLbl2[k]}`, 'N/M', 'Not measured for this year']; return [`Outcome ${abetLbl2[k]}`, `${v.pct}%`, lvlLbl2[v.level]||'—']; }).filter(Boolean);
          if (!abetRows.length) continue;
          ys = sectionLabel(doc, ys + 2, `ABET Outcomes — ${fypType}`);
          doc.autoTable({
            startY: ys, margin: { left: margin, right: margin }, theme: 'grid',
            headStyles: { fillColor: navy, textColor: 255, fontSize: 8, fontStyle: 'bold', cellPadding: 2, halign: 'center' },
            bodyStyles: { fontSize: 8, cellPadding: 2 },
            columnStyles: { 0: { fontStyle:'bold', cellWidth: cW*0.18 }, 1: { halign:'center', cellWidth: cW*0.18 }, 2: { cellWidth: cW*0.64 } },
            head: [['Outcome', 'Achievement %', 'Level of Achievement']],
            body: abetRows,
          });
          ys = doc.lastAutoTable.finalY + 6;
        }
        // Stats
        ys = sectionLabel(doc, ys + 2, 'Grade Statistics');
        const statRows = ['FYP1','FYP2'].map(pt => {
          const s = res.statistics && res.statistics[pt];
          if (!s) return null;
          return [pt, s.count, `${s.mean}%`, typeof s.sd === 'number' ? s.sd.toFixed(2) : s.sd];
        }).filter(Boolean);
        if (statRows.length) {
          doc.autoTable({
            startY: ys, margin: { left: margin, right: margin }, theme: 'grid',
            headStyles: { fillColor: navy, textColor: 255, fontSize: 8, fontStyle: 'bold', cellPadding: 2, halign: 'center' },
            bodyStyles: { fontSize: 8, cellPadding: 2, halign: 'center' },
            columnStyles: { 0: { fontStyle:'bold', halign:'left' } },
            head: [['Type', 'Students', 'Mean Grade', 'Std Dev']],
            body: statRows,
          });
        }
        // Per-student examiner grading pages (anonymized)
        for (const fypType of fypTypesToExport) {
          const examProjects = res.projects.filter(p => p.type === fypType);
          for (const proj of examProjects) {
            for (const stu of proj.students) {
              if ((!stu.repTable || !stu.repTable.rows.length) && (!stu.presTable || !stu.presTable.rows.length)) continue;
              doc.addPage();
              ys = drawHdr(doc, `${fypType} — Examiner Grading`);
              doc.setFillColor(...blue);
              doc.rect(margin, ys, cW, 8, 'F');
              doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(255, 255, 255);
              doc.text(`${stu.studentName}   (${stu.studentId})`, margin + 3, ys + 5.5);
              doc.setTextColor(0, 0, 0);
              ys += 11;
              ys = sectionLabel(doc, ys, `Project: ${proj.title}`);
              ys = drawExamTable(doc, ys, 'Examiner — Report Grading',       stu.repTable,  dkBlue, 'Report',       true);
              ys = drawExamTable(doc, ys, 'Examiner — Presentation Grading', stu.presTable, dkBlue, 'Presentation', true);
            }
          }
        }

        doc.save(`FYP_Assessment_Summary_${yr}${sem}.pdf`);
        Toast.show('Summary PDF downloaded.');
        return;
      }

      // ── Admin: one PDF per program per FYP type ───────────────────────────
      const programs = [...new Set(exportProjects.map(p => p.program || 'General'))];
      for (const program of programs) {
      for (const fypType of fypTypesToExport) {
        const typeProjects = exportProjects.filter(p => p.type === fypType && (p.program || 'General') === program);
        if (!typeProjects.length) continue;

        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

        // ── Page 1: Student grade summary (matches results tab) ──────────────
        let y = drawHdr(doc, `${fypType} — ${program} Assessment Report`);
        y = sectionLabel(doc, y, 'Student Grade Summary');
        let _sumIdx = 0;
        const _sumRows = typeProjects.flatMap(proj =>
          proj.students.map(s => [
            ++_sumIdx, s.studentName, s.studentId, proj.title,
            `${s.summary.teamworkPct}%`, `${s.summary.reportPct}%`, `${s.summary.presPct}%`,
            `${s.summary.finalGrade}%`,
            `${s.summary.finalGrade + (s.summary.boosted ? 1 : 0)}%${s.summary.boosted ? ' (+1)' : ''}`,
            s.summary.letterGrade,
          ])
        );
        doc.autoTable({
          startY: y, margin: { left: margin, right: margin }, theme: 'grid',
          headStyles: { fillColor: navy, textColor: 255, fontSize: 7.5, fontStyle: 'bold', cellPadding: 2, halign: 'center' },
          bodyStyles: { fontSize: 7.5, cellPadding: 2 },
          columnStyles: { 0:{cellWidth:8,halign:'center'}, 1:{cellWidth:cW*0.19}, 2:{cellWidth:cW*0.10,halign:'center'}, 3:{cellWidth:cW*0.21}, 4:{cellWidth:cW*0.075,halign:'center'}, 5:{cellWidth:cW*0.075,halign:'center'}, 6:{cellWidth:cW*0.075,halign:'center'}, 7:{cellWidth:cW*0.075,halign:'center'}, 8:{cellWidth:cW*0.09,halign:'center',fontStyle:'bold'}, 9:{cellWidth:cW*0.075,halign:'center',fontStyle:'bold'} },
          head: [['#', 'Student Name', 'Student ID', 'Project Title', `TW (${meta.weights?.tw??35}%)`, `Report (${meta.weights?.report??35}%)`, `Pres (${meta.weights?.pres??30}%)`, 'Weight', 'Final Grade', 'Letter']],
          body: _sumRows,
        });

        // ── Page 2: Grade Statistics, Distribution & ABET ────────────────────
        doc.addPage();
        let ys = drawHdr(doc, `${fypType} — Grade Statistics & ABET Outcomes`);

        const tStats = res.statistics[fypType];
        if (tStats) {
          doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...navy);
          doc.text('Grade Statistics', margin, ys + 4); ys += 8;
          doc.setTextColor(0, 0, 0);
          doc.autoTable({
            startY: ys, margin: { left: margin, right: margin }, theme: 'grid',
            headStyles: { fillColor: navy, textColor: 255, fontSize: 8.5, fontStyle: 'bold', cellPadding: 2.5, halign: 'center' },
            bodyStyles: { fontSize: 8.5, cellPadding: 2.5, halign: 'center' },
            columnStyles: { 0: { fontStyle: 'bold', halign: 'left' } },
            head: [['Type', 'Students', 'Mean Grade', 'Standard Deviation']],
            body: [[fypType, tStats.count, `${tStats.mean}%`, typeof tStats.sd === 'number' ? tStats.sd.toFixed(2) : tStats.sd]],
          });
          ys = doc.lastAutoTable.finalY + 10;
        }

        // ── Grade Distribution Histogram ─────────────────────────────────────
        const gradeOrder = ['A+','A','A-','B+','B','B-','C+','C','C-','D','D-','F'];
        const gradeColors2 = {
          'A+': [22,163,74], 'A': [22,163,74], 'A-': [22,163,74],
          'B+': [37,99,235], 'B': [37,99,235], 'B-': [37,99,235],
          'C+': [234,179,8], 'C': [234,179,8], 'C-': [234,179,8],
          'D': [239,68,68], 'D-': [239,68,68], 'F': [127,29,29],
        };
        const gradeCounts = {};
        gradeOrder.forEach(g => { gradeCounts[g] = 0; });
        typeProjects.forEach(proj => proj.students.forEach(stu => {
          const lg = stu.summary.letterGrade;
          if (Object.prototype.hasOwnProperty.call(gradeCounts, lg)) gradeCounts[lg]++;
        }));
        const maxCount = Math.max(1, ...gradeOrder.map(g => gradeCounts[g]));
        const chartH2  = 38, chartTop = ys + 8;
        const barSlot  = cW / gradeOrder.length;
        const barW2    = barSlot - 3;

        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...navy);
        doc.text('Grade Distribution', margin, ys + 4); ys += 8;
        doc.setTextColor(0, 0, 0);

        doc.setFillColor(248, 250, 252);
        doc.rect(margin, chartTop, cW, chartH2 + 8, 'F');
        doc.setDrawColor(220, 220, 220);
        doc.rect(margin, chartTop, cW, chartH2 + 8);

        gradeOrder.forEach((grade, i) => {
          const count = gradeCounts[grade];
          const bx = margin + i * barSlot + 1.5;
          const maxBarH = chartH2 - 4;
          const [r2, g2, b2] = gradeColors2[grade];
          if (count > 0) {
            const barH2 = Math.max(3, (count / maxCount) * maxBarH);
            const barY2 = chartTop + chartH2 - barH2;
            doc.setFillColor(r2, g2, b2);
            doc.rect(bx, barY2, barW2, barH2, 'F');
            doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(50, 50, 50);
            doc.text(String(count), bx + barW2 / 2, barY2 - 1, { align: 'center' });
          } else {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(5.5); doc.setTextColor(180, 180, 180);
            doc.text('N/A', bx + barW2 / 2, chartTop + chartH2 - 3, { align: 'center' });
          }
          doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(50, 50, 50);
          doc.text(grade, bx + barW2 / 2, chartTop + chartH2 + 6, { align: 'center' });
        });

        ys = chartTop + chartH2 + 14;

        const tAbet = res.abet[fypType];
        if (tAbet) {
          const abetRows = abetKeys.map(k => {
            const v = tAbet[k];
            if (!v) return null;
            if (v.notMeasured) return [`Outcome ${abetLbl[k]}`, 'N/M', 'Not measured for this year'];
            return [`Outcome ${abetLbl[k]}`, `${v.pct}%`, lvlLbl[v.level] || '—'];
          }).filter(Boolean);
          if (abetRows.length) {
            doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...navy);
            doc.text('ABET Outcomes', margin, ys + 4); ys += 8;
            doc.setTextColor(0, 0, 0);
            doc.autoTable({
              startY: ys, margin: { left: margin, right: margin }, theme: 'grid',
              headStyles: { fillColor: navy, textColor: 255, fontSize: 8.5, fontStyle: 'bold', cellPadding: 2.5, halign: 'center' },
              bodyStyles: { fontSize: 8.5, cellPadding: 2.5 },
              columnStyles: { 0: { fontStyle: 'bold', cellWidth: cW * 0.18 }, 1: { halign: 'center', cellWidth: cW * 0.18 }, 2: { cellWidth: cW * 0.64 } },
              head: [['Outcome', 'Achievement %', 'Level of Achievement']],
              body: abetRows,
            });
          }
        }

        for (const proj of typeProjects) {
          // ── Project overview page ─────────────────────────────────────────
          doc.addPage();
          let y = drawHdr(doc, `${fypType} — Assessment Report`);

          // Project banner (auto-expand for long titles)
          const titleLines = doc.splitTextToSize(proj.title, cW - 6);
          const titleTrunc  = titleLines.slice(0, 2);
          const bannerH     = titleTrunc.length > 1 ? 24 : 18;
          doc.setFillColor(235, 242, 255);
          doc.roundedRect(margin, y, cW, bannerH, 2, 2, 'F');
          doc.setFont('helvetica', 'bold'); doc.setFontSize(titleTrunc.length > 1 ? 9 : 11); doc.setTextColor(...navy);
          doc.text(titleTrunc, margin + 3, y + 6);
          doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(60, 60, 60);
          doc.text(`Type: ${proj.type}   ·   Program: ${proj.program}   ·   Supervisor(s): ${proj.supervisors.join(', ')}   ·   Generated: ${genDate}`, margin + 3, y + bannerH - 4);
          doc.setTextColor(0, 0, 0);
          y += bannerH + 3;

          // Student roster
          y = sectionLabel(doc, y, 'Students Enrolled in this Project');
          doc.autoTable({
            startY: y, margin: { left: margin, right: margin }, theme: 'grid',
            headStyles: { fillColor: navy, textColor: 255, fontSize: 8, fontStyle: 'bold', cellPadding: 2, halign: 'center' },
            bodyStyles: { fontSize: 8, cellPadding: 2 },
            columnStyles: { 0: { cellWidth: 10, halign: 'center' }, 1: { cellWidth: cW * 0.6 }, 2: { cellWidth: cW - 10 - cW * 0.6, halign: 'center' } },
            head: [['#', 'Student Name', 'Student ID']],
            body: proj.students.map((s, i) => [i + 1, s.studentName, s.studentId]),
          });

          // ── Per-student pages ─────────────────────────────────────────────
          for (const stu of proj.students) {
            doc.addPage();
            y = drawHdr(doc, `${fypType} — ${proj.title}`);
            const soloProj = proj.students.length === 1;

            // Student header
            doc.setFillColor(...blue);
            doc.rect(margin, y, cW, 8, 'F');
            doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(255, 255, 255);
            doc.text(`${stu.studentName}   (${stu.studentId})`, margin + 3, y + 5.5);
            doc.setTextColor(0, 0, 0);
            y += 11;

            // Teamwork individual criteria
            y = sectionLabel(doc, y, 'Teamwork — Individual Assessment');
            doc.autoTable({
              startY: y, margin: { left: margin, right: margin }, theme: 'grid',
              headStyles: { fillColor: navy, textColor: 255, fontSize: 7.5, fontStyle: 'bold', cellPadding: 1.8, halign: 'center' },
              bodyStyles: { fontSize: 7.5, cellPadding: 1.8 },
              footStyles: { fillColor: [230, 240, 255], textColor: [...navy], fontSize: 7.5, fontStyle: 'bold', cellPadding: 1.8 },
              columnStyles: { 0: { cellWidth: 7, halign: 'center' }, 1: { cellWidth: (cW - 7) * 0.62 }, 2: { cellWidth: (cW - 7) * 0.19, halign: 'center' }, 3: { cellWidth: (cW - 7) * 0.19, halign: 'center' } },
              head: [['#', 'Criterion', 'Grade', 'Max']],
              body: stu.twDetails.map(d => [d.num, d.criterion, d.grade, d.maxGrade]),
              foot: [
                soloProj
                  ? [{ content: 'Solo Project — Peer Evaluation: N/A (Supervisor weight 100%)', colSpan: 4, styles: { halign: 'center', fontStyle: 'italic', textColor: [100, 100, 100] } }]
                  : [{ content: 'Peer Evaluation Score', colSpan: 2, styles: { halign: 'right' } }, { content: `${stu.peerPct}%`, colSpan: 2, styles: { halign: 'center' } }],
                [{ content: 'Overall Teamwork Score', colSpan: 2, styles: { halign: 'right' } }, { content: `${stu.twScore}%`, colSpan: 2, styles: { halign: 'center' } }],
              ],
            });
            y = doc.lastAutoTable.finalY + 3;

            // Peer evaluation question breakdown
            if (stu.peerDetails && stu.peerDetails.length && !soloProj) {
              y = sectionLabel(doc, y, 'Peer Evaluation — Question Breakdown (Average of Peers)');
              doc.autoTable({
                startY: y, margin: { left: margin, right: margin }, theme: 'grid',
                headStyles: { fillColor: [80, 130, 180], textColor: 255, fontSize: 7.5, fontStyle: 'bold', cellPadding: 1.8, halign: 'center' },
                bodyStyles: { fontSize: 7.5, cellPadding: 1.8 },
                footStyles: { fillColor: [230, 240, 255], textColor: [...navy], fontSize: 7.5, fontStyle: 'bold', cellPadding: 1.8 },
                columnStyles: { 0: { cellWidth: 7, halign: 'center' }, 1: { cellWidth: cW - 42 }, 2: { cellWidth: 20, halign: 'center' }, 3: { cellWidth: 15, halign: 'center' } },
                head: [['#', 'Peer Evaluation Question', 'Avg Score', 'Max']],
                body: stu.peerDetails.map(d => [d.num, d.question, d.avgScore, d.maxGrade]),
                foot: [[{ content: 'Peer Evaluation Score', colSpan: 3, styles: { halign: 'right' } }, { content: `${stu.peerPct}%`, styles: { halign: 'center' } }]],
              });
              y = doc.lastAutoTable.finalY + 3;
            }

            // Examiner tables
            y = drawExamTable(doc, y, 'Examiner — Report Grading',       stu.repTable,  dkBlue, 'Report');
            y = drawExamTable(doc, y, 'Examiner — Presentation Grading', stu.presTable, dkBlue, 'Presentation');

            // Grade summary
            y = sectionLabel(doc, y, 'Grade Summary');
            doc.autoTable({
              startY: y, margin: { left: margin, right: margin }, theme: 'grid',
              headStyles: { fillColor: green, textColor: 255, fontSize: 7.5, fontStyle: 'bold', cellPadding: 2, halign: 'center' },
              bodyStyles: { fontSize: 9, fontStyle: 'bold', cellPadding: 2.5, halign: 'center' },
              columnStyles: { 0:{cellWidth:cW*0.18}, 1:{cellWidth:cW*0.18}, 2:{cellWidth:cW*0.18}, 3:{cellWidth:cW*0.15}, 4:{cellWidth:cW*0.15}, 5:{cellWidth:cW*0.16} },
              head: [[`Teamwork (${meta.weights?.tw ?? 35}%)`, `Report (${meta.weights?.report ?? 35}%)`, `Presentation (${meta.weights?.pres ?? 30}%)`, 'Weighted %', 'Final Grade', 'Letter Grade']],
              body: [[`${stu.summary.teamworkPct}%`, `${stu.summary.reportPct}%`, `${stu.summary.presPct}%`, `${stu.summary.finalGrade}%`, `${stu.summary.finalGrade + (stu.summary.boosted ? 1 : 0)}%${stu.summary.boosted ? ' (+1)' : ''}`, stu.summary.letterGrade]],
            });
          }
        }

        const pgLabel = program !== 'General' ? `_${program}` : '';
        doc.save(`FYP_Assessment${pgLabel}_${fypType}_${yr}${sem}.pdf`);
        Toast.show(`${program} — ${fypType} PDF downloaded.`);
      }
      }
    } catch (e) { Toast.show('PDF error: ' + (e.message || e), 'error'); console.error(e); }
    finally { Spinner.hide(); }
  },

  // ── Admin-only: FYP Statistics & Grade Distribution report ────────────
  async exportDistributionReport() {
    Spinner.show();
    try {
      const res = await gsrAuth('getCriteriaDistribution');
      if (!res.success) { Toast.show(res.message || 'Failed to load distribution data.', 'error'); return; }

      const logoUrl = 'https://usif-3jra.github.io/epme-study-plan/assets/logo_w.png';
      const loadImg = async url => {
        try {
          return await new Promise(resolve => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); resolve({ dataUrl: c.toDataURL('image/png'), w: img.width, h: img.height }); };
            img.onerror = () => resolve(null);
            img.src = url;
          });
        } catch { return null; }
      };
      const logoData = await loadImg(logoUrl);

      const { jsPDF } = window.jspdf;
      const W = 210, margin = 14, cW = W - 2 * margin, PAGE_H = 297, BOTTOM_MARGIN = 15;
      const navy = [30, 58, 95];
      const teal = [14, 116, 144];
      const meta = res.meta || {};
      const progList = res.programs || [];

      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

      let currentTitle = '';
      const drawHdr = (subtitle) => {
        currentTitle = subtitle;
        doc.setFillColor(...navy);
        doc.rect(0, 0, W, 27, 'F');
        let textX = W / 2, textMaxW = cW - 36;
        if (logoData) {
          const lw = 32, lh = lw * (logoData.h / logoData.w);
          doc.addImage(logoData.dataUrl, 'PNG', margin, (27 - lh) / 2, lw, lh);
          const logoRight = margin + lw + 4;
          textX = (logoRight + (W - margin)) / 2;
          textMaxW = (W - margin) - logoRight;
        }
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5);
        doc.text(subtitle, textX, 10, { align: 'center', maxWidth: textMaxW });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
        doc.text(`Beirut Arab University  ·  Faculty of Engineering  ·  ${meta.department || 'ECE'} Department`, W / 2, 17, { align: 'center' });
        doc.text(`Academic Year ${meta.year || ''}${meta.semester ? '  ·  Semester: ' + meta.semester : ''}`, W / 2, 22.5, { align: 'center' });
        doc.setTextColor(0, 0, 0);
        return 30;
      };

      const sectionLabel = (y, text) => {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(50, 50, 50);
        doc.text(text, margin, y + 3.5);
        doc.setTextColor(0, 0, 0);
        return y + 5;
      };

      const groupHeader = (y, text) => {
        doc.setFillColor(...navy);
        doc.rect(margin, y, cW, 6.5, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(255, 255, 255);
        doc.text(text, margin + 3, y + 4.5);
        doc.setTextColor(0, 0, 0);
        return y + 10;
      };

      const ensureSpace = (y, neededH) => {
        if (y + neededH > PAGE_H - BOTTOM_MARGIN) { doc.addPage(); return drawHdr(currentTitle); }
        return y;
      };

      // Shared autoTable base style
      const tblBase = {
        theme: 'grid',
        styles: { fontSize: 7.5, cellPadding: 2.2, overflow: 'linebreak' },
        headStyles: { fillColor: [30, 58, 95], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8, halign: 'center' },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        margin: { left: margin, right: margin },
      };
      const totalRowCB = lastIdx => ({
        willDrawCell: (d) => {
          if (d.section === 'body' && d.row.index === lastIdx) {
            d.cell.styles.fillColor = [30, 58, 95];
            d.cell.styles.textColor = [255, 255, 255];
            d.cell.styles.fontStyle = 'bold';
          }
        },
      });

      // ═══════════════════════════════════════════════════════════════
      // PAGE 1 — Semester Overview
      // ═══════════════════════════════════════════════════════════════
      let y = drawHdr('FYP Semester Statistics — Overview');

      doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(120, 120, 120);
      doc.text(`Generated on ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}`, margin, y + 1);
      doc.setTextColor(0, 0, 0);
      y += 7;

      // ── Grouped bar chart helper ──────────────────────────────────
      const orange = [209, 88, 12];
      const steelBlue = [37, 99, 235];
      const drawGroupedBar = (y2, note, groups, series, scaleMax, fmtVal) => {
        const cH = 46, aPadL = 14, pX2 = margin + aPadL, pW2 = cW - aPadL, pH2 = cH;
        const nG = Math.max(groups.length, 1), nS = series.length;
        const gW = pW2 / nG;
        const bW = Math.min(gW * 0.65 / nS, 9);
        const bGap = Math.min(0.8, bW * 0.08);
        const totalBW = nS * bW + (nS - 1) * bGap;

        y2 = sectionLabel(y2, note);
        const pY2 = y2 + 2;

        const steps = 5;
        doc.setLineWidth(0.1); doc.setDrawColor(225, 225, 225);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(5.8); doc.setTextColor(130, 130, 130);
        for (let si = 0; si <= steps; si++) {
          const sVal = (scaleMax / steps) * si;
          const gy2 = pY2 + pH2 - (sVal / scaleMax) * pH2;
          doc.line(pX2, gy2, pX2 + pW2, gy2);
          doc.text(fmtVal(sVal, true), pX2 - 2, gy2 + 1.1, { align: 'right' });
        }

        groups.forEach((grp, gi) => {
          const gCx = pX2 + gi * gW + gW / 2;
          const gLeft = gCx - totalBW / 2;
          series.forEach((s2, si2) => {
            const val = s2.data[gi] || 0;
            const bh = scaleMax > 0 ? (val / scaleMax) * pH2 : 0;
            const bx = gLeft + si2 * (bW + bGap);
            const by = pY2 + pH2 - bh;
            doc.setFillColor(...s2.color);
            if (bh > 0.3) doc.rect(bx, by, bW, bh, 'F');
            if (val > 0 || bh > 0.3) {
              doc.setFont('helvetica', 'bold'); doc.setFontSize(5.2); doc.setTextColor(...s2.color);
              doc.text(fmtVal(val), bx + bW / 2, Math.min(by - 0.8, pY2 + pH2 - 1), { align: 'center' });
            }
          });
          const lbl = grp.length > 10 ? grp.substring(0, 9) + '…' : grp;
          doc.setFont('helvetica', 'normal'); doc.setFontSize(5.5); doc.setTextColor(55, 55, 55);
          doc.text(lbl, gCx, pY2 + pH2 + 4, { align: 'center' });
        });

        doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.3);
        doc.line(pX2, pY2 + pH2, pX2 + pW2, pY2 + pH2);
        doc.setLineWidth(0.1); doc.setDrawColor(0, 0, 0);

        // legend
        const legY = pY2 + pH2 + 9;
        let legX = margin;
        series.forEach(s2 => {
          doc.setFillColor(...s2.color); doc.rect(legX, legY, 4, 3, 'F');
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(55, 55, 55);
          const lw = doc.getTextWidth(s2.label);
          doc.text(s2.label, legX + 5.5, legY + 2.5);
          legX += lw + 12;
        });
        doc.setTextColor(0, 0, 0);
        return legY + 7;
      };

      const niceMax = v => { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))); return Math.ceil(v / e) * e * (Math.ceil(v / e) >= v / e ? 1 : 1); };
      const roundUp5 = v => Math.max(1, Math.ceil(v / 5) * 5);
      const g = res.grandTotal || {};

      // ── Charts 1 & 2: Project & Student Overview ──────────────────
      y = groupHeader(y, 'Project & Student Overview by Program');

      const f1ProjData = progList.map(p => (res.programStats[p] || {}).fyp1Projects || 0);
      const f2ProjData = progList.map(p => (res.programStats[p] || {}).fyp2Projects || 0);
      const maxProj = roundUp5(Math.max(1, ...f1ProjData.map((v, i) => v + f2ProjData[i])));
      y = drawGroupedBar(y, 'Projects per Program', progList,
        [{ label: 'FYP1 Projects', color: navy, data: f1ProjData }, { label: 'FYP2 Projects', color: teal, data: f2ProjData }],
        maxProj, (v, ax) => ax ? (Number.isInteger(v) ? String(v) : v.toFixed(0)) : String(Math.round(v)));

      y = ensureSpace(y, 62);
      const f1StuData = progList.map(p => (res.programStats[p] || {}).fyp1Students || 0);
      const f2StuData = progList.map(p => (res.programStats[p] || {}).fyp2Students || 0);
      const maxStu = roundUp5(Math.max(1, ...f1StuData.map((v, i) => v + f2StuData[i])));
      y = drawGroupedBar(y, 'Students per Program', progList,
        [{ label: 'FYP1 Students', color: navy, data: f1StuData }, { label: 'FYP2 Students', color: teal, data: f2StuData }],
        maxStu, (v, ax) => ax ? (Number.isInteger(v) ? String(v) : v.toFixed(0)) : String(Math.round(v)));

      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...navy);
      doc.text(`Grand Total: ${g.totalProjects||0} projects  (${g.fyp1Projects||0} FYP1 + ${g.fyp2Projects||0} FYP2)   ·   ${g.totalStudents||0} students  (${g.fyp1Students||0} FYP1 + ${g.fyp2Students||0} FYP2)`, margin, y + 1);
      doc.setTextColor(0, 0, 0);
      y += 7;

      // ── Charts 3 & 4: Examiner & Student Statistics ───────────────
      y = ensureSpace(y, 70);
      y = groupHeader(y, 'Examiner & Student Statistics by Program');

      const insData     = progList.map(p => (res.programStats[p] || {}).insideCount    || 0);
      const outData     = progList.map(p => (res.programStats[p] || {}).outsideCount   || 0);
      const indData     = progList.map(p => (res.programStats[p] || {}).industryCount  || 0);
      const maxExCnt    = roundUp5(Math.max(1, ...progList.map((_, i) => insData[i] + outData[i] + indData[i])));
      y = drawGroupedBar(y, 'Number of Examiners per Program by Role', progList,
        [{ label: 'Inside University', color: navy, data: insData },
         { label: 'Outside/Program', color: teal, data: outData },
         { label: 'Industry', color: orange, data: indData }],
        maxExCnt, (v, ax) => ax ? (Number.isInteger(v) ? String(v) : v.toFixed(0)) : String(Math.round(v)));

      y = ensureSpace(y, 62);
      const avgStuData  = progList.map(p => (res.programStats[p] || {}).avgStudentsPerProject || 0);
      const avgInsData  = progList.map(p => (res.programStats[p] || {}).avgInsidePerGroup     || 0);
      const avgOutData  = progList.map(p => (res.programStats[p] || {}).avgOutsidePerGroup    || 0);
      const avgIndData  = progList.map(p => (res.programStats[p] || {}).avgIndustryPerGroup   || 0);
      const maxAvgVal   = Math.max(0.5, ...progList.map((_, i) => Math.max(avgStuData[i], avgInsData[i], avgOutData[i], avgIndData[i])));
      const niceAvgMax  = Math.ceil(maxAvgVal * 1.25 * 10) / 10;
      y = drawGroupedBar(y, 'Average per Project Group (students & examiners)', progList,
        [{ label: 'Avg Students', color: steelBlue, data: avgStuData },
         { label: 'Avg Inside',   color: navy,      data: avgInsData },
         { label: 'Avg Outside',  color: teal,      data: avgOutData },
         { label: 'Avg Industry', color: orange,    data: avgIndData }],
        niceAvgMax, (v, ax) => v === 0 ? '0' : v < 1 ? v.toFixed(2) : v.toFixed(1));

      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...navy);
      doc.text(`Grand Total: ${g.insideCount||0} inside + ${g.outsideCount||0} outside + ${g.industryCount||0} industry examiners   ·   Avg per group: ${g.avgStudentsPerProject||0} students, ${g.avgInsidePerGroup||0} inside, ${g.avgOutsidePerGroup||0} outside, ${g.avgIndustryPerGroup||0} industry`, margin, y + 1, { maxWidth: cW });
      doc.setTextColor(0, 0, 0);
      y += 9;

      // ── Table 3: Grading activity summary ─────────────────────────
      y = ensureSpace(y, 60);
      y = groupHeader(y, 'Grading Activity Summary — Criteria Graded per Role');
      const gc = res.gradingCounts || {};
      const actBodyRows = [
        ['Supervisor',                             'Teamwork — Individual Rubric',     gc.twCriteriaGraded   || 0],
        ['Student (Peer)',                          'Peer Evaluation Rubric',           gc.peerCriteriaGraded || 0],
        ['Inside University Examiner',              'Report Rubric',                    gc.insideReport       || 0],
        ['Inside University Examiner',              'Presentation Rubric',              gc.insidePres         || 0],
        ['Outside the Program/Univ. Examiner',      'Report Rubric',                    gc.outsideReport      || 0],
        ['Outside the Program/Univ. Examiner',      'Presentation Rubric',              gc.outsidePres        || 0],
        ['Industry Examiner',                       'Presentation Rubric',              gc.industryPres       || 0],
      ];
      const actGrandTotal = actBodyRows.reduce((s, r) => s + r[2], 0);
      const actBodyFinal = [...actBodyRows, ['TOTAL', '—', actGrandTotal]];
      doc.autoTable({
        startY: y,
        head: [['Grader Role', 'Rubric / Category', 'Criteria Graded']],
        body: actBodyFinal,
        ...tblBase,
        ...totalRowCB(actBodyFinal.length - 1),
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 62 }, 2: { halign: 'center', cellWidth: 28 } },
      });
      y = doc.lastAutoTable.finalY + 5;

      // ═══════════════════════════════════════════════════════════════
      // PAGE 2 — Average Grade by Program & FYP Type
      // ═══════════════════════════════════════════════════════════════
      doc.addPage();
      y = drawHdr('Average Grade by Program & FYP Type');

      // Stats table — avg ± std dev
      y = groupHeader(y, 'Average Grade & Standard Deviation per Program (all graded criteria scores, normalized to %)');
      const ov = res.avgOverall || {};
      const ovf1 = ov.FYP1 || { avg: 0, std: 0, n: 0 };
      const ovf2 = ov.FYP2 || { avg: 0, std: 0, n: 0 };
      const avgBody = [
        ...progList.map(p => {
          const d = res.avgByProgramType[p] || {};
          const f1 = d.FYP1 || { avg: 0, std: 0, n: 0 };
          const f2 = d.FYP2 || { avg: 0, std: 0, n: 0 };
          return [p,
            f1.n > 0 ? `${f1.avg}%` : '—', f1.n > 0 ? `±${f1.std}%` : '—', f1.n || 0,
            f2.n > 0 ? `${f2.avg}%` : '—', f2.n > 0 ? `±${f2.std}%` : '—', f2.n || 0];
        }),
        ['ALL PROGRAMS',
          ovf1.n > 0 ? `${ovf1.avg}%` : '—', ovf1.n > 0 ? `±${ovf1.std}%` : '—', ovf1.n || 0,
          ovf2.n > 0 ? `${ovf2.avg}%` : '—', ovf2.n > 0 ? `±${ovf2.std}%` : '—', ovf2.n || 0],
      ];
      doc.autoTable({
        startY: y,
        head: [['Program', 'FYP1 Avg Grade', 'FYP1 ± Std Dev', 'FYP1 (n)', 'FYP2 Avg Grade', 'FYP2 ± Std Dev', 'FYP2 (n)']],
        body: avgBody,
        ...tblBase,
        ...totalRowCB(avgBody.length - 1),
        columnStyles: { 0:{fontStyle:'bold',cellWidth:42}, 1:{halign:'center'}, 2:{halign:'center'}, 3:{halign:'center'}, 4:{halign:'center'}, 5:{halign:'center'}, 6:{halign:'center'} },
      });
      y = doc.lastAutoTable.finalY + 8;

      // Grouped bar chart — FYP1 vs FYP2 per program
      const chartH = 58, axisPadL = 12, legendH = 10;
      y = ensureSpace(y, chartH + legendH + 14);
      y = sectionLabel(y, 'Average Grade Comparison — FYP1 (navy) vs FYP2 (teal) per Program');

      const plotX = margin + axisPadL, plotW = cW - axisPadL, plotY = y + 2, plotH = chartH;
      const nGroups = Math.max(progList.length, 1);
      const groupW  = plotW / nGroups;
      const barW    = Math.min(groupW * 0.3, 9);

      doc.setLineWidth(0.1); doc.setDrawColor(225, 225, 225);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(130, 130, 130);
      [0, 25, 50, 75, 100].forEach(mark => {
        const gy = plotY + plotH - (mark / 100) * plotH;
        doc.line(plotX, gy, plotX + plotW, gy);
        doc.text(`${mark}%`, plotX - 2, gy + 1.2, { align: 'right' });
      });

      progList.forEach((prog, gi) => {
        const d  = res.avgByProgramType[prog] || {};
        const f1 = d.FYP1 || { avg: 0, std: 0, n: 0 };
        const f2 = d.FYP2 || { avg: 0, std: 0, n: 0 };
        const gx = plotX + gi * groupW + groupW / 2;
        const gap = 1.5;

        // FYP1 bar (navy, left)
        const b1h = (f1.avg / 100) * plotH;
        const b1x = gx - barW - gap / 2;
        const b1y = plotY + plotH - b1h;
        doc.setFillColor(...navy);
        if (f1.n > 0 && b1h > 0.3) doc.rect(b1x, b1y, barW, b1h, 'F');
        if (f1.n > 0) {
          doc.setFont('helvetica', 'bold'); doc.setFontSize(5.5); doc.setTextColor(...navy);
          doc.text(`${f1.avg}%`, b1x + barW / 2, b1y - 3.5, { align: 'center' });
          doc.setFont('helvetica', 'normal'); doc.setFontSize(5); doc.setTextColor(100, 100, 100);
          doc.text(`±${f1.std}%`, b1x + barW / 2, b1y - 1.2, { align: 'center' });
        }

        // FYP2 bar (teal, right)
        const b2h = (f2.avg / 100) * plotH;
        const b2x = gx + gap / 2;
        const b2y = plotY + plotH - b2h;
        doc.setFillColor(...teal);
        if (f2.n > 0 && b2h > 0.3) doc.rect(b2x, b2y, barW, b2h, 'F');
        if (f2.n > 0) {
          doc.setFont('helvetica', 'bold'); doc.setFontSize(5.5); doc.setTextColor(...teal);
          doc.text(`${f2.avg}%`, b2x + barW / 2, b2y - 3.5, { align: 'center' });
          doc.setFont('helvetica', 'normal'); doc.setFontSize(5); doc.setTextColor(100, 100, 100);
          doc.text(`±${f2.std}%`, b2x + barW / 2, b2y - 1.2, { align: 'center' });
        }

        // Program label (truncated)
        const lbl = prog.length > 9 ? prog.substring(0, 8) + '…' : prog;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(5.5); doc.setTextColor(60, 60, 60);
        doc.text(lbl, gx, plotY + plotH + 4, { align: 'center' });
      });

      doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.3);
      doc.line(plotX, plotY + plotH, plotX + plotW, plotY + plotH);
      doc.setLineWidth(0.1); doc.setDrawColor(0, 0, 0);
      y = plotY + plotH + 9;

      // Legend
      doc.setFillColor(...navy); doc.rect(margin, y, 5, 3.5, 'F');
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(60, 60, 60);
      doc.text('FYP1', margin + 7, y + 3);
      doc.setFillColor(...teal); doc.rect(margin + 24, y, 5, 3.5, 'F');
      doc.text('FYP2', margin + 31, y + 3);
      doc.setTextColor(0, 0, 0);
      y += legendH;

      // ═══════════════════════════════════════════════════════════════
      // PAGE 3+ — Grade Distribution Histograms (existing)
      // ═══════════════════════════════════════════════════════════════
      doc.addPage();
      y = drawHdr('Grade Distribution — Criteria Statistics Report');
      const buckets = res.buckets;

      doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(120, 120, 120);
      doc.text('Each bar shows the percentage of all graded criteria (Teamwork, Peer Evaluation, Report, Presentation) whose score fell within that 5-point range. Criteria scoring below 45% are excluded from the chart but still counted in the total (n).', margin, y, { maxWidth: cW });
      doc.setTextColor(0, 0, 0);
      y += 9;

      const drawHistogram = (y, title, labels, values, total) => {
        y = sectionLabel(y, `${title}  (n = ${total} graded ${total === 1 ? 'criterion' : 'criteria'})`);
        const cH = 52, aPadL = 12, pX = margin + aPadL, pW = cW - aPadL, pY = y + 2, pH = cH;
        doc.setLineWidth(0.1); doc.setDrawColor(225, 225, 225);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(130, 130, 130);
        [0, 25, 50, 75, 100].forEach(mark => {
          const gy = pY + pH - (mark / 100) * pH;
          doc.line(pX, gy, pX + pW, gy);
          doc.text(`${mark}%`, pX - 2, gy + 1.2, { align: 'right' });
        });
        const n = labels.length, slot = pW / n, bW = slot * 0.62;
        labels.forEach((lab, i) => {
          const val = values[i] || 0;
          const bH = (val / 100) * pH;
          const bx = pX + i * slot + (slot - bW) / 2;
          const by = pY + pH - bH;
          doc.setFillColor(...navy);
          if (bH > 0.3) doc.rect(bx, by, bW, bH, 'F');
          if (val > 0) { doc.setFont('helvetica', 'bold'); doc.setFontSize(6); doc.setTextColor(60, 60, 60); doc.text(`${val}%`, bx + bW / 2, by - 1.2, { align: 'center' }); }
          doc.setFont('helvetica', 'normal'); doc.setFontSize(6.3); doc.setTextColor(70, 70, 70);
          doc.text(lab, bx + bW / 2, pY + pH + 5, { align: 'center' });
        });
        doc.setDrawColor(150, 150, 150);
        doc.line(pX, pY + pH, pX + pW, pY + pH);
        doc.setTextColor(0, 0, 0); doc.setDrawColor(0, 0, 0);
        return pY + pH + 13;
      };

      // Overall
      y = ensureSpace(y, 70);
      y = groupHeader(y, 'Overall — All Programs & All FYP Types Combined');
      y = drawHistogram(y, 'Overall Distribution', buckets, res.overall.pct, res.overall.total);

      // By FYP Type
      if (res.byType && Object.keys(res.byType).length) {
        y = ensureSpace(y, 16);
        y = groupHeader(y, 'Distribution by FYP Type');
        for (const t of ['FYP1', 'FYP2']) {
          if (!res.byType[t]) continue;
          y = ensureSpace(y, 70);
          y = drawHistogram(y, t, buckets, res.byType[t].pct, res.byType[t].total);
        }
      }

      // By Category
      if (res.byCategory && Object.keys(res.byCategory).length) {
        y = ensureSpace(y, 16);
        y = groupHeader(y, 'Distribution by Grading Category');
        const catLabels = { TW: 'Teamwork — Supervisor Grading', Peer: 'Peer Evaluation', Report: 'Examiner — Report Grading', Presentation: 'Examiner — Presentation Grading' };
        for (const cat of ['TW', 'Peer', 'Report', 'Presentation']) {
          if (!res.byCategory[cat]) continue;
          y = ensureSpace(y, 70);
          y = drawHistogram(y, catLabels[cat] || cat, buckets, res.byCategory[cat].pct, res.byCategory[cat].total);
        }
      }

      // By Program
      const programs2 = Object.keys(res.byProgram || {});
      if (programs2.length) {
        y = ensureSpace(y, 16);
        y = groupHeader(y, 'Distribution by Program');
        for (const p of programs2) {
          y = ensureSpace(y, 70);
          y = drawHistogram(y, p, buckets, res.byProgram[p].pct, res.byProgram[p].total);
        }
      }

      doc.save(`FYP_Statistics_Report_${(meta.year || '').replace('–', '-')}.pdf`);
      Toast.show('FYP Statistics Report downloaded.');
    } catch (e) { Toast.show('Report error: ' + (e.message || e), 'error'); console.error(e); }
    finally { Spinner.hide(); }
  },
};

// ── Feedback Inbox (admin) ────────────────────────────────────────────

const FeedbackInbox = {
  async load() {
    const list = document.getElementById('feedback-inbox-list');
    list.innerHTML = '<div class="text-center text-muted py-5"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div>';
    try {
      const res = await gsrAuth('getFeedbacks');
      if (!res.success) { list.innerHTML = `<div class="text-danger p-4">${res.message}</div>`; return; }
      const badge = document.getElementById('feedback-unread-badge');
      if (badge) badge.classList.add('d-none');
      if (!res.feedbacks.length) {
        list.innerHTML = '<div class="text-center text-muted py-5"><i class="fas fa-inbox fa-2x mb-3 d-block opacity-25"></i>No feedback received yet.</div>';
        return;
      }
      list.innerHTML = res.feedbacks.map(f => `
        <div class="border-bottom p-3 ${f.isRead ? '' : 'bg-light'}">
          <div class="d-flex justify-content-between align-items-start mb-1">
            <div>
              <span class="fw-semibold">${escHtml(f.name)}</span>
              <span class="text-muted small ms-2">${escHtml(f.supervisorId)}</span>
              ${f.program ? `<span class="badge bg-secondary ms-1" style="font-size:10px;">${escHtml(f.program)}</span>` : ''}
            </div>
            <span class="text-muted small text-nowrap ms-3">${new Date(f.submittedAt).toLocaleString('en-GB')}</span>
          </div>
          <p class="mb-0 small" style="white-space:pre-wrap;color:#374151;">${escHtml(f.message)}</p>
        </div>`).join('');
    } catch (e) { list.innerHTML = `<div class="text-danger p-4">Error: ${e.message}</div>`; }
  },

  async checkUnread() {
    try {
      const res = await gsrAuth('getUnreadFeedbackCount');
      const badge = document.getElementById('feedback-unread-badge');
      if (!badge) return;
      if (res.count > 0) { badge.textContent = res.count; badge.classList.remove('d-none'); }
      else badge.classList.add('d-none');
    } catch { /* silent */ }
  },
};

// ── Feedback ──────────────────────────────────────────────────────────

const Feedback = {
  async send() {
    const msg = (document.getElementById('feedback-message').value || '').trim();
    const errEl = document.getElementById('feedback-err');
    const okEl  = document.getElementById('feedback-ok');
    errEl.classList.add('d-none');
    okEl.classList.add('d-none');
    if (!msg) { errEl.textContent = 'Please enter a message before sending.'; errEl.classList.remove('d-none'); return; }

    const btn = document.getElementById('btn-send-feedback');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm" style="width:1rem;height:1rem;border-width:.15em;vertical-align:-.125em;"></span>';
    try {
      const res = await gsrAuth('submitFeedback', msg);
      if (!res.success) throw new Error(res.message);
      okEl.classList.remove('d-none');
      document.getElementById('feedback-message').value = '';
      btn.innerHTML = '<i class="fas fa-check me-1"></i>Sent!';
      setTimeout(() => { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane me-1"></i>Send Feedback'; }, 2500);
    } catch (e) {
      errEl.textContent = 'Error: ' + (e.message || e);
      errEl.classList.remove('d-none');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-paper-plane me-1"></i>Send Feedback';
    }
  },
};

// ── Admin: Supervisor Credential Management ───────────────────────────

const Admin = {
  _supervisors: [],

  async loadUsers() {
    if (!Auth.supervisor || !Auth.supervisor.isAdmin) return;
    const tbody = document.getElementById('manageUsersTbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>';
    try {
      const res = await gsrAuth('getAllSupervisorsForAdmin');
      if (!res.success) throw new Error(res.message);
      this._supervisors = res.supervisors;
      tbody.innerHTML = res.supervisors.map(s => `
        <tr>
          <td><code>${s.id}</code></td>
          <td>${s.name}</td>
          <td class="small text-muted">${s.program}</td>
          <td>
            <input type="text" class="form-control form-control-sm cred-pwd"
                   data-id="${s.id}" data-name="${s.name}" data-email="${s.email}"
                   placeholder="Leave blank to keep current"/>
          </td>
          <td class="text-center">
            <input type="checkbox" class="form-check-input cred-email" data-id="${s.id}"
                   title="Send credentials email to ${s.email || 'no email'}"/>
          </td>
        </tr>`).join('');
    } catch(e) { tbody.innerHTML = `<tr><td colspan="5" class="text-danger small py-2">${e.message}</td></tr>`; }
  },

  async saveCredentials() {
    const targets = [];
    let hasWarning = false;
    document.querySelectorAll('#manageUsersTbody tr').forEach(row => {
      const pwdEl   = row.querySelector('.cred-pwd');
      const emailEl = row.querySelector('.cred-email');
      if (!pwdEl) return;
      const id        = pwdEl.dataset.id;
      const password  = pwdEl.value.trim();
      const sendEmail = emailEl ? emailEl.checked : false;
      if (!password && !sendEmail) return;
      if (!password) {
        Toast.show(`Enter a password for ${pwdEl.dataset.name} before sending email.`, 'warning');
        hasWarning = true;
        return;
      }
      const sup = this._supervisors.find(s => s.id === id);
      const email = sup ? (sup.email || '') : '';
      if (sendEmail && !email) {
        Toast.show(`No email on file for ${pwdEl.dataset.name} — password saved but email cannot be sent.`, 'warning');
        hasWarning = true;
      }
      targets.push({ id, password, name: pwdEl.dataset.name, email, sendEmail });
    });
    if (!targets.length) { Toast.show('No changes to save.', 'warning'); return; }
    Spinner.show();
    try {
      const res = await gsrAuth('setAndEmailCredentials', targets);
      if (!res.success) throw new Error(res.message);
      const sent   = res.sent   || [];
      const failed = res.failed || [];
      const emailRequested = targets.filter(t => t.sendEmail).length;
      let msg = `Passwords updated for ${targets.length} supervisor(s).`;
      if (emailRequested > 0) {
        if (sent.length > 0)   msg += ` ${sent.length} email(s) sent.`;
        if (failed.length > 0) msg += ` ${failed.length} email(s) failed.`;
      }
      Toast.show(msg, failed.length > 0 ? 'warning' : 'success');
      bootstrap.Modal.getInstance(document.getElementById('modalManageUsers')).hide();
    } catch(e) { Toast.show(e.message || e, 'error'); }
    finally { Spinner.hide(); }
  },
};

// ── Grade Publishing Settings (Admin) ─────────────────────────────────

const Publish = {
  _current: [], // cached settings

  async load() {
    const tbody  = document.getElementById('publishTbody');
    const status = document.getElementById('publish-status');
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-4"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>';
    if (status) status.textContent = '';
    try {
      const res = await gsrAuth('getProgramPublishSettings');
      if (!res.success) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="text-danger text-center py-3">${escHtml(res.message || 'Error')}</td></tr>`;
        return;
      }
      this._current = res.settings || [];
      if (!this._current.length) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-3">No programs configured.</td></tr>';
        return;
      }
      if (tbody) tbody.innerHTML = this._current.map(s => {
        const p = escHtml(s.programName);
        return `<tr>
          <td class="small fw-medium">${p}</td>
          <td class="text-center">
            <div class="form-check form-switch d-flex align-items-center justify-content-center gap-2 mb-0">
              <input class="form-check-input" type="checkbox" role="switch" id="pub-fyp1-${p}" ${s.unlockedFyp1 ? 'checked' : ''}
                onchange="Publish.toggle('${p}', 'fyp1', this.checked)">
              <label class="form-check-label small ${s.unlockedFyp1 ? 'text-success fw-semibold' : 'text-muted'}" for="pub-fyp1-${p}">
                ${s.unlockedFyp1 ? 'Unlocked' : 'Locked'}
              </label>
            </div>
          </td>
          <td class="text-center">
            <div class="form-check form-switch d-flex align-items-center justify-content-center gap-2 mb-0">
              <input class="form-check-input" type="checkbox" role="switch" id="pub-fyp2-${p}" ${s.unlockedFyp2 ? 'checked' : ''}
                onchange="Publish.toggle('${p}', 'fyp2', this.checked)">
              <label class="form-check-label small ${s.unlockedFyp2 ? 'text-success fw-semibold' : 'text-muted'}" for="pub-fyp2-${p}">
                ${s.unlockedFyp2 ? 'Unlocked' : 'Locked'}
              </label>
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="text-danger text-center py-3">${escHtml(e.message || String(e))}</td></tr>`;
    }
  },

  async toggle(programName, type, checked) {
    const status = document.getElementById('publish-status');
    if (status) { status.className = 'small text-muted mt-2'; status.textContent = 'Saving…'; }
    try {
      // Read both current values from DOM so we always send complete state
      const el1 = document.getElementById(`pub-fyp1-${programName}`);
      const el2 = document.getElementById(`pub-fyp2-${programName}`);
      const fyp1 = type === 'fyp1' ? checked : (el1 ? el1.checked : false);
      const fyp2 = type === 'fyp2' ? checked : (el2 ? el2.checked : false);
      const res = await gsrAuth('setProgramPublish', programName, fyp1, fyp2);
      if (!res.success) throw new Error(res.message);
      if (status) { status.className = 'small text-success mt-2'; status.textContent = `✓ ${programName} updated.`; }
      setTimeout(() => { if (status) status.textContent = ''; }, 3000);
      await this.load(); // refresh labels
    } catch (e) {
      if (status) { status.className = 'small text-danger mt-2'; status.textContent = `Error: ${e.message || e}`; }
    }
  },
};

// ── Boot ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  ['login-id', 'login-pwd'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') Auth.login();
    });
  });
});
