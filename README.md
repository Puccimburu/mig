# Auto-Migrate

Document migration workspace: a React frontend (TanStack Start) with a Python backend (FastAPI).

| Page | Runs on |
|---|---|
| Sanity Checks (cleaning data) | Python backend: CLM users list (`backend/users_collector`) and user name check (`backend/name_check`) |
| Transformation | TypeScript server functions (`src/server/transform`) |
| Populate Request ID | Python backend (`backend/request_id`), which drives Chrome to read the CLM Bulk Import Report |

## Requirements

- Node.js and npm
- Python 3.9+ and Google Chrome (for Populate Request ID)

## Setup

```sh
npm i
python -m pip install -r backend/requirements.txt
```

## Run

```sh
npm run dev
```

This starts the web app and the Python backend (port 8000; the web app proxies `/api` to it). The backend's output appears in the same terminal, and stopping the dev server stops it too.

To run the backend on its own instead (for example to restart it separately), start `npm run dev:api` first; `npm run dev` then uses that one. Set `SKIP_API=1` to start only the web app.

If the backend isn't running, the Populate Request ID page says so and offers a "Check again" button.

## Test

```sh
npm test          # frontend and transformation tests
npm run test:api  # backend tests (no browser or CLM access needed)
```

## Sanity Checks: user names

Checks user-name columns (Business Owner, Assignee, ...) in client data against the users on the CLM.

1. **CLM users list.** Collect it from the CLM (Vault → User Management → Users, 100 users per page) or upload a `users.xlsx` from an earlier collection. It is saved in `backend/data/` (git-ignored) and reused until replaced. A collection fails, instead of saving a partial list, when the users read don't add up to the total the CLM shows.
2. **Client workbook.** Pick the sheet and the name columns. Likely name columns are pre-selected.
3. **Check names.** Each name is matched against the list (Hound's matching: "Sen, Sudipta", department suffixes, middle names, initials):
   - **Matched**: 85% or more, one active user.
   - **Review**: 60–85%, or an inactive user, a name several users share, or a near-tie between two users.
   - **Not Found**: below 60%, left blank.

   Review suggestions can be accepted, swapped for another candidate, or cleared. The download writes the CLM user name and status next to each checked column. On Hound's template (one column, with "Correct User name" and "Validation Status" already on the sheet), it fills those columns instead. Rows that already have a correct name are never changed.

## Populate Request ID

1. Upload the filled bulk import template, already imported to the CLM.
2. Enter the CLM site URL, username and password, plus the batch's **Uploaded On** time (exactly as the Bulk Import Upload list shows it) and its **Total count**.
3. Run. Chrome logs in, reads the batch report and fills **Record ID, Request ID, File Names and File Path** after Record Reference Id. If enabled, it also fills the Supporting Document sheet.
4. Download the updated workbook. Records still processing on the CLM are left empty; run the downloaded workbook again later to fill them.

Notes:
- Only one run at a time: two logins on the same CLM account break each other's session.
- The password is passed to the run over a pipe. It is never saved, logged or written to disk.
- Each run works in its own temporary folder. The backend keeps the last five runs and deletes older ones.

The populator code in `backend/request_id/` is copied from [Bulk-design_process](https://github.com/markcastorm/Bulk-design_process). See `backend/request_id/SOURCE.md` before copying in a newer version.
