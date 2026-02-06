# Voice Interview Demo (Next.js App Router)

End-to-end demo for:
- recording interview answers in the browser
- transcribing recorded audio
- generating an evidence-linked report from transcript segments

## Requirements
- Node.js 20+
- npm 10+

## Setup
Install dependencies:

```bash
npm install
```

Optional: add real OpenAI API access in `.env.local`:

```bash
OPENAI_API_KEY=your_key_here
```

Start dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Routes
- `/` landing page with `Start Interview` and `Review`
- `/interview` record answers (with auto-stop)
- `/review` transcribe, generate report, and evidence-link to transcript segments
- `/api/transcribe` POST multipart (field `audio`)
- `/api/report` POST JSON report generation

## Force Mock Mode
Both APIs support `?mock=1` to bypass real OpenAI calls even when `OPENAI_API_KEY` is present.

Examples:

```bash
curl -X POST "http://localhost:3000/api/transcribe?mock=1" \
  -F "audio=@/path/to/sample.wav"
```

```bash
curl -X POST "http://localhost:3000/api/report?mock=1" \
  -H "Content-Type: application/json" \
  -d '{"questionId":"1","questionText":"Q","segments":[{"id":"s1","start":0,"end":1,"text":"hello"}],"rubric":{"dimensions":[{"key":"clarity","label":"Clarity","description":"Clear communication"}]}}'
```

## 1-Minute Demo Script
1. Open `/` and click `Start Interview`.
2. Record one short answer (5-10 seconds) and stop.
3. Click `Continue to Review`.
4. On the same question card, click `Transcribe`.
5. Click `Generate Report`.
6. Click an evidence chip to auto-scroll to segment, highlight it, and jump audio playback.
7. Refresh `/review` to show cached transcription/report persistence.

## Scripts
- `npm run dev`
- `npm run build`
- `npm run start`
- `npm run lint`
