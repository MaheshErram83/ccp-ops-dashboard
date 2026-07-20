import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const OPS_AGENTS = ["leo","oscar","smith","richard","rich","jason","jasond","liam"];
const INTERNAL_OPEN = 36594245061645;

function dispStatus(status: string | null, customId: number | null): string {
  const s = (status ?? "").toLowerCase();
  if (s === "new") return "new";
  if (s === "open" && customId === INTERNAL_OPEN) return "internal_open";
  if (s === "open") return "open";
  if (s === "pending") return "pending";
  if (s === "hold" || s === "on-hold") return "on_hold";
  if (s === "solved" || s === "closed") return "solved";
  return "other";
}

Deno.serve(async () => {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const snapshotDate = istNow.toISOString().slice(0, 10);

  // Pull all rows in pages (avoid 1000-row cap).
  let allRows: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("ops_view_tickets")
      .select("ops_owner, status, custom_status_id")
      .range(from, from + pageSize - 1);
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
    }
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  // Count per agent per display-status.
  const counts: Record<string, Record<string, number>> = {};
  for (const row of allRows) {
    const owner = (row.ops_owner ?? "").toLowerCase();
    if (!OPS_AGENTS.includes(owner)) continue;
    const ds = dispStatus(row.status, row.custom_status_id);
    if (ds === "solved" || ds === "other") continue; // opening = active only
    counts[owner] = counts[owner] || {};
    counts[owner][ds] = (counts[owner][ds] ?? 0) + 1;
  }

  // Build rows.
  const rows: any[] = [];
  for (const owner of OPS_AGENTS) {
    const perStatus = counts[owner] || {};
    for (const ds of ["new","open","internal_open","pending","on_hold"]) {
      rows.push({
        snapshot_date: snapshotDate,
        ops_owner: owner,
        disp_status: ds,
        opening_count: perStatus[ds] ?? 0,
        captured_at: new Date().toISOString(),
      });
    }
  }

  const { error: upErr } = await supabase
    .from("ops_daily_snapshot")
    .upsert(rows, { onConflict: "snapshot_date,ops_owner,disp_status" });

  if (upErr) {
    return new Response(JSON.stringify({ ok: false, error: upErr.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, snapshot_date: snapshotDate, rows: rows.length }), {
    status: 200, headers: { "content-type": "application/json" },
  });
});