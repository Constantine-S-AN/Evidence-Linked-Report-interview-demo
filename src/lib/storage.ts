import type { InterviewRecording } from "@/types/interview";

const STORAGE_KEY = "voice-interview-recordings-v1";

function isInterviewRecording(value: unknown): value is InterviewRecording {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.questionId === "number" &&
    Number.isInteger(candidate.questionId) &&
    candidate.questionId > 0 &&
    typeof candidate.mimeType === "string" &&
    candidate.mimeType.length > 0 &&
    typeof candidate.data === "string" &&
    candidate.data.length > 0 &&
    typeof candidate.url === "string" &&
    candidate.url.startsWith("data:") &&
    typeof candidate.durationMs === "number" &&
    Number.isFinite(candidate.durationMs) &&
    candidate.durationMs >= 0 &&
    typeof candidate.createdAt === "string" &&
    candidate.createdAt.length > 0
  );
}

export function loadInterviewRecordings(): InterviewRecording[] {
  if (typeof window === "undefined") {
    return [];
  }

  const rawValue = window.localStorage.getItem(STORAGE_KEY);
  if (!rawValue) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isInterviewRecording).sort((a, b) => a.questionId - b.questionId);
  } catch {
    return [];
  }
}

export function saveInterviewRecordings(recordings: InterviewRecording[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recordings));
}

export function upsertInterviewRecording(
  recordings: InterviewRecording[],
  recording: InterviewRecording,
): InterviewRecording[] {
  const next = recordings.filter((item) => item.questionId !== recording.questionId);
  next.push(recording);
  next.sort((a, b) => a.questionId - b.questionId);
  return next;
}
