# Evidence-Linked Interview Demo

Next.js (App Router) demo for:
- browser voice interview recording
- transcription with segment timestamps
- recruiter-style evidence-linked report generation
- clickable evidence that jumps transcript + audio

## Stack
- Next.js 16
- React 19
- TypeScript (strict)

## Requirements
- Node.js 20+
- npm 10+

## Setup
```bash
npm install
```

Optional: add OpenAI key in `.env.local` for real transcription/report generation.

```bash
OPENAI_API_KEY=your_openai_api_key
```

Run:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## App Routes
- `/` landing page (`Start Interview`, `Review`)
- `/interview`
  - 5 hardcoded questions
  - per-question Start/Stop recording
  - auto-stop timer (configurable, default `120s`)
  - chunked recording (`MediaRecorder` timeslice) persisted to IndexedDB
  - per-question playback + delete recording
- `/review`
  - transcribe per answer
  - generate evidence-linked scorecard per answer
  - coverage map + filter by dimension
  - evidence chips scroll/highlight transcript and seek/play audio
  - scorecard sections: observed signals, concerns, counter-signals, decision rationale, leveling, calibration notes

## API Routes
- `POST /api/transcribe`
  - request: `multipart/form-data` with file field `audio`
  - real mode: OpenAI transcription (`verbose_json` + segment timestamps)
  - response:
    - `transcriptText`
    - `segments[]` with `id/start/end/text`
- `POST /api/report`
  - request: question + transcript segments + rubric
  - response: strict JSON scorecard with:
    - anchored dimensions (`score` or `notObserved`)
    - evidence entries (`segmentId`, short `quote`, `interpretation`, `strength`)
    - recommendation + calibration rules
    - leveling + coverage map

## Mock Mode
If `OPENAI_API_KEY` is missing, APIs return deterministic mock data so the demo always works.

You can also force mock mode explicitly:
- `/api/transcribe?mock=1`
- `/api/report?mock=1`

Examples:

```bash
curl -X POST "http://localhost:3000/api/transcribe?mock=1" \
  -F "audio=@/path/to/sample.webm"
```

```bash
curl -X POST "http://localhost:3000/api/report?mock=1" \
  -H "Content-Type: application/json" \
  -d '{"questionId":"1","questionText":"Q","segments":[{"id":"s1","start":0,"end":1,"text":"hello"}],"rubric":{"dimensions":[{"key":"clarity","label":"Clarity","description":"Clear communication"}]}}'
```

## Storage
- Interview audio is chunk-persisted in IndexedDB (`voice-interview-recordings-db`).
- Review transcriptions/reports are cached in localStorage (`schemaVersion: 1`) for refresh persistence.

## Scorecard Notes
- Recommendation is normalized from weighted dimensions and calibration caps.
- If core dimensions are not observed (or evidence coverage is too low), recommendation is capped (for example, cannot exceed `LeanHire`).
- Legacy cached reports are still accepted and normalized into the modern scorecard shape.

## 1-Minute Demo Script
1. Open `/` and click `Start Interview`.
2. Record one answer and stop.
3. Click `Continue to Review`.
4. Click `Transcribe`, then `Generate Report`.
5. Click an evidence chip to verify transcript scroll/highlight + audio seek/play.
6. Refresh `/review` and verify transcription/report cache persists.

## Scripts
- `npm run dev`
- `npm run build`
- `npm run start`
- `npm run lint`
