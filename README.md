# Life OS V5 — slice 1

Goal of this slice: sign in (Google) → 4 isolated workspaces → tasks → works offline → syncs without loss/duplication. Database access is protected by Supabase RLS; browser caches, workspace lists, and offline outboxes are additionally partitioned by authenticated user ID.
V4 stays untouched at the repo root. V5 lives in `v5/` (copy this folder's contents there).

## Setup (once)
1. Supabase: create project. Authentication → Providers → enable Google (add Google OAuth client ID/secret).
   Authentication → URL Configuration: add your GitHub Pages URL `https://<user>.github.io/<repo>/v5/` and `http://localhost:5173/` to Redirect URLs.
2. SQL Editor: run `supabase/migrations/0001_init.sql`.
3. `cd web && cp .env.example .env` and fill URL + anon key. (Anon key is public; never use service_role in the browser.)
4. `npm install && npm run dev`. Copy `icon-192.png`/`icon-512.png` from V4 into `web/public/`.

## Verify the slice
- Sign in on phone and laptop; add a task on one, see it on the other after refresh.
- Go offline (airplane mode), add/complete tasks, reconnect: they sync once each (check `audit_log`).
- Edit the same task on two devices offline: the second sync is reported as a conflict, not overwritten.
- With a second Google account, confirm it cannot see the first account's workspaces/tasks (RLS).
- On the same browser, sign out of account A and sign in as account B: B must not see A's cached workspaces, tasks, or pending offline mutations. Sign back in as A and confirm A's own pending work is still available.

## Deploy to GitHub Pages under /v5/
Build with `npm run build`, publish `web/dist` to the `v5/` path (GitHub Action recommended; do not overwrite V4 files).
