# FYP Projects Organizer — v4 Design Specification

**Status:** build steps 1–8 complete (step 9, email notifications, not built) · **Base:** v3 (frozen) · **Stamp:** v04-16-09-2026 R01

## Scope decisions (confirmed)

| # | Decision |
|---|---|
| 1 | Student access = self-declared **full name + ID** (no roster, no password). Uniqueness enforced on both name and ID. |
| 2 | **Manual assignment inside the system, then auto-creation** of projects in the existing FYP system. No matching algorithm — doctors decide every pairing by hand. |
| 3 | Deadline editable by any supervisor in that program+campus; **admin can lock it or delegate it to one doctor** |
| 4 | **FYP1 only**, one cycle per semester |
| 5 | Develop against the **live Neon database** (all new tables are `org_*`; only existing-table change is `supervisors.campus`) |
| 6 | **Students-only** preferences; supervisors do not rank groups |

---

## 1. Phase state machine

One row per (academic_year, semester, program, campus). Every permission check reads this single field.

```
IDEAS_OPEN -> RANKING_OPEN -> RANKING_CLOSED -> ALLOCATED
```

- **IDEAS_OPEN** — supervisors draft/submit ideas. Students see "not yet open".
- **RANKING_OPEN** — reached automatically when the **idea deadline passes**; anyone who never responded is then recorded as having no ideas. There is no manual publish button and no supervisor is ever asked about, or shown, another supervisor's progress at submission time. Because there is no scheduler, the deadline is evaluated whenever a cycle is loaded (`maybeAutoPublish`). If no idea deadline is set the list never opens, so the control panel warns about it. Groups rank; editable until the ranking deadline. (Groups may be formed during IDEAS_OPEN too, so students can organise early.)
- **RANKING_CLOSED** — ranking frozen; matching can run.
- **ALLOCATED** — allocation published; projects + students rows created in the live FYP tables.

## 2. Data model (all new tables additive)

```sql
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS campus TEXT NOT NULL DEFAULT '';
-- v3 reads supervisors with SELECT *, so this is safe for the frozen version.
```

**org_cycles** — id, academic_year, semester, program, campus, phase, ideas_deadline, ranking_deadline, deadline_policy ('open' | 'locked' | 'delegate'), deadline_delegate, min_group_size (2), max_group_size (5), timestamps.
`UNIQUE (academic_year, semester, program, campus)`

**org_participants** — cycle_id, supervisor_id, max_groups (default 2), status ('not_started' | 'draft' | 'submitted' | 'declared_none'), submitted_at.
`PK (cycle_id, supervisor_id)` — this defines who the checkmark list covers.

**org_ideas** — id, cycle_id, supervisor_id, title, field, description, prerequisites, min_students, max_students, co_supervisor_id, status ('draft' | 'submitted' | 'withdrawn'), timestamps.
`UNIQUE INDEX (cycle_id, lower(title))`

**org_groups** — id, cycle_id, group_code, created_by_student_id, status ('forming' | 'ranked' | 'allocated'), rank_version, ranked_by_student_id, ranked_at, created_at.
`UNIQUE INDEX (cycle_id, group_code)` — codes are unique per cycle, not globally, so numbering restarts each semester.

Group codes read `PROGRAM-CAMPUS-Gnn`, e.g. **EPME-D-G01** (Electric Power and Machines Engineering, Debbieh, group 1) or **CE-T-G03**. The campus letter comes from the cycle, and `nn` is the next unused number in that cycle — taken from the highest existing code rather than a row count, so deleting a group never reissues its code. Abbreviations: EPME, CEE, CE, BME; any programme added later falls back to its initials.

