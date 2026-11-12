/**
 * Auditor: Audit events page (PHASE-10 P11.3/P10.3).
 *
 * GET /audit/events — admin/auditor only. Metadata shown as-is (audit-view
 * content; no secrets).
 */

"use client";

import { apiGet } from "@/lib/api";
import { useEffect, useState } from "react";

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

export default function AuditEventsPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiGet("/audit/events")) as { events: AuditEvent[] };
        if (!cancelled) setEvents(res.events ?? []);
      } catch (err) {
        if (!cancelled) {
          setError((err as { code?: string }).code === "ACCOUNT_NOT_FOUND" ? "Not permitted to view audit events." : "Failed to load audit events.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div>Loading audit events…</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div className="card">
      <h2>Audit Events</h2>
      {events.length === 0 && <p>No audit events.</p>}
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Occurred At</th>
            <th>Actor</th>
            <th>Event Type</th>
            <th>Subject Type</th>
            <th>Subject ID</th>
            <th>Reason Code</th>
            <th>Metadata</th>
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
    </div>
  );
}
