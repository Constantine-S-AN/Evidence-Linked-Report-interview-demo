import type { CoverageInterval, CoverageModel } from "@/lib/coverage";

interface CoverageMapProps {
  model: CoverageModel;
  onIntervalClick?: (interval: CoverageInterval) => void;
}

function toPercent(value: number, baseline: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline <= 0) {
    return 0;
  }
  return (value / baseline) * 100;
}

export default function CoverageMap({ model, onIntervalClick }: CoverageMapProps) {
  const hasIntervals = model.intervals.length > 0;

  return (
    <section className="space-y-2 rounded border border-neutral-200 p-3">
      <p className="text-xs font-semibold uppercase text-neutral-600">Coverage Map</p>

      <div className="relative h-3 w-full overflow-hidden rounded bg-neutral-200">
        {hasIntervals
          ? model.intervals.map((interval, index) => {
              const leftPercent = toPercent(interval.start, model.durationSeconds);
              const widthPercent = Math.max(toPercent(interval.end - interval.start, model.durationSeconds), 0.7);

              return (
                <button
                  aria-label={`Coverage interval ${index + 1}`}
                  className="absolute top-0 h-full rounded bg-emerald-500/90 hover:bg-emerald-600"
                  key={`${interval.start}-${interval.end}-${index}`}
                  onClick={() => {
                    if (onIntervalClick) {
                      onIntervalClick(interval);
                    }
                  }}
                  style={{
                    left: `${leftPercent}%`,
                    width: `${widthPercent}%`,
                  }}
                  type="button"
                />
              );
            })
          : null}
      </div>

      <p className="text-xs text-neutral-700">
        Evidence coverage: {model.coveragePercent.toFixed(1)}% | Cited segments:{" "}
        {model.citedSegmentCount} / total segments: {model.totalSegmentCount}
      </p>
    </section>
  );
}
