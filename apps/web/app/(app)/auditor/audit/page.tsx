/**
 * Auditor: Audit events page (PHASE-10 P11.3/P10.3; frontend quality pass).
 *
 * GET /audit/events — admin/auditor only. Metadata shown as-is (audit-view
 * content; no secrets).
 *
 * The API is cursor-paginated (default 50 per page); this page loads the
 * first page and then appends further pages on demand, so the auditor can
 * walk the whole history instead of only the newest 50 events.
 */

"use client";

import { apiGet } from "@/lib/api";
import { useCallback, useEffect, useState } from "react";

type AuditEvent = {
  id: string;
  occurredAt: string;
  actorId: string | null;
  eventType: string;
  subjectType: string | null;
  subjectId: string | null;
  reasonCode: string | null;
  metadata: unknown;
};

type AuditPage = { events?: AuditEvent[]; nextCursor?: string | null };

export default function AuditEventsPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (nextCursor: string | null, append: boolean) => {
    const query = nextCursor === null ? "" : `?cursor=${encodeURIComponent(nextCursor)}`;
    const res = (await apiGet(`/audit/events${query}`)) as AuditPage;
    const page = res.events ?? [];
    setEvents((previous) => (append ? [...previous, ...page] : page));
    setCursor(res.nextCursor ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiGet("/audit/events")) as AuditPage;
        if (cancelled) return;
        setEvents(res.events ?? []);
        setCursor(res.nextCursor ?? null);
      } catch (err) {
        if (cancelled) return;
        setError(
          (err as { code?: string }).code === "ACCOUNT_NOT_FOUND"
            ? "Not permitted to view audit events."
            : "Failed to load audit events.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMore() {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      await load(cursor, true);
    } catch (err) {
      setError(
        (err as { code?: string }).code === "ACCOUNT_NOT_FOUND"
          ? "Not permitted to view audit events."
          : "Failed to load more audit events.",
      );
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) return <div>Loading audit events…</div>;
  if (error && events.length === 0) return <div className="error" role="alert">{error}</div>;

  return (
    <div className="card">
      <h2>Audit Events</h2>
      <div role="status" aria-live="polite" aria-atomic="true">
        {error && <div className="error">{error}</div>}
      </div>
      {events.length === 0 && !error && <p>No audit events.</p>}
      <table>
        <caption className="visually-hidden">Audit events, newest first</caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Occurred At</th>
            <th scope="col">Actor</th>
            <th scope="col">Event Type</th>
            <th scope="col">Subject Type</th>
            <th scope="col">Subject ID</th>
            <th scope="col">Reason Code</th>
            <th scope="col">Metadata</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="mono">{e.id}</td>
              <td className="mono">{e.occurredAt}</td>
              <td className="mono">{e.actorId ?? "—"}</td>
              <td>{e.eventType}</td>
              <td>{e.subjectType ?? "—"}</td>
              <td className="mono">{e.subjectId ?? "—"}</td>
              <td>{e.reasonCode ?? "—"}</td>
              <td className="mono">{typeof e.metadata === "string" ? e.metadata : JSON.stringify(e.metadata ?? {})}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cursor !== null && (
        <div style={{ marginTop: "1rem" }}>
          <button onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more events"}
          </button>
          <span style={{ marginLeft: "0.75rem", fontSize: "0.875rem", color: "#666" }}>
            {events.length} loaded
          </span>
        </div>
      )}
    </div>
  );
}
