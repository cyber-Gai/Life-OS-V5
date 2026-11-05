# Life OS V5 (standalone repository)

This repository contains only V5. V4 lives in its own repository and is not affected.

## One-time setup
1. **Supabase**: enable Google provider; add `https://<user>.github.io/<repo-name>/**` and `http://localhost:5173/**` to Redirect URLs.
2. **Database**: apply migrations in order — `0001_init.sql`, `0002_hardening.sql`, `0003_planning.sql`
   (SQL editor, or `supabase db push`). Apply only the ones not yet applied. Back up first (Dashboard → Database → Backups).
   Apply database changes before merging app code that needs them.
3. **Icons**: `public/icon-192.png` and `public/icon-512.png` must be committed (the build refuses to run without them).
4. **GitHub**: Settings → Pages → Source = *GitHub Actions*. Settings → Secrets and variables → Actions → **Variables**: add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. **Supabase URLs**: the app lives at `https://<user>.github.io/<repo-name>/`. In Supabase → Authentication → URL Configuration, set Site URL to that address and add `https://<user>.github.io/<repo-name>/**` to Redirect URLs.
   Use the **anon / publishable** key only. Never use the `service_role` / `sb_secret_…` key anywhere in this app (the build detects and rejects it).

## Local
```
npm ci
cp .env.example .env     # fill in
npm run dev              # or: npm run verify  (typecheck + tests + build, same as CI)
```

## What the tests prove (`npm test`)
- **Database** (real migrations in an in-process Postgres, attacked as anon / user A / user B / viewer): cross-user reads and writes are blocked,
  clients cannot set version/created_by/completed_at or delete rows, the audit log cannot be altered, retries are idempotent,
  stale edits become conflicts, 0002 upgrades a 0001 database without losing data.
- **Sync engine**: nothing enqueued mid-flush is lost; overlapping flushes send each change once; repeated offline edits to one task don't
  conflict with themselves; one bad change doesn't block the rest; conflicts are kept for the user to resolve; accounts are isolated.

## Slice 2a: Goals → Projects → Milestones → Tasks
- One generic, whitelisted mutation function (`apply_mutation`) now serves every entity; adding habits/calendar means adding a table and one line in `mutable_columns()`.
- Parent links are composite foreign keys `(id, workspace_id)`: a project cannot point at another workspace's goal, even by guessing an id.
- Progress and health are deterministic code (`src/lib/progress.ts`, tested): project = done/total tasks; goal = equal-weight mean of its measurable projects; "no work yet" shows as unmeasured, not 0%.

## Deploy
Push/merge to `main`. CI runs `npm ci` → typecheck → tests → build, then deploys. Pull requests are verified but not deployed. The footer shows the build id (commit-run) so you can see what is live.
Database migrations are deliberately NOT auto-applied: run them manually, after a backup, before merging code that needs them.

## Known limits (deliberate, tracked)
- Deleting a goal/project is a soft delete and does not cascade: children keep their link but the UI shows them as unlinked. A "delete with children" flow is a later decision.
- `apply_task_mutation` (0002) is superseded by `apply_mutation`; drop it in a later migration once no old client is in use.
- `applied_ops` grows forever; add a scheduled prune (e.g. rows older than 90 days) before heavy use.
- Pages cannot set HTTP security headers (CSP etc.); consider Cloudflare Pages/Netlify later.
- Local data is not encrypted at rest on the device; "Sign out & clear device" erases it. Use it on shared devices.
