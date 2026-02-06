import type { ModernReportResponseBody } from "@/types/report";

export interface CoverageSegment {
  id: string;
  start: number;
  end: number;
}

export interface CoverageInterval {
  start: number;
  end: number;
  segmentIds: string[];
}

export interface CoverageModel {
  durationSeconds: number;
  intervals: CoverageInterval[];
  coveragePercent: number;
  citedSegmentCount: number;
  totalSegmentCount: number;
}

interface BuildCoverageModelInput {
  segments: CoverageSegment[];
  report: ModernReportResponseBody;
  activeDimensionId?: string | null;
  durationSeconds?: number;
  epsilonSeconds?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function deriveDurationSeconds(
  segments: CoverageSegment[],
  preferredDurationSeconds?: number,
): number {
  if (typeof preferredDurationSeconds === "number" && Number.isFinite(preferredDurationSeconds)) {
    if (preferredDurationSeconds > 0) {
      return preferredDurationSeconds;
    }
  }

  const maxSegmentEnd = segments.reduce((maxValue, segment) => {
    return Math.max(maxValue, Number.isFinite(segment.end) ? segment.end : 0);
  }, 0);

  if (maxSegmentEnd > 0) {
    return maxSegmentEnd;
  }

  return 1;
}

function mergeIntervals(intervals: CoverageInterval[], epsilonSeconds: number): CoverageInterval[] {
  if (intervals.length === 0) {
    return [];
  }

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: CoverageInterval[] = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({
        start: interval.start,
        end: interval.end,
        segmentIds: [...interval.segmentIds],
      });
      continue;
    }

    if (interval.start <= previous.end + epsilonSeconds) {
      previous.end = Math.max(previous.end, interval.end);
      const segmentIdSet = new Set([...previous.segmentIds, ...interval.segmentIds]);
      previous.segmentIds = Array.from(segmentIdSet);
      continue;
    }

    merged.push({
      start: interval.start,
      end: interval.end,
      segmentIds: [...interval.segmentIds],
    });
  }

  return merged;
}

export function buildCoverageModel(input: BuildCoverageModelInput): CoverageModel {
  const epsilonSeconds = input.epsilonSeconds ?? 0.05;
  const durationSeconds = deriveDurationSeconds(input.segments, input.durationSeconds);
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment] as const));
  const totalSegmentCount = input.segments.length;

  const dimensions =
    input.activeDimensionId && input.activeDimensionId.length > 0
      ? input.report.dimensions.filter((dimension) => dimension.id === input.activeDimensionId)
      : input.report.dimensions;

  const citedSegmentIdSet = new Set<string>();
  for (const dimension of dimensions) {
    for (const evidenceEntry of dimension.evidence) {
      if (segmentById.has(evidenceEntry.segmentId)) {
        citedSegmentIdSet.add(evidenceEntry.segmentId);
      }
    }
  }

  const rawIntervals: CoverageInterval[] = [];
  for (const segmentId of citedSegmentIdSet) {
    const segment = segmentById.get(segmentId);
    if (!segment) {
      continue;
    }

    const start = clamp(segment.start, 0, durationSeconds);
    const end = clamp(Math.max(segment.end, start), 0, durationSeconds);

    rawIntervals.push({
      start,
      end,
      segmentIds: [segmentId],
    });
  }

  const mergedIntervals = mergeIntervals(rawIntervals, epsilonSeconds);
  const coveredSeconds = mergedIntervals.reduce((sum, interval) => {
    return sum + Math.max(interval.end - interval.start, 0);
  }, 0);
  const coveragePercent = clamp((coveredSeconds / durationSeconds) * 100, 0, 100);

  return {
    durationSeconds,
    intervals: mergedIntervals,
    coveragePercent,
    citedSegmentCount: citedSegmentIdSet.size,
    totalSegmentCount,
  };
}
