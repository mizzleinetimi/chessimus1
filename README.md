# Chess Coach MVP

Bare-bones app that analyzes a PGN with Stockfish and adds coaching explanations with Gemini.

## Setup

1. Install dependencies

```
npm install
```

2. Configure environment (optional)

```
cp .env.example .env
```

Set `GEMINI_API_KEY` in `.env` if you want real coaching explanations.
You can also choose models:

- `GEMINI_PRIMARY_MODEL` (default `gemini-3-flash-preview`) for coaching text
- `GEMINI_FORMATTER_MODEL` (default `gemini-2.5-flash`) to format structured JSON
- `COACH_RESPONSE_MODE` (`json` or `text`)

3. Run the server

```
npm run dev
```

Open `http://localhost:3000`.

## Notes

- Stockfish must be installed and available on your PATH, or set `STOCKFISH_PATH`.
- Gemini calls are optional. Without `GEMINI_API_KEY`, the app falls back to Stockfish-only guidance.
- If the server fails to start with `EPERM` or “operation not permitted,” your environment is blocking local port binding. In that case, use the CLI smoke test or run on a normal local terminal.

## Local Smoke Test

```
npm run test:sample
```

This runs a small analysis and prints the first few move objects.
