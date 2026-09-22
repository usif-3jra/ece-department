// FYP Management System — Render/Express backend
// Stack: Neon PostgreSQL + Mailtrap Email Sending API

const { neon } = require('@neondatabase/serverless');
const crypto    = require('crypto');

const SENDER_EMAIL      = process.env.SENDER_EMAIL      || '';
const MAILTRAP_API_KEY  = process.env.MAILTRAP_API_KEY  || '';
const APP_URL           = (process.env.APP_URL || 'https://your-app.onrender.com').replace(/\/$/, '');
const PWD_SALT          = process.env.PWD_SALT || 'bau-fyp-salt-2025';

const ADMIN_ID          = 'A20160170';
const SESSION_TTL       = 8 * 60 * 60 * 1000;
const MAIL_MAX_RECIPIENTS = 200;   // guard against a runaway paste in the mailer
const MAX_TRIES         = 5;
const LOCKOUT_MS        = 15 * 60 * 1000;
const TOKEN_EXPIRY_DAYS = 30;
const DEFAULT_PWD       = 'fyp2025';

// ── Outlier detection (Modified Z-score, Iglewicz & Hoaglin 1993) ────────
// Requires ≥ 3 scores. Returns { clean: number[], outlierIndices: number[] }.
// If MAD ≈ 0 (all scores equal), flags any score deviating ≥ 20 points from median.
function detectOutliers(scores) {
  const n = scores.length;
  if (n < 3) return { clean: scores, outlierIndices: [] };

  const sorted = [...scores].sort((a, b) => a - b);
  const mid    = Math.floor(n / 2);
  const median = n % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const absDevs    = scores.map(s => Math.abs(s - median));
  const sortedDevs = [...absDevs].sort((a, b) => a - b);
  const mad        = n % 2 !== 0 ? sortedDevs[mid] : (sortedDevs[mid - 1] + sortedDevs[mid]) / 2;

  let outlierIndices;
  if (mad < 0.001) {
    // All values clustered — flag any deviating ≥ 20 points from median
    outlierIndices = scores.reduce((a, s, i) => { if (Math.abs(s - median) >= 20) a.push(i); return a; }, []);
  } else {
    // Modified Z-score threshold 3.5 (standard for academic small-N datasets)
    outlierIndices = scores.reduce((a, s, i) => { if (Math.abs(0.6745 * (s - median) / mad) > 3.5) a.push(i); return a; }, []);
  }

  // Never remove all grades
  if (outlierIndices.length >= n) return { clean: scores, outlierIndices: [] };
  return { clean: scores.filter((_, i) => !outlierIndices.includes(i)), outlierIndices };
}

