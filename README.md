# Auto-Migrate

Document migration workspace: a React frontend (TanStack Start) with a Python backend (FastAPI).

| Page | Runs on |
|---|---|
| Transformation | TypeScript server functions (`src/server/transform`) |
| Populate Request ID | Python backend (`backend/`), which drives Chrome to read the CLM Bulk Import Report |

## Requirements

- Node.js and npm
- Python 3.9+ and Google Chrome (for Populate Request ID)

## Setup

```sh
npm i
python -m pip install -r backend/requirements.txt
```

## Run

Use two terminals:

```sh
npm run dev       # web app
npm run dev:api   # Python backend on port 8000; the web app proxies /api to it
```

If the backend isn't running, the Populate Request ID page says so and offers a "Check again" button.

## Test

```sh
npm test          # frontend and transformation tests
npm run test:api  # backend tests (no browser or CLM access needed)
```

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
