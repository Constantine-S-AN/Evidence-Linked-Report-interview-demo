import { NextResponse } from "next/server";
import type { TranscribeResponse, TranscriptSegment } from "@/lib/transcribe";

export const runtime = "nodejs";

interface TranscribeErrorResponse {
  error: string;
}

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

function getMockTranscription(): TranscribeResponse {
  const segments: TranscriptSegment[] = [
    {
      id: "mock-1",
      start: 0,
      end: 3.2,
      text: "This is a deterministic mock transcript for the interview demo.",
    },
    {
      id: "mock-2",
      start: 3.2,
      end: 7.4,
      text: "Set OPENAI_API_KEY to switch this endpoint to real transcription.",
    },
  ];

  return {
    transcriptText: segments.map((segment) => segment.text).join(" "),
    segments,
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseOpenAIResponse(payload: unknown): TranscribeResponse {
  if (typeof payload !== "object" || payload === null) {
    return getMockTranscription();
  }

  const record = payload as Record<string, unknown>;
  const rawSegments = Array.isArray(record.segments) ? record.segments : [];
  const segments: TranscriptSegment[] = rawSegments.map((rawSegment, index) => {
    const segmentRecord =
      typeof rawSegment === "object" && rawSegment !== null
        ? (rawSegment as Record<string, unknown>)
        : {};

    const rawId = segmentRecord.id;
    const rawText = segmentRecord.text;
    const rawStart = segmentRecord.start;
    const rawEnd = segmentRecord.end;

    const id =
      typeof rawId === "string"
        ? rawId
        : typeof rawId === "number"
          ? String(rawId)
          : String(index + 1);
    const text = typeof rawText === "string" ? rawText : "";
    const start = toFiniteNumber(rawStart) ?? 0;
    const end = toFiniteNumber(rawEnd) ?? start;

    return {
      id,
      start,
      end,
      text,
    };
  });

  const transcriptText =
    typeof record.text === "string"
      ? record.text
      : segments.map((segment) => segment.text).join(" ").trim();

  if (segments.length > 0) {
    return {
      transcriptText,
      segments,
    };
  }

  if (transcriptText.length > 0) {
    return {
      transcriptText,
      segments: [
        {
          id: "1",
          start: 0,
          end: 0,
          text: transcriptText,
        },
      ],
    };
  }

  return getMockTranscription();
}

async function transcribeWithOpenAI(audioFile: File, apiKey: string): Promise<TranscribeResponse> {
  const openAIFormData = new FormData();
  openAIFormData.append("file", audioFile);
  openAIFormData.append("model", "whisper-1");
  openAIFormData.append("response_format", "verbose_json");
  openAIFormData.append("timestamp_granularities[]", "segment");

  const response = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: openAIFormData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenAI transcription failed (${response.status}): ${errorText.slice(0, 300)}`,
    );
  }

  const payload: unknown = await response.json();
  return parseOpenAIResponse(payload);
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const forceMockMode = url.searchParams.get("mock") === "1";

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json<TranscribeErrorResponse>(
      { error: "Expected multipart/form-data request." },
      { status: 400 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json<TranscribeErrorResponse>(
      { error: "Invalid multipart/form-data payload." },
      { status: 400 },
    );
  }

  const audio = formData.get("audio");
  if (!(audio instanceof File)) {
    return NextResponse.json<TranscribeErrorResponse>(
      { error: "Missing audio file. Use field name 'audio'." },
      { status: 400 },
    );
  }

  if (audio.size === 0) {
    return NextResponse.json<TranscribeErrorResponse>(
      { error: "Uploaded audio file is empty." },
      { status: 400 },
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (forceMockMode || !apiKey) {
    return NextResponse.json<TranscribeResponse>(getMockTranscription());
  }

  try {
    const transcription = await transcribeWithOpenAI(audio, apiKey);
    return NextResponse.json<TranscribeResponse>(transcription);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transcription request failed.";
    return NextResponse.json<TranscribeErrorResponse>({ error: message }, { status: 500 });
  }
}
