import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 py-12 text-center">
      <h1 className="text-3xl font-semibold">Voice Interview Demo</h1>
      <p className="max-w-xl text-sm text-neutral-600">
        Record answers, transcribe them, and generate an evidence-linked report.
      </p>
      <div className="flex w-full max-w-md flex-col gap-3 sm:flex-row">
        <Link
          className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          href="/interview"
        >
          Start Interview
        </Link>
        <Link
          className="w-full rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50"
          href="/review"
        >
          Review
        </Link>
      </div>
    </main>
  );
}
