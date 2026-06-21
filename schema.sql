-- FYP Management System — Neon PostgreSQL Schema
-- Run this ONCE in the Neon SQL Editor after creating your project.

-- ── Sessions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  supervisor_id TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  program       TEXT NOT NULL DEFAULT '',
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON sessions (last_seen);

-- ── Login lockout ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_lockout (
  supervisor_id TEXT PRIMARY KEY,
  tries         INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ
);

-- ── Programs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS programs (
  program_name TEXT PRIMARY KEY
);

-- ── Supervisors ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supervisors (
  supervisor_id TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  program       TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  password      TEXT NOT NULL DEFAULT ''
);

-- ── Projects ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  project_id            TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  type                  TEXT NOT NULL,
  semester              TEXT NOT NULL DEFAULT '',
  year                  TEXT NOT NULL DEFAULT '',
  end_date              TEXT NOT NULL DEFAULT '',
  program_type          TEXT NOT NULL DEFAULT '',
  supervisors           TEXT NOT NULL DEFAULT '',
  students              TEXT NOT NULL DEFAULT '',
  disable_notifications BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Students ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS students (
  student_id   TEXT PRIMARY KEY,
  student_name TEXT NOT NULL,
  email        TEXT NOT NULL DEFAULT '',
  project_id   TEXT NOT NULL
);

-- ── Teamwork config (key-value) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tw_config (
  config_key   TEXT PRIMARY KEY,
  config_value TEXT NOT NULL DEFAULT ''
);

-- ── Peer evaluation config ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS peer_config (
  question_no   INTEGER PRIMARY KEY,
  question_text TEXT NOT NULL,
  max_grade     NUMERIC NOT NULL DEFAULT 10,
  weight        NUMERIC NOT NULL DEFAULT 20,
  abet_outcome  TEXT NOT NULL DEFAULT ''
);

