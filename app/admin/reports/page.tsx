"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { OpenReport } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";

// A client page (not a server component) because this app's Cognito session
// lives client-side (Authorization: Bearer, no cookie session — see
// lib/store.ts). The real admin gate is server-side, in GET /api/admin/reports,
// POST /api/admin/memes/[id]/takedown, and POST .../dismiss; this page's own
// check is UX only.
export default function AdminReportsPage() {
  const { cognitoToken, addToast } = useAppStore();
  const [reports, setReports] = useState<OpenReport[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [takingDown, setTakingDown] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);

  useEffect(() => {
    if (!cognitoToken) {
      setNotFound(true);
      return;
    }
    fetch("/api/admin/reports", {
      headers: { Authorization: `Bearer ${cognitoToken}` },
    }).then(async (res) => {
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const data = await res.json();
      setReports(data.reports);
    });
  }, [cognitoToken]);

  const handleTakedown = async (memeId: string) => {
    if (!cognitoToken) return;
    setTakingDown(memeId);
    const res = await fetch(`/api/admin/memes/${memeId}/takedown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cognitoToken}` },
    });
    setTakingDown(null);
    if (!res.ok) {
      addToast("Takedown failed", "error");
      return;
    }
    setReports((r) => r?.filter((report) => report.memeId !== memeId) ?? null);
    addToast("Meme taken down", "success");
  };

  const handleDismiss = async (memeId: string) => {
    if (!cognitoToken) return;
    setDismissing(memeId);
    const res = await fetch(`/api/admin/memes/${memeId}/dismiss`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cognitoToken}` },
    });
    setDismissing(null);
    if (!res.ok) {
      addToast("Dismiss failed", "error");
      return;
    }
    setReports((r) => r?.filter((report) => report.memeId !== memeId) ?? null);
    addToast("Report dismissed", "success");
  };

  if (notFound) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-black text-white mb-2">Not found</h1>
        <p className="text-gray-400">This page doesn&apos;t exist.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-black text-white mb-6">Open reports</h1>

      {!reports ? (
        <p className="text-gray-500">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="text-gray-500">No open reports.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {reports.map((report) => (
            <div
              key={report.memeId}
              className="flex gap-4 bg-surface border border-border rounded-2xl p-4"
            >
              <img
                src={report.imageUrl}
                alt=""
                className="w-24 h-24 object-cover rounded-lg bg-gray-900 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <p className="text-white font-semibold break-words">{report.reason}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {report.reporterCount} distinct reporter{report.reporterCount === 1 ? "" : "s"} ·
                  first {formatDistanceToNow(new Date(report.firstReportedAt), { addSuffix: true })} ·
                  last {formatDistanceToNow(new Date(report.lastReportedAt), { addSuffix: true })}
                </p>
                <p className="text-xs text-gray-600 mt-1 font-mono break-all">{report.s3Key}</p>
              </div>
              {/* Dismiss (reversible, no content change) and takedown (destructive)
                  are stacked with a gap and opposite colors on purpose, so a
                  misclick can't land on the wrong one. */}
              <div className="flex flex-col gap-2 shrink-0 self-start">
                <button
                  onClick={() => handleDismiss(report.memeId)}
                  disabled={dismissing === report.memeId || takingDown === report.memeId}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-bg/60 text-gray-300 border border-border hover:bg-white/10 disabled:opacity-50 transition-colors"
                >
                  {dismissing === report.memeId ? "Dismissing…" : "Dismiss"}
                </button>
                <button
                  onClick={() => handleTakedown(report.memeId)}
                  disabled={takingDown === report.memeId || dismissing === report.memeId}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white transition-colors"
                >
                  {takingDown === report.memeId ? "Removing…" : "Take down"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
