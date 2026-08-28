# Keycard Employee Onboarding Assistant

A full-stack extension of the existing Keycard frontend. The original `index.html` remains the main employee workspace.

## PostgreSQL setup

The backend uses the `pg` package and reads one connection string from `DATABASE_URL`. The expected format is:

```text
postgresql://USER:PASSWORD@HOST:5432/DATABASE
```

The example value targets a local database named `keycard` and does not create that database automatically. PostgreSQL must be installed, running, and the database must exist before initialization.

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to your PostgreSQL connection string and replace `JWT_SECRET` with a long random value.
3. Create the database if needed:

	```bash
	createdb keycard
	```

4. Initialize all tables and indexes:

	```bash
	psql "$DATABASE_URL" -f schema.sql
	```

5. Verify the database connection through the running API:

	```bash
	curl http://localhost:3000/api/health
	```

The health endpoint returns HTTP 200 with `database: "connected"`, or HTTP 503 with `database: "unavailable"`.

## Development seed

The seed creates synthetic users and document metadata only. It never creates production credentials and does not create fake downloadable files. Set temporary development passwords in your shell or `.env` first:

```bash
export SEED_EMPLOYEE_PASSWORD='use-a-local-password'
export SEED_HR_PASSWORD='use-a-local-password'
export SEED_IT_PASSWORD='use-a-local-password'
npm run db:seed
```

Seed users:

- `demo.employee@example.test` as `employee`
- `demo.hr@example.test` as `hr_admin`
- `demo.it@example.test` as `it_support`

Upload the actual approved files through the authorized document endpoint after seeding to create persistent downloadable versions.

## Run locally

1. Run `npm install`.
2. Complete PostgreSQL setup above.
3. Run `npm start`.
4. Open `http://localhost:3000`.

The server supports employee, HR admin, and IT support roles. With `GEMINI_API_KEY` configured, the assistant sends only the retrieved document chunks and question to Gemini 2.5 Flash for a grounded answer. If the key is absent or Gemini fails, it uses the deterministic PostgreSQL full-text retrieval fallback.

## Production notes

- Set `NODE_ENV=production`, a strong `JWT_SECRET`, and `DATABASE_URL`. The server refuses to start in production with the development JWT fallback.
- Hosted PostgreSQL can use `DATABASE_SSL=true`; set `DATABASE_SSL_REJECT_UNAUTHORIZED=false` only when your provider requires it and you have another certificate-trust plan.
- Tune `DB_POOL_MAX` for the database connection limit. The default is 10 connections with a 30-second idle timeout.
- Login, registration, and password-reset endpoints have in-memory per-IP rate limits. Use a shared Redis-backed limiter when running multiple server instances.
- Run `schema.sql` for a new database. For an existing database, apply files in `migrations/` in order with `psql "$DATABASE_URL" -f migrations/001_password_reset_tokens.sql`.
- Schedule encrypted PostgreSQL backups with your provider or `pg_dump`; test restoring them regularly. The `storage/` directory must be backed up separately because uploaded files are stored there.
- Public registration creates employees only. HR and IT accounts should be created by an administrator or controlled seed process.
- Password reset tokens are hashed and expire after 30 minutes. Development responses expose a token for local testing; production requires an email delivery service before exposing reset links to users.
- Current retrieval remains PostgreSQL full-text search, followed by Gemini grounding. Add `pgvector` and embeddings only when keyword retrieval is insufficient.

## Gemini configuration

1. Create a Gemini API key in Google AI Studio.
2. Put it in your local `.env` as `GEMINI_API_KEY=...`; never commit that file or the real key.
3. Restart `npm start`. Sensitive questions are escalated before any Gemini request. Gemini failures and rate limits automatically use the extractive fallback.

## Tests

Run the classifier tests with:

```bash
npm test
```