-- ── Teamwork grades ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tw_grades (
  grade_id   TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  criterion  TEXT NOT NULL,
  grade      NUMERIC NOT NULL DEFAULT 0,
  graded_by  TEXT NOT NULL,
  grade_type TEXT NOT NULL,
  timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Peer evaluations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS peer_evaluations (
  eval_id      TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  evaluated_id TEXT NOT NULL,
  question_no  INTEGER NOT NULL,
  grade        NUMERIC NOT NULL DEFAULT 0,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS peer_evaluations_eval_idx
  ON peer_evaluations (evaluator_id, evaluated_id, question_no);

-- ── Examiners ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS examiners (
  assignment_id  TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  examiner_name  TEXT NOT NULL DEFAULT '',
  examiner_email TEXT NOT NULL,
  examiner_type  TEXT NOT NULL,
  token          TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'Assigned',
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  report_link    TEXT NOT NULL DEFAULT '',
  draft_grades   JSONB
);

-- ── Examiner grades ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS examiner_grades (
  grade_id       TEXT PRIMARY KEY,
  assignment_id  TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  examiner_email TEXT NOT NULL,
  category       TEXT NOT NULL,
  criterion      TEXT NOT NULL,
  student_id     TEXT NOT NULL DEFAULT '',
  score          NUMERIC NOT NULL DEFAULT 0,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Examiner config (rubric) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS examiner_config (
  id             SERIAL PRIMARY KEY,
  project_type   TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL,
  criterion_name TEXT NOT NULL,
  max_grade      NUMERIC NOT NULL DEFAULT 100,
  weight         NUMERIC NOT NULL DEFAULT 25,
  grading_scope  TEXT NOT NULL DEFAULT 'Individual',
  abet_outcome   TEXT NOT NULL DEFAULT ''
);

-- ── Program grade-publishing settings ───────────────────────────────────
-- unlocked_fyp1/fyp2: when TRUE, supervisors see results per-project as
-- soon as that project is fully graded (instead of waiting for all projects).
CREATE TABLE IF NOT EXISTS program_publish_settings (
  program_name  TEXT PRIMARY KEY,
  unlocked_fyp1 BOOLEAN NOT NULL DEFAULT FALSE,
  unlocked_fyp2 BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════════════
-- SEED DATA — Run once to pre-populate defaults
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO programs (program_name) VALUES
  ('Communication and Electronics'),
  ('Electric Power and Machines Engineering'),
  ('Computer Engineering'),
  ('Biomedical Engineering')
ON CONFLICT DO NOTHING;

-- Admin: A20160170 / Admin
-- Supervisors: password = 'fyp2025' (will be hashed to SHA-256+salt on first login)
INSERT INTO supervisors (supervisor_id, name, program, email, password) VALUES
  ('A20160170', 'Admin',                       'Electric Power and Machines Engineering', 'yousef.ajrah@bau.edu.lb', 'fyp2025'),
  ('F20160170', 'Dr. Youssef Ajra',            'Electric Power and Machines Engineering', 'yousef.ajrah@bau.edu.lb', 'fyp2025'),
  ('SUP_001',   'Dr. Ziad Osman',              'Communication and Electronics',            'alice@university.edu',    'fyp2025'),
  ('SUP_002',   'Dr. Hamza Issa',              'Communication and Electronics',            'bob@university.edu',      'fyp2025'),
  ('SUP_003',   'Dr. Hiba Halabi',             'Communication and Electronics',            'carol@university.edu',    'fyp2025'),
  ('SUP_004',   'Dr. Manal Fattoum',           'Communication and Electronics',            'david@university.edu',    'fyp2025'),
  ('SUP_005',   'Dr. Majeed Abdul Rahman',     'Communication and Electronics',            'eve@university.edu',      'fyp2025'),
  ('SUP_006',   'Dr. Abed Al-Rahman Elfelo',  'Communication and Electronics',            'frank@university.edu',    'fyp2025'),
  ('SUP_007',   'Dr. AbdAllah Al Sabbagh',    'Communication and Electronics',            'frank@university.edu',    'fyp2025'),
  ('SUP_008',   'Dr. Mohammad Tarnini',       'Electric Power and Machines Engineering',  'alice@university.edu',    'fyp2025'),
  ('SUP_009',   'Dr. Abdallah Al-Ghali',      'Electric Power and Machines Engineering',  'alice@university.edu',    'fyp2025'),
  ('SUP_010',   'Dr. Oussama Dankar',         'Electric Power and Machines Engineering',  'alice@university.edu',    'fyp2025'),
  ('SUP_011',   'Dr. Bilal Youssef',          'Electric Power and Machines Engineering',  'alice@university.edu',    'fyp2025'),
  ('SUP_012',   'Dr. Chadi Nohra',            'Electric Power and Machines Engineering',  'alice@university.edu',    'fyp2025'),
  ('SUP_013',   'Dr. Ali Haidar',             'Computer Engineering',                     'alice@university.edu',    'fyp2025'),
  ('SUP_014',   'Dr. Ziad Doughan',           'Computer Engineering',                     'alice@university.edu',    'fyp2025'),
  ('SUP_015',   'Dr. Hiba Bazzi',             'Computer Engineering',                     'alice@university.edu',    'fyp2025'),
  ('SUP_016',   'Dr. Iman Haidar',            'Computer Engineering',                     'alice@university.edu',    'fyp2025'),
  ('SUP_017',   'Dr. Mohammad Ayache',        'Biomedical Engineering',                   'alice@university.edu',    'fyp2025'),
  ('SUP_018',   'Dr. Amira Zaylaa',           'Biomedical Engineering',                   'alice@university.edu',    'fyp2025'),
  ('SUP_019',   'Dr. Alaa Daher',             'Biomedical Engineering',                   'alice@university.edu',    'fyp2025')
ON CONFLICT DO NOTHING;

INSERT INTO tw_config (config_key, config_value) VALUES
  ('teamwork_weight',     '35'),
  ('report_weight',       '35'),
  ('presentation_weight', '30'),
  ('peer_eval_weight',    '20'),
  ('supervisor_weight',   '80')
ON CONFLICT DO NOTHING;

INSERT INTO peer_config (question_no, question_text, max_grade, weight) VALUES
  (1, 'Contribution to project tasks',                          10, 20),
  (2, 'Communication and collaboration with team members',      10, 20),
  (3, 'Reliability and meeting deadlines',                      10, 20),
  (4, 'Quality of work delivered',                              10, 20),
  (5, 'Problem-solving and initiative',                         10, 20)
ON CONFLICT DO NOTHING;

INSERT INTO examiner_config (project_type, category, criterion_name, max_grade, weight, grading_scope, abet_outcome) VALUES
  ('FYP1','Report',      'Problem Definition & Objectives',  100, 25, 'Group',      ''),
  ('FYP1','Report',      'Literature Review & Background',   100, 20, 'Group',      ''),
  ('FYP1','Report',      'Methodology & Implementation',     100, 35, 'Group',      ''),
  ('FYP1','Report',      'Results & Analysis',               100, 20, 'Group',      ''),
  ('FYP1','Presentation','Clarity of Presentation',          100, 30, 'Group',      ''),
  ('FYP1','Presentation','Technical Knowledge & Q&A',        100, 35, 'Individual', ''),
  ('FYP1','Presentation','Project Demonstration',            100, 35, 'Group',      ''),
  ('FYP2','Report',      'Problem Definition & Objectives',  100, 25, 'Group',      ''),
  ('FYP2','Report',      'Literature Review & Background',   100, 20, 'Group',      ''),
  ('FYP2','Report',      'Methodology & Implementation',     100, 35, 'Group',      ''),
  ('FYP2','Report',      'Results & Analysis',               100, 20, 'Group',      ''),
  ('FYP2','Presentation','Clarity of Presentation',          100, 30, 'Group',      ''),
  ('FYP2','Presentation','Technical Knowledge & Q&A',        100, 35, 'Individual', ''),
  ('FYP2','Presentation','Project Demonstration',            100, 35, 'Group',      '');