**org_group_members** — id, cycle_id, group_id, student_id, student_name, email (**required for the group creator** — used for the assignment notification and the FYP grading portal's week-14 reminder), added_by_student_id, joined_at.

Only the student who created a group may add or remove members, or delete the group; teammates see the membership read-only and take part only in the ranking. The creator is marked GROUP CREATOR in the member list.
`UNIQUE (cycle_id, student_id)` and `UNIQUE INDEX (cycle_id, lower(student_name))`

> These two indexes **are** the duplicate-prevention mechanism. Application-level checks alone cannot survive two students submitting overlapping groups at the same moment, because Neon serverless gives no transaction spanning requests.

**org_rankings** — id, group_id, idea_id, rank. `UNIQUE (group_id, idea_id)`, `UNIQUE (group_id, rank)`

**org_audit** — id, cycle_id, group_id, actor_type, actor_id, actor_name, action, details JSONB, created_at.

**org_allocations** — id, cycle_id, group_id, idea_id, assigned_rank (the rank this idea held in that group's list, recorded for reporting), assigned_by (supervisor_id), status ('draft' | 'published'), project_id, created_at.
`UNIQUE (cycle_id, group_id)` and `UNIQUE (cycle_id, idea_id)` — one idea to one group, one idea per group.

## 3. Validation rules

- **Student ID regex: `/^20\d{7}$/`** — deliberately the *same* regex v3 uses in `registerProject`. A stricter `20xx0xxxx` pattern would let the organizer reject IDs that the grading system accepts. The 5th-digit-zero convention is shown as a soft warning, not a block.
- **Name uniqueness** mirrors v3: `registerProject` already rejects a student name that exists in any other project, so the organizer must apply the same rule or allocation publish will fail at the last step.
- **Group size** must be within the cycle min/max, and within the chosen idea's min/max students.
- **Consent escape:** since any student can list classmates, a student who finds themselves in a group they did not join can self-remove before the ranking deadline. Logged to `org_audit`.

## 4. Allocation — manual assignment console (no matching algorithm)

The allocation decision stays with the doctors. There is **no automatic matching engine**. The system's job is to present the preferences clearly, catch mistakes, and remove the re-typing.

**During ranking there are no restrictions at all:**

- Several groups may rank the same idea — including all of them at #1. Exclusivity is *not* enforced while students choose.
- A group must fill its **quota** before it can save: `quota = Σ over supervisors of min(their project count, their group capacity)`. A supervisor offering 3 projects but able to take only 2 groups may be chosen at most twice, and their remaining projects are shown locked. Partial lists are refused, so the assignment console always has a complete preference order. (Consequence: there are no partial saves — a group finishes the ordering in one sitting.)
- If a group's size falls outside an idea's min/max student range, the idea is shown with a warning badge but is **not** blocked from being ranked.

**Assignment console** (coordinator / any supervisor of that program+campus, per the deadline policy):

- Opens with a **preference matrix** — one row per project, one column per group, each cell holding the position that group gave that project. Rows are ordered by how many groups placed the project first. Groups appear by code only, so student names stay hidden while supervisors can still see exactly which group wants which project.
- Then lists every group — anonymous code + size + its ranked preferences in order.
- Each row has an idea dropdown. Assignment is entirely by hand.
- Live conflict flags:
  - the same idea assigned to two groups — **blocked**, since each project goes to exactly one group
  - a supervisor assigned more groups than their `max_groups`
  - a group whose size is outside the assigned idea's student range
  - groups still unassigned
- Nothing is written to the FYP tables until **Publish** is pressed, and Publish is preceded by the dry-run report in §5.

## 5. Publish → auto-create (pre-flight checks are mandatory)

`registerProject` in v3 enforces constraints that would make a naive auto-create fail halfway through:

1. **Project title must be globally unique** — check every allocated idea title against `projects`.
2. **Student name must be globally unique** across the whole `students` table.
3. **Student ID must be globally unique** (it is the primary key).
4. **At least one student email is required** unless `disable_notifications = TRUE`. Group creation therefore collects an optional email; if a group supplies none, the created project sets `disable_notifications = TRUE`.

Run all four as a **dry-run report** before any write. Then create, per allocated group:

- a `projects` row: `project_id = uid('PRJ')`, title = idea title, type = `'FYP1'`, semester/year from the cycle, `program_type` = program, `supervisors` = idea owner id, `students` = comma-joined student ids (matching v3's storage format exactly)
- one `students` row per member, all pointing at that `project_id`

Record `project_id` back into `org_allocations` so the link is traceable and reversible.

## 6. API actions (added to the existing `POST /api` dispatcher, `org` prefix)

**Supervisor (session token):** `orgGetCycle` · `orgGetMyIdeas` · `orgSaveIdea` · `orgDeleteIdea` · `orgSubmitIdeas` · `orgDeclareNoIdeas` · `orgGetColleagueStatus` · `orgSetDeadline` · `orgPublishIdeas` · `orgGetRankingResults`

**Admin / coordinator:** `orgCreateCycle` · `orgSetParticipants` · `orgSetDeadlinePolicy` · `orgGetAssignmentBoard` · `orgSetAssignment` · `orgClearAssignment` · `orgDryRunPublish` · `orgPublishAllocation`

**Student (no session):** `orgStudentLookup` · `orgCreateGroup` · `orgLeaveGroup` · `orgGetGroup` · `orgGetPublishedIdeas` · `orgSaveRanking` · `orgGetGroupAudit`

## 7. Front-end structure

- New page `public/organizer/index.html`, route `/organizer`. Self-contained with inline CSS/JS, matching the Meeting Organizer’s structure, and kept entirely out of `app.js` (already 191 KB) and `index.html`.
- Entry points: a button under the login box on `/fyp`, a card on the landing portal, and a token-carrying link for already-logged-in supervisors (no second login).
- The supervisor results view shows **anonymous group codes + sizes only** — never student names — until allocation is published.

## 8. Build order

1. Schema + `supervisors.campus` + admin UI to set campus ✅ done
2. `/organizer` page shell, routes, entry buttons ✅ done
3. Supervisor ideas module + colleague checkmark board ✅ done
4. Deadlines, policy, publish gate ✅ done
5. Student group formation (the two unique indexes first) ✅ done
6. Ranking UI + audit trail + version-conflict handling ✅ done
7. Manual assignment console with live conflict flags ✅ done
8. Publish → auto-create with dry-run report ✅ done
9. Optional: email notifications via the existing mail plumbing

## 9. Operational notes

- The supervisor page refreshes itself every 30 seconds after sign-in (paused while a form is open or the tab is hidden), so colleague submissions and student rankings appear without pressing anything.
- Session failures return `sessionInvalid`, and the page sends the user back to sign-in rather than showing an error inside a panel. The message distinguishes "no token sent" from "token expired or unknown".

- `/api` is rate limited to 300 requests / 15 min **per IP** (`server.js`). A lab of students behind one campus NAT will trip it during ranking week — raise it or exempt organizer reads before go-live.
- The version stamp lives in 3 files (`index.html`, `landing.html`, `meetings/index.html`) and will be 4 once `organizer/index.html` exists. Bump on every change.
- `Data.txt` holds live credentials in plaintext — remove it or gitignore it before pushing to GitHub.