// Groups grades by (criterion, student_id), detects per-group outliers,
// returns filtered grades and a log of what was removed.
function filterOutlierGrades(grades) {
  const groups = {};
  grades.forEach((g, i) => {
    const key = `${g.criterion}::${g.student_id || 'GROUP'}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ ...g, _idx: i });
  });

  const outlierOrigIndices = new Set();
  const outlierLog = [];

  Object.entries(groups).forEach(([key, group]) => {
    if (group.length < 3) return; // need ≥ 3 examiners per criterion
    const scores = group.map(g => parseFloat(g.score || 0));
    const { outlierIndices } = detectOutliers(scores);
    if (!outlierIndices.length) return;
    const [criterion, studentId] = key.split('::');
    outlierIndices.forEach(i => {
      outlierOrigIndices.add(group[i]._idx);
      outlierLog.push({ criterion, studentId, score: scores[i], assignmentId: group[i].assignment_id });
    });
  });

  return {
    filteredGrades: grades.filter((_, i) => !outlierOrigIndices.has(i)),
    outlierLog,
  };
}

function buildExaminerEmail({ name, projectTitle, supervisorName, examinerType, projectType, reportLink, gradingLink }) {
  const isIndustry = examinerType === 'Industry';
  const ghost = 'display:inline-block;background:#fff;color:#0a1f44;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;border:2px solid #0a1f44;';

  const roleNote = isIndustry
    ? `<div style="background:#fff8e1;border-left:4px solid #f59e0b;border-radius:6px;padding:14px 18px;margin:0 0 20px;font-size:14px;color:#78350f;">
         <strong>Note:</strong> You are assigned to grade the <strong>Presentation</strong> only. No report grading is required from you.
       </div>`
    : (reportLink
        ? `<p style="margin:0 0 10px;font-size:14px;color:#374151;">The project report is available for your review:</p>
           <table cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td>
             <a href="${reportLink}" style="${ghost}">Access Project Report</a>
           </td></tr></table>`
        : '');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;"><tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
  <tr><td align="center" style="background:#ffffff;padding:28px 40px 16px;"><img src="https://usif-3jra.github.io/epme-study-plan/assets/logo_ECE.png" alt="BAU ECE" width="130" style="display:block;max-width:130px;height:auto;"/></td></tr>
  <tr><td style="background:#0a1f44;padding:24px 40px;text-align:center;"><div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:.02em;margin-bottom:6px;">FYP Management &amp; Grading System</div><div style="color:#94a3b8;font-size:13px;">Beirut Arab University — Faculty of Engineering — ECE Department</div></td></tr>
  <tr><td style="padding:32px 40px;color:#2d2d2d;font-size:15px;line-height:1.7;">
    <p style="margin:0 0 16px;">Dear ${name || 'Examiner'},</p>
    <p style="margin:0 0 20px;">You have been assigned as an examiner for a Final Year Project at Beirut Arab University. Please review your assignment details below:</p>
    <div style="background:#f0f4ff;border-left:4px solid #0a1f44;border-radius:6px;padding:18px 24px;margin:0 0 20px;">
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        <tr><td style="font-size:13px;color:#6b7280;font-weight:600;padding:5px 0;width:140px;">Project Title</td><td style="font-size:14px;font-weight:700;color:#0a1f44;padding:5px 0;">${projectTitle}</td></tr>
        <tr><td style="font-size:13px;color:#6b7280;font-weight:600;padding:5px 0;border-top:1px solid #dde3f3;">Supervisor</td><td style="font-size:14px;font-weight:700;color:#0a1f44;padding:5px 0;border-top:1px solid #dde3f3;">${supervisorName || '—'}</td></tr>
        <tr><td style="font-size:13px;color:#6b7280;font-weight:600;padding:5px 0;border-top:1px solid #dde3f3;">Examiner Role</td><td style="font-size:14px;font-weight:700;color:#0a1f44;padding:5px 0;border-top:1px solid #dde3f3;">${examinerType}</td></tr>
        <tr><td style="font-size:13px;color:#6b7280;font-weight:600;padding:5px 0;border-top:1px solid #dde3f3;">Project Type</td><td style="font-size:14px;font-weight:700;color:#0a1f44;padding:5px 0;border-top:1px solid #dde3f3;">${projectType || '—'}</td></tr>
      </table>
    </div>
    ${roleNote}
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">Your grading portal has been prepared. Please use the button below to access it:</p>
    <p style="margin:0 0 16px;font-size:12px;color:#6b7280;">This link is unique to you — do not share it with anyone.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 12px;"><tr><td><a href="${gradingLink}" style="${ghost}">Open Grading Portal</a></td></tr></table>
    <p style="margin:0 0 12px;font-size:13px;color:#6b7280;">To access the FYP assessment rubrics, please use the button below:</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;"><tr><td><a href="https://mirror-logic.github.io/fyp-grading/FYP%20Grading%20and%20Rubrics.pdf" style="${ghost}">FYP 1 &amp; 2 Rubrics</a></td></tr></table>
    <p style="margin:0 0 8px;font-size:14px;">Should you encounter any issues or have suggestions for improving the system, you are welcome to submit your feedback through the dashboard after logging in.</p>
    <p style="margin:0 0 4px;">Best regards,</p>
    <p style="margin:0 0 2px;font-weight:600;">ECE Department Administration</p>
    <p style="margin:0;color:#6b7280;font-size:13px;">Faculty of Engineering — Beirut Arab University</p>
  </td></tr>
  <tr><td style="border-top:1px solid #e5e7eb;padding:16px 40px;text-align:center;color:#9ca3af;font-size:11px;background:#f9fafb;">
    &copy; 2026 Beirut Arab University — Faculty of Engineering — ECE Department<br/>
    This is an automated message. Please do not reply directly to this email.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://send.api.mailtrap.io/api/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MAILTRAP_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: { email: SENDER_EMAIL, name: 'FYP System — BAU — ECE' },
      to: [{ email: String(to) }],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => String(res.status));
    throw new Error(`Email failed (${res.status}): ${err}`);
  }
}

function hashPwd(plain) {
  return crypto.createHash('sha256').update(plain + PWD_SALT).digest('hex');
}

function uid(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function genToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

function mapProject(r) {
  return {
    ProjectID:            r.project_id,
    Title:                r.title,
    Type:                 r.type,
    Semester:             r.semester,
    Year:                 r.year,
    EndDate:              r.end_date || '',
    ProgramType:          r.program_type,
    Supervisors:          r.supervisors || '',
    Students:             r.students || '',
    DisableNotifications: r.disable_notifications ? 'TRUE' : 'FALSE',
    CreatedAt:            r.created_at || '',
  };
}
function mapStudent(r)    { return { StudentID: r.student_id, StudentName: r.student_name, Email: r.email || '', ProjectID: r.project_id }; }
function mapSupervisor(r) { return { SupervisorID: r.supervisor_id, Name: r.name, Program: r.program, Email: r.email || '' }; }
function mapPeerConfig(r) { return { QuestionNo: r.question_no, QuestionText: r.question_text, MaxGrade: r.max_grade, Weight: r.weight, AbetOutcome: r.abet_outcome || '' }; }
function mapExaminer(r) {
  return {
    AssignmentID: r.assignment_id, ProjectID: r.project_id,
    ExaminerName: r.examiner_name, ExaminerEmail: r.examiner_email,
    ExaminerType: r.examiner_type, Token: r.token, Status: r.status,
    AssignedAt: r.assigned_at, ReportLink: r.report_link || '',
    DraftGrades: r.draft_grades || '',
  };
}
function mapExConfig(r) {
  return {
    ProjectType: r.project_type, Category: r.category, CriterionName: r.criterion_name,
    MaxGrade: r.max_grade, Weight: r.weight, GradingScope: r.grading_scope,
    ABETOutcome: r.abet_outcome || '',
  };
}

// ── Grade boost helpers ───────────────────────────────────────────────────
const ALL_BOUNDARIES  = [54, 59, 64, 69, 72, 75, 79, 82, 85, 89, 94];
const DEFAULT_BOOSTED = [54, 59, 64, 69, 72, 75, 79, 82, 85];

async function getActiveBorders(sql) {
  try {
    await sql`CREATE TABLE IF NOT EXISTS grade_boost_config (
      boundary INT PRIMARY KEY,
      boosted  BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    const count = await sql`SELECT COUNT(*) AS c FROM grade_boost_config`;
    if (!count[0] || Number(count[0].c) === 0) {
      for (const b of ALL_BOUNDARIES) {
        await sql`INSERT INTO grade_boost_config (boundary, boosted)
                  VALUES (${b}, ${DEFAULT_BOOSTED.includes(b)})
                  ON CONFLICT DO NOTHING`;
      }
    }
    const rows = await sql`SELECT boundary FROM grade_boost_config WHERE boosted = TRUE ORDER BY boundary`;
    return rows.map(r => Number(r.boundary));
  } catch { return DEFAULT_BOOSTED; }
}

// ── Meeting Organizer table setup ─────────────────────────────────────────
let _meetingTablesReady  = false;
let _pubSettingsReady    = false;
let _feedbackTableReady  = false;
let _distAccessReady     = false;
let _exNamesAccessReady  = false;
let _delegateTablesReady = false;
async function ensureMeetingTables(sql) {
  if (_meetingTablesReady) return;
  await sql`CREATE TABLE IF NOT EXISTS meeting_sessions (
    id               SERIAL PRIMARY KEY,
    session_number   INT NOT NULL,
    academic_year    VARCHAR(9) NOT NULL,
    meeting_date     DATE,
    meeting_time     TIME,
    created_by       VARCHAR(50),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS meeting_entries (
    id            SERIAL PRIMARY KEY,
    session_id    INT NOT NULL,
    supervisor_id VARCHAR(50) NOT NULL,
    section       CHAR(1) NOT NULL,
    entry_type    VARCHAR(50) NOT NULL,
    entry_data    JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  _meetingTablesReady = true;
}
async function ensureDelegateTables(sql) {
  if (_delegateTablesReady) return;
  await sql`CREATE TABLE IF NOT EXISTS meeting_delegates (
    supervisor_id VARCHAR(50) PRIMARY KEY,
    granted_by    VARCHAR(50) NOT NULL,
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  _delegateTablesReady = true;
}
// ── FYP Projects Organizer table setup ────────────────────────────────────
// Campuses a program can run on. Supervisors carry one; ideas and groups are
// scoped per (program, campus) because the same program exists on both sites.
const CAMPUSES = ['Debbieh', 'Tripoli'];

let _campusColumnReady   = false;
let _organizerTablesReady = false;

// Adds supervisors.campus. Additive and invisible to v3, which reads the table
// with SELECT * — an extra column changes nothing for it.
async function ensureCampusColumn(sql) {
  if (_campusColumnReady) return;
  await sql`ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS campus TEXT NOT NULL DEFAULT ''`;
  _campusColumnReady = true;
}

async function ensureOrganizerTables(sql) {
  if (_organizerTablesReady) return;
  await ensureCampusColumn(sql);

  await sql`CREATE TABLE IF NOT EXISTS org_cycles (
    id                SERIAL PRIMARY KEY,
    academic_year     VARCHAR(9) NOT NULL,
    semester          TEXT NOT NULL DEFAULT '',
    program           TEXT NOT NULL,
    campus            TEXT NOT NULL,
    phase             TEXT NOT NULL DEFAULT 'IDEAS_OPEN',
    ideas_deadline    TIMESTAMPTZ,
    ranking_deadline  TIMESTAMPTZ,
    deadline_policy   TEXT NOT NULL DEFAULT 'open',
    deadline_delegate TEXT NOT NULL DEFAULT '',
    min_group_size    INT  NOT NULL DEFAULT 2,
    max_group_size    INT  NOT NULL DEFAULT 5,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS org_cycles_key_idx
    ON org_cycles (academic_year, semester, program, campus)`;

  // expected = counted in the "everyone has responded" gate. A coordinator can
  // clear it for someone on sabbatical so one dormant account cannot block the
  // whole program.
  await sql`CREATE TABLE IF NOT EXISTS org_participants (
    cycle_id      INT  NOT NULL,
    supervisor_id TEXT NOT NULL,
    max_groups    INT  NOT NULL DEFAULT 1,
    status        TEXT NOT NULL DEFAULT 'not_started',
    expected      BOOLEAN NOT NULL DEFAULT TRUE,
    submitted_at  TIMESTAMPTZ,
    PRIMARY KEY (cycle_id, supervisor_id)
  )`;
  await sql`ALTER TABLE org_participants ADD COLUMN IF NOT EXISTS expected BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE org_participants ALTER COLUMN max_groups SET DEFAULT 1`;

  await sql`CREATE TABLE IF NOT EXISTS org_ideas (
    id               SERIAL PRIMARY KEY,
    cycle_id         INT  NOT NULL,
    supervisor_id    TEXT NOT NULL,
    title            TEXT NOT NULL,
    field            TEXT NOT NULL DEFAULT '',
    description      TEXT NOT NULL DEFAULT '',
    prerequisites    TEXT NOT NULL DEFAULT '',
    min_students     INT  NOT NULL DEFAULT 2,
    max_students     INT  NOT NULL DEFAULT 4,
    co_supervisor_id TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'draft',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS org_ideas_title_idx
    ON org_ideas (cycle_id, lower(title))`;

  // group_code is unique per cycle, not globally: codes restart at G01 each
  // semester, so EPME-D-G01 recurs legitimately in a later cycle.
  await sql`CREATE TABLE IF NOT EXISTS org_groups (
    id                   SERIAL PRIMARY KEY,
    cycle_id             INT  NOT NULL,
    group_code           TEXT NOT NULL,
    created_by_student_id TEXT NOT NULL DEFAULT '',
    status               TEXT NOT NULL DEFAULT 'forming',
    rank_version         INT  NOT NULL DEFAULT 0,
    ranked_by_student_id TEXT NOT NULL DEFAULT '',
    ranked_at            TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  // Drops the old global-unique constraint on databases created before codes
  // became per-cycle, then enforces uniqueness within the cycle instead.
  await sql`ALTER TABLE org_groups DROP CONSTRAINT IF EXISTS org_groups_group_code_key`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS org_groups_code_idx ON org_groups (cycle_id, group_code)`;
  // A group may optionally propose a project of its own. Never required.
  await sql`ALTER TABLE org_groups ADD COLUMN IF NOT EXISTS proposed_title TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE org_groups ADD COLUMN IF NOT EXISTS proposed_desc  TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE org_groups ADD COLUMN IF NOT EXISTS proposed_by    TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE org_groups ADD COLUMN IF NOT EXISTS proposed_at    TIMESTAMPTZ`;

  // The two unique indexes below are the duplicate-prevention mechanism.
  // App-level checks cannot survive two students submitting overlapping groups
  // at the same moment — Neon serverless has no transaction spanning requests.
  await sql`CREATE TABLE IF NOT EXISTS org_group_members (
    id                 SERIAL PRIMARY KEY,
    cycle_id           INT  NOT NULL,
    group_id           INT  NOT NULL,
    student_id         TEXT NOT NULL,
    student_name       TEXT NOT NULL,
    email              TEXT NOT NULL DEFAULT '',
    added_by_student_id TEXT NOT NULL DEFAULT '',
    joined_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`ALTER TABLE org_group_members ADD COLUMN IF NOT EXISTS cgpa NUMERIC(4,2)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS org_members_id_idx
    ON org_group_members (cycle_id, student_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS org_members_name_idx
    ON org_group_members (cycle_id, lower(student_name))`;

  await sql`CREATE TABLE IF NOT EXISTS org_rankings (
    id       SERIAL PRIMARY KEY,
    group_id INT NOT NULL,
    idea_id  INT NOT NULL,
    rank     INT NOT NULL
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS org_rankings_idea_idx ON org_rankings (group_id, idea_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS org_rankings_rank_idx ON org_rankings (group_id, rank)`;

  await sql`CREATE TABLE IF NOT EXISTS org_audit (
    id         SERIAL PRIMARY KEY,
    cycle_id   INT  NOT NULL DEFAULT 0,
    group_id   INT  NOT NULL DEFAULT 0,
    actor_type TEXT NOT NULL DEFAULT '',
    actor_id   TEXT NOT NULL DEFAULT '',
    actor_name TEXT NOT NULL DEFAULT '',
    action     TEXT NOT NULL,
    details    JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS org_audit_group_idx ON org_audit (group_id, created_at)`;

  // One idea to one group, one idea per group — enforced at assignment time
  // only. Students may rank the same idea in any number of groups.
  await sql`CREATE TABLE IF NOT EXISTS org_allocations (
    id            SERIAL PRIMARY KEY,
    cycle_id      INT  NOT NULL,
    group_id      INT  NOT NULL,
    idea_id       INT  NOT NULL,
    assigned_rank INT  NOT NULL DEFAULT 0,
    assigned_by   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'draft',
    project_id    TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS org_alloc_group_idx ON org_allocations (cycle_id, group_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS org_alloc_idea_idx  ON org_allocations (cycle_id, idea_id)`;

  _organizerTablesReady = true;
}

// Derives the academic year and semester from a date. FYP1 runs once per
// semester, so this plus (program, campus) identifies the current cycle.
// Sep–Jan is Fall of the year that started in September; Feb–Aug is Spring.
function academicContext(now) {
  const d = now || new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  if (m >= 9)  return { academic_year: `${y}-${y + 1}`, semester: 'Fall'   };
  if (m === 1) return { academic_year: `${y - 1}-${y}`, semester: 'Fall'   };
  return { academic_year: `${y - 1}-${y}`, semester: 'Spring' };
}

// Publishing is time-driven: once the idea deadline passes, the list opens to
// students by itself and anyone who never responded is recorded as having no
// ideas. Supervisors are never asked to wait for or chase each other.
// There is no scheduler, so this is evaluated whenever a cycle is loaded.
async function maybeAutoPublish(sql, cycle) {
  if (!cycle || cycle.phase !== 'IDEAS_OPEN') return cycle;
  if (!deadlinePassed(cycle.ideas_deadline)) return cycle;

  const ideaCount = await sql`SELECT COUNT(*) AS c FROM org_ideas WHERE cycle_id = ${cycle.id}`;
  // Nothing to publish — hold the phase open rather than opening an empty list
  if (Number(ideaCount[0].c) === 0) return cycle;

  await sql`UPDATE org_participants SET status = 'declared_none', submitted_at = NOW()
    WHERE cycle_id = ${cycle.id} AND expected = TRUE
      AND status NOT IN ('submitted', 'declared_none')`;
  await sql`UPDATE org_ideas SET status = 'submitted' WHERE cycle_id = ${cycle.id} AND status = 'draft'`;
  const updated = await sql`UPDATE org_cycles SET phase = 'RANKING_OPEN', updated_at = NOW()
    WHERE id = ${cycle.id} AND phase = 'IDEAS_OPEN' RETURNING *`;
  if (!updated[0]) return cycle; // another request published it first
  await logAudit(sql, cycle.id, 0, 'system', '', 'System', 'ideas_published',
    { trigger: 'ideas_deadline_passed' });
  return updated[0];
}

// Returns the cycle for this program+campus, creating it on first use so the
// module works without a separate admin setup step.
async function getOrCreateCycle(sql, program, campus) {
  await ensureOrganizerTables(sql);
  const { academic_year, semester } = academicContext();
  const found = await sql`SELECT * FROM org_cycles
    WHERE academic_year = ${academic_year} AND semester = ${semester}
      AND program = ${program} AND campus = ${campus}`;
  if (found[0]) return await maybeAutoPublish(sql, found[0]);
  try {
    const created = await sql`INSERT INTO org_cycles (academic_year, semester, program, campus)
      VALUES (${academic_year}, ${semester}, ${program}, ${campus}) RETURNING *`;
    return created[0];
  } catch (e) {
    // Lost the race with a concurrent first request — read back the winner
    const again = await sql`SELECT * FROM org_cycles
      WHERE academic_year = ${academic_year} AND semester = ${semester}
        AND program = ${program} AND campus = ${campus}`;
    if (again[0]) return again[0];
    throw e;
  }
}

// Everyone in this program+campus is expected to respond. Rows are added as
// campuses get set, so the board stays accurate without manual maintenance.
async function syncParticipants(sql, cycle) {
  const sups = await sql`SELECT supervisor_id FROM supervisors
    WHERE program = ${cycle.program} AND campus = ${cycle.campus} AND supervisor_id != ${ADMIN_ID}`;
  for (const s of sups) {
    await sql`INSERT INTO org_participants (cycle_id, supervisor_id)
      VALUES (${cycle.id}, ${s.supervisor_id}) ON CONFLICT DO NOTHING`;
  }
  return sups.map(s => s.supervisor_id);
}

// Resolves the logged-in supervisor from the supervisors table rather than the
// session, so a campus set after login is picked up immediately.
async function orgContext(sql, session) {
  await ensureCampusColumn(sql);
  const rows = await sql`SELECT * FROM supervisors WHERE supervisor_id = ${session.supervisor_id}`;
  const sup = rows[0];
  if (!sup) return { error: 'Supervisor record not found.' };
  if (!sup.campus) return { error: 'Your campus has not been set yet. Ask the admin to set it from Manage Users.' };
  if (!sup.program) return { error: 'Your program has not been set yet. Ask the admin to set it.' };
  const cycle = await getOrCreateCycle(sql, sup.program, sup.campus);
  return { sup, cycle };
}

// Who may set deadlines, publish the idea list and run the assignment console.
// Default is open to any supervisor of that program+campus; the admin can lock
// it to himself or delegate it to one named colleague.
function canManageCycle(session, sup, cycle) {
  if (isAdminUser(session)) return true;
  const policy = cycle.deadline_policy || 'open';
  if (policy === 'locked')   return false;
  if (policy === 'delegate') return cycle.deadline_delegate === sup.supervisor_id;
  return true;
}

// Distinguishes "no token was sent" from "the token is unknown or expired", so
// a session complaint identifies its own cause instead of being ambiguous.
// sessionInvalid tells the page to return to the sign-in screen.
function sessionGone(token) {
  return {
    success: false,
    sessionInvalid: true,
    message: token
      ? 'Your session has expired or is no longer valid — please sign in again.'
      : 'No sign-in was sent with this request — please sign in again.',
  };
}

// Group codes read as PROGRAM-CAMPUS-Gnn, e.g. EPME-D-G01 for the first group
// of Electric Power and Machines Engineering at Debbieh.
const PROGRAM_ABBR = {
  'Electric Power and Machines Engineering': 'EPME',
  'Communication and Electronics':           'CEE',
  'Computer Engineering':                    'CE',
  'Biomedical Engineering':                  'BME',
};

// Programmes can be added at runtime, so unknown names fall back to initials.
function programAbbr(name) {
  if (PROGRAM_ABBR[name]) return PROGRAM_ABBR[name];
  const skip = new Set(['and', 'of', 'the', 'for', '&', 'in']);
  const initials = String(name || '')
    .split(/[\s-]+/)
    .filter(w => w && !skip.has(w.toLowerCase()))
    .map(w => w[0].toUpperCase())
    .join('');
  return (initials || 'PRG').slice(0, 5);
}

function campusLetter(campus) {
  return String(campus || '?').trim().charAt(0).toUpperCase();
}

function groupCodePrefix(cycle) {
  return `${programAbbr(cycle.program)}-${campusLetter(cycle.campus)}-G`;
}

// Next free sequence number in this cycle. Reads the highest existing number
// rather than counting rows, so deleting a group never reissues its code.
async function nextGroupNumber(sql, cycle) {
  const rows = await sql`SELECT group_code FROM org_groups WHERE cycle_id = ${cycle.id}`;
  let max = 0;
  for (const r of rows) {
    const m = /G(\d+)$/.exec(r.group_code || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function formatGroupCode(cycle, n) {
  return groupCodePrefix(cycle) + String(n).padStart(2, '0');
}

const STUDENT_ID_RE = /^20\d{7}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// CGPA on the standard 4.00 scale. Returned as a number, or null when the
// value is missing or outside the scale.
const CGPA_MAX = 4;
function parseCgpa(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return null;
  if (!/^\d(?:\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  if (!isFinite(n) || n < 0 || n > CGPA_MAX) return null;
  return Math.round(n * 100) / 100;
}
function normName(s) { return String(s || '').trim().replace(/\s+/g, ' '); }

// Student-side cycle resolution. Refuses to create a cycle for a program+campus
// that has no supervisors at all, so typos cannot litter the table.
async function studentCycle(sql, program, campus) {
  await ensureOrganizerTables(sql);
  if (!CAMPUSES.includes(campus)) return { error: 'Please select a valid campus.' };
  const sups = await sql`SELECT supervisor_id FROM supervisors
    WHERE program = ${program} AND campus = ${campus} AND supervisor_id != ${ADMIN_ID} LIMIT 1`;
  if (!sups.length)
    return { error: 'No supervisors are registered for that program on that campus yet. Please check your selection.' };
  const cycle = await getOrCreateCycle(sql, program, campus);
  return { cycle };
}

// Resolves a student to their group for the current cycle.
async function findStudentGroup(sql, cycleId, studentId) {
  const rows = await sql`SELECT * FROM org_group_members
    WHERE cycle_id = ${cycleId} AND student_id = ${studentId}`;
  if (!rows[0]) return null;
  const g = await sql`SELECT * FROM org_groups WHERE id = ${rows[0].group_id}`;
  if (!g[0]) return null;
  const members = await sql`SELECT * FROM org_group_members WHERE group_id = ${g[0].id} ORDER BY id`;
  return { group: g[0], me: rows[0], members };
}

async function logAudit(sql, cycleId, groupId, actorType, actorId, actorName, action, details) {
  try {
    await sql`INSERT INTO org_audit (cycle_id, group_id, actor_type, actor_id, actor_name, action, details)
      VALUES (${cycleId}, ${groupId}, ${actorType}, ${actorId}, ${actorName}, ${action},
              ${JSON.stringify(details || {})})`;
  } catch { /* the audit trail must never break the operation it records */ }
}

function deadlinePassed(ts) {
  return !!ts && new Date(ts).getTime() < Date.now();
}

// Pre-flight for publishing an allocation into the live FYP tables.
// registerProject enforces globally unique project titles and globally unique
// student names, and needs an email unless notifications are disabled — a
// naive insert loop would fail halfway and leave orphan rows, so every rule is
// checked before anything is written.
async function buildPublishReport(sql, cycle) {
  const allocs = await sql`SELECT * FROM org_allocations WHERE cycle_id = ${cycle.id}`;
  const groups = await sql`SELECT * FROM org_groups WHERE cycle_id = ${cycle.id}`;
  const blockers = [], warnings = [], plan = [];

  const unassigned = groups.filter(g => !allocs.some(a => a.group_id === g.id));
  if (unassigned.length)
    warnings.push(`${unassigned.length} group(s) have no project assigned and will be skipped: ${unassigned.map(g => g.group_code).join(', ')}.`);

  const pending = allocs.filter(a => a.status !== 'published');
  const alreadyDone = allocs.length - pending.length;
  if (alreadyDone) warnings.push(`${alreadyDone} group(s) were already published and will be skipped.`);
  if (!pending.length) blockers.push('There is nothing new to publish.');

  const [existingProjects, existingStudents] = await Promise.all([
    sql`SELECT title FROM projects`,
    sql`SELECT student_id, student_name FROM students`,
  ]);
  const titleTaken = new Set(existingProjects.map(p => p.title.trim().toLowerCase()));
  const idTaken    = new Set(existingStudents.map(s => s.student_id));
  const nameTaken  = new Set(existingStudents.map(s => s.student_name.trim().toLowerCase()));

  for (const a of pending) {
    const g = groups.find(x => x.id === a.group_id);
    const iRows = await sql`SELECT * FROM org_ideas WHERE id = ${a.idea_id}`;
    const idea = iRows[0];
    if (!g || !idea) { blockers.push(`Allocation ${a.id} refers to a missing group or project.`); continue; }

    const members = await sql`SELECT * FROM org_group_members WHERE group_id = ${g.id} ORDER BY id`;
    if (!members.length) { blockers.push(`Group ${g.group_code} has no students.`); continue; }

    if (titleTaken.has(idea.title.trim().toLowerCase()))
      blockers.push(`A project titled "${idea.title}" already exists in the FYP system — rename the idea before publishing.`);

    for (const m of members) {
      if (idTaken.has(m.student_id))
        blockers.push(`Student ID ${m.student_id} (${m.student_name}) is already registered in another FYP project.`);
      if (nameTaken.has(m.student_name.trim().toLowerCase()))
        blockers.push(`Student name "${m.student_name}" is already registered in another FYP project — the FYP system requires unique names.`);
    }

    const size = members.length;
    if (size < Number(idea.min_students) || size > Number(idea.max_students))
      warnings.push(`Group ${g.group_code} has ${size} student(s) but "${idea.title}" expects ${idea.min_students}–${idea.max_students}.`);

    const emails = members.map(m => (m.email || '').trim()).filter(Boolean);
    if (!emails.length)
      warnings.push(`Group ${g.group_code} gave no email address — its project will be created with notifications disabled.`);

    const supervisorIds = [idea.supervisor_id].concat(idea.co_supervisor_id ? [idea.co_supervisor_id] : []);
    plan.push({
      groupId: g.id, code: g.group_code, title: idea.title,
      supervisorIds, hasEmail: emails.length > 0,
      students: members.map(m => ({ id: m.student_id, name: m.student_name, email: m.email || '' })),
    });
  }

  return { ready: blockers.length === 0 && plan.length > 0, plan, blockers, warnings };
}

// supervisor_id -> how many groups that supervisor is willing to take.
async function supervisorCaps(sql, cycle) {
  const rows = await sql`SELECT supervisor_id, max_groups FROM org_participants WHERE cycle_id = ${cycle.id}`;
  const m = new Map();
  rows.forEach(r => m.set(r.supervisor_id, Number(r.max_groups)));
  return m;
}

// A group may rank at most `capacity` projects from any one supervisor, since
// that supervisor cannot take more groups than that. The complete-ranking rule
// therefore targets the sum of those per-supervisor limits rather than the raw
// number of projects.
function rankingQuota(ideas, caps) {
  const bySup = new Map();
  ideas.forEach(i => bySup.set(i.supervisor_id, (bySup.get(i.supervisor_id) || 0) + 1));
  let quota = 0;
  const limits = new Map();
  bySup.forEach((count, supId) => {
    const cap = caps.get(supId) != null ? caps.get(supId) : 1;
    const allowed = Math.min(count, cap);
    limits.set(supId, allowed);
    quota += allowed;
  });
  return { quota, limits };
}

function mapIdea(r) {
  return {
    id: r.id, title: r.title, field: r.field || '', description: r.description || '',
    prerequisites: r.prerequisites || '', minStudents: Number(r.min_students),
    maxStudents: Number(r.max_students), coSupervisorId: r.co_supervisor_id || '',
    status: r.status, supervisorId: r.supervisor_id,
  };
}

// ── Department mailer ─────────────────────────────────────────────────────
// Any signed-in supervisor may send from the department address, so every
// send is recorded: who, to whom, and what subject.
let _mailLogReady = false;
async function ensureMailLog(sql) {
  if (_mailLogReady) return;
  await sql`CREATE TABLE IF NOT EXISTS email_log (
    id            SERIAL PRIMARY KEY,
    supervisor_id TEXT NOT NULL,
    supervisor_name TEXT NOT NULL DEFAULT '',
    subject       TEXT NOT NULL DEFAULT '',
    recipients    TEXT NOT NULL DEFAULT '',
    sent_count    INT  NOT NULL DEFAULT 0,
    failed_count  INT  NOT NULL DEFAULT 0,
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS email_log_when_idx ON email_log (sent_at DESC)`;
  _mailLogReady = true;
}

// Wraps free text in the same frame the system's own notifications use.
function mailLetterhead({ title, subtitle, content, footer, logo }) {
  const useLogo = logo && logo !== 'none'
    ? logo : (logo === 'none' ? '' : 'https://usif-3jra.github.io/epme-study-plan/assets/logo_ECE.png');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;">
<tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
  ${useLogo ? `<tr><td align="center" style="background:#ffffff;padding:28px 40px 16px;">
    <img src="${useLogo}" alt="" width="130" style="display:block;max-width:130px;height:auto;"/></td></tr>` : ''}
  ${title ? `<tr><td style="background:#0a1f44;padding:24px 40px;text-align:center;">
    <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:.02em;margin-bottom:6px;">${title}</div>
    ${subtitle ? `<div style="color:#94a3b8;font-size:13px;">${subtitle}</div>` : ''}</td></tr>` : ''}
  <tr><td style="padding:32px 40px;color:#2d2d2d;font-size:15px;line-height:1.7;">
${content}
  </td></tr>
  <tr><td style="border-top:1px solid #e5e7eb;padding:16px 40px;text-align:center;color:#9ca3af;font-size:11px;background:#f9fafb;">
    ${footer || '&copy; ' + new Date().getFullYear() + ' Beirut Arab University — Faculty of Engineering — ECE Department'}
  </td></tr>
</table></td></tr></table></body></html>`;
}

// Plain text to simple paragraphs, so nobody has to write HTML
function mailTextToHtml(text) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text).split(/\n\s*\n/).map(block => {
    const lines = block.split('\n').map(l => esc(l.trim())).filter(Boolean);
    return lines.length ? `<p style="margin:0 0 16px;">${lines.join('<br/>')}</p>` : '';
  }).filter(Boolean).join('\n');
}

function buildMailBody(p) {
  const content = p.mode === 'text' ? mailTextToHtml(p.body || '') : String(p.body || '');
  return p.letterhead
    ? mailLetterhead({ title: p.title, subtitle: p.subtitle, content, footer: p.footer, logo: p.logo })
    : content;
}

// Same transport as the rest of the system, plus a reply-to so answers reach
// the supervisor who wrote the message rather than the no-reply address.
async function sendEmailAs(to, subject, html, fromName, replyTo) {
  const payload = {
    from: { email: SENDER_EMAIL, name: fromName || 'ECE Department — BAU' },
    to: [{ email: String(to) }],
    subject,
    html,
  };
  if (replyTo) payload.reply_to = { email: replyTo };
  const res = await fetch('https://send.api.mailtrap.io/api/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${MAILTRAP_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => String(res.status));
    throw new Error(`${res.status}: ${err.slice(0, 300)}`);
  }
}

async function isMeetingDelegate(sql, supervisorId) {
  await ensureDelegateTables(sql);
  const rows = await sql`SELECT 1 FROM meeting_delegates WHERE supervisor_id = ${supervisorId}`;
  return rows.length > 0;
}
// Robust admin check: accepts both the stored is_admin flag AND a direct ID match
// (guards against sessions created before is_admin was reliably stored)
function isAdminUser(session) {
  return !!(session && (session.is_admin || session.supervisor_id === ADMIN_ID));
}

// ── Main handler ──────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.json({ error: 'Method not allowed' }); return; }

  const sql = neon(process.env.DATABASE_URL);
  const body = req.body || {};
  const { action, args = [] } = body;

  // ok() just returns its argument so `return ok({...})` exits dispatch()
  function ok(data) { return data; }

  // ── Session helpers ────────────────────────────────────────────────────

  async function verifySession(token) {
    if (!token) return null;
    const rows = await sql`SELECT * FROM sessions WHERE token = ${token} AND expires_at > NOW()`;
    return rows[0] || null;
  }

  async function checkLockout(supId) {
    const rows = await sql`SELECT * FROM login_lockout WHERE supervisor_id = ${supId}`;
    const data = rows[0] || null;
    if (!data) return { blocked: false };
    if (data.locked_until && new Date(data.locked_until) > new Date()) {
      return { blocked: true, remaining: Math.ceil((new Date(data.locked_until) - Date.now()) / 60000) };
    }
    if (data.locked_until) {
      await sql`DELETE FROM login_lockout WHERE supervisor_id = ${supId}`;
    }
    return { blocked: false };
  }

  async function recordLoginFail(supId) {
    const rows = await sql`SELECT * FROM login_lockout WHERE supervisor_id = ${supId}`;
    const existing = rows[0] || null;
    const tries = ((existing && existing.tries) || 0) + 1;
    const locked_until = tries >= MAX_TRIES ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;
    await sql`INSERT INTO login_lockout (supervisor_id, tries, locked_until) VALUES (${supId}, ${tries}, ${locked_until}) ON CONFLICT (supervisor_id) DO UPDATE SET tries = ${tries}, locked_until = ${locked_until}`;
    return { tries, locked_until };
  }

  async function clearLockout(supId) {
    await sql`DELETE FROM login_lockout WHERE supervisor_id = ${supId}`;
  }

  async function createSession(sup) {
    const token     = crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'');
    const expiresAt = new Date(Date.now() + SESSION_TTL).toISOString();
    await sql`INSERT INTO sessions (token, supervisor_id, name, program, is_admin, expires_at, last_seen) VALUES (${token}, ${sup.id}, ${sup.name}, ${sup.program || ''}, ${!!sup.isAdmin}, ${expiresAt}, NOW())`;
    return token;
  }

  async function getTWConfig() {
    const rows = await sql`SELECT * FROM tw_config`;
    const cfg = {};
    rows.forEach(r => { cfg[r.config_key] = r.config_value; });
    return cfg;
  }

  async function getIndividualRubric() {
    const cfg = await getTWConfig();
    try { const stored = JSON.parse(cfg.individual_rubric || '[]'); if (stored.length) return stored; } catch {}
    return [
      { criterion: 'Technical Contribution',   maxGrade: 25, weight: 25, abetOutcome: '' },
      { criterion: 'Initiative & Leadership',  maxGrade: 25, weight: 25, abetOutcome: '' },
      { criterion: 'Attendance & Punctuality', maxGrade: 25, weight: 25, abetOutcome: '' },
      { criterion: 'Documentation Quality',    maxGrade: 25, weight: 25, abetOutcome: '' },
    ];
  }

  async function filterProjectsBySession(session, allProjects, allSups) {
    if (session.is_admin) return allProjects;
    const prog = session.program || '';
    if (!prog) return allProjects;
    return allProjects.filter(p => {
      if (p.program_type === prog) return true;
      const supIds = (p.supervisors || '').split(',').map(x => x.trim()).filter(Boolean);
      return supIds.some(sid => {
        const found = allSups.find(su => su.supervisor_id === sid);
        return found && found.program === prog;
      });
    });
  }

  function pct(num, denom) { return denom > 0 ? (num / denom) * 100 : 0; }
  function rnd(v) { return Math.round(v * 10) / 10; }

  function weightedPct(grades, config) {
    if (!grades.length || !config.length) return 0;
    let wSum = 0, wTotal = 0;
    config.forEach(c => {
      const cg  = grades.filter(g => g.criterion === c.criterion_name || g.Criterion === c.CriterionName);
      const max = parseFloat(c.max_grade || c.MaxGrade);
      const w   = parseFloat(c.weight || c.Weight);
      if (cg.length && max > 0) {
        const avg = cg.reduce((s, g) => s + parseFloat(g.score || g.Score || 0), 0) / cg.length;
        wSum += (avg / max) * 100 * w;
        wTotal += w;
      }
    });
    return wTotal > 0 ? wSum / wTotal : 0;
  }

  const GRADE_BORDERS = [54, 59, 64, 69, 72, 75, 79, 82, 85, 89, 94];

  function letterGrade(score) {
    const rounded  = Math.round(score);
    const adjusted = GRADE_BORDERS.includes(rounded) ? rounded + 1 : rounded;
    if (adjusted >= 95) return 'A+'; if (adjusted >= 90) return 'A';
    if (adjusted >= 86) return 'A-'; if (adjusted >= 83) return 'B+';
    if (adjusted >= 80) return 'B';  if (adjusted >= 76) return 'B-';
    if (adjusted >= 73) return 'C+'; if (adjusted >= 70) return 'C';
    if (adjusted >= 65) return 'C-'; if (adjusted >= 60) return 'D';
    if (adjusted >= 55) return 'D-';
    return 'F';
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  async function dispatch() {
    switch (action) {

      // ─── Auth ────────────────────────────────────────────────────────

      case 'loginSupervisor': {
        const [supervisorId, password] = args;
        if (!supervisorId || !password) return ok({ success: false, message: 'ID and password are required.' });

        const lockCheck = await checkLockout(supervisorId.trim());
        if (lockCheck.blocked) return ok({ success: false, message: `Account locked. Try again in ${lockCheck.remaining} minute(s).` });

        await ensureCampusColumn(sql);
        const supRows = await sql`SELECT * FROM supervisors WHERE supervisor_id = ${supervisorId.trim()}`;
        const sup = supRows[0] || null;
        if (!sup) {
          await recordLoginFail(supervisorId.trim());
          return ok({ success: false, message: 'Supervisor ID not found.' });
        }

        const stored = sup.password || '';
        const inputHash = hashPwd(password);
        const isHash = stored.length === 64;
        const passwordOk = isHash ? stored === inputHash : (stored === password || stored === '');

        if (!passwordOk) {
          const failData = await recordLoginFail(supervisorId.trim());
          const left = MAX_TRIES - (failData.tries || 0);
          return ok({ success: false, message: left > 0 ? `Incorrect password. ${left} attempt(s) left.` : 'Account locked for 15 minutes.' });
        }

        if (!isHash) await sql`UPDATE supervisors SET password = ${inputHash} WHERE supervisor_id = ${sup.supervisor_id}`;
        await clearLockout(supervisorId.trim());

        const supervisorData = { id: sup.supervisor_id, name: sup.name, program: sup.program, email: sup.email, campus: sup.campus || '', isAdmin: sup.supervisor_id === ADMIN_ID };
        const sessionToken = await createSession(supervisorData);
        return ok({ success: true, supervisor: supervisorData, sessionToken });
      }

      case 'logoutSession': {
        const [token] = args;
        if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
        return ok({ success: true });
      }

      case 'changePassword': {
        const [sessionToken, currentPwd, newPwd] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const supRows = await sql`SELECT * FROM supervisors WHERE supervisor_id = ${session.supervisor_id}`;
        const sup = supRows[0] || null;
        if (!sup) return ok({ success: false, message: 'Supervisor not found.' });
        const stored = sup.password || '';
        const isHash = stored.length === 64;
        const currentOk = isHash ? stored === hashPwd(currentPwd) : (stored === currentPwd || stored === '');
        if (!currentOk) return ok({ success: false, message: 'Current password is incorrect.' });
        if (!newPwd || newPwd.length < 6) return ok({ success: false, message: 'New password must be at least 6 characters.' });
        await sql`UPDATE supervisors SET password = ${hashPwd(newPwd)} WHERE supervisor_id = ${session.supervisor_id}`;
        await sql`DELETE FROM sessions WHERE supervisor_id = ${session.supervisor_id} AND token != ${sessionToken}`;
        return ok({ success: true });
      }

      case 'heartbeat': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false });
        await sql`UPDATE sessions SET last_seen = NOW() WHERE token = ${sessionToken}`;
        return ok({ success: true });
      }

      case 'getOnlineUsers': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ users: [] });
        const rows = await sql`SELECT supervisor_id, name, program, is_admin, last_seen FROM sessions WHERE last_seen > NOW() - INTERVAL '5 minutes' AND expires_at > NOW() ORDER BY last_seen DESC`;
        return ok({ users: rows.map(r => ({ id: r.supervisor_id, name: r.name, program: r.program, isAdmin: r.is_admin, lastSeen: r.last_seen })) });
      }

      case 'initializeSheets': return ok({ success: true });

      // ─── KPIs ────────────────────────────────────────────────────────

      case 'getKPIs': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ fyp1: 0, fyp2: 0, students: 0, projects: 0 });

        const [allProjects, allStudents, allSups] = await Promise.all([
          sql`SELECT * FROM projects`,
          sql`SELECT * FROM students`,
          sql`SELECT * FROM supervisors`,
        ]);

        const projects   = await filterProjectsBySession(session, allProjects, allSups);
        const projectIds = new Set(projects.map(p => p.project_id));
        const students   = allStudents.filter(s => projectIds.has(s.project_id));
        return ok({
          fyp1:     projects.filter(p => p.type === 'FYP1').length,
          fyp2:     projects.filter(p => p.type === 'FYP2').length,
          students: students.length,
          projects: projects.length,
        });
      }

      // ─── Programs & Supervisors ──────────────────────────────────────

      case 'getPrograms': {
        const rows = await sql`SELECT * FROM programs ORDER BY program_name`;
        return ok(rows.map(r => r.program_name));
      }

      case 'getSupervisorsByProgram': {
        const [program] = args;
        const rows = await sql`SELECT * FROM supervisors WHERE program = ${program} AND supervisor_id != ${ADMIN_ID}`;
        return ok(rows.map(r => ({ id: r.supervisor_id, name: r.name, email: r.email })));
      }

      case 'getAllSupervisors': {
        const [sessionToken] = args;
        if (!await verifySession(sessionToken)) return ok([]);
        await ensureCampusColumn(sql);
        const rows = await sql`SELECT * FROM supervisors WHERE supervisor_id != ${ADMIN_ID} ORDER BY name`;
        return ok(rows.map(r => ({ id: r.supervisor_id, name: r.name, program: r.program, email: r.email || '', campus: r.campus || '' })));
      }

      case 'addSupervisorToSystem': {
        // campus is appended last so existing callers that omit it keep working
        const [sessionToken, name, program, email, initialPassword, campus] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        if (!session.is_admin) return ok({ success: false, message: 'Only the admin can add supervisors.' });
        await ensureCampusColumn(sql);
        const campusVal = CAMPUSES.includes(campus) ? campus : '';
        const existing = await sql`SELECT supervisor_id FROM supervisors WHERE name = ${name} AND program = ${program}`;
        if (existing.length) return ok({ success: false, message: 'Supervisor already exists in this program.' });
        const id  = uid('SUP');
        const pwd = (initialPassword && initialPassword.length >= 6) ? initialPassword : DEFAULT_PWD;
        await sql`INSERT INTO supervisors (supervisor_id, name, program, email, password, campus) VALUES (${id}, ${name}, ${program}, ${email || ''}, ${hashPwd(pwd)}, ${campusVal})`;
        return ok({ success: true, id, name, program, campus: campusVal });
      }

      case 'getAllSupervisorsForAdmin': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        await ensureCampusColumn(sql);
        const rows = await sql`SELECT * FROM supervisors WHERE supervisor_id != ${ADMIN_ID} ORDER BY name`;
        return ok({ success: true, campuses: CAMPUSES, supervisors: rows.map(r => ({ id: r.supervisor_id, name: r.name, program: r.program, email: r.email || '', campus: r.campus || '' })) });
      }

      // ─── Projects Organizer: campus assignment ───────────────────────

      case 'setSupervisorCampuses': {
        // targets: [{ id, campus }] — campus '' clears the assignment
        const [sessionToken, targets] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        if (!Array.isArray(targets) || !targets.length) return ok({ success: false, message: 'No changes to save.' });
        await ensureCampusColumn(sql);
        for (const t of targets) {
          if (t.campus && !CAMPUSES.includes(t.campus))
            return ok({ success: false, message: `Invalid campus "${t.campus}".` });
        }
        for (const t of targets) {
          await sql`UPDATE supervisors SET campus = ${t.campus || ''} WHERE supervisor_id = ${t.id}`;
        }
        return ok({ success: true, updated: targets.length });
      }

      case 'orgInitSchema': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        await ensureOrganizerTables(sql);
        const rows = await sql`SELECT table_name FROM information_schema.tables
                               WHERE table_schema = 'public' AND table_name LIKE 'org%' ORDER BY table_name`;
        const colRows = await sql`SELECT column_name FROM information_schema.columns
                                  WHERE table_name = 'supervisors' AND column_name = 'campus'`;
        return ok({ success: true, tables: rows.map(r => r.table_name), campusColumn: colRows.length > 0 });
      }

      // ─── Projects Organizer: supervisor idea submission ──────────────

      case 'orgGetMyIdeas': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;

        await syncParticipants(sql, cycle);
        const partRows = await sql`SELECT * FROM org_participants
          WHERE cycle_id = ${cycle.id} AND supervisor_id = ${sup.supervisor_id}`;
        const ideaRows = await sql`SELECT * FROM org_ideas
          WHERE cycle_id = ${cycle.id} AND supervisor_id = ${sup.supervisor_id} ORDER BY id`;
        const colleagues = await sql`SELECT supervisor_id, name FROM supervisors
          WHERE program = ${cycle.program} AND campus = ${cycle.campus}
            AND supervisor_id != ${ADMIN_ID} AND supervisor_id != ${sup.supervisor_id} ORDER BY name`;

        const part = partRows[0] || { status: 'not_started', max_groups: 1 };
        return ok({
          success: true,
          cycle: {
            id: cycle.id, academicYear: cycle.academic_year, semester: cycle.semester,
            program: cycle.program, campus: cycle.campus, phase: cycle.phase,
            ideasDeadline: cycle.ideas_deadline, rankingDeadline: cycle.ranking_deadline,
          },
          me: { id: sup.supervisor_id, name: sup.name, status: part.status, maxGroups: Number(part.max_groups) },
          ideas: ideaRows.map(mapIdea),
          colleagues: colleagues.map(c => ({ id: c.supervisor_id, name: c.name })),
        });
      }

      case 'orgSaveIdea': {
        const [sessionToken, payload] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (cycle.phase !== 'IDEAS_OPEN')
          return ok({ success: false, message: 'The idea list for your program has already been published — it can no longer be changed.' });

        const p = payload || {};
        const title = String(p.title || '').trim();
        const description = String(p.description || '').trim();
        if (title.length < 5)       return ok({ success: false, message: 'Please give the project a title of at least 5 characters.' });
        if (description.length < 20) return ok({ success: false, message: 'Please write a short description — at least 20 characters — so students can rank it sensibly.' });
        const minS = Number(p.minStudents), maxS = Number(p.maxStudents);
        if (!Number.isInteger(minS) || !Number.isInteger(maxS) || minS < 1 || maxS > 6)
          return ok({ success: false, message: 'Student numbers must be whole numbers between 1 and 6.' });
        if (maxS < minS) return ok({ success: false, message: 'The maximum number of students cannot be less than the minimum.' });

        const co = String(p.coSupervisorId || '').trim();
        if (co) {
          const coRows = await sql`SELECT supervisor_id FROM supervisors
            WHERE supervisor_id = ${co} AND program = ${cycle.program} AND campus = ${cycle.campus}`;
          if (!coRows[0]) return ok({ success: false, message: 'The selected co-supervisor is not in your program and campus.' });
        }

        try {
          if (p.id) {
            const owned = await sql`SELECT id FROM org_ideas
              WHERE id = ${Number(p.id)} AND supervisor_id = ${sup.supervisor_id} AND cycle_id = ${cycle.id}`;
            if (!owned[0]) return ok({ success: false, message: 'That idea was not found, or it is not yours.' });
            await sql`UPDATE org_ideas SET title = ${title}, field = ${String(p.field || '').trim()},
              description = ${description}, prerequisites = ${String(p.prerequisites || '').trim()},
              min_students = ${minS}, max_students = ${maxS}, co_supervisor_id = ${co}, updated_at = NOW()
              WHERE id = ${Number(p.id)}`;
            return ok({ success: true, id: Number(p.id) });
          }
          const ins = await sql`INSERT INTO org_ideas
            (cycle_id, supervisor_id, title, field, description, prerequisites, min_students, max_students, co_supervisor_id, status)
            VALUES (${cycle.id}, ${sup.supervisor_id}, ${title}, ${String(p.field || '').trim()}, ${description},
                    ${String(p.prerequisites || '').trim()}, ${minS}, ${maxS}, ${co}, 'draft') RETURNING id`;
          return ok({ success: true, id: ins[0].id });
        } catch (e) {
          if (e.code === '23505')
            return ok({ success: false, message: `Another project in your program is already titled "${title}". Please choose a different title.` });
          return ok({ success: false, message: 'Could not save the idea: ' + (e.message || e) });
        }
      }

      case 'orgDeleteIdea': {
        const [sessionToken, ideaId] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (cycle.phase !== 'IDEAS_OPEN')
          return ok({ success: false, message: 'The idea list has already been published — it can no longer be changed.' });
        const res = await sql`DELETE FROM org_ideas
          WHERE id = ${Number(ideaId)} AND supervisor_id = ${sup.supervisor_id} AND cycle_id = ${cycle.id} RETURNING id`;
        if (!res[0]) return ok({ success: false, message: 'That idea was not found, or it is not yours.' });
        // Dropping to zero ideas invalidates a previous submission
        const left = await sql`SELECT COUNT(*) AS c FROM org_ideas
          WHERE cycle_id = ${cycle.id} AND supervisor_id = ${sup.supervisor_id}`;
        if (Number(left[0].c) === 0) {
          await sql`UPDATE org_participants SET status = 'not_started', submitted_at = NULL
            WHERE cycle_id = ${cycle.id} AND supervisor_id = ${sup.supervisor_id} AND status = 'submitted'`;
        }
        return ok({ success: true });
      }

      case 'orgSubmitIdeas': {
        const [sessionToken, maxGroups] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (cycle.phase !== 'IDEAS_OPEN')
          return ok({ success: false, message: 'The idea list has already been published.' });

        const ideaRows = await sql`SELECT id FROM org_ideas
          WHERE cycle_id = ${cycle.id} AND supervisor_id = ${sup.supervisor_id}`;
        if (!ideaRows.length)
          return ok({ success: false, message: 'You have no ideas to submit. Add at least one, or declare that you have none this semester.' });

        const cap = Number(maxGroups);
        const capVal = (Number.isInteger(cap) && cap >= 1 && cap <= 10) ? cap : 1;
        await sql`UPDATE org_ideas SET status = 'submitted', updated_at = NOW()
          WHERE cycle_id = ${cycle.id} AND supervisor_id = ${sup.supervisor_id}`;
        await sql`INSERT INTO org_participants (cycle_id, supervisor_id, max_groups, status, submitted_at)
          VALUES (${cycle.id}, ${sup.supervisor_id}, ${capVal}, 'submitted', NOW())
          ON CONFLICT (cycle_id, supervisor_id)
          DO UPDATE SET status = 'submitted', max_groups = ${capVal}, submitted_at = NOW()`;

        // Submission is entirely individual — no check on what colleagues have
        // done. The list opens to students when the idea deadline passes
        // (see maybeAutoPublish).
        await logAudit(sql, cycle.id, 0, 'supervisor', sup.supervisor_id, sup.name,
          'ideas_submitted', { count: ideaRows.length });
        return ok({ success: true, count: ideaRows.length, ideasDeadline: cycle.ideas_deadline });
      }

      case 'orgDeclareNoIdeas': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (cycle.phase !== 'IDEAS_OPEN')
          return ok({ success: false, message: 'The idea list has already been published.' });
        const ideaRows = await sql`SELECT id FROM org_ideas
          WHERE cycle_id = ${cycle.id} AND supervisor_id = ${sup.supervisor_id}`;
        if (ideaRows.length)
          return ok({ success: false, message: 'You still have ideas saved. Delete them first if you do not want to offer any project this semester.' });
        await sql`INSERT INTO org_participants (cycle_id, supervisor_id, status, submitted_at)
          VALUES (${cycle.id}, ${sup.supervisor_id}, 'declared_none', NOW())
          ON CONFLICT (cycle_id, supervisor_id)
          DO UPDATE SET status = 'declared_none', submitted_at = NOW()`;

        await logAudit(sql, cycle.id, 0, 'supervisor', sup.supervisor_id, sup.name,
          'declared_no_ideas', {});
        return ok({ success: true, ideasDeadline: cycle.ideas_deadline });
      }

      case 'orgReopenMySubmission': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (cycle.phase !== 'IDEAS_OPEN')
          return ok({ success: false, message: 'The idea list has already been published.' });
        await sql`UPDATE org_participants SET status = 'not_started', submitted_at = NULL
          WHERE cycle_id = ${cycle.id} AND supervisor_id = ${sup.supervisor_id}`;
        await sql`UPDATE org_ideas SET status = 'draft'
          WHERE cycle_id = ${cycle.id} AND supervisor_id = ${sup.supervisor_id}`;
        return ok({ success: true });
      }

      case 'orgGetColleagueStatus': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { cycle } = ctx;

        await syncParticipants(sql, cycle);
        const [sups, parts, ideas] = await Promise.all([
          sql`SELECT supervisor_id, name FROM supervisors
              WHERE program = ${cycle.program} AND campus = ${cycle.campus}
                AND supervisor_id != ${ADMIN_ID} ORDER BY name`,
          sql`SELECT * FROM org_participants WHERE cycle_id = ${cycle.id}`,
          sql`SELECT * FROM org_ideas WHERE cycle_id = ${cycle.id} ORDER BY id`,
        ]);
        const partBy = new Map(parts.map(p => [p.supervisor_id, p]));
        const nameBy = new Map(sups.map(s => [s.supervisor_id, s.name]));

        const board = sups.map(s => {
          const p = partBy.get(s.supervisor_id) || { status: 'not_started', max_groups: 1, expected: true };
          const mine = ideas.filter(i => i.supervisor_id === s.supervisor_id);
          return {
            id: s.supervisor_id, name: s.name, status: p.status,
            maxGroups: Number(p.max_groups),
            expected: p.expected !== false,
            submittedAt: p.submitted_at || null,
            ideaCount: mine.length,
            ideas: mine.map(i => ({
              id: i.id, title: i.title, field: i.field || '', description: i.description || '',
              prerequisites: i.prerequisites || '',
              minStudents: Number(i.min_students), maxStudents: Number(i.max_students),
              coSupervisor: i.co_supervisor_id ? (nameBy.get(i.co_supervisor_id) || '') : '',
              status: i.status,
            })),
          };
        });
        const expected  = board.filter(b => b.expected);
        const responded = expected.filter(b => b.status === 'submitted' || b.status === 'declared_none').length;
        return ok({
          success: true,
          phase: cycle.phase,
          program: cycle.program, campus: cycle.campus,
          academicYear: cycle.academic_year, semester: cycle.semester,
          totalExpected: expected.length, responded,
          totalIdeas: ideas.length,
          canManage: canManageCycle(session, ctx.sup, cycle),
          deadlinePolicy: cycle.deadline_policy,
          board,
        });
      }

      // Supervisor-only view of the full project list, available as soon as
      // every expected supervisor has responded — it does not wait for the
      // idea deadline or for the list to be published to students.
      case 'orgGetPrintList': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { cycle } = ctx;

        await syncParticipants(sql, cycle);
        const parts = await sql`SELECT * FROM org_participants WHERE cycle_id = ${cycle.id} AND expected = TRUE`;
        const pending = parts.filter(p => p.status !== 'submitted' && p.status !== 'declared_none');
        if (pending.length) {
          const names = await sql`SELECT name FROM supervisors
            WHERE supervisor_id = ANY(${pending.map(p => p.supervisor_id)}) ORDER BY name`;
          return ok({ success: false, notReady: true, pending: names.map(n => n.name),
            message: `${pending.length} supervisor(s) have not submitted yet.` });
        }

        const rows = await sql`SELECT i.*, s.name AS supervisor_name, c.name AS co_name
          FROM org_ideas i
          LEFT JOIN supervisors s ON s.supervisor_id = i.supervisor_id
          LEFT JOIN supervisors c ON c.supervisor_id = i.co_supervisor_id
          WHERE i.cycle_id = ${cycle.id} ORDER BY s.name, i.id`;
        if (!rows.length)
          return ok({ success: false, message: 'There are no project ideas to print.' });
        const caps = await supervisorCaps(sql, cycle);
        return ok({
          success: true,
          program: cycle.program, campus: cycle.campus,
          academicYear: cycle.academic_year, semester: cycle.semester,
          ideas: rows.map(r => ({
            id: r.id, title: r.title, field: r.field || '', description: r.description || '',
            prerequisites: r.prerequisites || '',
            minStudents: Number(r.min_students), maxStudents: Number(r.max_students),
            supervisor: r.supervisor_name || '', supervisorId: r.supervisor_id,
            coSupervisor: r.co_name || '',
            supervisorCapacity: caps.get(r.supervisor_id) != null ? caps.get(r.supervisor_id) : 1,
          })),
        });
      }

      // ─── Projects Organizer: deadlines, policy and the publish gate ──

      case 'orgGetCycleSettings': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        const delegateRows = cycle.deadline_delegate
          ? await sql`SELECT name FROM supervisors WHERE supervisor_id = ${cycle.deadline_delegate}` : [];
        return ok({
          success: true,
          cycle: {
            id: cycle.id, phase: cycle.phase,
            program: cycle.program, campus: cycle.campus,
            academicYear: cycle.academic_year, semester: cycle.semester,
            ideasDeadline: cycle.ideas_deadline, rankingDeadline: cycle.ranking_deadline,
            deadlinePolicy: cycle.deadline_policy, deadlineDelegate: cycle.deadline_delegate,
            deadlineDelegateName: delegateRows[0] ? delegateRows[0].name : '',
            minGroupSize: Number(cycle.min_group_size), maxGroupSize: Number(cycle.max_group_size),
          },
          canManage: canManageCycle(session, sup, cycle),
          isAdmin: isAdminUser(session),
        });
      }

      case 'orgSetDeadline': {
        // which: 'ideas' | 'ranking'; value: ISO string or '' to clear
        const [sessionToken, which, value] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (!canManageCycle(session, sup, cycle))
          return ok({ success: false, message: 'The admin has restricted who can change deadlines for your program.' });

        // Must carry a timezone. A bare "2026-09-20T10:00" would be read in the
        // server's zone (UTC on Render) and silently shift the time, so it is
        // refused rather than guessed at — the page sends a full ISO instant.
        if (value && !/(Z|[+-]\d{2}:?\d{2})$/.test(String(value)))
          return ok({ success: false, message: 'This page is out of date — please refresh (Ctrl+F5) and set the deadline again.' });
        const ts = value ? new Date(value) : null;
        if (value && isNaN(ts.getTime())) return ok({ success: false, message: 'That date is not valid.' });
        if (which === 'ideas') {
          await sql`UPDATE org_cycles SET ideas_deadline = ${ts}, updated_at = NOW() WHERE id = ${cycle.id}`;
        } else if (which === 'ranking') {
          await sql`UPDATE org_cycles SET ranking_deadline = ${ts}, updated_at = NOW() WHERE id = ${cycle.id}`;
        } else {
          return ok({ success: false, message: 'Unknown deadline type.' });
        }
        await logAudit(sql, cycle.id, 0, 'supervisor', sup.supervisor_id, sup.name,
          'deadline_set', { which, value: value || null });
        return ok({ success: true });
      }

      case 'orgSetGroupSizes': {
        const [sessionToken, minSize, maxSize] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (!canManageCycle(session, sup, cycle))
          return ok({ success: false, message: 'You are not allowed to change these settings.' });
        const mn = Number(minSize), mx = Number(maxSize);
        if (!Number.isInteger(mn) || !Number.isInteger(mx) || mn < 1 || mx > 6 || mx < mn)
          return ok({ success: false, message: 'Group sizes must be whole numbers between 1 and 6, with the maximum not below the minimum.' });
        await sql`UPDATE org_cycles SET min_group_size = ${mn}, max_group_size = ${mx}, updated_at = NOW() WHERE id = ${cycle.id}`;
        return ok({ success: true });
      }

      case 'orgSetParticipantExpected': {
        const [sessionToken, supervisorId, expected] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (!canManageCycle(session, sup, cycle))
          return ok({ success: false, message: 'You are not allowed to change the expected list.' });
        await sql`UPDATE org_participants SET expected = ${!!expected}
          WHERE cycle_id = ${cycle.id} AND supervisor_id = ${String(supervisorId)}`;
        await logAudit(sql, cycle.id, 0, 'supervisor', sup.supervisor_id, sup.name,
          'participant_expected', { supervisorId, expected: !!expected });
        return ok({ success: true });
      }

      case 'orgPublishIdeas': {
        // Opens the student side. Non-responders are recorded as having no ideas.
        const [sessionToken, force] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (!canManageCycle(session, sup, cycle))
          return ok({ success: false, message: 'The admin has restricted who can publish the idea list for your program.' });
        if (cycle.phase !== 'IDEAS_OPEN')
          return ok({ success: false, message: 'The idea list has already been published.' });

        await syncParticipants(sql, cycle);
        const parts = await sql`SELECT * FROM org_participants WHERE cycle_id = ${cycle.id} AND expected = TRUE`;
        const pending = parts.filter(p => p.status !== 'submitted' && p.status !== 'declared_none');
        const deadlineDone = deadlinePassed(cycle.ideas_deadline);

        if (pending.length && !deadlineDone && !force) {
          const names = await sql`SELECT supervisor_id, name FROM supervisors
            WHERE supervisor_id = ANY(${pending.map(p => p.supervisor_id)})`;
          return ok({
            success: false, needsForce: true,
            pending: names.map(n => n.name),
            message: `${pending.length} supervisor(s) have not responded yet and the idea deadline has not passed.`,
          });
        }

        const ideaCount = await sql`SELECT COUNT(*) AS c FROM org_ideas WHERE cycle_id = ${cycle.id}`;
        if (Number(ideaCount[0].c) === 0)
          return ok({ success: false, message: 'There are no ideas to publish. At least one supervisor must submit a project idea first.' });

        // Everyone still pending is recorded as having no ideas this semester
        for (const p of pending) {
          await sql`UPDATE org_participants SET status = 'declared_none', submitted_at = NOW()
            WHERE cycle_id = ${cycle.id} AND supervisor_id = ${p.supervisor_id}`;
        }
        await sql`UPDATE org_ideas SET status = 'submitted' WHERE cycle_id = ${cycle.id} AND status = 'draft'`;
        await sql`UPDATE org_cycles SET phase = 'RANKING_OPEN', updated_at = NOW() WHERE id = ${cycle.id}`;
        await logAudit(sql, cycle.id, 0, 'supervisor', sup.supervisor_id, sup.name,
          'ideas_published', { forced: !!force, autoDeclared: pending.length });
        return ok({ success: true, autoDeclared: pending.length, ideas: Number(ideaCount[0].c) });
      }

      case 'orgSetPhase': {
        // Manual phase moves: reopen ideas, close ranking, reopen ranking.
        const [sessionToken, phase] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (!canManageCycle(session, sup, cycle))
          return ok({ success: false, message: 'You are not allowed to change the phase.' });
        const allowed = { IDEAS_OPEN: 1, RANKING_OPEN: 1, RANKING_CLOSED: 1 };
        if (!allowed[phase]) return ok({ success: false, message: 'That phase cannot be set manually.' });
        if (cycle.phase === 'ALLOCATED')
          return ok({ success: false, message: 'The allocation has been published — this cycle is closed.' });
        await sql`UPDATE org_cycles SET phase = ${phase}, updated_at = NOW() WHERE id = ${cycle.id}`;
        await logAudit(sql, cycle.id, 0, 'supervisor', sup.supervisor_id, sup.name,
          'phase_changed', { from: cycle.phase, to: phase });
        return ok({ success: true });
      }

      // ─── Projects Organizer: admin policy control ────────────────────

      case 'orgAdminOverview': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        if (!isAdminUser(session)) return ok({ success: false, message: 'Only the admin can do this.' });
        await ensureOrganizerTables(sql);
        const { academic_year, semester } = academicContext();
        const cycles = await sql`SELECT * FROM org_cycles
          WHERE academic_year = ${academic_year} AND semester = ${semester} ORDER BY program, campus`;
        const sups = await sql`SELECT supervisor_id, name, program, campus FROM supervisors
          WHERE supervisor_id != ${ADMIN_ID} ORDER BY name`;
        const rows = [];
        for (const c of cycles) {
          const counts = await sql`SELECT COUNT(*) AS ideas FROM org_ideas WHERE cycle_id = ${c.id}`;
          const groups = await sql`SELECT COUNT(*) AS g FROM org_groups WHERE cycle_id = ${c.id}`;
          rows.push({
            id: c.id, program: c.program, campus: c.campus, phase: c.phase,
            deadlinePolicy: c.deadline_policy, deadlineDelegate: c.deadline_delegate,
            ideasDeadline: c.ideas_deadline, rankingDeadline: c.ranking_deadline,
            ideaCount: Number(counts[0].ideas), groupCount: Number(groups[0].g),
          });
        }
        return ok({
          success: true, academicYear: academic_year, semester,
          cycles: rows,
          supervisors: sups.map(s => ({ id: s.supervisor_id, name: s.name, program: s.program, campus: s.campus || '' })),
        });
      }

      // Admin-only directory of everything in the current term, across every
      // programme and campus. This is the one view that shows student names
      // alongside their group — supervisors only ever see group codes.
      case 'orgAdminDirectory': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        if (!isAdminUser(session)) return ok({ success: false, message: 'Only the admin can view this.' });
        await ensureOrganizerTables(sql);

        const { academic_year, semester } = academicContext();
        const cycles = await sql`SELECT * FROM org_cycles
          WHERE academic_year = ${academic_year} AND semester = ${semester}
          ORDER BY program, campus`;
        if (!cycles.length)
          return ok({ success: true, academicYear: academic_year, semester, campuses: [], totals: {} });

        const ids = cycles.map(c => c.id);
        const [groups, members, ideas, parts, ranks] = await Promise.all([
          sql`SELECT * FROM org_groups WHERE cycle_id = ANY(${ids}) ORDER BY group_code`,
          sql`SELECT * FROM org_group_members WHERE cycle_id = ANY(${ids}) ORDER BY id`,
          sql`SELECT i.*, s.name AS supervisor_name, c.name AS co_name
              FROM org_ideas i
              LEFT JOIN supervisors s ON s.supervisor_id = i.supervisor_id
              LEFT JOIN supervisors c ON c.supervisor_id = i.co_supervisor_id
              WHERE i.cycle_id = ANY(${ids}) ORDER BY s.name, i.id`,
          sql`SELECT p.*, s.name AS supervisor_name FROM org_participants p
              LEFT JOIN supervisors s ON s.supervisor_id = p.supervisor_id
              WHERE p.cycle_id = ANY(${ids})`,
          sql`SELECT g.cycle_id, r.group_id FROM org_rankings r
              JOIN org_groups g ON g.id = r.group_id WHERE g.cycle_id = ANY(${ids})`,
        ]);

        const rankedGroups = new Set(ranks.map(r => r.group_id));
        // Campus is the top-level split, programme sits inside it
        const byCampus = new Map();
        let tGroups = 0, tStudents = 0, tIdeas = 0, tWithIdea = 0;

        for (const cyc of cycles) {
          const cycGroups = groups.filter(g => g.cycle_id === cyc.id);
          const cycIdeas  = ideas.filter(i => i.cycle_id === cyc.id);
          const cycParts  = parts.filter(p => p.cycle_id === cyc.id);

          const groupRows = cycGroups.map(g => {
            const mem = members.filter(m => m.group_id === g.id);
            const cg = mem.map(m => m.cgpa).filter(v => v != null).map(Number);
            return {
              code: g.group_code,
              size: mem.length,
              createdAt: g.created_at,
              hasRanked: rankedGroups.has(g.id),
              avgCgpa: cg.length ? Math.round((cg.reduce((a, b) => a + b, 0) / cg.length) * 100) / 100 : null,
              proposedTitle: g.proposed_title || '',
              proposedDesc:  g.proposed_desc || '',
              members: mem.map(m => ({
                name: m.student_name, id: m.student_id,
                cgpa: m.cgpa == null ? null : Number(m.cgpa),
                email: m.email || '',
                isCreator: m.student_id === g.created_by_student_id,
              })),
            };
          });

          // Supervisors of this programme+campus, each with the ideas they wrote
          const supMap = new Map();
          cycParts.forEach(p => supMap.set(p.supervisor_id, {
            id: p.supervisor_id, name: p.supervisor_name || p.supervisor_id,
            capacity: Number(p.max_groups), status: p.status,
            expected: p.expected !== false, ideas: [],
          }));
          cycIdeas.forEach(i => {
            if (!supMap.has(i.supervisor_id)) {
              supMap.set(i.supervisor_id, {
                id: i.supervisor_id, name: i.supervisor_name || i.supervisor_id,
                capacity: 1, status: 'submitted', expected: true, ideas: [],
              });
            }
            supMap.get(i.supervisor_id).ideas.push({
              title: i.title, field: i.field || '', description: i.description || '',
              prerequisites: i.prerequisites || '',
              minStudents: Number(i.min_students), maxStudents: Number(i.max_students),
              coSupervisor: i.co_name || '', status: i.status,
            });
          });

          const withIdea = groupRows.filter(g => g.proposedTitle).length;
          const students = groupRows.reduce((a, g) => a + g.size, 0);
          tGroups += groupRows.length; tStudents += students;
          tIdeas += cycIdeas.length;   tWithIdea += withIdea;

          if (!byCampus.has(cyc.campus)) byCampus.set(cyc.campus, []);
          byCampus.get(cyc.campus).push({
            program: cyc.program, cycleId: cyc.id, phase: cyc.phase,
            groupCount: groupRows.length, studentCount: students,
            ideaCount: cycIdeas.length, groupsWithIdea: withIdea,
            groups: groupRows,
            supervisors: [...supMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
          });
        }

        // Debbieh before Tripoli, matching CAMPUSES; anything else after
        const campusOrder = c => {
          const i = CAMPUSES.indexOf(c);
          return i === -1 ? CAMPUSES.length : i;
        };
        const campuses = [...byCampus.entries()]
          .map(([campus, programs]) => ({
            campus,
            programs: programs.sort((a, b) => a.program.localeCompare(b.program)),
            totals: programs.reduce((t, p) => ({
              groups: t.groups + p.groupCount,
              students: t.students + p.studentCount,
              ideas: t.ideas + p.ideaCount,
              groupsWithIdea: t.groupsWithIdea + p.groupsWithIdea,
            }), { groups: 0, students: 0, ideas: 0, groupsWithIdea: 0 }),
          }))
          .sort((a, b) => campusOrder(a.campus) - campusOrder(b.campus));

        return ok({
          success: true, academicYear: academic_year, semester,
          campuses,
          totals: { groups: tGroups, students: tStudents, ideas: tIdeas, groupsWithIdea: tWithIdea },
        });
      }

      case 'orgSetDeadlinePolicy': {
        const [sessionToken, cycleId, policy, delegateId] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        if (!isAdminUser(session)) return ok({ success: false, message: 'Only the admin can change this.' });
        await ensureOrganizerTables(sql);
        if (!['open', 'locked', 'delegate'].includes(policy))
          return ok({ success: false, message: 'Unknown policy.' });
        const cRows = await sql`SELECT * FROM org_cycles WHERE id = ${Number(cycleId)}`;
        const cycle = cRows[0];
        if (!cycle) return ok({ success: false, message: 'Cycle not found.' });
        let delegate = '';
        if (policy === 'delegate') {
          delegate = String(delegateId || '');
          const d = await sql`SELECT supervisor_id FROM supervisors
            WHERE supervisor_id = ${delegate} AND program = ${cycle.program} AND campus = ${cycle.campus}`;
          if (!d[0]) return ok({ success: false, message: 'Choose a supervisor from that program and campus.' });
        }
        await sql`UPDATE org_cycles SET deadline_policy = ${policy}, deadline_delegate = ${delegate}, updated_at = NOW()
          WHERE id = ${Number(cycleId)}`;
        await logAudit(sql, cycle.id, 0, 'admin', session.supervisor_id, session.name || 'Admin',
          'policy_changed', { policy, delegate });
        return ok({ success: true });
      }

      // ─── Projects Organizer: student groups ──────────────────────────

      case 'orgStudentLookup': {
        const [program, campus, studentId, studentName] = args;
        const sid  = String(studentId || '').trim();
        const name = normName(studentName);
        if (!STUDENT_ID_RE.test(sid))
          return ok({ success: false, message: 'Student ID must be exactly 9 digits starting with 20.' });
        if (name.split(' ').length < 2)
          return ok({ success: false, message: 'Please enter your full name — at least a first and a family name.' });

        const cy = await studentCycle(sql, program, campus);
        if (cy.error) return ok({ success: false, message: cy.error });
        const cycle = cy.cycle;

        const found = await findStudentGroup(sql, cycle.id, sid);
        // A known ID must match the name it was registered with
        if (found && normName(found.me.student_name).toLowerCase() !== name.toLowerCase()) {
          return ok({ success: false,
            message: `ID ${sid} is already registered in a group under a different name. If this is an error, ask your coordinator.` });
        }
        return ok({
          success: true,
          cycle: {
            id: cycle.id, phase: cycle.phase, program: cycle.program, campus: cycle.campus,
            academicYear: cycle.academic_year, semester: cycle.semester,
            minGroupSize: Number(cycle.min_group_size), maxGroupSize: Number(cycle.max_group_size),
            rankingDeadline: cycle.ranking_deadline,
            rankingClosed: cycle.phase === 'RANKING_CLOSED' || cycle.phase === 'ALLOCATED'
                           || deadlinePassed(cycle.ranking_deadline),
          },
          hasGroup: !!found,
        });
      }

      case 'orgCreateGroup': {
        const [program, campus, me, others] = args;
        const cy = await studentCycle(sql, program, campus);
        if (cy.error) return ok({ success: false, message: cy.error });
        const cycle = cy.cycle;
        if (cycle.phase === 'ALLOCATED')
          return ok({ success: false, message: 'Projects for this semester have already been assigned.' });

        // The creator's email is required: it is how the department notifies the
        // group of its assigned project, and it carries into the FYP grading
        // system for the week-14 report reminder.
        const creatorEmail = String((me && me.email) || '').trim();
        if (!EMAIL_RE.test(creatorEmail))
          return ok({ success: false, message: 'Please enter a valid email address — your group will be notified there about the project assignment and report deadlines.' });

        const raw = [{ ...(me || {}), email: creatorEmail, creator: true }].concat(Array.isArray(others) ? others : []);
        const members = [];
        for (const m of raw) {
          const sid  = String((m && m.id) || '').trim();
          const name = normName(m && m.name);
          if (!STUDENT_ID_RE.test(sid))
            return ok({ success: false, message: `"${sid || '(blank)'}" is not a valid student ID — it must be 9 digits starting with 20.` });
          if (name.split(' ').length < 2)
            return ok({ success: false, message: `Please give a full name for student ${sid}.` });
          const cgpa = parseCgpa(m && m.cgpa);
          if (cgpa === null)
            return ok({ success: false,
              message: `Please enter a valid CGPA for ${name || sid} — a number between 0.00 and ${CGPA_MAX.toFixed(2)}.` });
          members.push({ id: sid, name, email: String((m && m.email) || '').trim(), cgpa, creator: !!m.creator });
        }
        if (members.length < Number(cycle.min_group_size))
          return ok({ success: false, message: `A group needs at least ${cycle.min_group_size} students.` });
        if (members.length > Number(cycle.max_group_size))
          return ok({ success: false, message: `A group can have at most ${cycle.max_group_size} students.` });

        // Duplicates inside the submitted list
        const seenId = new Set(), seenName = new Set();
        for (const m of members) {
          if (seenId.has(m.id))   return ok({ success: false, message: `Student ID ${m.id} is listed twice.` });
          if (seenName.has(m.name.toLowerCase())) return ok({ success: false, message: `"${m.name}" is listed twice.` });
          seenId.add(m.id); seenName.add(m.name.toLowerCase());
        }

        // Clashes with groups that already exist — checked up front for a clear
        // message; the unique indexes below are the real guarantee.
        const clashes = await sql`SELECT student_id, student_name FROM org_group_members
          WHERE cycle_id = ${cycle.id}
            AND (student_id = ANY(${members.map(m => m.id)})
                 OR lower(student_name) = ANY(${members.map(m => m.name.toLowerCase())}))`;
        if (clashes.length) {
          const who = clashes.map(c => `${c.student_name} (${c.student_id})`).join(', ');
          return ok({ success: false,
            message: `Already in another group: ${who}. Each student can belong to only one group.` });
        }

        const creator = members.find(m => m.creator) || members[0];

        // Claim the next sequence number. Two groups created at the same instant
        // both compute the same number; the per-cycle unique index rejects the
        // loser, which simply tries the next one.
        let groupId = null, code = '';
        let n = await nextGroupNumber(sql, cycle);
        for (let attempt = 0; attempt < 25; attempt++, n++) {
          code = formatGroupCode(cycle, n);
          try {
            const g = await sql`INSERT INTO org_groups (cycle_id, group_code, created_by_student_id, status)
              VALUES (${cycle.id}, ${code}, ${creator.id}, 'forming') RETURNING *`;
            groupId = g[0].id;
            break;
          } catch (e) {
            if (e.code === '23505') continue; // code taken, try the next number
            return ok({ success: false, message: 'Could not create the group: ' + (e.message || e) });
          }
        }
        if (!groupId)
          return ok({ success: false, message: 'Could not allocate a group number. Please try again.' });

        try {
          for (const m of members) {
            await sql`INSERT INTO org_group_members
              (cycle_id, group_id, student_id, student_name, email, cgpa, added_by_student_id)
              VALUES (${cycle.id}, ${groupId}, ${m.id}, ${m.name}, ${m.email}, ${m.cgpa}, ${creator.id})`;
          }
        } catch (e) {
          // Roll back so a half-built group never blocks the students in it
          if (groupId) {
            await sql`DELETE FROM org_group_members WHERE group_id = ${groupId}`.catch(() => {});
            await sql`DELETE FROM org_groups WHERE id = ${groupId}`.catch(() => {});
          }
          if (e.code === '23505')
            return ok({ success: false,
              message: 'One of these students was added to another group a moment ago. Please reload and check the list.' });
          return ok({ success: false, message: 'Could not create the group: ' + (e.message || e) });
        }

        await logAudit(sql, cycle.id, groupId, 'student', creator.id, creator.name,
          'group_created', { code, members: members.map(m => `${m.name} (${m.id})`) });
        return ok({ success: true, groupId, groupCode: code });
      }

      case 'orgGetGroup': {
        const [program, campus, studentId] = args;
        const cy = await studentCycle(sql, program, campus);
        if (cy.error) return ok({ success: false, message: cy.error });
        const cycle = cy.cycle;
        const sid = String(studentId || '').trim();
        const found = await findStudentGroup(sql, cycle.id, sid);
        if (!found) return ok({
          success: true, hasGroup: false,
          cycle: {
            id: cycle.id, phase: cycle.phase, program: cycle.program, campus: cycle.campus,
            minGroupSize: Number(cycle.min_group_size), maxGroupSize: Number(cycle.max_group_size),
            rankingDeadline: cycle.ranking_deadline,
          },
        });

        const ranks = await sql`SELECT r.rank, r.idea_id, i.title, i.field, i.min_students, i.max_students,
                                       s.name AS supervisor_name
          FROM org_rankings r
          JOIN org_ideas i ON i.id = r.idea_id
          LEFT JOIN supervisors s ON s.supervisor_id = i.supervisor_id
          WHERE r.group_id = ${found.group.id} ORDER BY r.rank`;
        const audit = await sql`SELECT * FROM org_audit WHERE group_id = ${found.group.id}
          ORDER BY created_at DESC LIMIT 40`;

        const rankingClosed = cycle.phase === 'RANKING_CLOSED' || cycle.phase === 'ALLOCATED'
                              || deadlinePassed(cycle.ranking_deadline);
        let allocation = null;
        if (cycle.phase === 'ALLOCATED') {
          const a = await sql`SELECT a.*, i.title, i.description, s.name AS supervisor_name
            FROM org_allocations a
            JOIN org_ideas i ON i.id = a.idea_id
            LEFT JOIN supervisors s ON s.supervisor_id = i.supervisor_id
            WHERE a.group_id = ${found.group.id} AND a.status = 'published'`;
          if (a[0]) allocation = { title: a[0].title, description: a[0].description, supervisor: a[0].supervisor_name || '' };
        }

        return ok({
          success: true, hasGroup: true,
          cycle: {
            id: cycle.id, phase: cycle.phase, program: cycle.program, campus: cycle.campus,
            rankingDeadline: cycle.ranking_deadline, rankingClosed,
            minGroupSize: Number(cycle.min_group_size), maxGroupSize: Number(cycle.max_group_size),
          },
          group: {
            id: found.group.id, code: found.group.group_code, status: found.group.status,
            rankVersion: Number(found.group.rank_version),
            rankedBy: found.group.ranked_by_student_id, rankedAt: found.group.ranked_at,
            createdBy: found.group.created_by_student_id,
            proposedTitle: found.group.proposed_title || '',
            proposedDesc:  found.group.proposed_desc || '',
            proposedAt:    found.group.proposed_at || null,
          },
          members: found.members.map(m => ({
            id: m.student_id, name: m.student_name, email: m.email || '',
            cgpa: m.cgpa == null ? null : Number(m.cgpa),
          })),
          ranking: ranks.map(r => ({
            rank: Number(r.rank), ideaId: r.idea_id, title: r.title, field: r.field || '',
            minStudents: Number(r.min_students), maxStudents: Number(r.max_students),
            supervisor: r.supervisor_name || '',
          })),
          audit: audit.map(a => ({
            at: a.created_at, actor: a.actor_name, action: a.action, details: a.details || {},
          })),
          allocation,
        });
      }

      case 'orgLeaveGroup': {
        const [program, campus, studentId] = args;
        const cy = await studentCycle(sql, program, campus);
        if (cy.error) return ok({ success: false, message: cy.error });
        const cycle = cy.cycle;
        if (cycle.phase === 'ALLOCATED' || cycle.phase === 'RANKING_CLOSED')
          return ok({ success: false, message: 'Groups are frozen — contact your coordinator.' });
        const sid = String(studentId || '').trim();
        const found = await findStudentGroup(sql, cycle.id, sid);
        if (!found) return ok({ success: false, message: 'You are not in a group.' });
        // Only the student who created the group may change its membership
        if (found.group.created_by_student_id !== sid)
          return ok({ success: false,
            message: 'Only the student who created this group can change its members. Ask them if you need to be removed.' });

        const me = found.members.find(m => m.student_id === sid);
        await sql`DELETE FROM org_rankings WHERE group_id = ${found.group.id}`;
        await sql`DELETE FROM org_group_members WHERE group_id = ${found.group.id}`;
        await sql`DELETE FROM org_groups WHERE id = ${found.group.id}`;
        await logAudit(sql, cycle.id, found.group.id, 'student', sid, me ? me.student_name : sid,
          'group_deleted', { members: found.members.length });
        return ok({ success: true, groupDeleted: true });
      }

      // A group's own project proposal — entirely optional, and stored on the
      // group rather than in org_ideas so it never enters the ranking list.
      case 'orgSaveGroupIdea': {
        const [program, campus, studentId, title, description] = args;
        const cy = await studentCycle(sql, program, campus);
        if (cy.error) return ok({ success: false, message: cy.error });
        const cycle = cy.cycle;
        if (cycle.phase === 'ALLOCATED')
          return ok({ success: false, message: 'Projects have already been assigned.' });
        const sid = String(studentId || '').trim();
        const found = await findStudentGroup(sql, cycle.id, sid);
        if (!found) return ok({ success: false, message: 'You are not in a group.' });
        if (found.group.created_by_student_id !== sid)
          return ok({ success: false, message: 'Only the student who created this group can enter or change the group idea.' });

        const t = String(title || '').trim();
        const d = String(description || '').trim();
        const me = found.members.find(m => m.student_id === sid);
        const who = me ? me.student_name : sid;

        if (!t && !d) {
          await sql`UPDATE org_groups SET proposed_title = '', proposed_desc = '',
            proposed_by = '', proposed_at = NULL WHERE id = ${found.group.id}`;
          await logAudit(sql, cycle.id, found.group.id, 'student', sid, who, 'group_idea_cleared', {});
          return ok({ success: true, cleared: true });
        }
        if (t.length < 5)  return ok({ success: false, message: 'Please give your idea a title of at least 5 characters.' });
        if (d.length < 20) return ok({ success: false, message: 'Please describe your idea in at least 20 characters.' });
        if (t.length > 160) return ok({ success: false, message: 'Please keep the title under 160 characters.' });
        if (d.length > 1200) return ok({ success: false, message: 'Please keep the description under 1200 characters.' });

        await sql`UPDATE org_groups SET proposed_title = ${t}, proposed_desc = ${d},
          proposed_by = ${sid}, proposed_at = NOW() WHERE id = ${found.group.id}`;
        await logAudit(sql, cycle.id, found.group.id, 'student', sid, who, 'group_idea_saved', { title: t });
        return ok({ success: true });
      }

      // Supervisors can see the groups that have formed, and any idea they
      // proposed, before deciding what to submit themselves.
      case 'orgGetStudentGroups': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { cycle } = ctx;

        const groups = await sql`SELECT * FROM org_groups WHERE cycle_id = ${cycle.id} ORDER BY group_code`;
        const members = await sql`SELECT group_id, cgpa FROM org_group_members WHERE cycle_id = ${cycle.id}`;
        const sizeBy = new Map(), cgpaBy = new Map();
        members.forEach(m => {
          sizeBy.set(m.group_id, (sizeBy.get(m.group_id) || 0) + 1);
          if (m.cgpa != null) cgpaBy.set(m.group_id, (cgpaBy.get(m.group_id) || []).concat(Number(m.cgpa)));
        });
        const avgCgpa = gid => {
          const v = cgpaBy.get(gid);
          return v && v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
        };
        return ok({
          success: true,
          phase: cycle.phase,
          groups: groups.map(g => ({
            // Group code and size only — student names stay hidden until the
            // allocation is published.
            code: g.group_code,
            size: sizeBy.get(g.id) || 0,
            avgCgpa: avgCgpa(g.id),
            createdAt: g.created_at,
            proposedTitle: g.proposed_title || '',
            proposedDesc:  g.proposed_desc || '',
            proposedAt:    g.proposed_at || null,
          })),
          withIdea: groups.filter(g => (g.proposed_title || '').trim()).length,
        });
      }

      // Fills in a CGPA that is still missing. Members registered before CGPA
      // became mandatory have a NULL, and nothing else would ever ask for it.
      case 'orgSetMemberCgpa': {
        const [program, campus, studentId, targetId, cgpa] = args;
        const cy = await studentCycle(sql, program, campus);
        if (cy.error) return ok({ success: false, message: cy.error });
        const cycle = cy.cycle;
        if (cycle.phase === 'ALLOCATED')
          return ok({ success: false, message: 'Projects have already been assigned.' });
        const sid = String(studentId || '').trim();
        const tid = String(targetId || '').trim();
        const found = await findStudentGroup(sql, cycle.id, sid);
        if (!found) return ok({ success: false, message: 'You are not in a group.' });
        if (found.group.created_by_student_id !== sid)
          return ok({ success: false, message: 'Only the student who created this group can enter a CGPA.' });
        const target = found.members.find(m => m.student_id === tid);
        if (!target) return ok({ success: false, message: 'That student is not in your group.' });

        const value = parseCgpa(cgpa);
        if (value === null)
          return ok({ success: false,
            message: `Please enter a valid CGPA — a number between 0.00 and ${CGPA_MAX.toFixed(2)}.` });

        await sql`UPDATE org_group_members SET cgpa = ${value}
          WHERE cycle_id = ${cycle.id} AND student_id = ${tid}`;
        const me = found.members.find(m => m.student_id === sid);
        await logAudit(sql, cycle.id, found.group.id, 'student', sid, me ? me.student_name : sid,
          'cgpa_set', { student: target.student_name, cgpa: value });
        return ok({ success: true });
      }

      case 'orgRemoveMember': {
        const [program, campus, studentId, targetId] = args;
        const cy = await studentCycle(sql, program, campus);
        if (cy.error) return ok({ success: false, message: cy.error });
        const cycle = cy.cycle;
        if (cycle.phase === 'ALLOCATED' || cycle.phase === 'RANKING_CLOSED')
          return ok({ success: false, message: 'Groups are frozen — contact your coordinator.' });
        const sid = String(studentId || '').trim();
        const tid = String(targetId || '').trim();
        const found = await findStudentGroup(sql, cycle.id, sid);
        if (!found) return ok({ success: false, message: 'You are not in a group.' });
        if (found.group.created_by_student_id !== sid)
          return ok({ success: false, message: 'Only the student who created this group can remove members.' });
        if (tid === sid)
          return ok({ success: false, message: 'You created this group — use "Delete this group" instead of removing yourself.' });

        const target = found.members.find(m => m.student_id === tid);
        if (!target) return ok({ success: false, message: 'That student is not in your group.' });
        if (found.members.length - 1 < Number(cycle.min_group_size))
          return ok({ success: false, message: `A group needs at least ${cycle.min_group_size} students.` });

        await sql`DELETE FROM org_group_members WHERE cycle_id = ${cycle.id} AND student_id = ${tid}`;
        const me = found.members.find(m => m.student_id === sid);
        await logAudit(sql, cycle.id, found.group.id, 'student', sid, me ? me.student_name : sid,
          'member_removed', { removed: `${target.student_name} (${tid})` });
        return ok({ success: true });
      }

      case 'orgAddMember': {
        const [program, campus, studentId, newMember] = args;
        const cy = await studentCycle(sql, program, campus);
        if (cy.error) return ok({ success: false, message: cy.error });
        const cycle = cy.cycle;
        if (cycle.phase === 'ALLOCATED' || cycle.phase === 'RANKING_CLOSED')
          return ok({ success: false, message: 'Groups are frozen — contact your coordinator.' });
        const sid = String(studentId || '').trim();
        const found = await findStudentGroup(sql, cycle.id, sid);
        if (!found) return ok({ success: false, message: 'You are not in a group.' });
        if (found.group.created_by_student_id !== sid)
          return ok({ success: false, message: 'Only the student who created this group can add members.' });
        if (found.members.length >= Number(cycle.max_group_size))
          return ok({ success: false, message: `A group can have at most ${cycle.max_group_size} students.` });

        const nid  = String((newMember && newMember.id) || '').trim();
        const name = normName(newMember && newMember.name);
        if (!STUDENT_ID_RE.test(nid))
          return ok({ success: false, message: 'Student ID must be 9 digits starting with 20.' });
        if (name.split(' ').length < 2)
          return ok({ success: false, message: 'Please enter their full name.' });
        const newCgpa = parseCgpa(newMember && newMember.cgpa);
        if (newCgpa === null)
          return ok({ success: false,
            message: `Please enter a valid CGPA for ${name} — a number between 0.00 and ${CGPA_MAX.toFixed(2)}.` });

        try {
          await sql`INSERT INTO org_group_members
            (cycle_id, group_id, student_id, student_name, email, cgpa, added_by_student_id)
            VALUES (${cycle.id}, ${found.group.id}, ${nid}, ${name},
                    ${String((newMember && newMember.email) || '').trim()}, ${newCgpa}, ${sid})`;
        } catch (e) {
          if (e.code === '23505')
            return ok({ success: false, message: `${name} (${nid}) is already in a group.` });
          return ok({ success: false, message: 'Could not add that student: ' + (e.message || e) });
        }
        const meRow = found.members.find(m => m.student_id === sid);
        await logAudit(sql, cycle.id, found.group.id, 'student', sid, meRow ? meRow.student_name : sid,
          'member_added', { added: `${name} (${nid})` });
        return ok({ success: true });
      }

      // ─── Projects Organizer: ranking ─────────────────────────────────

      case 'orgGetPublishedIdeas': {
        const [program, campus] = args;
        const cy = await studentCycle(sql, program, campus);
        if (cy.error) return ok({ success: false, message: cy.error });
        const cycle = cy.cycle;
        if (cycle.phase === 'IDEAS_OPEN')
          return ok({ success: true, published: false, ideas: [] });
        const rows = await sql`SELECT i.*, s.name AS supervisor_name, c.name AS co_name
          FROM org_ideas i
          LEFT JOIN supervisors s ON s.supervisor_id = i.supervisor_id
          LEFT JOIN supervisors c ON c.supervisor_id = i.co_supervisor_id
          WHERE i.cycle_id = ${cycle.id} ORDER BY s.name, i.id`;
        const caps = await supervisorCaps(sql, cycle);
        return ok({
          success: true, published: true,
          program: cycle.program, campus: cycle.campus,
          academicYear: cycle.academic_year, semester: cycle.semester,
          ideas: rows.map(r => ({
            id: r.id, title: r.title, field: r.field || '', description: r.description || '',
            prerequisites: r.prerequisites || '',
            minStudents: Number(r.min_students), maxStudents: Number(r.max_students),
            supervisor: r.supervisor_name || '', supervisorId: r.supervisor_id,
            coSupervisor: r.co_name || '',
            // How many groups this supervisor can take in total — a group may
            // not rank more of their projects than this.
            supervisorCapacity: caps.get(r.supervisor_id) != null ? caps.get(r.supervisor_id) : 1,
          })),
        });
      }

      case 'orgSaveRanking': {
        // orderedIdeaIds is the group's full preference list, best first.
        const [program, campus, studentId, orderedIdeaIds, version] = args;
        const cy = await studentCycle(sql, program, campus);
        if (cy.error) return ok({ success: false, message: cy.error });
        const cycle = cy.cycle;
        const sid = String(studentId || '').trim();
        const found = await findStudentGroup(sql, cycle.id, sid);
        if (!found) return ok({ success: false, message: 'You are not in a group.' });

        if (cycle.phase !== 'RANKING_OPEN')
          return ok({ success: false, message: 'Ranking is not open at the moment.' });
        if (deadlinePassed(cycle.ranking_deadline))
          return ok({ success: false, message: 'The deadline for changing your project choices has passed.' });

        // Optimistic locking — two teammates editing at once must not overwrite
        // each other silently.
        const current = Number(found.group.rank_version);
        if (version != null && Number(version) !== current) {
          const whoRows = await sql`SELECT student_name FROM org_group_members
            WHERE cycle_id = ${cycle.id} AND student_id = ${found.group.ranked_by_student_id}`;
          const who = whoRows[0] ? whoRows[0].student_name : 'A teammate';
          return ok({ success: false, stale: true,
            message: `${who} changed the list while you were editing. Reload to see their version before saving.` });
        }

        const ids = Array.isArray(orderedIdeaIds) ? orderedIdeaIds.map(Number) : [];
        if (new Set(ids).size !== ids.length)
          return ok({ success: false, message: 'The same project appears twice in your list.' });

        const allIdeas = await sql`SELECT id, supervisor_id FROM org_ideas WHERE cycle_id = ${cycle.id}`;
        const ideaById = new Map(allIdeas.map(i => [i.id, i]));
        for (const id of ids) {
          if (!ideaById.has(id))
            return ok({ success: false, message: 'One of the selected projects is no longer available. Please reload.' });
        }

        // No supervisor may be chosen more times than the number of groups they
        // can supervise, and the list must be complete up to that limit.
        const caps = await supervisorCaps(sql, cycle);
        const { quota, limits } = rankingQuota(allIdeas, caps);
        const perSup = new Map();
        for (const id of ids) {
          const supId = ideaById.get(id).supervisor_id;
          perSup.set(supId, (perSup.get(supId) || 0) + 1);
        }
        for (const [supId, used] of perSup) {
          const allowed = limits.get(supId);
          if (used > allowed) {
            const nameRows = await sql`SELECT name FROM supervisors WHERE supervisor_id = ${supId}`;
            const who = nameRows[0] ? nameRows[0].name : 'That supervisor';
            return ok({ success: false,
              message: `${who} can supervise only ${allowed} project(s), but you selected ${used}.` });
          }
        }
        if (ids.length !== quota) {
          const missing = quota - ids.length;
          return ok({ success: false,
            message: `Please rank ${quota} project(s) before saving — ${missing} still to add.` });
        }

        const before = await sql`SELECT r.rank, i.title FROM org_rankings r
          JOIN org_ideas i ON i.id = r.idea_id WHERE r.group_id = ${found.group.id} ORDER BY r.rank`;
        await sql`DELETE FROM org_rankings WHERE group_id = ${found.group.id}`;
        for (let i = 0; i < ids.length; i++) {
          await sql`INSERT INTO org_rankings (group_id, idea_id, rank) VALUES (${found.group.id}, ${ids[i]}, ${i + 1})`;
        }
        const after = await sql`SELECT r.rank, i.title FROM org_rankings r
          JOIN org_ideas i ON i.id = r.idea_id WHERE r.group_id = ${found.group.id} ORDER BY r.rank`;

        await sql`UPDATE org_groups SET rank_version = ${current + 1}, ranked_by_student_id = ${sid},
          ranked_at = NOW(), status = ${ids.length ? 'ranked' : 'forming'} WHERE id = ${found.group.id}`;

        const meRow = found.members.find(m => m.student_id === sid);
        await logAudit(sql, cycle.id, found.group.id, 'student', sid, meRow ? meRow.student_name : sid,
          'ranking_saved', {
            before: before.map(b => b.title),
            after: after.map(a => a.title),
            count: ids.length,
          });
        return ok({ success: true, version: current + 1 });
      }

      // ─── Projects Organizer: assignment console ──────────────────────

      case 'orgGetAssignmentBoard': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;

        const [groups, ideas, ranks, allocs, parts] = await Promise.all([
          sql`SELECT * FROM org_groups WHERE cycle_id = ${cycle.id} ORDER BY group_code`,
          sql`SELECT i.*, s.name AS supervisor_name FROM org_ideas i
              LEFT JOIN supervisors s ON s.supervisor_id = i.supervisor_id
              WHERE i.cycle_id = ${cycle.id} ORDER BY s.name, i.id`,
          sql`SELECT r.* , g.cycle_id FROM org_rankings r
              JOIN org_groups g ON g.id = r.group_id WHERE g.cycle_id = ${cycle.id} ORDER BY r.rank`,
          sql`SELECT * FROM org_allocations WHERE cycle_id = ${cycle.id}`,
          sql`SELECT * FROM org_participants WHERE cycle_id = ${cycle.id}`,
        ]);
        const memberRows = await sql`SELECT group_id, student_id, cgpa FROM org_group_members WHERE cycle_id = ${cycle.id}`;

        const sizeBy = new Map(), cgpaLists = new Map();
        memberRows.forEach(m => {
          sizeBy.set(m.group_id, (sizeBy.get(m.group_id) || 0) + 1);
          if (m.cgpa != null) cgpaLists.set(m.group_id, (cgpaLists.get(m.group_id) || []).concat(Number(m.cgpa)));
        });
        const groupAvg = gid => {
          const v = cgpaLists.get(gid);
          return v && v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
        };
        const ideaBy  = new Map(ideas.map(i => [i.id, i]));
        const allocBy = new Map(allocs.map(a => [a.group_id, a]));
        const capBy   = new Map(parts.map(p => [p.supervisor_id, Number(p.max_groups)]));

        // Groups stay anonymous — code and size only, never student names.
        const groupRows = groups.map(g => {
          const prefs = ranks.filter(r => r.group_id === g.id)
            .map(r => { const i = ideaBy.get(r.idea_id); return i ? { rank: Number(r.rank), ideaId: i.id, title: i.title, supervisor: i.supervisor_name || '' } : null; })
            .filter(Boolean);
          const a = allocBy.get(g.id);
          const assignedIdea = a ? ideaBy.get(a.idea_id) : null;
          const size = sizeBy.get(g.id) || 0;
          const warnings = [];
          if (assignedIdea) {
            if (size < Number(assignedIdea.min_students) || size > Number(assignedIdea.max_students))
              warnings.push(`Group of ${size} is outside this project's range of ${assignedIdea.min_students}–${assignedIdea.max_students}.`);
          }
          return {
            id: g.id, code: g.group_code, size, status: g.status,
            avgCgpa: groupAvg(g.id),
            prefs,
            assignedIdeaId: a ? a.idea_id : null,
            assignedTitle: assignedIdea ? assignedIdea.title : '',
            assignedRank: a ? Number(a.assigned_rank) : 0,
            published: a ? a.status === 'published' : false,
            warnings,
          };
        });

        // Supervisor load against declared capacity
        const loadBy = new Map();
        allocs.forEach(a => {
          const i = ideaBy.get(a.idea_id);
          if (i) loadBy.set(i.supervisor_id, (loadBy.get(i.supervisor_id) || 0) + 1);
        });
        const overloaded = [];
        loadBy.forEach((n, supId) => {
          const cap = capBy.has(supId) ? capBy.get(supId) : 2;
          if (n > cap) {
            const nm = ideas.find(i => i.supervisor_id === supId);
            overloaded.push({ supervisor: nm ? nm.supervisor_name : supId, assigned: n, capacity: cap });
          }
        });

        return ok({
          success: true,
          canManage: canManageCycle(session, sup, cycle),
          cycle: {
            id: cycle.id, phase: cycle.phase, program: cycle.program, campus: cycle.campus,
            academicYear: cycle.academic_year, semester: cycle.semester,
          },
          groups: groupRows,
          ideas: ideas.map(i => ({
            id: i.id, title: i.title, supervisor: i.supervisor_name || '', supervisorId: i.supervisor_id,
            minStudents: Number(i.min_students), maxStudents: Number(i.max_students),
            taken: allocs.some(a => a.idea_id === i.id),
          })),
          unassigned: groupRows.filter(g => !g.assignedIdeaId).length,
          overloaded,
        });
      }

      case 'orgSetAssignment': {
        const [sessionToken, groupId, ideaId] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (!canManageCycle(session, sup, cycle))
          return ok({ success: false, message: 'You are not allowed to assign projects for this program.' });
        if (cycle.phase === 'ALLOCATED')
          return ok({ success: false, message: 'The allocation has already been published.' });

        const g = await sql`SELECT * FROM org_groups WHERE id = ${Number(groupId)} AND cycle_id = ${cycle.id}`;
        if (!g[0]) return ok({ success: false, message: 'Group not found.' });
        const i = await sql`SELECT * FROM org_ideas WHERE id = ${Number(ideaId)} AND cycle_id = ${cycle.id}`;
        if (!i[0]) return ok({ success: false, message: 'Project idea not found.' });

        const taken = await sql`SELECT a.group_id, g.group_code FROM org_allocations a
          JOIN org_groups g ON g.id = a.group_id
          WHERE a.cycle_id = ${cycle.id} AND a.idea_id = ${Number(ideaId)} AND a.group_id != ${Number(groupId)}`;
        if (taken.length)
          return ok({ success: false, message: `That project is already assigned to group ${taken[0].group_code}.` });

        const rankRow = await sql`SELECT rank FROM org_rankings
          WHERE group_id = ${Number(groupId)} AND idea_id = ${Number(ideaId)}`;
        const assignedRank = rankRow[0] ? Number(rankRow[0].rank) : 0;

        try {
          await sql`INSERT INTO org_allocations (cycle_id, group_id, idea_id, assigned_rank, assigned_by, status)
            VALUES (${cycle.id}, ${Number(groupId)}, ${Number(ideaId)}, ${assignedRank}, ${sup.supervisor_id}, 'draft')
            ON CONFLICT (cycle_id, group_id)
            DO UPDATE SET idea_id = ${Number(ideaId)}, assigned_rank = ${assignedRank},
                          assigned_by = ${sup.supervisor_id}, created_at = NOW()`;
        } catch (e) {
          // The (cycle_id, idea_id) unique index catches a colleague assigning
          // the same project a moment earlier
          if (e.code === '23505')
            return ok({ success: false, message: 'Another supervisor just assigned that project to a different group. Refresh to see the current state.' });
          throw e;
        }
        await logAudit(sql, cycle.id, Number(groupId), 'supervisor', sup.supervisor_id, sup.name,
          'assignment_set', { group: g[0].group_code, idea: i[0].title, rank: assignedRank });
        return ok({ success: true, assignedRank });
      }

      case 'orgClearAssignment': {
        const [sessionToken, groupId] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (!canManageCycle(session, sup, cycle))
          return ok({ success: false, message: 'You are not allowed to change assignments.' });
        if (cycle.phase === 'ALLOCATED')
          return ok({ success: false, message: 'The allocation has already been published.' });
        await sql`DELETE FROM org_allocations WHERE cycle_id = ${cycle.id} AND group_id = ${Number(groupId)}`;
        await logAudit(sql, cycle.id, Number(groupId), 'supervisor', sup.supervisor_id, sup.name,
          'assignment_cleared', {});
        return ok({ success: true });
      }

      // ─── Projects Organizer: publish into the FYP system ─────────────

      case 'orgDryRunPublish': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (!canManageCycle(session, sup, cycle))
          return ok({ success: false, message: 'You are not allowed to publish for this program.' });

        const report = await buildPublishReport(sql, cycle);
        return ok({ success: true, ...report });
      }

      case 'orgPublishAllocation': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok(sessionGone(sessionToken));
        const ctx = await orgContext(sql, session);
        if (ctx.error) return ok({ success: false, message: ctx.error });
        const { sup, cycle } = ctx;
        if (!canManageCycle(session, sup, cycle))
          return ok({ success: false, message: 'You are not allowed to publish for this program.' });
        if (cycle.phase === 'ALLOCATED')
          return ok({ success: false, message: 'This allocation has already been published.' });

        const report = await buildPublishReport(sql, cycle);
        if (!report.ready)
          return ok({ success: false, message: 'The pre-flight check found problems. Fix them and run the check again.', ...report });

        const created = [];
        for (const row of report.plan) {
          const projectId = uid('PRJ');
          const insertedIds = [];
          try {
            for (const s of row.students) {
              await sql`INSERT INTO students (student_id, student_name, email, project_id)
                VALUES (${s.id}, ${s.name}, ${s.email || ''}, ${projectId})`;
              insertedIds.push(s.id);
            }
            await sql`INSERT INTO projects
              (project_id, title, type, semester, year, end_date, program_type, supervisors, students, disable_notifications)
              VALUES (${projectId}, ${row.title}, 'FYP1', ${cycle.semester}, ${cycle.academic_year}, '',
                      ${cycle.program}, ${row.supervisorIds.join(',')}, ${insertedIds.join(',')},
                      ${!row.hasEmail})`;
            await sql`UPDATE org_allocations SET status = 'published', project_id = ${projectId}
              WHERE cycle_id = ${cycle.id} AND group_id = ${row.groupId}`;
            await sql`UPDATE org_groups SET status = 'allocated' WHERE id = ${row.groupId}`;
            created.push({ group: row.code, title: row.title, projectId });
          } catch (e) {
            // Undo this project only; earlier ones already published stay valid
            for (const sid of insertedIds) await sql`DELETE FROM students WHERE student_id = ${sid}`.catch(() => {});
            await sql`DELETE FROM projects WHERE project_id = ${projectId}`.catch(() => {});
            return ok({
              success: false,
              message: `Created ${created.length} project(s), then failed on group ${row.code}: ${e.message || e}. `
                     + 'The failed project was rolled back; the successful ones remain and will be skipped if you publish again.',
              created,
            });
          }
        }

        await sql`UPDATE org_cycles SET phase = 'ALLOCATED', updated_at = NOW() WHERE id = ${cycle.id}`;
        await logAudit(sql, cycle.id, 0, 'supervisor', sup.supervisor_id, sup.name,
          'allocation_published', { projects: created.length });
        return ok({ success: true, created });
      }

      case 'setAndEmailCredentials': {
        const [sessionToken, targets] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        const sent = [], failed = [];
        for (const t of (targets || [])) {
          if (!t.id || !t.password) continue;
          await sql`UPDATE supervisors SET password = ${hashPwd(String(t.password))} WHERE supervisor_id = ${String(t.id)}`;
          const shouldEmail = t.sendEmail === true || t.sendEmail === 'true' || t.sendEmail === 1;
          if (t.email && shouldEmail) {
            try {
              await sendEmail(
                String(t.email),
                'FYP Management & Grading System — Your Login Credentials',
                `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;"><tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
  <tr><td align="center" style="background:#ffffff;padding:28px 40px 16px;"><img src="https://usif-3jra.github.io/epme-study-plan/assets/logo_ECE.png" alt="BAU ECE" width="130" style="display:block;max-width:130px;height:auto;"/></td></tr>
  <tr><td style="background:#0a1f44;padding:24px 40px;text-align:center;"><div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:.02em;margin-bottom:6px;">FYP Management &amp; Grading System</div><div style="color:#94a3b8;font-size:13px;">Beirut Arab University — Faculty of Engineering — ECE Department</div></td></tr>
  <tr><td style="padding:32px 40px;color:#2d2d2d;font-size:15px;line-height:1.7;">
    <p style="margin:0 0 16px;">Dear ${t.name || t.id},</p>
    <p style="margin:0 0 16px;">We are pleased to inform you that your account for the <strong>FYP Management &amp; Grading System</strong> has been successfully created.</p>
    <p style="margin:0 0 20px;">Please find your login credentials below:</p>
    <div style="background:#f0f4ff;border-left:4px solid #0a1f44;border-radius:6px;padding:18px 24px;margin:0 0 20px;">
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        <tr><td style="font-size:13px;color:#6b7280;font-weight:600;padding:5px 0;width:140px;">Supervisor ID</td><td style="font-size:15px;font-family:'Courier New',monospace;font-weight:700;color:#0a1f44;padding:5px 0;">${t.id}</td></tr>
        <tr><td style="font-size:13px;color:#6b7280;font-weight:600;padding:5px 0;border-top:1px solid #dde3f3;">Password</td><td style="font-size:15px;font-family:'Courier New',monospace;font-weight:700;color:#0a1f44;padding:5px 0;border-top:1px solid #dde3f3;">${t.password}</td></tr>
      </table>
    </div>
    <p style="margin:0 0 20px;color:#6b7280;font-size:13px;">For security purposes, this password has been auto-generated by the system. You are strongly advised to change it upon your first login.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 12px;">
      <tr><td><a href="${APP_URL}/fyp" style="display:inline-block;background:#fff;color:#0a1f44;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;border:2px solid #0a1f44;">Open FYP Grading System</a></td></tr>
    </table>
    <p style="margin:0 0 12px;color:#6b7280;font-size:13px;">To access the FYP assessment rubrics, please use the button below:</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr><td><a href="https://mirror-logic.github.io/fyp-grading/FYP%20Grading%20and%20Rubrics.pdf" style="display:inline-block;background:#fff;color:#0a1f44;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;border:2px solid #0a1f44;">FYP 1 &amp; 2 Rubrics</a></td></tr>
    </table>
    <p style="margin:0 0 8px;">Should you encounter any issues or have suggestions for improving the system, you are welcome to submit your feedback directly through the <strong>Feedback</strong> button available on the dashboard after logging in.</p>
    <p style="margin:0 0 4px;">Best regards,</p>
    <p style="margin:0 0 2px;font-weight:600;">ECE Department Administration</p>
    <p style="margin:0;color:#6b7280;font-size:13px;">Faculty of Engineering — Beirut Arab University</p>
  </td></tr>
  <tr><td style="border-top:1px solid #e5e7eb;padding:16px 40px;text-align:center;color:#9ca3af;font-size:11px;background:#f9fafb;">
    &copy; 2026 Beirut Arab University — Faculty of Engineering — ECE Department<br/>
    This is an automated message. Please do not reply directly to this email.
  </td></tr>
</table>
</td></tr></table>
</body></html>`
              );
              sent.push(String(t.id));
            } catch { failed.push(String(t.id)); }
          }
        }
        return ok({ success: true, sent, failed });
      }

      case 'addProgram': {
        const [sessionToken, name] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        if (!name) return ok({ success: false, message: 'Program name is required.' });
        try {
          await sql`INSERT INTO programs (program_name) VALUES (${name})`;
        } catch { return ok({ success: false, message: 'Program already exists.' }); }
        return ok({ success: true });
      }

      // ─── Projects & Students ─────────────────────────────────────────

      case 'registerProject': {
        const [sessionToken, payload] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });

        const payloadStudents = (payload.students || []);

        // Within-payload duplicate check — catch duplicates before any DB write
        const seenIds   = new Set();
        const seenNames = new Set();
        for (const s of payloadStudents) {
          if (seenIds.has(s.id))
            return ok({ success: false, message: `Duplicate Student ID "${s.id}" — each student must have a unique ID.` });
          seenIds.add(s.id);
          const normName = s.name.toLowerCase().trim();
          if (seenNames.has(normName))
            return ok({ success: false, message: `Duplicate Student name "${s.name}" — each student must have a unique name.` });
          seenNames.add(normName);
        }

        const existingProjects = await sql`SELECT title FROM projects`;
        if (existingProjects.some(r => r.title.trim().toLowerCase() === (payload.title || '').trim().toLowerCase()))
          return ok({ success: false, message: `A project titled "${payload.title}" already exists. Please use a unique title.` });

        const allStudents = await sql`SELECT student_id, student_name FROM students`;
        for (const s of payloadStudents) {
          if (allStudents.some(r => r.student_name.toLowerCase().trim() === s.name.toLowerCase().trim()))
            return ok({ success: false, message: `Student name "${s.name}" is already registered in another project.` });
          if (allStudents.some(r => r.student_id === s.id))
            return ok({ success: false, message: `Student ID "${s.id}" is already registered in another project.` });
        }

        const idFmt = /^20\d{7}$/;
        for (const s of payloadStudents) {
          if (!idFmt.test(s.id)) return ok({ success: false, message: `Invalid Student ID "${s.id}" — must be exactly 9 digits starting with 20.` });
        }
        const supIds = (payload.supervisors || []).map(s => s.id);
        if (new Set(supIds).size !== supIds.length) return ok({ success: false, message: 'Duplicate supervisors are not allowed.' });
        if (!payload.disableNotifications && !payloadStudents.some(s => s.email && s.email.trim()))
          return ok({ success: false, message: 'At least one student email is required when notifications are enabled.' });

        // All validation passed — insert atomically; roll back students if project insert fails
        const projectId        = uid('PRJ');
        const insertedStudentIds = [];
        try {
          for (const s of payloadStudents) {
            await sql`INSERT INTO students (student_id, student_name, email, project_id) VALUES (${s.id}, ${s.name}, ${s.email || ''}, ${projectId})`;
            insertedStudentIds.push(s.id);
          }
          await sql`INSERT INTO projects (project_id, title, type, semester, year, end_date, program_type, supervisors, students, disable_notifications) VALUES (${projectId}, ${payload.title}, ${payload.type}, ${payload.semester}, ${payload.year}, ${payload.endDate || ''}, ${payload.programType || ''}, ${supIds.join(',')}, ${insertedStudentIds.join(',')}, ${!!payload.disableNotifications})`;
        } catch (insertErr) {
          // Remove every student inserted in this attempt so the DB stays clean
          for (const sid of insertedStudentIds) {
            await sql`DELETE FROM students WHERE student_id = ${sid}`.catch(() => {});
          }
          return ok({ success: false, message: 'Registration failed due to a database error — no data was saved. Please correct the information and try again.' });
        }
        return ok({ success: true, projectId });
      }

      case 'getProjects': {
        const data = await sql`SELECT * FROM projects ORDER BY created_at DESC`;
        return ok(data.map(mapProject));
      }

      case 'getProjectsFiltered': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok([]);
        const [allProjects, allSups] = await Promise.all([
          sql`SELECT * FROM projects ORDER BY created_at DESC`,
          sql`SELECT * FROM supervisors`,
        ]);
        const filtered = await filterProjectsBySession(session, allProjects, allSups);
        return ok(filtered.map(mapProject));
      }

      case 'getStudents': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok([]);
        const allStudents = await sql`SELECT * FROM students`;
        if (session.is_admin) return ok(allStudents.map(mapStudent));
        const [allProjects, allSups] = await Promise.all([
          sql`SELECT * FROM projects`,
          sql`SELECT * FROM supervisors`,
        ]);
        const progProjects = await filterProjectsBySession(session, allProjects, allSups);
        const ids = new Set(progProjects.map(p => p.project_id));
        return ok(allStudents.filter(s => ids.has(s.project_id)).map(mapStudent));
      }

      case 'getProjectsWithStudents': {
        const [sessionToken] = args;
        if (!await verifySession(sessionToken)) return ok([]);
        const [projects, students] = await Promise.all([
          sql`SELECT * FROM projects`,
          sql`SELECT * FROM students`,
        ]);
        return ok(projects.map(p => ({ ...mapProject(p), studentList: students.filter(s => s.project_id === p.project_id).map(mapStudent) })));
      }

      case 'getAllProjectsSummary': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok([]);
        let data;
        if (session.is_admin) {
          data = await sql`SELECT project_id, title, type, supervisors FROM projects ORDER BY title`;
        } else {
          const needle = session.supervisor_id.trim().toLowerCase();
          const all = await sql`SELECT project_id, title, type, supervisors FROM projects ORDER BY title`;
          data = all.filter(p => (p.supervisors || '').split(',').map(x => x.trim().toLowerCase()).includes(needle));
        }
        return ok(data.map(r => ({ ProjectID: r.project_id, Title: r.title, Type: r.type, Supervisors: r.supervisors || '' })));
      }

      case 'getSupervisedProjectsForGrading': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok([]);
        const needle = session.supervisor_id.trim().toLowerCase();
        const [projects, students] = await Promise.all([
          sql`SELECT * FROM projects`,
          sql`SELECT * FROM students`,
        ]);
        return ok(projects
          .filter(p => (p.supervisors || '').split(',').map(x => x.trim().toLowerCase()).includes(needle))
          .map(p => ({
            ProjectID: p.project_id, Title: p.title, Type: p.type,
            studentList: students.filter(s => s.project_id === p.project_id)
              .map(s => ({ StudentID: s.student_id, StudentName: s.student_name })),
          })));
      }

      // ─── Teamwork Config ─────────────────────────────────────────────

      case 'getTeamworkConfig': return ok(await getTWConfig());

      case 'getIndividualRubric': return ok(await getIndividualRubric());

      case 'saveTeamworkConfig': {
        const [sessionToken, updates] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        if (!session.is_admin) return ok({ success: false, message: 'Only the admin can change grade weights.' });
        const twV   = parseFloat(updates.teamwork_weight     || 0);
        const repV  = parseFloat(updates.report_weight       || 0);
        const presV = parseFloat(updates.presentation_weight || 0);
        const supV  = parseFloat(updates.supervisor_weight   || 0);
        const peerV = parseFloat(updates.peer_eval_weight    || 0);
        if (Math.round(twV + repV + presV) !== 100)
          return ok({ success: false, message: `Teamwork + Report + Presentation must sum to 100% (currently ${twV + repV + presV}%).` });
        if (Math.round(supV + peerV) !== 100)
          return ok({ success: false, message: `Supervisor + Peer Eval portions must sum to 100% (currently ${supV + peerV}%).` });
        for (const [key, value] of Object.entries(updates || {})) {
          await sql`INSERT INTO tw_config (config_key, config_value) VALUES (${key}, ${String(value)}) ON CONFLICT (config_key) DO UPDATE SET config_value = ${String(value)}`;
        }
        return ok({ success: true });
      }

      case 'getSemesterEndDate': {
        const cfg = await getTWConfig();
        return ok({ success: true, date: cfg.semester_end_date || '' });
      }

      case 'saveSemesterEndDate': {
        const [sessionToken, date] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        await sql`INSERT INTO tw_config (config_key, config_value) VALUES ('semester_end_date', ${String(date || '')}) ON CONFLICT (config_key) DO UPDATE SET config_value = ${String(date || '')}`;
        return ok({ success: true });
      }

      case 'saveWeek14Date': {
        const [sessionToken, date] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        await sql`INSERT INTO tw_config (config_key, config_value) VALUES ('week14_date', ${String(date || '')}) ON CONFLICT (config_key) DO UPDATE SET config_value = ${String(date || '')}`;
        return ok({ success: true });
      }

      case 'setTWLock': {
        const [sessionToken, locked] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        await sql`INSERT INTO tw_config (config_key, config_value) VALUES ('tw_locked', ${locked ? 'true' : 'false'}) ON CONFLICT (config_key) DO UPDATE SET config_value = ${locked ? 'true' : 'false'}`;
        if (locked) {
          const [allProjects, allStudents, existingGrades] = await Promise.all([
            sql`SELECT * FROM projects`,
            sql`SELECT * FROM students`,
            sql`SELECT * FROM tw_grades WHERE grade_type = 'Individual'`,
          ]);
          const indRubric = await getIndividualRubric();
          const ts = new Date().toISOString();
          for (const proj of allProjects) {
            const projStudents = allStudents.filter(s => s.project_id === proj.project_id);
            const projGrades   = existingGrades.filter(g => g.project_id === proj.project_id);
            for (const student of projStudents) {
              for (const r of indRubric) {
                const hasGrade = projGrades.some(g => g.student_id === student.student_id && g.criterion === r.criterion);
                if (!hasGrade) {
                  const minGrade = Math.round(Number(r.maxGrade || 25) * 0.45 * 10) / 10;
                  await sql`INSERT INTO tw_grades (grade_id, project_id, student_id, criterion, grade, graded_by, grade_type, timestamp) VALUES (${uid('TG')}, ${proj.project_id}, ${student.student_id}, ${r.criterion}, ${minGrade}, ${'system'}, ${'Individual'}, ${ts})`;
                }
              }
            }
          }
        }
        return ok({ success: true, locked: !!locked });
      }

      case 'saveTWRubric': {
        const [sessionToken, type, criteria] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        if (!session.is_admin) return ok({ success: false, message: 'Only the admin can save rubrics.' });
        const key  = type === 'group' ? 'group_rubric' : 'individual_rubric';
        const safe = (criteria || []).map(c => ({
          criterion:   String(c.criterion || ''),
          maxGrade:    Math.max(1, Number(c.maxGrade || 25)),
          weight:      Math.max(0, Number(c.weight   || 0)),
          abetOutcome: String(c.abetOutcome || ''),
        }));
        await sql`INSERT INTO tw_config (config_key, config_value) VALUES (${key}, ${JSON.stringify(safe)}) ON CONFLICT (config_key) DO UPDATE SET config_value = ${JSON.stringify(safe)}`;
        return ok({ success: true });
      }

      // ─── Teamwork Grading ────────────────────────────────────────────

      case 'getTeamworkGrades': {
        const [sessionToken, projectId] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok([]);

        const twCfgG = await getTWConfig();
        const dateLocked = twCfgG.week14_date && (() => { const w = new Date(twCfgG.week14_date); w.setHours(23,59,59,999); return new Date() > w; })();
        const isLockedG  = twCfgG.tw_locked === 'true' || dateLocked;

        if (isLockedG) {
          const [projStudents, existingG] = await Promise.all([
            sql`SELECT * FROM students WHERE project_id = ${projectId}`,
            sql`SELECT * FROM tw_grades WHERE project_id = ${projectId} AND grade_type = 'Individual'`,
          ]);
          const indRubric = await getIndividualRubric();
          const ts = new Date().toISOString();
          for (const student of projStudents) {
            for (const r of indRubric) {
              const hasGrade = existingG.some(g => g.student_id === student.student_id && g.criterion === r.criterion);
              if (!hasGrade) {
                const minGrade = Math.round(Number(r.maxGrade || 25) * 0.45 * 10) / 10;
                await sql`INSERT INTO tw_grades (grade_id, project_id, student_id, criterion, grade, graded_by, grade_type, timestamp) VALUES (${uid('TG')}, ${projectId}, ${student.student_id}, ${r.criterion}, ${minGrade}, ${'system'}, ${'Individual'}, ${ts})`;
              }
            }
          }
        }

        const rows = await sql`
          SELECT DISTINCT ON (g.student_id, g.criterion)
            g.student_id, g.criterion, g.grade, g.graded_by, s.name AS supervisor_name
          FROM tw_grades g
          LEFT JOIN supervisors s ON s.supervisor_id = g.graded_by
          WHERE g.project_id = ${projectId} AND g.grade_type = 'Individual'
          ORDER BY g.student_id, g.criterion, g.timestamp DESC
        `;
        return ok(rows.map(r => ({
          studentId:  r.student_id,
          criterion:  r.criterion,
          grade:      Number(r.grade),
          gradedBy:   r.graded_by === 'system' ? 'Auto-filled (45% min)' : (r.supervisor_name || r.graded_by),
          isMe:       r.graded_by === session.supervisor_id,
        })));
      }

      case 'submitTeamworkGrades': {
        const [sessionToken, projectId, groupGrades, individualGrades] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const twCfg = await getTWConfig();
        if (twCfg.tw_locked === 'true') return ok({ success: false, message: 'Teamwork grading has been locked by the administrator.' });
        if (twCfg.week14_date) {
          const w14 = new Date(twCfg.week14_date); w14.setHours(23, 59, 59, 999);
          if (new Date() > w14) return ok({ success: false, message: 'Teamwork grades are locked after the Week 14 deadline and cannot be changed.' });
        }
        const gradedBy = session.supervisor_id;
        await sql`DELETE FROM tw_grades WHERE project_id = ${projectId}`;
        const ts = new Date().toISOString();
        for (const g of (individualGrades || [])) {
          await sql`INSERT INTO tw_grades (grade_id, project_id, student_id, criterion, grade, graded_by, grade_type, timestamp) VALUES (${uid('TG')}, ${projectId}, ${g.studentId}, ${g.criterion}, ${g.grade}, ${gradedBy}, 'Individual', ${ts})`;
        }
        return ok({ success: true });
      }

      case 'saveTeamworkDraft': {
        const [sessionToken, projectId, individualGrades] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const twCfg2 = await getTWConfig();
        if (twCfg2.tw_locked === 'true') return ok({ success: false, message: 'Teamwork grading has been locked by the administrator.' });
        if (twCfg2.week14_date) {
          const w14 = new Date(twCfg2.week14_date); w14.setHours(23, 59, 59, 999);
          if (new Date() > w14) return ok({ success: false, message: 'Teamwork grades are locked after the Week 14 deadline.' });
        }
        const gradedBy = session.supervisor_id;
        await sql`DELETE FROM tw_grades WHERE project_id = ${projectId}`;
        const ts = new Date().toISOString();
        for (const g of (individualGrades || [])) {
          if (g.grade === null || g.grade === undefined || isNaN(g.grade)) continue;
          await sql`INSERT INTO tw_grades (grade_id, project_id, student_id, criterion, grade, graded_by, grade_type, timestamp) VALUES (${uid('TG')}, ${projectId}, ${g.studentId}, ${g.criterion}, ${g.grade}, ${gradedBy}, 'Individual', ${ts})`;
        }
        return ok({ success: true });
      }

      case 'getMyPendingTasks': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, twTasks: [], examTasks: [] });
        if (session.is_admin) return ok({ success: true, twTasks: [], examTasks: [] });

        const supId = session.supervisor_id;

        // TW lock state — skip TW tasks when grading is not actionable
        const twCfg          = await getTWConfig();
        const twManualLocked = twCfg.tw_locked === 'true';
        const twDateLocked   = twCfg.week14_date
          ? (() => { try { const w = new Date(twCfg.week14_date); w.setHours(23,59,59,999); return new Date() > w; } catch { return false; } })()
          : false;
        const twIsLocked = twManualLocked || twDateLocked;
        const week14Label = twCfg.week14_date || '';
        const semEndLabel = twCfg.semester_end_date || '';

        // ── TW tasks: projects this supervisor owns that are not fully graded ──
        const twTasks = [];
        if (!twIsLocked) {
          const allProjects = await sql`SELECT project_id, title, type, supervisors FROM projects`;
          const myProjects  = allProjects.filter(p =>
            (p.supervisors || '').split(',').map(s => s.trim()).includes(supId)
          );
          if (myProjects.length) {
            const myProjIds = myProjects.map(p => p.project_id);
            const [allStudents, allGrades, indRubric] = await Promise.all([
              sql`SELECT student_id, project_id FROM students WHERE project_id = ANY(${myProjIds})`,
              sql`SELECT project_id, student_id, criterion, graded_by FROM tw_grades WHERE project_id = ANY(${myProjIds}) AND grade_type = 'Individual'`,
              getIndividualRubric(),
            ]);
            for (const proj of myProjects) {
              const pid          = proj.project_id;
              const projStudents = allStudents.filter(s => s.project_id === pid);
              if (!projStudents.length || !indRubric.length) continue;
              const expected    = projStudents.length * indRubric.length;
              const humanGrades = allGrades.filter(g => g.project_id === pid && g.graded_by !== 'system').length;
              if (humanGrades < expected) {
                twTasks.push({ projectId: pid, title: proj.title, type: String(proj.type || 'FYP1'),
                  status: humanGrades === 0 ? 'not_started' : 'in_progress', graded: humanGrades, total: expected });
              }
            }
          }
        }

        // ── Examiner tasks: assignments where this supervisor is the examiner ──
        const examTasks = [];
        const supEmailRows = await sql`SELECT email FROM supervisors WHERE supervisor_id = ${supId}`;
        const supEmail = supEmailRows[0] ? String(supEmailRows[0].email || '').trim().toLowerCase() : '';
        if (supEmail) {
          const assignments = await sql`
            SELECT e.project_id, e.examiner_type, e.status, e.token, e.report_link,
                   p.title AS project_title, p.supervisors AS proj_sups
            FROM examiners e
            LEFT JOIN projects p ON p.project_id = e.project_id
            WHERE LOWER(e.examiner_email) = ${supEmail} AND e.status != 'Submitted'
          `;
          if (assignments.length) {
            const allSupIds = [...new Set(
              assignments.flatMap(a => (a.proj_sups || '').split(',').map(s => s.trim()).filter(Boolean))
            )];
            const supNameRows = allSupIds.length
              ? await sql`SELECT supervisor_id, name FROM supervisors WHERE supervisor_id = ANY(${allSupIds})`
              : [];
            const supNameMap = {};
            supNameRows.forEach(r => { supNameMap[r.supervisor_id] = r.name; });
            for (const a of assignments) {
              const supIds = (a.proj_sups || '').split(',').map(s => s.trim()).filter(Boolean);
              const supervisorNames = supIds.map(id => supNameMap[id] || id).join(', ') || '—';
              const isIndustry = a.examiner_type === 'Industry';
              const missing    = isIndustry             ? ['Presentation']
                               : a.status === 'Pending' ? ['Report', 'Presentation']
                               :                          ['Presentation'];
              examTasks.push({ projectId: a.project_id, projectTitle: a.project_title || '—',
                supervisorNames, examinerType: a.examiner_type, status: a.status,
                token: a.token, missing, reportLink: a.report_link || '' });
            }
          }
        }

        return ok({ success: true, twTasks, examTasks, week14Label, semEndLabel });
      }

      case 'submitFeedback': {
        const [sessionToken, message] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const from = session.name || session.supervisor_id;
        const ts   = new Date().toISOString();
        // Always store in DB first so feedback is never lost
        if (!_feedbackTableReady) {
          await sql`CREATE TABLE IF NOT EXISTS feedback (
            id TEXT PRIMARY KEY, supervisor_id TEXT, supervisor_name TEXT,
            program TEXT, message TEXT, submitted_at TIMESTAMPTZ DEFAULT NOW(), is_read BOOLEAN DEFAULT FALSE
          )`;
          _feedbackTableReady = true;
        }
        await sql`INSERT INTO feedback (id, supervisor_id, supervisor_name, program, message, submitted_at)
                  VALUES (${uid('FB')}, ${session.supervisor_id}, ${from}, ${session.program || ''}, ${String(message || '')}, ${ts})`;
        // Email notification — always to admin's personal email
        try {
          await sendEmail(
            'yousef.ajrah@bau.edu.lb',
            `FYP System Feedback — from ${from}`,
            `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:28px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;">
              <h3 style="color:#1e3a5f;margin-top:0;border-bottom:2px solid #e5e7eb;padding-bottom:12px;">FYP System — User Feedback</h3>
              <p><strong>From:</strong> ${from}</p>
              <p><strong>ID:</strong> ${session.supervisor_id}</p>
              <p><strong>Program:</strong> ${session.program || '—'}</p>
              <p><strong>Submitted:</strong> ${new Date(ts).toLocaleString('en-GB')}</p>
              <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;"/>
              <p style="white-space:pre-wrap;line-height:1.7;color:#374151;">${String(message || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
              <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;"/>
              <p style="color:#9ca3af;font-size:12px;margin:0;">Sent via the FYP Management System feedback form. All submissions are also stored in the system dashboard.</p>
            </div>`
          );
        } catch { /* email failure doesn't affect the stored record */ }
        return ok({ success: true });
      }

      case 'getFeedbacks': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        if (!_feedbackTableReady) {
          await sql`CREATE TABLE IF NOT EXISTS feedback (
            id TEXT PRIMARY KEY, supervisor_id TEXT, supervisor_name TEXT,
            program TEXT, message TEXT, submitted_at TIMESTAMPTZ DEFAULT NOW(), is_read BOOLEAN DEFAULT FALSE
          )`;
          _feedbackTableReady = true;
        }
        const rows = await sql`SELECT * FROM feedback ORDER BY submitted_at DESC`;
        await sql`UPDATE feedback SET is_read = TRUE WHERE is_read = FALSE`;
        return ok({ success: true, feedbacks: rows.map(r => ({
          id: r.id, supervisorId: r.supervisor_id, name: r.supervisor_name,
          program: r.program, message: r.message,
          submittedAt: r.submitted_at, isRead: r.is_read,
        })) });
      }

      case 'getUnreadFeedbackCount': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ count: 0 });
        try {
          if (!_feedbackTableReady) {
            await sql`CREATE TABLE IF NOT EXISTS feedback (
              id TEXT PRIMARY KEY, supervisor_id TEXT, supervisor_name TEXT,
              program TEXT, message TEXT, submitted_at TIMESTAMPTZ DEFAULT NOW(), is_read BOOLEAN DEFAULT FALSE
            )`;
            _feedbackTableReady = true;
          }
          const rows = await sql`SELECT COUNT(*) AS cnt FROM feedback WHERE is_read = FALSE`;
          return ok({ count: Number(rows[0]?.cnt || 0) });
        } catch { return ok({ count: 0 }); }
      }

      // ─── Peer Evaluation ─────────────────────────────────────────────

      case 'getPeerEvalURL': {
        const [sessionToken] = args;
        if (!await verifySession(sessionToken)) return ok({ success: false, message: 'Session expired.' });
        return ok(`${APP_URL}/peer.html`);
      }

      case 'getPeerEvalStatus': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok([]);
        const needle = session.supervisor_id.trim().toLowerCase();
        const [allProjects, allStudents, peerEvals] = await Promise.all([
          sql`SELECT * FROM projects`,
          sql`SELECT * FROM students`,
          sql`SELECT evaluator_id FROM peer_evaluations`,
        ]);
        const myProjects  = allProjects.filter(p => (p.supervisors || '').split(',').map(x => x.trim().toLowerCase()).includes(needle));
        const submittedIds = new Set(peerEvals.map(e => e.evaluator_id));
        return ok(myProjects.map(p => {
          const studs = allStudents.filter(s => s.project_id === p.project_id);
          const studentStatuses = studs.map(s => ({ id: s.student_id, name: s.student_name, submitted: submittedIds.has(s.student_id) }));
          return { projectId: p.project_id, projectTitle: p.title, allSubmitted: studentStatuses.length > 0 && studentStatuses.every(s => s.submitted), students: studentStatuses };
        }));
      }

      case 'getPeerEvalConfig': {
        const data = await sql`SELECT * FROM peer_config ORDER BY question_no`;
        return ok(data.map(mapPeerConfig));
      }

      case 'savePeerEvalConfig': {
        const [sessionToken, questions] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        if (!session.is_admin) return ok({ success: false, message: 'Only the admin can edit peer eval questions.' });
        await sql`DELETE FROM peer_config WHERE question_no != 0`;
        const inserts = (questions || []).map((q, i) => ({ question_no: i + 1, question_text: q.text, max_grade: q.maxGrade || 10, weight: q.weight || 20, abet_outcome: q.abetOutcome || '' }));
        for (const q of inserts) {
          await sql`INSERT INTO peer_config (question_no, question_text, max_grade, weight, abet_outcome) VALUES (${q.question_no}, ${q.question_text}, ${q.max_grade}, ${q.weight}, ${q.abet_outcome})`;
        }
        return ok({ success: true });
      }

      case 'validateStudentForPeerEval': {
        const [studentId] = args;
        const studentRows = await sql`SELECT * FROM students WHERE student_id = ${String(studentId)}`;
        const student = studentRows[0] || null;
        if (!student) return ok({ valid: false, message: 'Student ID not found.' });
        const existingRows = await sql`SELECT eval_id FROM peer_evaluations WHERE evaluator_id = ${String(studentId)} LIMIT 1`;
        if (existingRows.length) return ok({ valid: false, message: 'You have already submitted your peer evaluation.' });
        const projectRows = await sql`SELECT * FROM projects WHERE project_id = ${student.project_id}`;
        const project = projectRows[0] || null;
        if (!project) return ok({ valid: false, message: 'No project associated with this student.' });
        const teammates = await sql`SELECT * FROM students WHERE project_id = ${student.project_id} AND student_id != ${String(studentId)}`;
        const questions = await sql`SELECT * FROM peer_config ORDER BY question_no`;
        return ok({
          valid: true,
          student:   { id: student.student_id, name: student.student_name },
          project:   { id: project.project_id, title: project.title },
          teammates: teammates.map(t => ({ id: t.student_id, name: t.student_name })),
          questions: questions.map(mapPeerConfig),
        });
      }

      case 'submitPeerEvaluation': {
        const [evaluatorId, projectId, grades] = args;
        const evalStudentRows = await sql`SELECT student_id FROM students WHERE student_id = ${String(evaluatorId)} AND project_id = ${String(projectId)}`;
        if (!evalStudentRows[0]) return ok({ success: false, message: 'Invalid student or project.' });
        const existingRows = await sql`SELECT eval_id FROM peer_evaluations WHERE evaluator_id = ${String(evaluatorId)} LIMIT 1`;
        if (existingRows.length) return ok({ success: false, message: 'You have already submitted your peer evaluation.' });
        const teammates = await sql`SELECT student_id FROM students WHERE project_id = ${String(projectId)} AND student_id != ${String(evaluatorId)}`;
        const validTeammateIds = new Set(teammates.map(t => t.student_id));
        for (const g of (grades || [])) {
          if (!validTeammateIds.has(String(g.evaluatedId))) return ok({ success: false, message: 'Invalid evaluated student.' });
        }
        const ts = new Date().toISOString();
        const inserts = (grades || []).map(g => ({ eval_id: uid('PE'), project_id: projectId, evaluator_id: evaluatorId, evaluated_id: g.evaluatedId, question_no: g.questionNo, grade: g.grade, submitted_at: ts }));
        try {
          for (const i of inserts) {
            await sql`INSERT INTO peer_evaluations (eval_id, project_id, evaluator_id, evaluated_id, question_no, grade, submitted_at) VALUES (${i.eval_id}, ${i.project_id}, ${i.evaluator_id}, ${i.evaluated_id}, ${i.question_no}, ${i.grade}, ${i.submitted_at})`;
          }
        } catch(e) {
          if (e.code === '23505') return ok({ success: false, message: 'You have already submitted your peer evaluation.' });
          return ok({ success: false, message: e.message });
        }
        return ok({ success: true });
      }

      // ─── Examiner Config ─────────────────────────────────────────────

      case 'getExaminerConfig': {
        const [sessionToken] = args;
        if (!await verifySession(sessionToken)) return ok([]);
        const data = await sql`SELECT * FROM examiner_config ORDER BY id`;
        return ok(data.map(mapExConfig));
      }

      case 'saveExaminerConfig': {
        const [sessionToken, criteria] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        if (!session.is_admin) return ok({ success: false, message: 'Only the admin can edit the examiner rubric.' });
        await sql`DELETE FROM examiner_config WHERE id != 0`;
        const inserts = (criteria || []).map(c => ({
          project_type: c.projectType, category: c.category, criterion_name: c.criterionName,
          max_grade: c.maxGrade, weight: c.weight, grading_scope: c.gradingScope || 'Individual',
          abet_outcome: c.abetOutcome || '',
        }));
        for (const c of inserts) {
          await sql`INSERT INTO examiner_config (project_type, category, criterion_name, max_grade, weight, grading_scope, abet_outcome) VALUES (${c.project_type}, ${c.category}, ${c.criterion_name}, ${c.max_grade}, ${c.weight}, ${c.grading_scope}, ${c.abet_outcome})`;
        }
        return ok({ success: true });
      }

      // ─── Examiner Assignment ─────────────────────────────────────────

      case 'assignExaminers': {
        const [sessionToken, projectId, examiners, reportLink] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const link = String(reportLink || '');
        if (link && !link.startsWith('https://')) return ok({ success: false, message: 'Report link must use HTTPS.' });

        // Prevent any supervisor of this project from being assigned as an examiner
        const projRow = await sql`SELECT supervisors FROM projects WHERE project_id = ${projectId}`;
        const projSupIds = (projRow[0] ? projRow[0].supervisors || '' : '').split(',').map(x => x.trim()).filter(Boolean);
        if (projSupIds.length) {
          const projSupRows = await sql`SELECT supervisor_id, name, email FROM supervisors WHERE supervisor_id = ANY(${projSupIds})`;
          const projSupEmails = new Map(projSupRows.map(r => [String(r.email).toLowerCase(), r.name || r.supervisor_id]));
          const blocked = (examiners || []).find(e => projSupEmails.has(String(e.email).toLowerCase()));
          if (blocked) {
            const name = projSupEmails.get(String(blocked.email).toLowerCase());
            const isSelf = String(blocked.email).toLowerCase() === (projSupRows.find(r => r.supervisor_id === session.supervisor_id) || {}).email?.toLowerCase();
            return ok({ success: false, message: isSelf ? 'You cannot assign yourself as an examiner.' : `"${name}" is already a supervisor of this project and cannot be assigned as an examiner.` });
          }
        }

        // Require at least one non-Industry examiner to ensure the Report is graded
        const hasInternal = (examiners || []).some(e => e.type === 'Inside University' || e.type === 'Outside the Program/University');
        if (!hasInternal)
          return ok({ success: false, message: 'At least one Internal examiner must be assigned to ensure the Report component is graded.' });

        const existing  = await sql`SELECT * FROM examiners WHERE project_id = ${projectId}`;
        const newEmails = (examiners || []).map(e => String(e.email).toLowerCase());

        // Only remove examiners that were never emailed; keep Invited/Submitted ones
        for (const old of existing) {
          if (!newEmails.includes(old.examiner_email.toLowerCase()) && old.status === 'Assigned') {
            await sql`DELETE FROM examiner_grades WHERE assignment_id = ${old.assignment_id}`;
            await sql`DELETE FROM examiners WHERE assignment_id = ${old.assignment_id}`;
          }
        }

        const assignments = [];
        const warnings    = [];
        for (const ex of (examiners || [])) {
          const found = existing.find(e => e.examiner_email.toLowerCase() === String(ex.email).toLowerCase());
          if (found && found.status !== 'Assigned') {
            // Already emailed — preserve as-is, warn the caller
            warnings.push({ name: found.examiner_name || found.examiner_email, email: found.examiner_email });
            continue;
          }
          let token, aId;
          if (found) {
            token = found.token; aId = found.assignment_id;
            await sql`UPDATE examiners SET examiner_name = ${ex.name || ''}, examiner_type = ${ex.type}, report_link = ${link} WHERE assignment_id = ${aId}`;
          } else {
            token = genToken(); aId = uid('EXM');
            await sql`INSERT INTO examiners (assignment_id, project_id, examiner_name, examiner_email, examiner_type, token, status, report_link) VALUES (${aId}, ${projectId}, ${ex.name || ''}, ${ex.email}, ${ex.type}, ${token}, 'Assigned', ${link})`;
          }
          assignments.push({ assignmentId: aId, name: ex.name || '', email: ex.email, type: ex.type, token, reportLink: link });
        }
        return ok({ success: true, assignments, warnings });
      }

      case 'sendExaminerEmails': {
        const [sessionToken, projectId, assignments] = args;
        if (!await verifySession(sessionToken)) return ok({ success: false, message: 'Session expired.' });
        const projectRows = await sql`SELECT title, type, supervisors FROM projects WHERE project_id = ${projectId}`;
        const project = projectRows[0] || null;
        const supIds = (project?.supervisors || '').split(',').map(x => x.trim()).filter(Boolean);
        const supRows = supIds.length ? await sql`SELECT name FROM supervisors WHERE supervisor_id = ANY(${supIds})` : [];
        const supervisorName = supRows.map(r => r.name).join(', ') || '—';
        await Promise.all((assignments || []).map(async a => {
          const link = `${APP_URL}/examiner.html?token=${a.token}`;
          await sendEmail(
            a.email,
            `FYP Grading Assignment — ${project ? project.title : projectId}`,
            buildExaminerEmail({
              name:          a.name,
              projectTitle:  project ? project.title : projectId,
              supervisorName,
              examinerType:  a.type,
              projectType:   project ? project.type : '',
              reportLink:    a.type !== 'Industry' ? (a.reportLink || '') : '',
              gradingLink:   link,
            })
          );
          await sql`UPDATE examiners SET status = 'Invited' WHERE assignment_id = ${a.assignmentId} AND status = 'Assigned'`;
        }));
        return ok({ success: true });
      }

      case 'removeExaminer': {
        const [sessionToken, assignmentId] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const examinerRows = await sql`SELECT status FROM examiners WHERE assignment_id = ${assignmentId}`;
        const examiner = examinerRows[0] || null;
        if (!examiner) return ok({ success: false, message: 'Examiner not found.' });
        if (examiner.status !== 'Assigned') return ok({ success: false, message: 'Cannot remove an examiner after the invitation email has been sent.' });
        await sql`DELETE FROM examiner_grades WHERE assignment_id = ${assignmentId}`;
        await sql`DELETE FROM examiners WHERE assignment_id = ${assignmentId}`;
        return ok({ success: true });
      }

      case 'getExaminersForProject': {
        const [sessionToken, projectId] = args;
        if (!await verifySession(sessionToken)) return ok([]);
        const data = await sql`
          SELECT e.*,
            EXISTS(SELECT 1 FROM examiner_grades g WHERE g.assignment_id = e.assignment_id AND g.category = 'Report')       AS has_report,
            EXISTS(SELECT 1 FROM examiner_grades g WHERE g.assignment_id = e.assignment_id AND g.category = 'Presentation') AS has_presentation
          FROM examiners e
          WHERE e.project_id = ${projectId}
        `;
        return ok(data.map(r => ({ ...mapExaminer(r), HasReport: r.has_report, HasPresentation: r.has_presentation })));
      }

      case 'resendExaminerEmail': {
        const [sessionToken, assignmentId] = args;
        if (!await verifySession(sessionToken)) return ok({ success: false, message: 'Session expired.' });
        const rows = await sql`SELECT e.*, p.title, p.type AS project_type, p.supervisors FROM examiners e JOIN projects p ON p.project_id = e.project_id WHERE e.assignment_id = ${assignmentId}`;
        const e = rows[0];
        if (!e) return ok({ success: false, message: 'Examiner not found.' });
        const rSupIds = (e.supervisors || '').split(',').map(x => x.trim()).filter(Boolean);
        const rSupRows = rSupIds.length ? await sql`SELECT name FROM supervisors WHERE supervisor_id = ANY(${rSupIds})` : [];
        const rSupervisorName = rSupRows.map(r => r.name).join(', ') || '—';
        const link = `${APP_URL}/examiner.html?token=${e.token}`;
        await sendEmail(
          e.examiner_email,
          `FYP Grading Assignment — ${e.title || assignmentId}`,
          buildExaminerEmail({
            name:           e.examiner_name,
            projectTitle:   e.title || assignmentId,
            supervisorName: rSupervisorName,
            examinerType:   e.examiner_type,
            projectType:    e.project_type || '',
            reportLink:     e.examiner_type !== 'Industry' ? (e.report_link || '') : '',
            gradingLink:    link,
          })
        );
        await sql`UPDATE examiners SET status = 'Invited' WHERE assignment_id = ${assignmentId} AND status = 'Assigned'`;
        return ok({ success: true });
      }

      case 'sendPendingExaminerEmails': {
        const [sessionToken, projectId] = args;
        if (!await verifySession(sessionToken)) return ok({ success: false, message: 'Session expired.' });
        const rows = await sql`
          SELECT e.*, p.title, p.type AS project_type, p.supervisors
          FROM examiners e JOIN projects p ON p.project_id = e.project_id
          WHERE e.project_id = ${projectId} AND e.status = 'Assigned'`;
        if (!rows.length) return ok({ success: true, sent: 0 });
        const pSupIds = (rows[0]?.supervisors || '').split(',').map(x => x.trim()).filter(Boolean);
        const pSupRows = pSupIds.length ? await sql`SELECT name FROM supervisors WHERE supervisor_id = ANY(${pSupIds})` : [];
        const pSupervisorName = pSupRows.map(r => r.name).join(', ') || '—';
        await Promise.all(rows.map(async e => {
          const link = `${APP_URL}/examiner.html?token=${e.token}`;
          await sendEmail(
            e.examiner_email,
            `FYP Grading Assignment — ${e.title || projectId}`,
            buildExaminerEmail({
              name:           e.examiner_name,
              projectTitle:   e.title || projectId,
              supervisorName: pSupervisorName,
              examinerType:   e.examiner_type,
              projectType:    e.project_type || '',
              reportLink:     e.examiner_type !== 'Industry' ? (e.report_link || '') : '',
              gradingLink:    link,
            })
          );
          await sql`UPDATE examiners SET status = 'Invited' WHERE assignment_id = ${e.assignment_id} AND status = 'Assigned'`;
        }));
        return ok({ success: true, sent: rows.length });
      }

      // ─── Examiner Portal ─────────────────────────────────────────────

      case 'getExaminerByToken': {
        const [token] = args;
        const assignmentRows = await sql`SELECT * FROM examiners WHERE token = ${token}`;
        const assignment = assignmentRows[0] || null;
        if (!assignment) return ok({ valid: false, message: 'Invalid or expired access link.' });
        if (assignment.status === 'Submitted') return ok({ valid: false, message: 'You have already submitted grades for this project.' });

        const assignedAt = new Date(assignment.assigned_at || 0);
        if (isNaN(assignedAt.getTime()) || Date.now() > assignedAt.getTime() + TOKEN_EXPIRY_DAYS * 24 * 3600 * 1000)
          return ok({ valid: false, message: 'This grading link has expired. Please contact your supervisor to receive a new link.' });

        const [projectRows, students, allConfig, cfg] = await Promise.all([
          sql`SELECT * FROM projects WHERE project_id = ${assignment.project_id}`,
          sql`SELECT * FROM students WHERE project_id = ${assignment.project_id}`,
          sql`SELECT * FROM examiner_config ORDER BY id`,
          getTWConfig(),
        ]);
        const project = projectRows[0] || null;

        const projectType = project ? String(project.type || 'FYP1') : 'FYP1';
        const typed  = allConfig.filter(c => String(c.project_type) === projectType);
        const config = typed.length ? typed : allConfig;

        let presentationLocked = true;
        if (cfg.semester_end_date) {
          try {
            const endDate = new Date(cfg.semester_end_date);
            endDate.setHours(23, 59, 59, 999);
            presentationLocked = new Date() < endDate;
          } catch {}
        }

        let draftGrades = [];
        try { if (assignment.draft_grades) draftGrades = Array.isArray(assignment.draft_grades) ? assignment.draft_grades : JSON.parse(assignment.draft_grades); } catch {}

        return ok({
          valid: true,
          presentationLocked,
          reportSubmitted: assignment.status === 'ReportSubmitted',
          draftGrades,
          assignment: { id: assignment.assignment_id, name: assignment.examiner_name, email: assignment.examiner_email, type: assignment.examiner_type, reportLink: assignment.report_link || '' },
          project:    { id: project ? project.project_id : '', title: project ? project.title : '', type: projectType },
          students:   students.map(s => ({ id: s.student_id, name: s.student_name })),
          config:     config.map(mapExConfig),
        });
      }

      case 'saveExaminerDraft': {
        const [token, grades] = args;
        const assignmentRows = await sql`SELECT assignment_id, status FROM examiners WHERE token = ${token}`;
        const assignment = assignmentRows[0] || null;
        if (!assignment) return ok({ success: false, message: 'Invalid token.' });
        if (assignment.status === 'Submitted') return ok({ success: false, message: 'Already submitted.' });
        const safe = (grades || []).map(g => ({ category: String(g.category||''), criterion: String(g.criterion||''), studentId: String(g.studentId||''), score: Number(g.score||0) }));
        await sql`UPDATE examiners SET draft_grades = ${JSON.stringify(safe)}::jsonb WHERE assignment_id = ${assignment.assignment_id}`;
        return ok({ success: true });
      }

      case 'submitExaminerGrades': {
        const [token, gradesPayload] = args;
        const assignmentRows = await sql`SELECT * FROM examiners WHERE token = ${token}`;
        const assignment = assignmentRows[0] || null;
        if (!assignment) return ok({ success: false, message: 'Invalid token.' });
        if (assignment.status === 'Submitted') return ok({ success: false, message: 'Already submitted.' });

        const cfg = await getTWConfig();
        let presentationLocked = true;
        if (cfg.semester_end_date) {
          try {
            const endDate = new Date(cfg.semester_end_date);
            endDate.setHours(23, 59, 59, 999);
            presentationLocked = new Date() < endDate;
          } catch {}
        }
        if (presentationLocked && (gradesPayload.grades || []).some(g => g.category === 'Presentation'))
          return ok({ success: false, message: 'Presentation grading is not yet open.' });

        const grades     = gradesPayload.grades || [];
        const isIndustry = assignment.examiner_type === 'Industry';
        const hasReport  = grades.some(g => g.category === 'Report');
        const hasPres    = grades.some(g => g.category === 'Presentation');

        // Partial: non-Industry examiner whose submission has no presentation grades
        // (date-independent — only complete when both Report + Presentation are present)
        const isPartial  = !isIndustry && hasReport && !hasPres;

        const ts = new Date().toISOString();
        // Delete existing grades first to avoid duplicates on re-submission
        await sql`DELETE FROM examiner_grades WHERE assignment_id = ${assignment.assignment_id}`;
        for (const g of grades) {
          await sql`INSERT INTO examiner_grades (grade_id, assignment_id, project_id, examiner_email, category, criterion, student_id, score, submitted_at) VALUES (${uid('EG')}, ${assignment.assignment_id}, ${assignment.project_id}, ${assignment.examiner_email}, ${g.category}, ${g.criterion}, ${g.studentId || ''}, ${g.score}, ${ts})`;
        }

        if (isPartial) {
          // Save submitted grades as draft so they pre-fill on next visit
          const safeDraft = grades.map(g => ({ category: g.category, criterion: g.criterion, studentId: g.studentId || '', score: g.score }));
          await sql`UPDATE examiners SET status = 'ReportSubmitted', draft_grades = ${JSON.stringify(safeDraft)}::jsonb WHERE assignment_id = ${assignment.assignment_id}`;
          return ok({ success: true, partial: true });
        }

        // Complete submission
        await sql`UPDATE examiners SET status = 'Submitted' WHERE assignment_id = ${assignment.assignment_id}`;

        // Confirmation email — fire-and-forget, never blocks response
        try {
          const projRows      = await sql`SELECT title, supervisors, type FROM projects WHERE project_id = ${assignment.project_id}`;
          const proj          = projRows[0] || null;
          const projectTitle  = proj ? proj.title : '—';
          const projectType   = proj ? String(proj.type || 'FYP1') : 'FYP1';
          const supIds        = proj ? (proj.supervisors || '').split(',').map(s => s.trim()).filter(Boolean) : [];
          const supRows       = supIds.length ? await sql`SELECT name FROM supervisors WHERE supervisor_id = ANY(${supIds})` : [];
          const supervisorName = supRows.map(r => r.name).join(', ') || '—';
          const rawCfg        = await sql`SELECT * FROM examiner_config WHERE project_type = ${projectType} ORDER BY id`;
          const cfgMap        = {};
          for (const c of rawCfg) cfgMap[`${c.category}::${c.criterion_name}`] = { weight: c.weight, maxGrade: c.max_grade };

          const examinerName   = assignment.examiner_name || 'Examiner';
          const examinerType   = assignment.examiner_type;
          const isIndustryExam = examinerType === 'Industry';

          const buildGradeTable = (cat) => {
            const catGrades = grades.filter(g => g.category === cat);
            if (!catGrades.length) return '';
            const hasStudentCol = catGrades.some(g => g.studentId);
            const thSt = 'padding:8px 12px;border:1px solid #e5e7eb;font-size:12px;color:#374151;font-weight:600;';
            const tdSt = 'padding:8px 12px;border:1px solid #e5e7eb;font-size:13px;';
            const thead = `<tr style="background:#f0f4ff;"><th style="${thSt}text-align:left;">Criterion</th>${hasStudentCol ? `<th style="${thSt}text-align:center;">Student</th>` : ''}<th style="${thSt}text-align:center;">Score</th><th style="${thSt}text-align:center;">Weight</th><th style="${thSt}text-align:center;">Max</th></tr>`;
            const tbody = catGrades.map(g => {
              const c = cfgMap[`${cat}::${g.criterion}`] || {};
              return `<tr><td style="${tdSt}color:#374151;">${g.criterion}</td>${hasStudentCol ? `<td style="${tdSt}text-align:center;color:#6b7280;">${g.studentId || '—'}</td>` : ''}<td style="${tdSt}text-align:center;font-weight:700;color:#0a1f44;">${g.score}</td><td style="${tdSt}text-align:center;color:#6b7280;">${c.weight != null ? c.weight + '%' : '—'}</td><td style="${tdSt}text-align:center;color:#6b7280;">${c.maxGrade != null ? c.maxGrade : '—'}</td></tr>`;
            }).join('');
            return `<p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#0a1f44;">${cat} Grades</p><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 24px;">${thead}${tbody}</table>`;
          };

          const categories     = isIndustryExam ? ['Presentation'] : ['Report', 'Presentation'];
          const tablesHtml     = categories.map(buildGradeTable).join('');
          const completionNote = isIndustryExam
            ? 'the <strong>Presentation</strong> grading'
            : 'grading of both the <strong>Report</strong> and <strong>Presentation</strong>';

          await sendEmail(
            assignment.examiner_email,
            `Grade Submission Confirmed — ${projectTitle}`,
            `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;"><tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
  <tr><td align="center" style="background:#ffffff;padding:28px 40px 16px;"><img src="https://usif-3jra.github.io/epme-study-plan/assets/logo_ECE.png" alt="BAU ECE" width="130" style="display:block;max-width:130px;height:auto;"/></td></tr>
  <tr><td style="background:#0a1f44;padding:24px 40px;text-align:center;"><div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:.02em;margin-bottom:6px;">FYP Management &amp; Grading System</div><div style="color:#94a3b8;font-size:13px;">Beirut Arab University — Faculty of Engineering — ECE Department</div></td></tr>
  <tr><td style="padding:32px 40px;color:#2d2d2d;font-size:15px;line-height:1.7;">
    <p style="margin:0 0 16px;">Dear ${examinerName},</p>
    <div style="background:#e8f5e9;border-left:4px solid #22c55e;border-radius:6px;padding:14px 18px;margin:0 0 20px;font-size:14px;color:#166534;"><strong>&#10003; Submission Confirmed</strong> &mdash; Your grades have been successfully recorded.</div>
    <p style="margin:0 0 16px;">Thank you for completing ${completionNote} for the following project:</p>
    <div style="background:#f0f4ff;border-left:4px solid #0a1f44;border-radius:6px;padding:18px 24px;margin:0 0 24px;">
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        <tr><td style="font-size:13px;color:#6b7280;font-weight:600;padding:5px 0;width:140px;">Project Title</td><td style="font-size:14px;font-weight:700;color:#0a1f44;padding:5px 0;">${projectTitle}</td></tr>
        <tr><td style="font-size:13px;color:#6b7280;font-weight:600;padding:5px 0;border-top:1px solid #dde3f3;">Supervisor(s)</td><td style="font-size:14px;font-weight:700;color:#0a1f44;padding:5px 0;border-top:1px solid #dde3f3;">${supervisorName}</td></tr>
        <tr><td style="font-size:13px;color:#6b7280;font-weight:600;padding:5px 0;border-top:1px solid #dde3f3;">Examiner Role</td><td style="font-size:14px;font-weight:700;color:#0a1f44;padding:5px 0;border-top:1px solid #dde3f3;">${examinerType} Examiner</td></tr>
      </table>
    </div>
    <p style="margin:0 0 16px;font-size:14px;color:#374151;">A summary of the grades you submitted is provided below:</p>
    ${tablesHtml}
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">No further action is required. Should you have any questions, please contact the ECE Department.</p>
    <p style="margin:0 0 4px;">Best regards,</p>
    <p style="margin:0 0 2px;font-weight:600;">ECE Department Administration</p>
    <p style="margin:0;color:#6b7280;font-size:13px;">Faculty of Engineering &mdash; Beirut Arab University</p>
  </td></tr>
  <tr><td style="border-top:1px solid #e5e7eb;padding:16px 40px;text-align:center;color:#9ca3af;font-size:11px;background:#f9fafb;">
    &copy; 2026 Beirut Arab University &mdash; Faculty of Engineering &mdash; ECE Department<br/>
    This is an automated message. Please do not reply directly to this email.
  </td></tr>
</table>
</td></tr></table>
</body></html>`
          );
        } catch {}

        return ok({ success: true });
      }

      // ─── Final Results ────────────────────────────────────────────────

      case 'getDetailedResults': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });

        const [allProjects, allStudents, twGrades, peerEvals, exGrades, allSups, exCfg, peerCfg, allExaminers] = await Promise.all([
          sql`SELECT * FROM projects`,
          sql`SELECT * FROM students`,
          sql`SELECT * FROM tw_grades`,
          sql`SELECT * FROM peer_evaluations`,
          sql`SELECT * FROM examiner_grades`,
          sql`SELECT * FROM supervisors`,
          sql`SELECT * FROM examiner_config ORDER BY id`,
          sql`SELECT * FROM peer_config ORDER BY question_no`,
          sql`SELECT * FROM examiners`,
        ]);
        const cfg       = await getTWConfig();
        const indRubric = await getIndividualRubric();

        const twW   = parseFloat(cfg.teamwork_weight     || 35) / 100;
        const peerW = parseFloat(cfg.peer_eval_weight    || 20) / 100;
        const supW  = parseFloat(cfg.supervisor_weight   || 80) / 100;
        const repW  = parseFloat(cfg.report_weight       || 35) / 100;
        const presW = parseFloat(cfg.presentation_weight || 30) / 100;
        const outlierRuleEnabled = cfg.outlier_rule_enabled !== '0';

        let projects = await filterProjectsBySession(session, allProjects, allSups);

        let showExNames = isAdminUser(session);
        if (!showExNames) {
          if (!_exNamesAccessReady) {
            await sql`CREATE TABLE IF NOT EXISTS examiner_names_access (supervisor_id TEXT PRIMARY KEY, granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
            _exNamesAccessReady = true;
          }
          const exRows = await sql`SELECT 1 FROM examiner_names_access WHERE supervisor_id = ${session.supervisor_id}`;
          showExNames = exRows.length > 0;
        }

        const projectDetails = projects.map(proj => {
          const pid      = proj.project_id;
          const projType = String(proj.type || 'FYP1');
          const supIds   = (proj.supervisors || '').split(',').map(s => s.trim()).filter(Boolean);
          const supNames = supIds.map(id => { const s = allSups.find(s => s.supervisor_id === id); return s ? s.name : id; });
          const projStudents = allStudents.filter(s => s.project_id === pid);
          const projExCfg    = exCfg.filter(c => !c.project_type || c.project_type === projType);
          const repCfg       = projExCfg.filter(c => c.category === 'Report');
          const presCfg      = projExCfg.filter(c => c.category === 'Presentation');
          const projGrades   = exGrades.filter(g => g.project_id === pid);
          const projExList   = allExaminers.filter(e => e.project_id === pid);

          // Grade lookup: assignmentId -> criterion -> studentId -> score
          const gLookup = {};
          projGrades.forEach(g => {
            if (!gLookup[g.assignment_id]) gLookup[g.assignment_id] = {};
            if (!gLookup[g.assignment_id][g.criterion]) gLookup[g.assignment_id][g.criterion] = {};
            gLookup[g.assignment_id][g.criterion][g.student_id] = parseFloat(g.score || 0);
          });

          // Examiners who submitted each category
          const repExaminers  = projExList.filter(e => projGrades.some(g => g.assignment_id === e.assignment_id && g.category === 'Report'));
          const presExaminers = projExList.filter(e => projGrades.some(g => g.assignment_id === e.assignment_id && g.category === 'Presentation'));

          // Build per-examiner table for a category
          const buildExTable = (examList, criteria, category, sid, showNames) => {
            if (!examList.length || !criteria.length) return null;
            const exNames = showNames
              ? examList.map(e => `${e.examiner_name || e.examiner_email} (${e.examiner_type})`)
              : examList.map((_, i) => `Examiner ${i + 1}`);
            const rows = criteria.map((c, idx) => {
              const isGroup  = (c.grading_scope || 'Individual') === 'Group';
              const lookupId = isGroup ? 'GROUP' : sid;
              const scores   = examList.map(e => {
                const s = gLookup[e.assignment_id]?.[c.criterion_name]?.[lookupId];
                return s !== undefined ? s : null;
              });
              return { num: idx + 1, criterion: c.criterion_name, scope: isGroup ? 'Group' : 'Individual', maxGrade: parseFloat(c.max_grade), weight: parseFloat(c.weight), scores };
            });
            const allG  = projGrades.filter(g => g.category === category && (g.student_id === sid || g.student_id === 'GROUP'));
            const pctVal = weightedPct(allG.map(g => ({ Criterion: g.criterion, Score: g.score })), criteria.map(c => ({ CriterionName: c.criterion_name, MaxGrade: c.max_grade, Weight: c.weight })));
            return { examiners: exNames, rows, pct: rnd(pctVal) };
          };

          const studentsData = projStudents.map(student => {
            const sid = student.student_id;

            const twDetails = indRubric.map((r, idx) => {
              const g = twGrades.find(g => g.student_id === sid && g.criterion === r.criterion && g.grade_type === 'Individual');
              return { num: idx + 1, criterion: r.criterion, grade: g ? parseFloat(g.grade) : 0, maxGrade: Number(r.maxGrade || 25) };
            });
            const indMax  = indRubric.reduce((s, r) => s + Number(r.maxGrade || 25), 0) || 100;
            const indPct  = pct(twDetails.reduce((s, d) => s + d.grade, 0), indMax);
            const peer      = peerEvals.filter(e => e.evaluated_id === sid);
            const maxPeer   = peerCfg.reduce((s, q) => s + parseFloat(q.max_grade || 10), 0);
            const peerCount = peerCfg.length || 1;
            const peerPct   = pct(peer.reduce((s, e) => s + parseFloat(e.grade || 0), 0), maxPeer * (peer.length / peerCount));
            const isSolo    = projStudents.length === 1;
            const twScore   = isSolo ? indPct : (indPct * supW) + (peerPct * peerW);

            const peerDetails = peerCfg.map((q, idx) => {
              const qGrades = peer.filter(e => String(e.question_no) === String(q.question_no));
              const avg = qGrades.length ? qGrades.reduce((s, g) => s + parseFloat(g.grade || 0), 0) / qGrades.length : 0;
              return { num: idx + 1, question: q.question_text, avgScore: Math.round(avg * 10) / 10, maxGrade: parseFloat(q.max_grade || 10) };
            });

            const repTable  = buildExTable(repExaminers,  repCfg,  'Report',       sid, showExNames);
            const presTable = buildExTable(presExaminers, presCfg, 'Presentation', sid, showExNames);

            // Compute raw and outlier-filtered pcts (mirrors getFinalResults logic)
            const rawRepAllG   = projGrades.filter(g => g.category === 'Report');
            const rawPresAllG  = projGrades.filter(g => g.category === 'Presentation');
            const repExCnt     = new Set(rawRepAllG.map(g => g.assignment_id)).size;
            const presExCnt    = new Set(rawPresAllG.map(g => g.assignment_id)).size;
            const { filteredGrades: repGFilt }  = repExCnt  >= 3 ? filterOutlierGrades(rawRepAllG)  : { filteredGrades: rawRepAllG };
            const { filteredGrades: presGFilt } = presExCnt >= 3 ? filterOutlierGrades(rawPresAllG) : { filteredGrades: rawPresAllG };
            const exCfgMapFn   = c => ({ CriterionName: c.criterion_name, MaxGrade: c.max_grade, Weight: c.weight });
            const repScopeFn   = g => { const c = repCfg.find(cf => cf.criterion_name === g.criterion); return (c && c.grading_scope === 'Individual') ? g.student_id === sid : (g.student_id === 'GROUP' || !g.student_id); };
            const presScopeFn  = g => { const c = presCfg.find(cf => cf.criterion_name === g.criterion); return (c && c.grading_scope === 'Individual') ? g.student_id === sid : (g.student_id === 'GROUP' || !g.student_id); };
            const rawRepPct    = weightedPct(rawRepAllG.filter(repScopeFn).map(g => ({ Criterion: g.criterion, Score: g.score })), repCfg.map(exCfgMapFn));
            const filtRepPct   = weightedPct(repGFilt.filter(repScopeFn).map(g => ({ Criterion: g.criterion, Score: g.score })), repCfg.map(exCfgMapFn));
            const rawPresPct   = weightedPct(rawPresAllG.filter(presScopeFn).map(g => ({ Criterion: g.criterion, Score: g.score })), presCfg.map(exCfgMapFn));
            const filtPresPct  = weightedPct(presGFilt.filter(presScopeFn).map(g => ({ Criterion: g.criterion, Score: g.score })), presCfg.map(exCfgMapFn));
            const rawFinal      = (twScore * twW) + (rawRepPct  * repW) + (rawPresPct  * presW);
            const filteredFinal = (twScore * twW) + (filtRepPct * repW) + (filtPresPct * presW);
            const effectiveFinal = outlierRuleEnabled ? filteredFinal : rawFinal;

            return {
              studentId: sid, studentName: student.student_name,
              isSolo: projStudents.length === 1,
              twDetails, peerDetails, indPct: rnd(indPct), peerPct: rnd(peerPct), twScore: rnd(twScore),
              repTable, presTable,
              summary: {
                teamworkPct: rnd(twScore),
                reportPct: rnd(filtRepPct),
                presPct: rnd(filtPresPct),
                rawFinalGrade: Math.round(rawFinal),
                filteredFinalGrade: Math.round(filteredFinal),
                finalGrade: Math.round(effectiveFinal),
                boosted: GRADE_BORDERS.includes(Math.round(effectiveFinal)),
                letterGrade: letterGrade(effectiveFinal),
              },
            };
          });

          return { projectId: pid, title: proj.title || pid, type: projType, program: proj.program_type || '', supervisors: supNames, students: studentsData };
        });

        // Statistics
        const allSR = projectDetails.flatMap(p => p.students.map(s => ({ ...s.summary, pt: p.type })));
        const statsByType = {};
        ['FYP1','FYP2'].forEach(pt => {
          const gr = allSR.filter(r => r.pt === pt);
          if (!gr.length) return;
          const mean = gr.reduce((s, r) => s + r.finalGrade, 0) / gr.length;
          const sd   = Math.sqrt(gr.reduce((s, r) => s + Math.pow(r.finalGrade - mean, 2), 0) / gr.length);
          statsByType[pt] = { count: gr.length, mean: rnd(mean), sd: rnd(sd) };
        });

        // ABET
        const abetByType = {};
        ['FYP1','FYP2'].forEach(pt => {
          const typeIds = new Set(projects.filter(p => p.type === pt).map(p => p.project_id));
          if (!typeIds.size) return;
          const tIndG = twGrades.filter(g => typeIds.has(g.project_id) && g.grade_type === 'Individual');
          const tExG  = exGrades.filter(g => typeIds.has(g.project_id));
          function computeABET2(tag) {
            const cp = [];
            indRubric.filter(r => String(r.abetOutcome || '') === tag).forEach(c => {
              const gs = tIndG.filter(g => g.criterion === c.criterion);
              if (!gs.length) return;
              cp.push((gs.filter(g => parseFloat(g.grade || 0) >= 0.7 * c.maxGrade).length / gs.length) * 100);
            });
            exCfg.filter(c => String(c.abet_outcome || '') === tag).forEach(c => {
              const cg = tExG.filter(g => g.criterion === c.criterion_name);
              if (!cg.length) return;
              cp.push((cg.filter(g => parseFloat(g.score || 0) >= 0.7 * parseFloat(c.max_grade || 100)).length / cg.length) * 100);
            });
            if (!cp.length) return tag === '2b' ? { notMeasured: true } : null;
            const avg2 = cp.reduce((a, b) => a + b, 0) / cp.length;
            return { pct: rnd(avg2), level: avg2 < 60 ? 1 : avg2 < 70 ? 2 : avg2 < 85 ? 3 : 4 };
          }
          abetByType[pt] = { abet1a: computeABET2('1a'), abet2a: computeABET2('2a'), abet2b: computeABET2('2b'), abet3a: computeABET2('3a'), abet3b: computeABET2('3b'), abet4a: computeABET2('4a'), abet5a: computeABET2('5a'), abet5b: computeABET2('5b'), abet7a: computeABET2('7a') };
        });

        const now = new Date();
        return ok({ success: true, projects: projectDetails, statistics: statsByType, abet: abetByType,
          meta: { year: `${now.getFullYear()}–${now.getFullYear()+1}`, semester: cfg.semester || '', department: 'ECE',
            weights: { tw: Math.round(twW*100), report: Math.round(repW*100), pres: Math.round(presW*100) },
            outlierRuleEnabled } });
      }

      // ─── Criteria Grade Distribution (Admin statistical report) ──────
      case 'getCriteriaDistribution': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        if (!session.is_admin) return ok({ success: false, message: 'Only the admin can view this report.' });

        const [allProjects, twGrades, peerEvals, exGrades, exCfg, peerCfg, allStudents, allExaminers] = await Promise.all([
          sql`SELECT * FROM projects`,
          sql`SELECT * FROM tw_grades WHERE grade_type = 'Individual'`,
          sql`SELECT * FROM peer_evaluations`,
          sql`SELECT * FROM examiner_grades`,
          sql`SELECT * FROM examiner_config ORDER BY id`,
          sql`SELECT * FROM peer_config ORDER BY question_no`,
          sql`SELECT * FROM students`,
          sql`SELECT assignment_id, project_id, examiner_type FROM examiners`,
        ]);
        const indRubric = await getIndividualRubric();
        const cfg = await getTWConfig();

        const projById = {};
        allProjects.forEach(p => { projById[p.project_id] = p; });

        // Each entry = one graded criterion instance, normalized to a percentage
        const entries = [];

        // TW — Supervisor (Individual rubric)
        twGrades.forEach(g => {
          const proj = projById[g.project_id];
          if (!proj) return;
          const rub = indRubric.find(r => r.criterion === g.criterion);
          const max = rub ? Number(rub.maxGrade || 25) : 25;
          if (max <= 0) return;
          entries.push({ pct: (parseFloat(g.grade || 0) / max) * 100, program: proj.program_type || 'Unspecified', type: String(proj.type || 'FYP1'), category: 'TW' });
        });

        // Peer Evaluation
        const peerMaxByQ = {};
        peerCfg.forEach(q => { peerMaxByQ[String(q.question_no)] = parseFloat(q.max_grade || 10); });
        peerEvals.forEach(e => {
          const proj = projById[e.project_id];
          if (!proj) return;
          const max = peerMaxByQ[String(e.question_no)] || 10;
          if (max <= 0) return;
          entries.push({ pct: (parseFloat(e.grade || 0) / max) * 100, program: proj.program_type || 'Unspecified', type: String(proj.type || 'FYP1'), category: 'Peer' });
        });

        // Examiner — Report & Presentation
        exGrades.forEach(g => {
          const proj = projById[g.project_id];
          if (!proj) return;
          const projType = String(proj.type || 'FYP1');
          const cfgMatch = exCfg.find(c => c.criterion_name === g.criterion && c.category === g.category && (!c.project_type || c.project_type === projType));
          const max = cfgMatch ? parseFloat(cfgMatch.max_grade || 0) : 0;
          if (!max || max <= 0) return;
          const category = g.category === 'Presentation' ? 'Presentation' : 'Report';
          entries.push({ pct: (parseFloat(g.score || 0) / max) * 100, program: proj.program_type || 'Unspecified', type: projType, category });
        });

        // ── Bucketing: 45-49, 50-54, ..., 95-100 (11 buckets) ──────────────
        const bucketLabels = ['45-49','50-54','55-59','60-64','65-69','70-74','75-79','80-84','85-89','90-94','95-100'];
        const bucketIndex = p => p < 45 ? -1 : Math.min(10, Math.floor((p - 45) / 5));
        const makeDist = list => {
          const total = list.length;
          const counts = new Array(11).fill(0);
          list.forEach(e => { const idx = bucketIndex(e.pct); if (idx >= 0) counts[idx]++; });
          return { total, pct: counts.map(c => total > 0 ? rnd((c / total) * 100) : 0) };
        };

        const overall = makeDist(entries);
        const byType = {};
        ['FYP1', 'FYP2'].forEach(t => { const list = entries.filter(e => e.type === t); if (list.length) byType[t] = makeDist(list); });
        const byCategory = {};
        ['TW', 'Peer', 'Report', 'Presentation'].forEach(cat => { const list = entries.filter(e => e.category === cat); if (list.length) byCategory[cat] = makeDist(list); });
        const programs = [...new Set(allProjects.map(p => p.program_type || 'Unspecified'))].sort();
        const byProgram = {};
        programs.forEach(p => { const list = entries.filter(e => e.program === p); if (list.length) byProgram[p] = makeDist(list); });

        // ── Per-student final grades (same algorithm as getFinalResults) ──
        const twW   = parseFloat(cfg.teamwork_weight     || 35) / 100;
        const peerW = parseFloat(cfg.peer_eval_weight    || 20) / 100;
        const supW  = parseFloat(cfg.supervisor_weight   || 80) / 100;
        const repW  = parseFloat(cfg.report_weight       || 35) / 100;
        const presW = parseFloat(cfg.presentation_weight || 30) / 100;
        const outlierRuleEnabled = cfg.outlier_rule_enabled !== '0';
        const maxPeer  = peerCfg.reduce((s, q) => s + parseFloat(q.max_grade || 10), 0);
        const peerQCnt = peerCfg.length || 1;
        const indMax   = indRubric.reduce((s, r) => s + Number(r.maxGrade || 25), 0) || 100;
        const repCfgMap  = c => ({ CriterionName: c.criterion_name, MaxGrade: c.max_grade, Weight: c.weight });

        const studentGrades = allStudents.map(student => {
          const project = projById[student.project_id];
          if (!project) return null;
          const pt = String(project.type || 'FYP1');
          const prog = project.program_type || 'Unspecified';

          const ind    = twGrades.filter(g => g.student_id === student.student_id && g.grade_type === 'Individual');
          const indPct = pct(ind.reduce((s, g) => s + parseFloat(g.grade || 0), 0), indMax);

          const peer    = peerEvals.filter(e => e.evaluated_id === student.student_id);
          const peerPct = pct(peer.reduce((s, e) => s + parseFloat(e.grade || 0), 0), maxPeer * (peer.length / peerQCnt));

          const projStudents = allStudents.filter(s => s.project_id === student.project_id);
          const isSolo  = projStudents.length === 1;
          const twScore = isSolo ? indPct : (indPct * supW) + (peerPct * peerW);

          const projExCfg = exCfg.filter(c => !c.project_type || c.project_type === pt);
          const repCfg    = projExCfg.filter(c => c.category === 'Report');
          const presCfg   = projExCfg.filter(c => c.category === 'Presentation');

          const rawRepG  = exGrades.filter(g => g.project_id === student.project_id && g.category === 'Report');
          const rawPresG = exGrades.filter(g => g.project_id === student.project_id && g.category === 'Presentation');

          const repExCount  = new Set(rawRepG.map(g => g.assignment_id)).size;
          const presExCount = new Set(rawPresG.map(g => g.assignment_id)).size;
          const { filteredGrades: repGClean }  = repExCount  >= 3 ? filterOutlierGrades(rawRepG)  : { filteredGrades: rawRepG  };
          const { filteredGrades: presGClean } = presExCount >= 3 ? filterOutlierGrades(rawPresG) : { filteredGrades: rawPresG };

          const repScope  = g => { const c = repCfg.find(cf => cf.criterion_name === g.criterion);  return c && c.grading_scope === 'Individual' ? g.student_id === student.student_id : (g.student_id === 'GROUP' || !g.student_id); };
          const presScope = g => { const c = presCfg.find(cf => cf.criterion_name === g.criterion); return c && c.grading_scope === 'Individual' ? g.student_id === student.student_id : (g.student_id === 'GROUP' || !g.student_id); };

          const repPct  = weightedPct(repGClean.filter(repScope).map(g => ({ Criterion: g.criterion, Score: g.score })),  repCfg.map(repCfgMap));
          const rawRepPct = weightedPct(rawRepG.filter(repScope).map(g => ({ Criterion: g.criterion, Score: g.score })), repCfg.map(repCfgMap));
          const presPct = weightedPct(presGClean.filter(presScope).map(g => ({ Criterion: g.criterion, Score: g.score })), presCfg.map(repCfgMap));
          const rawPresPct = weightedPct(rawPresG.filter(presScope).map(g => ({ Criterion: g.criterion, Score: g.score })), presCfg.map(repCfgMap));

          const filteredFinal = (twScore * twW) + (repPct  * repW) + (presPct  * presW);
          const rawFinal      = (twScore * twW) + (rawRepPct * repW) + (rawPresPct * presW);
          const finalGrade    = Math.round(outlierRuleEnabled ? filteredFinal : rawFinal);

          return { finalGrade, prog, pt };
        }).filter(Boolean);

        // ── Average final grade & std dev per program/FYP type ────────────
        const computeGradeStats = list => {
          const grades = list.map(s => s.finalGrade);
          const n = grades.length;
          if (!n) return { avg: 0, std: 0, n: 0 };
          const avg = grades.reduce((a, b) => a + b, 0) / n;
          const variance = grades.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
          return { avg: rnd(avg), std: rnd(Math.sqrt(variance)), n };
        };
        const avgByProgramType = {};
        programs.forEach(p => {
          avgByProgramType[p] = {
            FYP1: computeGradeStats(studentGrades.filter(s => s.prog === p && s.pt === 'FYP1')),
            FYP2: computeGradeStats(studentGrades.filter(s => s.prog === p && s.pt === 'FYP2')),
          };
        });
        const avgOverall = {
          FYP1: computeGradeStats(studentGrades.filter(s => s.pt === 'FYP1')),
          FYP2: computeGradeStats(studentGrades.filter(s => s.pt === 'FYP2')),
        };

        // ── Program summary (projects + students + examiners) ─────────────
        const fyp1ProjIds = new Set(allProjects.filter(p => String(p.type) === 'FYP1').map(p => p.project_id));
        const fyp2ProjIds = new Set(allProjects.filter(p => String(p.type) === 'FYP2').map(p => p.project_id));
        const programStats = {};
        programs.forEach(prog => {
          const progProjs  = allProjects.filter(p => (p.program_type || 'Unspecified') === prog);
          const f1Projs    = progProjs.filter(p => String(p.type) === 'FYP1');
          const f2Projs    = progProjs.filter(p => String(p.type) === 'FYP2');
          const f1IdSet    = new Set(f1Projs.map(p => p.project_id));
          const f2IdSet    = new Set(f2Projs.map(p => p.project_id));
          const allIdSet   = new Set(progProjs.map(p => p.project_id));
          const f1Stu      = allStudents.filter(s => f1IdSet.has(s.project_id)).length;
          const f2Stu      = allStudents.filter(s => f2IdSet.has(s.project_id)).length;
          const totalProj  = progProjs.length;
          const totalStu   = f1Stu + f2Stu;
          const progExs    = allExaminers.filter(e => allIdSet.has(e.project_id));
          const insideCnt  = progExs.filter(e => e.examiner_type === 'Inside University').length;
          const outsideCnt = progExs.filter(e => e.examiner_type === 'Outside the Program/University').length;
          const industryCnt= progExs.filter(e => e.examiner_type === 'Industry').length;
          programStats[prog] = {
            fyp1Projects: f1Projs.length, fyp1Students: f1Stu,
            fyp2Projects: f2Projs.length, fyp2Students: f2Stu,
            totalProjects: totalProj, totalStudents: totalStu,
            insideCount: insideCnt, outsideCount: outsideCnt, industryCount: industryCnt,
            avgStudentsPerProject: totalProj > 0 ? rnd(totalStu / totalProj) : 0,
            avgInsidePerGroup:     totalProj > 0 ? rnd(insideCnt  / totalProj) : 0,
            avgOutsidePerGroup:    totalProj > 0 ? rnd(outsideCnt / totalProj) : 0,
            avgIndustryPerGroup:   totalProj > 0 ? rnd(industryCnt/ totalProj) : 0,
          };
        });
        const gTotalProj = allProjects.length;
        const gTotalStu  = allStudents.length;
        const gInside    = allExaminers.filter(e => e.examiner_type === 'Inside University').length;
        const gOutside   = allExaminers.filter(e => e.examiner_type === 'Outside the Program/University').length;
        const gIndustry  = allExaminers.filter(e => e.examiner_type === 'Industry').length;
        const grandTotal = {
          fyp1Projects: allProjects.filter(p => String(p.type) === 'FYP1').length,
          fyp1Students: allStudents.filter(s => fyp1ProjIds.has(s.project_id)).length,
          fyp2Projects: allProjects.filter(p => String(p.type) === 'FYP2').length,
          fyp2Students: allStudents.filter(s => fyp2ProjIds.has(s.project_id)).length,
          totalProjects: gTotalProj, totalStudents: gTotalStu,
          insideCount: gInside, outsideCount: gOutside, industryCount: gIndustry,
          avgStudentsPerProject: gTotalProj > 0 ? rnd(gTotalStu / gTotalProj) : 0,
          avgInsidePerGroup:     gTotalProj > 0 ? rnd(gInside   / gTotalProj) : 0,
          avgOutsidePerGroup:    gTotalProj > 0 ? rnd(gOutside  / gTotalProj) : 0,
          avgIndustryPerGroup:   gTotalProj > 0 ? rnd(gIndustry / gTotalProj) : 0,
        };

        // ── Grading criteria counts by role ───────────────────────────────
        const exTypeMap = {};
        allExaminers.forEach(e => { exTypeMap[e.assignment_id] = e.examiner_type; });
        const twCriteriaGraded   = twGrades.filter(g => g.graded_by !== 'system').length;
        const peerCriteriaGraded = peerEvals.length;
        let insideReport = 0, insidePres = 0, outsideReport = 0, outsidePres = 0, industryPres = 0;
        exGrades.forEach(g => {
          const et  = exTypeMap[g.assignment_id] || '';
          const cat = g.category === 'Presentation' ? 'pres' : 'report';
          if      (et === 'Inside University')                 { if (cat === 'report') insideReport++; else insidePres++;  }
          else if (et === 'Outside the Program/University')    { if (cat === 'report') outsideReport++; else outsidePres++; }
          else if (et === 'Industry')                          { if (cat === 'pres')   industryPres++;                     }
        });
        const gradingCounts = { twCriteriaGraded, peerCriteriaGraded,
          insideReport, insidePres, outsideReport, outsidePres, industryPres };

        const now2 = new Date();
        return ok({ success: true, buckets: bucketLabels, overall, byType, byCategory, byProgram,
          programs, programStats, grandTotal, avgByProgramType, avgOverall, gradingCounts,
          meta: { year: `${now2.getFullYear()}–${now2.getFullYear()+1}`, semester: cfg.semester || '', department: 'ECE' } });
      }

      case 'getFinalResults': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });

        const [allProjects, allStudents, twGrades, peerEvals, exGrades, allSups, exCfg, peerCfg, allExaminers] = await Promise.all([
          sql`SELECT * FROM projects`,
          sql`SELECT * FROM students`,
          sql`SELECT * FROM tw_grades`,
          sql`SELECT * FROM peer_evaluations`,
          sql`SELECT * FROM examiner_grades`,
          sql`SELECT * FROM supervisors`,
          sql`SELECT * FROM examiner_config ORDER BY id`,
          sql`SELECT * FROM peer_config ORDER BY question_no`,
          sql`SELECT * FROM examiners`,
        ]);

        const cfg       = await getTWConfig();
        const indRubric = await getIndividualRubric();

        let projects = await filterProjectsBySession(session, allProjects, allSups);
        const programName = session.is_admin ? '' : (session.program || '');

        const projectIds = new Set(projects.map(p => p.project_id));
        const students   = allStudents.filter(s => projectIds.has(s.project_id));

        // ── Per-project completeness ─────────────────────────────────────
        const incompleteByType  = { FYP1: [], FYP2: [] };
        const projectCompletion = {}; // pid → true if fully complete

        projects.forEach(proj => {
          const pid      = proj.project_id;
          const projType = String(proj.type || 'FYP1');
          const key      = projType === 'FYP2' ? 'FYP2' : 'FYP1';
          const projStudents = allStudents.filter(s => s.project_id === pid);
          const missing = [];

          if (projStudents.length > 1) {
            const peerSubmitters = new Set(peerEvals.filter(e => e.project_id === pid).map(e => e.evaluator_id));
            projStudents.forEach(s => { if (!peerSubmitters.has(s.student_id)) missing.push(`Peer eval not submitted by ${s.student_name}`); });
          }

          if (!twGrades.some(g => g.project_id === pid))
            missing.push('Teamwork grades not submitted by supervisor');

          const projExaminers = allExaminers.filter(e => e.project_id === pid);
          if (!projExaminers.length) missing.push('No examiners assigned yet');
          projExaminers.forEach(examiner => {
            const name  = examiner.examiner_name || examiner.examiner_email;
            const eType = examiner.examiner_type;
            if (examiner.status === 'Assigned') { missing.push(`${name} (${eType}) — invitation email not yet sent`); return; }
            const eg      = exGrades.filter(g => g.assignment_id === examiner.assignment_id);
            const hasRep  = eg.some(g => g.category === 'Report');
            const hasPres = eg.some(g => g.category === 'Presentation');
            if (eType === 'Industry') { if (!hasPres) missing.push(`${name} (Industry) — Presentation grades missing`); }
            else { if (!hasRep) missing.push(`${name} (${eType}) — Report grades missing`); if (!hasPres) missing.push(`${name} (${eType}) — Presentation grades missing`); }
          });

          projectCompletion[pid] = missing.length === 0;
          if (missing.length) incompleteByType[key].push({ title: String(proj.title || pid), missing });
        });

        // ── Determine showable projects ──────────────────────────────────
        const showableProjectIds   = new Set();
        let   partialPendingByType = {};
        let   completeTypes        = [];
        let   incompleteOut        = {};

        if (session.is_admin) {
          // Admin: show any individually-complete project, no type-level blocking
          projects.forEach(p => { if (projectCompletion[p.project_id]) showableProjectIds.add(p.project_id); });
          if (showableProjectIds.size === 0)
            return ok({ success: false, incomplete: true, program: '', incompleteByType: {}, message: 'No project has complete grading yet.' });
        } else {
          // Non-admin: program publish / unlock settings gate per-type visibility
          let pubRows = [];
          try {
            if (!_pubSettingsReady) {
              await sql`CREATE TABLE IF NOT EXISTS program_publish_settings (
                program_name TEXT PRIMARY KEY, unlocked_fyp1 BOOLEAN NOT NULL DEFAULT FALSE,
                unlocked_fyp2 BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
              )`;
              _pubSettingsReady = true;
            }
            pubRows = await sql`SELECT * FROM program_publish_settings`;
          } catch {}
          const pubMap = {};
          pubRows.forEach(r => { pubMap[r.program_name] = r; });
          const isUnlocked = (type) => {
            const row = pubMap[programName];
            if (!row) return false;
            return type === 'FYP1' ? !!row.unlocked_fyp1 : !!row.unlocked_fyp2;
          };

          ['FYP1', 'FYP2'].forEach(pt => {
            const typeProjects   = projects.filter(p => String(p.type || 'FYP1') === pt);
            const typeIncomplete = incompleteByType[pt] || [];
            const allComplete    = typeIncomplete.length === 0;
            if (allComplete) {
              completeTypes.push(pt);
              typeProjects.forEach(p => showableProjectIds.add(p.project_id));
            } else if (isUnlocked(pt)) {
              const individually = typeProjects.filter(p => projectCompletion[p.project_id]);
              if (individually.length) {
                individually.forEach(p => showableProjectIds.add(p.project_id));
                partialPendingByType[pt] = typeIncomplete;
              }
            }
          });

          incompleteOut = Object.fromEntries(
            Object.entries(incompleteByType).filter(([t, v]) => v.length > 0 && !isUnlocked(t))
          );

          if (showableProjectIds.size === 0)
            return ok({ success: false, incomplete: true, program: programName, incompleteByType: { ...incompleteOut, ...Object.fromEntries(Object.entries(incompleteByType).filter(([,v]) => v.length > 0)) }, message: 'No project type is fully graded yet.' });
        }

        // ── Compute results for showable projects ────────────────────────
        const showableStudents = students.filter(s => showableProjectIds.has(s.project_id));

        const twW   = parseFloat(cfg.teamwork_weight     || 35) / 100;
        const peerW = parseFloat(cfg.peer_eval_weight    || 20) / 100;
        const supW  = parseFloat(cfg.supervisor_weight   || 80) / 100;
        const repW  = parseFloat(cfg.report_weight       || 35) / 100;
        const presW = parseFloat(cfg.presentation_weight || 30) / 100;
        const outlierRuleEnabled = cfg.outlier_rule_enabled !== '0';

        const results = showableStudents.map(student => {
          const project = projects.find(p => p.project_id === student.project_id);
          const pt      = project ? String(project.type || 'FYP1') : 'FYP1';

          const ind    = twGrades.filter(g => g.student_id === student.student_id && g.grade_type === 'Individual');
          const indMax = indRubric.reduce((s, r) => s + Number(r.maxGrade||25), 0) || 100;
          const indPct = pct(ind.reduce((s, g) => s + parseFloat(g.grade||0), 0), indMax);

          const peer      = peerEvals.filter(e => e.evaluated_id === student.student_id);
          const maxPeer   = peerCfg.reduce((s, q) => s + parseFloat(q.max_grade||10), 0);
          const peerCount = peerCfg.length || 1;
          const peerPct   = pct(peer.reduce((s, e) => s + parseFloat(e.grade||0), 0), maxPeer * (peer.length / peerCount));

          const isSolo    = students.filter(s => s.project_id === student.project_id).length === 1;
          const twScore   = isSolo ? indPct : (indPct * supW) + (peerPct * peerW);

          const projExCfg = exCfg.filter(c => !c.project_type || c.project_type === pt);

          // ── Report: always compute both raw and outlier-filtered grades
          const repCfg     = projExCfg.filter(c => c.category === 'Report');
          const rawRepG    = exGrades.filter(g => g.project_id === student.project_id && g.category === 'Report');
          const repExCount = new Set(rawRepG.map(g => g.assignment_id)).size;
          const { filteredGrades: repGClean, outlierLog: repOutliers } = repExCount >= 3
            ? filterOutlierGrades(rawRepG) : { filteredGrades: rawRepG, outlierLog: [] };
          const repCfgMap = c => ({ CriterionName: c.criterion_name, MaxGrade: c.max_grade, Weight: c.weight });
          const repScope  = g => { const c = repCfg.find(cf => cf.criterion_name === g.criterion); return c && c.grading_scope === 'Individual' ? g.student_id === student.student_id : (g.student_id === 'GROUP' || !g.student_id); };
          const repG          = repGClean.filter(repScope);
          const rawRepGScoped = rawRepG.filter(repScope);
          const repPct        = weightedPct(repG.map(g => ({ Criterion: g.criterion, Score: g.score })), repCfg.map(repCfgMap));
          const rawRepPct     = weightedPct(rawRepGScoped.map(g => ({ Criterion: g.criterion, Score: g.score })), repCfg.map(repCfgMap));

          // ── Presentation: always compute both raw and outlier-filtered grades
          const presCfg     = projExCfg.filter(c => c.category === 'Presentation');
          const rawPresG    = exGrades.filter(g => g.project_id === student.project_id && g.category === 'Presentation');
          const presExCount = new Set(rawPresG.map(g => g.assignment_id)).size;
          const { filteredGrades: presGClean, outlierLog: presOutliers } = presExCount >= 3
            ? filterOutlierGrades(rawPresG) : { filteredGrades: rawPresG, outlierLog: [] };
          const presCfgMap = c => ({ CriterionName: c.criterion_name, MaxGrade: c.max_grade, Weight: c.weight });
          const presScope  = g => { const c = presCfg.find(cf => cf.criterion_name === g.criterion); return c && c.grading_scope === 'Individual' ? g.student_id === student.student_id : (g.student_id === 'GROUP' || !g.student_id); };
          const presG          = presGClean.filter(presScope);
          const rawPresGScoped = rawPresG.filter(presScope);
          const presPct        = weightedPct(presG.map(g => ({ Criterion: g.criterion, Score: g.score })), presCfg.map(presCfgMap));
          const rawPresPct     = weightedPct(rawPresGScoped.map(g => ({ Criterion: g.criterion, Score: g.score })), presCfg.map(presCfgMap));

          const filteredFinal  = (twScore * twW) + (repPct    * repW) + (presPct    * presW);
          const rawFinal       = (twScore * twW) + (rawRepPct * repW) + (rawPresPct * presW);
          const outliers       = [...repOutliers, ...presOutliers];
          const effectiveFinal = outlierRuleEnabled ? filteredFinal : rawFinal;

          const effectiveRounded = Math.round(effectiveFinal);
          return {
            studentId: student.student_id, studentName: student.student_name,
            projectId: student.project_id, projectTitle: project ? project.title : '—',
            projectType: pt, projectProgram: project ? (project.program_type || '') : '',
            teamworkPct: rnd(twScore), reportPct: rnd(repPct), presPct: rnd(presPct),
            rawFinalGrade: Math.round(rawFinal), filteredFinalGrade: Math.round(filteredFinal),
            finalGrade: effectiveRounded, boosted: GRADE_BORDERS.includes(effectiveRounded),
            letterGrade: letterGrade(effectiveFinal),
            isSolo, peerWarning: !isSolo && peer.length === 0,
            outliersDetected: outliers.length > 0,
            outlierDetails: outliers.map(o => ({ criterion: o.criterion, score: o.score })),
          };
        });

        // ── ABET (only for projects in showableProjectIds) ───────────────
        const abetByType = {};
        ['FYP1','FYP2'].forEach(pt => {
          const typeShowable = projects.filter(p => String(p.type||'FYP1') === pt && showableProjectIds.has(p.project_id));
          if (!typeShowable.length) return;
          const typeIds = new Set(typeShowable.map(p => p.project_id));
          const tIndG   = twGrades.filter(g => typeIds.has(g.project_id) && g.grade_type === 'Individual');
          const tExG    = exGrades.filter(g => typeIds.has(g.project_id));
          function computeABET(tag) {
            const cp = [];
            indRubric.filter(r => String(r.abetOutcome||'') === tag).forEach(c => {
              const gs = tIndG.filter(g => g.criterion === c.criterion);
              if (!gs.length) return;
              cp.push((gs.filter(g=>parseFloat(g.grade||0)>=0.7*c.maxGrade).length/gs.length)*100);
            });
            exCfg.filter(c => String(c.abet_outcome||'') === tag).forEach(c => {
              const cg = tExG.filter(g => g.criterion === c.criterion_name);
              if (!cg.length) return;
              cp.push((cg.filter(g=>parseFloat(g.score||0)>=0.7*parseFloat(c.max_grade||100)).length/cg.length)*100);
            });
            if (!cp.length) return tag === '2b' ? { notMeasured: true } : null;
            const avg2 = cp.reduce((a,b)=>a+b,0)/cp.length;
            return { pct: rnd(avg2), level: avg2<60?1:avg2<70?2:avg2<85?3:4 };
          }
          abetByType[pt] = { abet1a: computeABET('1a'), abet2a: computeABET('2a'), abet2b: computeABET('2b'), abet3a: computeABET('3a'), abet3b: computeABET('3b'), abet4a: computeABET('4a'), abet5a: computeABET('5a'), abet5b: computeABET('5b'), abet7a: computeABET('7a') };
        });

        // ── Per-program ABET (for admin program filter in UI) ────────────
        const abetByProgram = {};
        const progNames = [...new Set(projects.map(p => p.program_type || 'Unspecified'))];
        progNames.forEach(prog => {
          abetByProgram[prog] = {};
          ['FYP1','FYP2'].forEach(pt => {
            const progProjs = projects.filter(p => String(p.type||'FYP1') === pt && (p.program_type||'Unspecified') === prog && showableProjectIds.has(p.project_id));
            if (!progProjs.length) return;
            const progIds = new Set(progProjs.map(p => p.project_id));
            const tIndG   = twGrades.filter(g => progIds.has(g.project_id) && g.grade_type === 'Individual');
            const tExG    = exGrades.filter(g => progIds.has(g.project_id));
            function computeABETprog(tag) {
              const cp = [];
              indRubric.filter(r => String(r.abetOutcome||'') === tag).forEach(c => {
                const gs = tIndG.filter(g => g.criterion === c.criterion);
                if (!gs.length) return;
                cp.push((gs.filter(g=>parseFloat(g.grade||0)>=0.7*c.maxGrade).length/gs.length)*100);
              });
              exCfg.filter(c => String(c.abet_outcome||'') === tag).forEach(c => {
                const cg = tExG.filter(g => g.criterion === c.criterion_name);
                if (!cg.length) return;
                cp.push((cg.filter(g=>parseFloat(g.score||0)>=0.7*parseFloat(c.max_grade||100)).length/cg.length)*100);
              });
              if (!cp.length) return tag === '2b' ? { notMeasured: true } : null;
              const avg2 = cp.reduce((a,b)=>a+b,0)/cp.length;
              return { pct: rnd(avg2), level: avg2<60?1:avg2<70?2:avg2<85?3:4 };
            }
            abetByProgram[prog][pt] = { abet1a: computeABETprog('1a'), abet2a: computeABETprog('2a'), abet2b: computeABETprog('2b'), abet3a: computeABETprog('3a'), abet3b: computeABETprog('3b'), abet4a: computeABETprog('4a'), abet5a: computeABETprog('5a'), abet5b: computeABETprog('5b'), abet7a: computeABETprog('7a') };
          });
        });

        const statsByType = {};
        ['FYP1','FYP2'].forEach(pt => {
          const gr = results.filter(r => r.projectType === pt);
          if (!gr.length) return;
          const mean = gr.reduce((s,r)=>s+r.finalGrade,0)/gr.length;
          const sd   = Math.sqrt(gr.reduce((s,r)=>s+Math.pow(r.finalGrade-mean,2),0)/gr.length);
          statsByType[pt] = { count: gr.length, mean: rnd(mean), sd: rnd(sd) };
        });

        return ok({ success: true, results, abetByType, abetByProgram, statsByType, incompleteByType: incompleteOut, completeTypes, partialPendingByType, outlierRuleEnabled });
      }

      case 'updateProject': {
        const [sessionToken, projectId, updates] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const projectRows = await sql`SELECT supervisors FROM projects WHERE project_id = ${projectId}`;
        const project = projectRows[0] || null;
        if (!project) return ok({ success: false, message: 'Project not found.' });
        const isOwner = (project.supervisors || '').split(',').map(x => x.trim()).includes(session.supervisor_id);
        if (!session.is_admin && !isOwner) return ok({ success: false, message: 'You can only edit projects you supervise.' });

        const patch = {};
        if (updates.title    !== undefined) patch.title    = String(updates.title).trim();
        if (updates.type     !== undefined) patch.type     = updates.type;
        if (updates.semester !== undefined) patch.semester = updates.semester;
        if (updates.year     !== undefined) patch.year     = updates.year;
        if (updates.endDate  !== undefined) patch.end_date = updates.endDate;
        if (updates.disableNotifications !== undefined) patch.disable_notifications = !!updates.disableNotifications;
        if (patch.title !== undefined && !patch.title) return ok({ success: false, message: 'Title cannot be empty.' });

        if (updates.students !== undefined) {
          const submitted   = (updates.students || []).map(s => ({ ...s, studentId: String(s.studentId).trim(), studentName: String(s.studentName).trim() }));
          if (!submitted.length) return ok({ success: false, message: 'A project must have at least one student.' });
          const submittedIds = submitted.map(s => s.studentId);

          const currentStudents = await sql`SELECT * FROM students WHERE project_id = ${projectId}`;
          const currentIds = currentStudents.map(s => s.student_id);

          const toDelete = currentIds.filter(id => !submittedIds.includes(id));
          const toInsert = submitted.filter(s => !s.isExisting);
          const toUpdate = submitted.filter(s => s.isExisting);

          if (toInsert.length) {
            // Within-batch duplicate check before any write
            const newIds   = new Set();
            const newNames = new Set();
            for (const s of toInsert) {
              if (newIds.has(s.studentId))
                return ok({ success: false, message: `Duplicate Student ID "${s.studentId}" in the submitted list.` });
              newIds.add(s.studentId);
              const norm = s.studentName.toLowerCase().trim();
              if (newNames.has(norm))
                return ok({ success: false, message: `Duplicate Student name "${s.studentName}" in the submitted list.` });
              newNames.add(norm);
            }
            const otherStudents = await sql`SELECT student_id, student_name FROM students WHERE project_id != ${projectId}`;
            for (const s of toInsert) {
              if (otherStudents.some(r => r.student_id === s.studentId))
                return ok({ success: false, message: `Student ID "${s.studentId}" is already registered in another project.` });
              if (otherStudents.some(r => r.student_name.trim().toLowerCase() === s.studentName.toLowerCase()))
                return ok({ success: false, message: `Student name "${s.studentName}" is already registered in another project.` });
            }
          }

          for (const id of toDelete) {
            await sql`DELETE FROM tw_grades WHERE student_id = ${id} AND project_id = ${projectId}`;
            await sql`DELETE FROM peer_evaluations WHERE evaluator_id = ${id}`;
            await sql`DELETE FROM peer_evaluations WHERE evaluated_id = ${id}`;
            await sql`DELETE FROM examiner_grades WHERE student_id = ${id} AND project_id = ${projectId}`;
            await sql`DELETE FROM students WHERE student_id = ${id}`;
          }
          for (const s of toUpdate) {
            await sql`UPDATE students SET student_name = ${s.studentName}, email = ${s.email || ''} WHERE student_id = ${s.studentId}`;
          }
          const insertedNewIds = [];
          try {
            for (const s of toInsert) {
              await sql`INSERT INTO students (student_id, student_name, email, project_id) VALUES (${s.studentId}, ${s.studentName}, ${s.email || ''}, ${projectId})`;
              insertedNewIds.push(s.studentId);
            }
          } catch (insertErr) {
            for (const sid of insertedNewIds) {
              await sql`DELETE FROM students WHERE student_id = ${sid}`.catch(() => {});
            }
            return ok({ success: false, message: 'Failed to add new students due to a database error — no new students were saved. Please check the data and try again.' });
          }
          patch.students = submittedIds.join(',');
        }

        if (Object.keys(patch).length) {
          const fields = [];
          const params = [];
          let idx = 1;
          for (const [k, v] of Object.entries(patch)) {
            fields.push(`${k} = $${idx++}`);
            params.push(v);
          }
          params.push(projectId);
          await sql(`UPDATE projects SET ${fields.join(', ')} WHERE project_id = $${idx}`, params);
        }
        return ok({ success: true });
      }

      // ─── Grade Publishing Settings ───────────────────────────────
      // Admin can unlock per-program per-type so supervisors see
      // results project-by-project as each finishes, without waiting
      // for the entire program cohort.

      case 'getProgramPublishSettings': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        if (!_pubSettingsReady) {
          try {
            await sql`CREATE TABLE IF NOT EXISTS program_publish_settings (
              program_name TEXT PRIMARY KEY, unlocked_fyp1 BOOLEAN NOT NULL DEFAULT FALSE,
              unlocked_fyp2 BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`;
            _pubSettingsReady = true;
          } catch {}
        }
        const programs = await sql`SELECT * FROM programs ORDER BY program_name`;
        const settings = await sql`SELECT * FROM program_publish_settings`;
        const map = {};
        settings.forEach(r => { map[r.program_name] = r; });
        return ok({
          success: true,
          settings: programs.map(p => ({
            programName:   p.program_name,
            unlockedFyp1:  !!(map[p.program_name]?.unlocked_fyp1),
            unlockedFyp2:  !!(map[p.program_name]?.unlocked_fyp2),
          })),
        });
      }

      case 'setProgramPublish': {
        const [sessionToken, programName, unlockedFyp1, unlockedFyp2] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        if (!_pubSettingsReady) {
          try {
            await sql`CREATE TABLE IF NOT EXISTS program_publish_settings (
              program_name TEXT PRIMARY KEY, unlocked_fyp1 BOOLEAN NOT NULL DEFAULT FALSE,
              unlocked_fyp2 BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`;
            _pubSettingsReady = true;
          } catch {}
        }
        await sql`INSERT INTO program_publish_settings (program_name, unlocked_fyp1, unlocked_fyp2, updated_at)
                  VALUES (${programName}, ${!!unlockedFyp1}, ${!!unlockedFyp2}, NOW())
                  ON CONFLICT (program_name) DO UPDATE
                  SET unlocked_fyp1 = ${!!unlockedFyp1}, unlocked_fyp2 = ${!!unlockedFyp2}, updated_at = NOW()`;
        return ok({ success: true });
      }

      case 'getGradeBoostConfig': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        const borders = await getActiveBorders(sql);
        const activeSet = new Set(borders);
        return ok({
          success: true,
          boundaries: ALL_BOUNDARIES.map(b => ({ boundary: b, boosted: activeSet.has(b) })),
        });
      }

      case 'setGradeBoostConfig': {
        const [sessionToken, config] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        await sql`CREATE TABLE IF NOT EXISTS grade_boost_config (
          boundary INT PRIMARY KEY, boosted BOOLEAN NOT NULL DEFAULT TRUE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
        for (const { boundary, boosted } of (config || [])) {
          if (!ALL_BOUNDARIES.includes(Number(boundary))) continue;
          await sql`INSERT INTO grade_boost_config (boundary, boosted, updated_at)
                    VALUES (${Number(boundary)}, ${!!boosted}, NOW())
                    ON CONFLICT (boundary) DO UPDATE SET boosted = EXCLUDED.boosted, updated_at = NOW()`;
        }
        return ok({ success: true });
      }

      case 'getMyDistributionAccess': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        if (session.is_admin) return ok({ success: true, canAccess: true });
        if (!_distAccessReady) {
          await sql`CREATE TABLE IF NOT EXISTS distribution_report_access (
            supervisor_id TEXT PRIMARY KEY,
            granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
          _distAccessReady = true;
        }
        const rows = await sql`SELECT 1 FROM distribution_report_access WHERE supervisor_id = ${session.supervisor_id}`;
        return ok({ success: true, canAccess: rows.length > 0 });
      }

      case 'getDistributionReportAccess': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        if (!_distAccessReady) {
          await sql`CREATE TABLE IF NOT EXISTS distribution_report_access (
            supervisor_id TEXT PRIMARY KEY,
            granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
          _distAccessReady = true;
        }
        const allSups  = await sql`SELECT * FROM supervisors WHERE supervisor_id != ${ADMIN_ID} ORDER BY name`;
        const granted  = await sql`SELECT supervisor_id FROM distribution_report_access`;
        const grantSet = new Set(granted.map(r => r.supervisor_id));
        return ok({
          success: true,
          supervisors: allSups.map(r => ({
            id:        r.supervisor_id,
            name:      r.name,
            program:   r.program   || '',
            email:     r.email     || '',
            hasAccess: grantSet.has(r.supervisor_id),
          })),
        });
      }

      case 'setDistributionReportAccess': {
        const [sessionToken, allowedIds] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        if (!_distAccessReady) {
          await sql`CREATE TABLE IF NOT EXISTS distribution_report_access (
            supervisor_id TEXT PRIMARY KEY,
            granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
          _distAccessReady = true;
        }
        await sql`DELETE FROM distribution_report_access`;
        for (const id of (allowedIds || [])) {
          if (id) await sql`INSERT INTO distribution_report_access (supervisor_id)
                            VALUES (${String(id)}) ON CONFLICT DO NOTHING`;
        }
        return ok({ success: true });
      }

      case 'getExNamesAccess': {
        const [sessionToken] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        if (!_exNamesAccessReady) {
          await sql`CREATE TABLE IF NOT EXISTS examiner_names_access (supervisor_id TEXT PRIMARY KEY, granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
          _exNamesAccessReady = true;
        }
        const allSups = await sql`SELECT * FROM supervisors WHERE supervisor_id != ${ADMIN_ID} ORDER BY name`;
        const granted = await sql`SELECT supervisor_id FROM examiner_names_access`;
        const grantSet = new Set(granted.map(r => r.supervisor_id));
        return ok({
          success: true,
          supervisors: allSups.map(r => ({
            id: r.supervisor_id, name: r.name, program: r.program || '', hasAccess: grantSet.has(r.supervisor_id),
          })),
        });
      }

      case 'setExNamesAccess': {
        const [sessionToken, allowedIds] = args;
        const session = await verifySession(sessionToken);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        if (!_exNamesAccessReady) {
          await sql`CREATE TABLE IF NOT EXISTS examiner_names_access (supervisor_id TEXT PRIMARY KEY, granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
          _exNamesAccessReady = true;
        }
        await sql`DELETE FROM examiner_names_access`;
        for (const id of (allowedIds || [])) {
          if (id) await sql`INSERT INTO examiner_names_access (supervisor_id) VALUES (${String(id)}) ON CONFLICT DO NOTHING`;
        }
        return ok({ success: true });
      }

      case 'deleteProject': {
        const [sessionToken, projectId] = args;
        const session = await verifySession(sessionToken);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        if (!session.is_admin) return ok({ success: false, message: 'Only the admin can delete projects.' });
        await sql`DELETE FROM peer_evaluations WHERE project_id = ${projectId}`;
        await sql`DELETE FROM examiner_grades WHERE project_id = ${projectId}`;
        await sql`DELETE FROM examiners WHERE project_id = ${projectId}`;
        await sql`DELETE FROM tw_grades WHERE project_id = ${projectId}`;
        await sql`DELETE FROM students WHERE project_id = ${projectId}`;
        await sql`DELETE FROM projects WHERE project_id = ${projectId}`;
        return ok({ success: true });
      }

      // ─── Outlier Rule Config ─────────────────────────────────────────────

      case 'getOutlierRuleEnabled': {
        const [token] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const cfg2 = await getTWConfig();
        return ok({ success: true, enabled: cfg2.outlier_rule_enabled !== '0' });
      }

      case 'setOutlierRuleEnabled': {
        const [token, enabled] = args;
        const session = await verifySession(token);
        if (!session || !session.is_admin) return ok({ success: false, message: 'Unauthorized.' });
        await sql`INSERT INTO tw_config (config_key, config_value) VALUES ('outlier_rule_enabled', ${enabled ? '1' : '0'}) ON CONFLICT (config_key) DO UPDATE SET config_value = ${enabled ? '1' : '0'}`;
        return ok({ success: true });
      }

      // ─── Meeting Organizer ───────────────────────────────────────────────

      case 'getMeetingSessions': {
        const [token] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        await ensureMeetingTables(sql);
        const rows = await sql`SELECT id, session_number, academic_year, meeting_date, meeting_time, created_by, last_modified_at FROM meeting_sessions ORDER BY session_number DESC`;
        return ok({ success: true, sessions: rows });
      }

      case 'createMeetingSession': {
        const [token] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        await ensureMeetingTables(sql);
        const latestRows = await sql`SELECT session_number, created_at, meeting_date FROM meeting_sessions ORDER BY session_number DESC LIMIT 1`;
        if (latestRows.length) {
          const latest = latestRows[0];
          const daysSinceCreated = (Date.now() - new Date(latest.created_at).getTime()) / (1000 * 60 * 60 * 24);
          const meetingDatePassed = latest.meeting_date && new Date(latest.meeting_date) < new Date();
          if (!meetingDatePassed && daysSinceCreated < 7) {
            const daysLeft = Math.ceil(7 - daysSinceCreated);
            return ok({ success: false, message: `Cannot create a new session yet. The previous session must be completed (meeting date set and passed) or at least 7 days must pass since it was created (${daysLeft} day(s) remaining).` });
          }
        }
        const maxRow = await sql`SELECT COALESCE(MAX(session_number), 13) AS mx FROM meeting_sessions`;
        const nextNum = Number(maxRow[0].mx) + 1;
        const now = new Date();
        const acYear = now.getMonth() >= 8 ? `${now.getFullYear()}/${now.getFullYear()+1}` : `${now.getFullYear()-1}/${now.getFullYear()}`;
        const rows = await sql`INSERT INTO meeting_sessions (session_number, academic_year, created_by) VALUES (${nextNum}, ${acYear}, ${session.supervisor_id}) RETURNING *`;
        return ok({ success: true, session: rows[0] });
      }

      case 'getMySessionEntries': {
        const [token, sessionId] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        await ensureMeetingTables(sql);
        const rows = await sql`SELECT * FROM meeting_entries WHERE session_id = ${Number(sessionId)} AND supervisor_id = ${session.supervisor_id} ORDER BY section, created_at`;
        return ok({ success: true, entries: rows });
      }

      case 'addMeetingEntry': {
        const [token, sessionId, section, entryType, entryData, attributedId, attributedName] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        await ensureMeetingTables(sql);
        const finalData = attributedName
          ? { ...(entryData || {}), __attributedId: attributedId, __attributedName: attributedName }
          : (entryData || {});
        const rows = await sql`INSERT INTO meeting_entries (session_id, supervisor_id, section, entry_type, entry_data) VALUES (${Number(sessionId)}, ${session.supervisor_id}, ${section}, ${entryType}, ${JSON.stringify(finalData)}) RETURNING *`;
        await sql`UPDATE meeting_sessions SET last_modified_at = NOW() WHERE id = ${Number(sessionId)}`;
        return ok({ success: true, entry: rows[0] });
      }

      case 'updateMeetingEntry': {
        const [token, entryId, entryData, attributedId, attributedName] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const authorized = isAdminUser(session) || await isMeetingDelegate(sql, session.supervisor_id);
        const finalData = attributedName
          ? { ...(entryData || {}), __attributedId: attributedId, __attributedName: attributedName }
          : (entryData || {});
        const rows = authorized
          ? await sql`UPDATE meeting_entries SET entry_data = ${JSON.stringify(finalData)}, updated_at = NOW() WHERE id = ${Number(entryId)} RETURNING session_id`
          : await sql`UPDATE meeting_entries SET entry_data = ${JSON.stringify(finalData)}, updated_at = NOW() WHERE id = ${Number(entryId)} AND supervisor_id = ${session.supervisor_id} RETURNING session_id`;
        if (rows.length) await sql`UPDATE meeting_sessions SET last_modified_at = NOW() WHERE id = ${rows[0].session_id}`;
        return ok({ success: true });
      }

      case 'deleteMeetingEntry': {
        const [token, entryId] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const authorized = isAdminUser(session) || await isMeetingDelegate(sql, session.supervisor_id);
        const rows = authorized
          ? await sql`DELETE FROM meeting_entries WHERE id = ${Number(entryId)} RETURNING session_id`
          : await sql`DELETE FROM meeting_entries WHERE id = ${Number(entryId)} AND supervisor_id = ${session.supervisor_id} RETURNING session_id`;
        if (rows.length) await sql`UPDATE meeting_sessions SET last_modified_at = NOW() WHERE id = ${rows[0].session_id}`;
        return ok({ success: true });
      }

      case 'updateSessionDetails': {
        const [token, sessionId, meetingDate, meetingTime] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        await sql`UPDATE meeting_sessions SET meeting_date = ${meetingDate || null}, meeting_time = ${meetingTime || null}, last_modified_at = NOW() WHERE id = ${Number(sessionId)}`;
        return ok({ success: true });
      }

      case 'deleteSession': {
        const [token, sessionId] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        await ensureMeetingTables(sql);
        const sid = Number(sessionId);
        if (session.is_admin) {
          // Admin can delete any session (and its entries)
          await sql`DELETE FROM meeting_entries WHERE session_id = ${sid}`;
          await sql`DELETE FROM meeting_sessions WHERE id = ${sid}`;
          return ok({ success: true });
        }
        // Non-admin: must be creator AND sole contributor
        const sesRows = await sql`SELECT created_by FROM meeting_sessions WHERE id = ${sid}`;
        if (!sesRows.length) return ok({ success: false, message: 'Session not found.' });
        if (sesRows[0].created_by !== session.supervisor_id) return ok({ success: false, message: 'Only the session creator can delete this session.' });
        const otherEntries = await sql`SELECT 1 FROM meeting_entries WHERE session_id = ${sid} AND supervisor_id <> ${session.supervisor_id} LIMIT 1`;
        if (otherEntries.length) return ok({ success: false, message: 'Cannot delete: other members have already contributed to this session.' });
        await sql`DELETE FROM meeting_entries WHERE session_id = ${sid}`;
        await sql`DELETE FROM meeting_sessions WHERE id = ${sid}`;
        return ok({ success: true });
      }

      case 'getReportData': {
        const [token, sessionId] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        await ensureMeetingTables(sql);
        const sessionRows = await sql`SELECT * FROM meeting_sessions WHERE id = ${Number(sessionId)}`;
        if (!sessionRows.length) return ok({ success: false, message: 'Session not found.' });
        const entries = await sql`
          SELECT me.*,
                 COALESCE(me.entry_data->>'__attributedName', s.name) AS supervisor_name,
                 s.name AS actual_supervisor_name
          FROM meeting_entries me
          JOIN supervisors s ON s.supervisor_id = me.supervisor_id
          WHERE me.session_id = ${Number(sessionId)}
          ORDER BY me.section, me.created_at
        `;
        return ok({ success: true, session: sessionRows[0], entries });
      }

      case 'getAllSessionEntries': {
        const [token, sessionId] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const authorized = isAdminUser(session) || await isMeetingDelegate(sql, session.supervisor_id);
        if (!authorized) return ok({ success: false, message: 'Unauthorized.' });
        await ensureMeetingTables(sql);
        const rows = await sql`
          SELECT me.*,
                 COALESCE(me.entry_data->>'__attributedName', s.name) AS supervisor_name,
                 s.name AS actual_supervisor_name
          FROM meeting_entries me
          JOIN supervisors s ON s.supervisor_id = me.supervisor_id
          WHERE me.session_id = ${Number(sessionId)}
          ORDER BY me.section, me.created_at
        `;
        return ok({ success: true, entries: rows });
      }

      case 'getMeetingDelegates': {
        const [token] = args;
        const session = await verifySession(token);
        if (!isAdminUser(session)) return ok({ success: false, message: 'Unauthorized.' });
        await ensureDelegateTables(sql);
        const rows = await sql`
          SELECT d.supervisor_id, s.name, s.program
          FROM meeting_delegates d
          JOIN supervisors s ON s.supervisor_id = d.supervisor_id
          ORDER BY s.name
        `;
        return ok({ success: true, delegates: rows });
      }

      case 'setMeetingDelegates': {
        const [token, supervisorIds] = args;
        const session = await verifySession(token);
        if (!isAdminUser(session)) return ok({ success: false, message: 'Unauthorized.' });
        await ensureDelegateTables(sql);
        await sql`DELETE FROM meeting_delegates`;
        for (const id of (supervisorIds || [])) {
          if (id) await sql`INSERT INTO meeting_delegates (supervisor_id, granted_by) VALUES (${String(id)}, ${session.supervisor_id}) ON CONFLICT DO NOTHING`;
        }
        return ok({ success: true });
      }

      case 'getIsDelegateInfo': {
        const [token] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, isDelegate: false });
        if (isAdminUser(session)) return ok({ success: true, isDelegate: true, isAdmin: true });
        const isDelegate = await isMeetingDelegate(sql, session.supervisor_id);
        return ok({ success: true, isDelegate, isAdmin: false });
      }

      // ─── Department mailer (any signed-in supervisor) ────────────────

      case 'mailPreview': {
        const [token, payload] = args;
        if (!await verifySession(token)) return ok({ success: false, message: 'Session expired.' });
        return ok({ success: true, html: buildMailBody(payload || {}) });
      }

      case 'mailRecipientBook': {
        // Colleagues, so addresses can be picked rather than typed
        const [token] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const rows = await sql`SELECT name, email, program FROM supervisors
          WHERE supervisor_id != ${ADMIN_ID} AND email != '' ORDER BY name`;
        const seen = new Set(), people = [];
        for (const r of rows) {
          const e = (r.email || '').trim().toLowerCase();
          if (!e || seen.has(e)) continue;
          seen.add(e);
          people.push({ name: r.name, email: r.email, program: r.program || '' });
        }
        return ok({ success: true, people });
      }

      case 'mailSend': {
        const [token, payload] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        if (!MAILTRAP_API_KEY || !SENDER_EMAIL)
          return ok({ success: false, message: 'Email is not configured on the server.' });

        const p = payload || {};
        const subject = String(p.subject || '').trim();
        if (!subject) return ok({ success: false, message: 'Please enter a subject.' });
        if (!String(p.body || '').trim()) return ok({ success: false, message: 'The message is empty.' });

        const raw = String(p.to || '').split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
        const seen = new Set(), list = [], bad = [];
        for (const addr of raw) {
          const a = addr.toLowerCase();
          if (seen.has(a)) continue;
          seen.add(a);
          (EMAIL_RE.test(a) ? list : bad).push(addr);
        }
        if (bad.length) return ok({ success: false, message: `Not a valid address: ${bad.slice(0, 5).join(', ')}` });
        if (!list.length) return ok({ success: false, message: 'Please enter at least one recipient.' });
        if (list.length > MAIL_MAX_RECIPIENTS)
          return ok({ success: false, message: `That is ${list.length} recipients — the limit is ${MAIL_MAX_RECIPIENTS}.` });

        const supRows = await sql`SELECT name, email FROM supervisors WHERE supervisor_id = ${session.supervisor_id}`;
        const me = supRows[0] || { name: session.name || '', email: '' };
        const fromName = `${me.name || 'ECE Department'} — ECE Department, BAU`;
        const html = buildMailBody(p);

        const sent = [], failed = [];
        for (const to of list) {
          try {
            await sendEmailAs(to, subject, html, fromName, me.email || '');
            sent.push(to);
          } catch (e) {
            failed.push({ email: to, error: e.message || String(e) });
          }
          if (list.length > 1) await new Promise(r => setTimeout(r, 150));
        }

        // Recorded because the message leaves the department's own address
        try {
          await ensureMailLog(sql);
          await sql`INSERT INTO email_log
            (supervisor_id, supervisor_name, subject, recipients, sent_count, failed_count)
            VALUES (${session.supervisor_id}, ${me.name || ''}, ${subject},
                    ${list.join(', ').slice(0, 4000)}, ${sent.length}, ${failed.length})`;
        } catch { /* logging must never block a delivered message */ }

        return ok({ success: true, sent, failed, replyTo: me.email || '' });
      }

      case 'mailHistory': {
        const [token, mineOnly] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        await ensureMailLog(sql);
        const rows = isAdminUser(session) && !mineOnly
          ? await sql`SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 100`
          : await sql`SELECT * FROM email_log WHERE supervisor_id = ${session.supervisor_id}
                      ORDER BY sent_at DESC LIMIT 100`;
        return ok({
          success: true,
          isAdmin: isAdminUser(session),
          items: rows.map(r => ({
            at: r.sent_at, by: r.supervisor_name || r.supervisor_id, subject: r.subject,
            recipients: r.recipients, sent: Number(r.sent_count), failed: Number(r.failed_count),
          })),
        });
      }

      case 'getMeetingSupervisors': {
        const [token] = args;
        const session = await verifySession(token);
        if (!session) return ok({ success: false, message: 'Session expired.' });
        const rows = await sql`SELECT supervisor_id, name, program FROM supervisors WHERE supervisor_id != ${ADMIN_ID} ORDER BY name`;
        return ok({ success: true, supervisors: rows });
      }

      default:
        return ok({ success: false, message: 'Unknown action: ' + action });
    }
  }

  try {
    const result = await dispatch();
    res.json(result);
  } catch (err) {
    if (!res.headersSent) {
      res.json({ success: false, message: err.message || String(err) });
    }
  }
};
