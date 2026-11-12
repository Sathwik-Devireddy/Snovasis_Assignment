"use client";

import { apiGet } from "@/lib/api";
import { useSearchParams, useParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Statement page (PHASE-10 P11.3/P11.4/P11.5).
 *
 * GET /accounts/:id/statement — merged timeline with keyset pagination.
 * Money/sequence values rendered as strings (T-049). Never re-parsed through
 * Number.
 */

type TimelineRow = {
  category: "event" | "attempt";
  eventPosition: string | null;
  type: string;
  direction: string | null;
  amountMinor: string | null;
  balanceMinor: string | null;
  occurredAt: string;
  initiator: { userId: string; displayName: string | null } | null;
  journalTransactionId: string | null;
  status: "POSTED" | "REFUSED";
  reasonCode: string | null;
};

type StatementResponse = {
  account: { id: string; accountNumber: string; kind: string; status: string; balanceMinor: string | null; eventLastSeq: string | null };
  timeline: TimelineRow[];
  nextCursor: string | null;
};

export default function StatementPage() {
  const { id } = useParams();
  const searchParams = useSearchParams();
  const [data, setData] = useState<StatementResponse | null>(null);
  const [error, setError] = useState("");

  const cursor = searchParams.get("cursor") ?? undefined;
  const limit = searchParams.get("limit") ?? "50";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = `/accounts/${id}/statement?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = (await apiGet(url)) as StatementResponse;
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) {
          if ((err as { statusCode?: number }).statusCode === 404) setError("Account not found or not visible.");
          else setError("Failed to load statement.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [id, cursor, limit]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div>Loading statement…</div>;

  return (
    <div className="card">
      <h2>Statement — {data.account.accountNumber}</h2>
      <p>
        Kind: {data.account.kind} &nbsp;|&nbsp; Status: {data.account.status} &nbsp;|&nbsp; Balance:{" "}
        <span className="mono">{data.account.balanceMinor ?? "—"} INR</span>
      </p>

      {data.timeline.length === 0 && <p>No events.</p>}

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Type</th>
            <th>Direction</th>
            <th>Amount</th>
            <th>Balance After</th>
            <th>Occurred At</th>
            <th>Initiator</th>
            <th>Status</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {data.timeline.map((row, i) => (
            <tr key={`${row.category}-${row.eventPosition}-${i}`}>
              <td className="mono">{row.eventPosition ?? "—"}</td>
              <td>{row.type}</td>
              <td>{row.direction ?? "—"}</td>
              <td className="mono">{row.amountMinor ?? "—"}</td>
              <td className="mono">{row.balanceMinor ?? "—"}</td>
              <td className="mono">{row.occurredAt}</td>
              <td>
                {row.initiator ? `${row.initiator.userId} (${row.initiator.displayName ?? "—"})` : "—"}
              </td>
              <td>
                <span className={`badge ${row.status === "REFUSED" ? "badge-refused" : "badge-success"}`}>
                  {row.status}
                </span>
              </td>
              <td>{row.reasonCode ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.nextCursor && (
        <button
          onClick={() => {
            const sp = new URLSearchParams(searchParams.toString());
            sp.set("cursor", data.nextCursor!);
            window.location.search = sp.toString();
          }}
        >
          Load more
        </button>
      )}
    </div>
  );
}
