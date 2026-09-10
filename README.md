# Enduroverse Forms API

Backend for:
- Deadly Dozen "Notify Me" race signups
- Gym Partner Information intake form

Stores everything in your Render Postgres database (`enduroverse-db`),
already created in your Enduroverse workspace.

## Deploy steps

1. **Push this folder to a GitHub repo.**
   - Create a new repo on github.com (public or private both work).
   - From this folder: `git init && git add . && git commit -m "Enduroverse API"`
   - `git remote add origin <your-repo-url>` then `git push -u origin main`

2. **Tell Claude (or Render's dashboard) the repo URL.**
   - If you tell me the repo URL, I can create the Render web service for you
     directly (Render → New → Web Service → connect this repo).
   - Runtime: Node · Build command: `npm install` · Start command: `npm start`

3. **Link the database.**
   - In the Render dashboard, open the new web service → Environment →
     add `DATABASE_URL`, pasting the **Internal Connection String** from
     `enduroverse-db`'s Connect tab. (Using the internal string, not the
     external one, is faster and free of egress costs since both live on
     Render.)
   - Optionally set `ADMIN_PASSWORD` (defaults to `DDadmin` if unset — the
     same password the Deadly Dozen page's admin panel already uses).

4. **Deploy.** Render builds and starts the service automatically. Tables are
   created on first boot — no manual SQL needed.

5. **Point the forms at it.** In `gym-form.html`, set:
   ```js
   const API_URL = "https://your-service-name.onrender.com";
   ```

## Endpoints

- `POST /api/gym` — save a gym submission
- `GET /api/gym?password=...` — list all gym submissions (admin)
- `POST /api/notify` — save a race notify-me signup
- `GET /api/notify?password=...` — list all signups (admin)
- `GET /health` — health check

## Reminder

The free Render Postgres plan expires 30 days after creation. Upgrade it to
a paid plan in the dashboard before then if you want to keep the data.
