import { isReportResponseBody } from "@/lib/report";
import type { TranscribeResponse } from "@/lib/transcribe";
import type { ReportResponseBody } from "@/types/report";

const REVIEW_CACHE_STORAGE_KEY = "voice-interview-review-cache";
const REVIEW_CACHE_SCHEMA_VERSION = 1;

type TranscriptionMap = Partial<Record<number, TranscribeResponse>>;
type ReportMap = Partial<Record<number, ReportResponseBody>>;

interface ReviewCachePayloadV1 {
  schemaVersion: 1;
  transcriptions: Record<string, TranscribeResponse>;
  reports: Record<string, ReportResponseBody>;
}

interface ReviewCacheState {
  transcriptions: TranscriptionMap;
  reports: ReportMap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTranscriptSegment(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.start === "number" &&
    Number.isFinite(value.start) &&
    typeof value.end === "number" &&
    Number.isFinite(value.end) &&
    typeof value.text === "string"
  );
}

function isTranscribeResponse(value: unknown): value is TranscribeResponse {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.transcriptText !== "string" || !Array.isArray(value.segments)) {
    return false;
  }

  return value.segments.every((segment) => isTranscriptSegment(segment));
}

function toNumberKeyedMap<T>(
  source: Record<string, unknown>,
  validator: (value: unknown) => value is T,
): Partial<Record<number, T>> {
  const result: Partial<Record<number, T>> = {};

  for (const [rawKey, value] of Object.entries(source)) {
    const numericKey = Number(rawKey);
    if (!Number.isInteger(numericKey) || numericKey <= 0) {
      continue;
    }

    if (!validator(value)) {
      continue;
    }

    result[numericKey] = value;
  }

  return result;
}

function toStringKeyedMap<T>(source: Partial<Record<number, T>>): Record<string, T> {
  const result: Record<string, T> = {};

  for (const [rawKey, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    result[rawKey] = value;
  }

  return result;
}

function emptyReviewCache(): ReviewCacheState {
  return {
    transcriptions: {},
    reports: {},
  };
}

export function loadReviewCache(): ReviewCacheState {
  if (typeof window === "undefined") {
    return emptyReviewCache();
  }

  const rawValue = window.localStorage.getItem(REVIEW_CACHE_STORAGE_KEY);
  if (!rawValue) {
    return emptyReviewCache();
  }

  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (!isRecord(parsed)) {
      return emptyReviewCache();
    }

    if (parsed.schemaVersion !== REVIEW_CACHE_SCHEMA_VERSION) {
      return emptyReviewCache();
    }

    const transcriptionsSource = isRecord(parsed.transcriptions) ? parsed.transcriptions : {};
    const reportsSource = isRecord(parsed.reports) ? parsed.reports : {};

    return {
      transcriptions: toNumberKeyedMap(transcriptionsSource, isTranscribeResponse),
      reports: toNumberKeyedMap(reportsSource, isReportResponseBody),
    };
  } catch {
    return emptyReviewCache();
  }
}

export function saveReviewCache(cache: ReviewCacheState): void {
  if (typeof window === "undefined") {
    return;
  }

  const payload: ReviewCachePayloadV1 = {
    schemaVersion: REVIEW_CACHE_SCHEMA_VERSION,
    transcriptions: toStringKeyedMap(cache.transcriptions),
    reports: toStringKeyedMap(cache.reports),
  };

  window.localStorage.setItem(REVIEW_CACHE_STORAGE_KEY, JSON.stringify(payload));
}
