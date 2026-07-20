import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ERP_URL = Deno.env.get("ERP_URL")!;
const ERP_API_KEY = Deno.env.get("ERP_API_KEY")!;
const ERP_API_SECRET = Deno.env.get("ERP_API_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const ERP_AUTH = `token ${ERP_API_KEY}:${ERP_API_SECRET}`;

const OPS_AGENTS: Record<string, string> = {
  "leo@cozycornerpatios.com": "Leo",
  "oscar@cozycornerpatios.com": "Oscar",
  "smith@cozycornerpatios.com": "Smith",
  "richard@cozycornerpatios.com": "Richard",
  "jason@cozycornerpatios.com": "Jason",
  "liam@cozycornerpatios.com": "Liam",
};

// Exclude these from agent detection
const EXCLUDED_USERS = [
  "administrator", "admin@", "vinay@", "guest",
  "priyanshi@", "sahil@", "sahilvik", "harshitverma@",
  "factory@", "rakesh@",
];

function isExcludedUser(email: string): boolean {
  const lower = email.toLowerCase();
  return EXCLUDED_USERS.some((ex) => lower.includes(ex));
}

async function erpFetch(endpoint: string): Promise<any> {
  const res = await fetch(`${ERP_URL}${endpoint}`, {
    headers: { Authorization: ERP_AUTH },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ERPNext ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

// ── Fetch order names ──────────────────────────────────────

async function fetchRecentOrderNames(minutesAgo: number): Promise<string[]> {
  const since = new Date(Date.now() - minutesAgo * 60 * 1000);
  const sinceStr = since.toISOString().replace("T", " ").substring(0, 19);
  const filters = JSON.stringify([
    ["docstatus", "=", "1"],
    ["custom_ops_status", "!=", ""],
    ["modified", ">=", sinceStr],
  ]);
  const url = `/api/resource/Sales Order?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent(JSON.stringify(["name"]))}&limit_page_length=100&order_by=modified desc`;
  const data = await erpFetch(url);
  return (data.data || []).map((o: any) => o.name);
}

async function fetchAllActiveOrderNames(): Promise<string[]> {
  const filters = JSON.stringify([
    ["docstatus", "=", "1"],
    ["custom_ops_status", "!=", ""],
    ["custom_ops_status", "not in", ["COMPLETED", "SHIPPED"]],
  ]);
  const url = `/api/resource/Sales Order?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent(JSON.stringify(["name"]))}&limit_page_length=0&order_by=modified desc`;
  const data = await erpFetch(url);
  return (data.data || []).map((o: any) => o.name);
}

async function fetchOrderDetail(name: string): Promise<any | null> {
  try {
    const data = await erpFetch(`/api/resource/Sales Order/${encodeURIComponent(name)}`);
    return data.data;
  } catch { return null; }
}

async function fetchOrderDetails(names: string[]): Promise<any[]> {
  const results: any[] = [];
  for (let i = 0; i < names.length; i++) {
    const doc = await fetchOrderDetail(names[i]);
    if (doc) results.push(doc);
    if (i > 0 && i % 3 === 0) await new Promise((r) => setTimeout(r, 100));
  }
  return results;
}

// ── Agent Detection ────────────────────────────────────────
// Priority: 1) _assign field  2) modified_by field

function extractAgent(doc: any): string | null {
  // 1. Check _assign first (rare but explicit assignment)
  const assign = doc._assign;
  if (assign) {
    try {
      const emails: string[] = typeof assign === "string" ? JSON.parse(assign) : assign;
      for (const email of emails) {
        const c = email.trim().toLowerCase();
        if (OPS_AGENTS[c]) return OPS_AGENTS[c];
      }
    } catch {}
  }

  // 2. Fallback: modified_by (who last worked on it)
  const modifiedBy = (doc.modified_by || "").toLowerCase();
  if (modifiedBy && !isExcludedUser(modifiedBy) && OPS_AGENTS[modifiedBy]) {
    return OPS_AGENTS[modifiedBy];
  }

  // 3. Check owner too
  const owner = (doc.owner || "").toLowerCase();
  if (owner && !isExcludedUser(owner) && OPS_AGENTS[owner]) {
    return OPS_AGENTS[owner];
  }

  return null;
}

// ── Helpers ────────────────────────────────────────────────

function deriveStore(doc: any): { store: string; prefix: string } {
  // Check custom_sales_channel first
  const channel = (doc.custom_sales_channel || "").toLowerCase();
  if (channel.includes("etsy")) return { store: "Marketplace", prefix: "F-40" };

  const soName = (doc.custom_sales_order_name || doc.name || "").toUpperCase();
  if (soName.match(/^[FC]-43/)) return { store: "ZipCushions", prefix: "F-43" };
  if (soName.match(/^[FC]-53/)) return { store: "ZipCovers", prefix: "F-53" };
  if (soName.match(/^F-4\d{8,}/)) return { store: "Marketplace", prefix: "F-40" };
  if (doc.custom_is_zipcovers_order) return { store: "ZipCovers", prefix: "F-53" };
  if (doc.custom_is_market_placed) return { store: "Marketplace", prefix: "F-40" };
  return { store: "ZipCushions", prefix: "F-43" };
}

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function toIST(dateStr: string | null): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// ── Sync orders ────────────────────────────────────────────

async function syncOrders(orders: any[]) {
  let upserted = 0, errors = 0;

  const rows = orders.map((doc) => {
    const { store, prefix } = deriveStore(doc);
    const agentName = extractAgent(doc);
    return {
      order_name: doc.name,
      agent: agentName,
      assigned_agent: agentName,
      ops_status: doc.custom_ops_status || "",
      order_type: doc.order_type || "Sales",
      creation_ist: toIST(doc.creation),
      days_pending: daysSince(doc.creation),
      total_qty: doc.total_qty || 0,
      is_rush: doc.custom_is_rush_order === 1,
      is_escalated: doc.custom_is_escalated_order === 1,
      shopify_fulfilment_status: doc.custom_shopify_fulfilment_status || null,
      aggregate_production_status: doc.custom__aggregate_production_status || null,
      production_status: doc.custom__aggregate_production_status || null,
      ops_status_updated_at: doc.modified || null,
      days_in_current_status: daysSince(doc.modified),
      store,
      order_prefix: prefix,
      synced_at: new Date().toISOString(),
    };
  });

  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase.from("orders").upsert(batch, { onConflict: "order_name" });
    if (error) {
      errors += batch.length;
      console.error("Upsert error:", error.message);
    } else {
      upserted += batch.length;
    }
  }
  return { upserted, errors };
}

// ── Link tickets to orders via custom_zendesk_ticket_id ────

async function linkTicketsToOrders(orders: any[]) {
  let linked = 0;
  for (const doc of orders) {
    const ticketId = doc.custom_zendesk_ticket_id;
    if (!ticketId) continue;

    const { error } = await supabase.from("tickets")
      .update({ linked_order: doc.name })
      .eq("ticket_id", ticketId.toString());

    if (!error) linked++;
  }
  return linked;
}

// ── Alerts ─────────────────────────────────────────────────

async function generateAlerts(orders: any[]) {
  const fourHoursAgo = new Date(Date.now() - 4 * 3600000).toISOString();
  let inserted = 0;

  for (const doc of orders) {
    const status = doc.custom_ops_status || "";
    if (["COMPLETED", "SHIPPED"].includes(status)) continue;

    const agent = extractAgent(doc);
    const soName = doc.custom_sales_order_name || doc.name;
    const days = daysSince(doc.modified);
    const alerts: any[] = [];

    if (doc.custom_is_rush_order === 1) {
      alerts.push({ alert_type: "rush_order", severity: "critical",
        title: `Rush order ${soName}`,
        description: `${doc.customer_name || doc.custom_end_customer_name || ""} — ${status}, agent: ${agent || "unassigned"}`,
        order_name: doc.name, agent_name: agent });
    }
    if (days > 7) {
      alerts.push({ alert_type: "stuck_order", severity: "critical",
        title: `${soName} stuck ${days}d`,
        description: `In "${status}" for ${days} days`,
        order_name: doc.name, agent_name: agent });
    } else if (days > 3) {
      alerts.push({ alert_type: "stuck_order", severity: "warning",
        title: `${soName} stuck ${days}d`,
        description: `In "${status}" for ${days} days`,
        order_name: doc.name, agent_name: agent });
    }

    for (const a of alerts) {
      const { data: ex } = await supabase.from("alerts").select("id")
        .eq("order_name", a.order_name).eq("alert_type", a.alert_type)
        .eq("is_resolved", false).gte("created_at", fourHoursAgo).limit(1);
      if (ex && ex.length > 0) continue;
      const { error } = await supabase.from("alerts").insert(a);
      if (!error) inserted++;
    }
  }
  return inserted;
}

// ── Metrics ────────────────────────────────────────────────

async function updateMetrics() {
  const today = new Date().toISOString().split("T")[0];

  const { data: existingSOD } = await supabase.from("sod_eod_log")
    .select("id").eq("log_date", today).eq("log_type", "SOD").limit(1);
  const logType = existingSOD && existingSOD.length > 0 ? "EOD" : "SOD";

  for (const [email, name] of Object.entries(OPS_AGENTS)) {
    const { count: newCount } = await supabase.from("orders")
      .select("*", { count: "exact", head: true })
      .eq("assigned_agent", name).eq("ops_status", "NEW");

    const { count: confPending } = await supabase.from("orders")
      .select("*", { count: "exact", head: true })
      .eq("assigned_agent", name).eq("ops_status", "CONFIRMATION PENDING");

    const { count: inProd } = await supabase.from("orders")
      .select("*", { count: "exact", head: true })
      .eq("assigned_agent", name).in("ops_status", ["IN PRODUCTION", "PRODUCTION STARTED"]);

    const { count: completed } = await supabase.from("orders")
      .select("*", { count: "exact", head: true })
      .eq("assigned_agent", name).eq("ops_status", "COMPLETED");

    const { count: totalAssigned } = await supabase.from("orders")
      .select("*", { count: "exact", head: true })
      .eq("assigned_agent", name);

    const nc = newCount || 0;

    await supabase.from("sod_eod_log").upsert({
      log_date: today, log_type: logType, agent_name: name,
      new_count: nc, confirmation_pending_count: confPending || 0,
      in_production_count: inProd || 0, total_count: totalAssigned || 0,
      captured_at: new Date().toISOString(),
    }, { onConflict: "log_date,log_type,agent_name" });

    const { data: sodRow } = await supabase.from("sod_eod_log")
      .select("new_count").eq("log_date", today).eq("log_type", "SOD")
      .eq("agent_name", name).limit(1);
    const sodNew = sodRow?.[0]?.new_count ?? nc;

    await supabase.from("agent_metrics").upsert({
      agent_name: name, agent_email: email, metric_date: today,
      sod_new: sodNew, current_new: nc,
      worked: Math.max(0, sodNew - nc),
      confirmation_pending: confPending || 0,
      in_production: inProd || 0,
      completed: completed || 0,
      total_assigned: totalAssigned || 0,
      emails_sent: 0, emails_received: 0,
    }, { onConflict: "agent_name,metric_date" });
  }
  return logType;
}

// ── Main ───────────────────────────────────────────────────

serve(async (req: Request) => {
  const startTime = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const fullSync = body.full === true;

    console.log(`[sync-erpnext] Started, fullSync=${fullSync}`);

    let orderNames: string[];
    if (fullSync) {
      orderNames = await fetchAllActiveOrderNames();
    } else {
      orderNames = await fetchRecentOrderNames(30);
    }
    console.log(`[sync-erpnext] Found ${orderNames.length} orders`);

    const capped = orderNames.slice(0, 100);
    const orders = await fetchOrderDetails(capped);
    console.log(`[sync-erpnext] Fetched ${orders.length} details`);

    const stats = await syncOrders(orders);
    console.log(`[sync-erpnext] Synced: ${stats.upserted}, Errors: ${stats.errors}`);

    const linkedCount = await linkTicketsToOrders(orders);
    const alertCount = await generateAlerts(orders);
    const logType = await updateMetrics();

    const elapsed = Date.now() - startTime;
    console.log(`[sync-erpnext] Done in ${elapsed}ms`);

    return new Response(JSON.stringify({
      ok: true, elapsed_ms: elapsed,
      orders_found: orderNames.length, orders_synced: stats.upserted,
      errors: stats.errors, tickets_linked: linkedCount,
      alerts: alertCount, sod_eod: logType,
      capped: orderNames.length > 100,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[sync-erpnext] Fatal: ${msg}`);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
