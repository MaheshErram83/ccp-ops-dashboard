import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ZENDESK_SUBDOMAIN = Deno.env.get("ZENDESK_SUBDOMAIN")!;
const ZENDESK_EMAIL = Deno.env.get("ZENDESK_EMAIL")!;
const ZENDESK_API_TOKEN = Deno.env.get("ZENDESK_API_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const ZD_BASE = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const ZD_AUTH = btoa(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`);

const OPS_AGENT_MAP: Record<string, string> = {
  "leo@cozycornerpatios.com": "Leo",
  "oscar@cozycornerpatios.com": "Oscar",
  "smith@cozycornerpatios.com": "Smith",
  "richard@cozycornerpatios.com": "Richard",
  "jason@cozycornerpatios.com": "Jason",
  "liam@cozycornerpatios.com": "Liam",
};

const SLA_TARGETS: Record<string, number> = {
  urgent: 60, high: 240, normal: 480, low: 1440,
};

// ── Zendesk API ────────────────────────────────────────────

async function zdFetch(endpoint: string) {
  const res = await fetch(`${ZD_BASE}${endpoint}`, {
    headers: { Authorization: `Basic ${ZD_AUTH}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zendesk ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

async function fetchRecentTickets(): Promise<any[]> {
  const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
  const isoTime = twentyMinAgo.toISOString();
  const query = encodeURIComponent(`type:ticket updated>${isoTime}`);
  const data = await zdFetch(`/search.json?query=${query}&sort_by=updated_at&sort_order=desc&per_page=100`);
  return data.results || [];
}

async function fetchTicket(ticketId: number) {
  const data = await zdFetch(`/tickets/${ticketId}.json`);
  return data.ticket;
}

// ── User cache ─────────────────────────────────────────────

const userCache: Record<number, string> = {};

async function resolveUserEmails(userIds: number[]): Promise<void> {
  const unknownIds = userIds.filter((id) => id && !userCache[id]);
  if (unknownIds.length === 0) return;

  // Batch fetch up to 100
  for (let i = 0; i < unknownIds.length; i += 100) {
    const batch = unknownIds.slice(i, i + 100);
    try {
      const data = await zdFetch(`/users/show_many.json?ids=${batch.join(",")}`);
      for (const user of (data.users || [])) {
        if (user.id && user.email) userCache[user.id] = user.email.toLowerCase();
      }
    } catch (e) {
      console.error("User resolve failed:", e);
    }
  }
}

function getAgentName(userId: number): string | null {
  const email = userCache[userId] || "";
  return OPS_AGENT_MAP[email] || null;
}

// ── Helpers ────────────────────────────────────────────────

function toIST(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function extractOrderNumber(ticket: any): string | null {
  const subject = ticket.subject || "";
  const patterns = [/\b([FC]-4[03]\d?-\d{4,})\b/i, /\b([FC]-5[03]-\d{4,})\b/i];
  for (const p of patterns) {
    const m = subject.match(p);
    if (m) return m[1];
  }
  if (ticket.custom_fields) {
    for (const f of ticket.custom_fields) {
      if (f.value && typeof f.value === "string") {
        for (const p of patterns) {
          const m = f.value.match(p);
          if (m) return m[1];
        }
      }
    }
  }
  return null;
}

function computeSlaBreachAt(ticket: any): string | null {
  const priority = ticket.priority || "normal";
  const targetMin = SLA_TARGETS[priority];
  if (!targetMin) return null;
  const created = new Date(ticket.created_at);
  return new Date(created.getTime() + targetMin * 60000).toISOString();
}

// ── Process ticket ─────────────────────────────────────────
// Actual columns: ticket_id, agent, subject, status, priority,
// created_at_ist, updated_at_ist, ticket_url, synced_at,
// sla_breach_at, first_response_minutes, linked_order

async function processTicket(ticket: any): Promise<{ upserted: boolean; alert: any | null }> {
  const userIds = [ticket.assignee_id, ticket.requester_id].filter(Boolean);
  await resolveUserEmails(userIds);

  const agentName = ticket.assignee_id ? getAgentName(ticket.assignee_id) : null;
  const slaBreachAt = computeSlaBreachAt(ticket);
  const linkedOrder = extractOrderNumber(ticket);

  const ticketRow = {
    ticket_id: ticket.id.toString(),
    agent: agentName,
    subject: ticket.subject || "",
    status: ticket.status || "new",
    priority: ticket.priority || "normal",
    created_at_ist: toIST(ticket.created_at),
    updated_at_ist: toIST(ticket.updated_at),
    ticket_url: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${ticket.id}`,
    synced_at: new Date().toISOString(),
    sla_breach_at: slaBreachAt,
    first_response_minutes: null,
    linked_order: linkedOrder,
  };

  const { error } = await supabase
    .from("tickets")
    .upsert(ticketRow, { onConflict: "ticket_id" });

  if (error) {
    console.error(`Ticket ${ticket.id} upsert failed:`, error.message);
    return { upserted: false, alert: null };
  }

  // SLA alert
  let alert = null;
  if (slaBreachAt && !["solved", "closed"].includes(ticket.status)) {
    const now = Date.now();
    const breachTime = new Date(slaBreachAt).getTime();
    if (now > breachTime) {
      alert = {
        alert_type: "sla_breach", severity: "critical",
        title: `Ticket #${ticket.id} SLA breached`,
        description: `${ticket.priority} priority — ${(ticket.subject || "").substring(0, 80)}`,
        ticket_id: ticket.id.toString(), agent_name: agentName,
      };
    } else if (breachTime - now < 3600000) {
      const minsLeft = Math.round((breachTime - now) / 60000);
      alert = {
        alert_type: "sla_breach", severity: "warning",
        title: `Ticket #${ticket.id} SLA in ${minsLeft}m`,
        description: `${ticket.priority} priority — ${(ticket.subject || "").substring(0, 80)}`,
        ticket_id: ticket.id.toString(), agent_name: agentName,
      };
    }
  }

  return { upserted: true, alert };
}

// ── Save alerts (deduplicated) ─────────────────────────────

async function saveAlerts(alerts: any[]) {
  const fourHoursAgo = new Date(Date.now() - 4 * 3600000).toISOString();
  for (const alert of alerts) {
    const { data: ex } = await supabase.from("alerts").select("id")
      .eq("ticket_id", alert.ticket_id).eq("alert_type", alert.alert_type)
      .eq("is_resolved", false).gte("created_at", fourHoursAgo).limit(1);
    if (ex && ex.length > 0) continue;
    await supabase.from("alerts").insert(alert);
  }
}

// ── Update agent ticket metrics ────────────────────────────

async function updateAgentTicketMetrics() {
  const today = new Date().toISOString().split("T")[0];

  for (const [email, name] of Object.entries(OPS_AGENT_MAP)) {
    const { count: openCount } = await supabase.from("tickets")
      .select("*", { count: "exact", head: true })
      .eq("agent", name).in("status", ["new", "open", "pending"]);

    const { count: solvedCount } = await supabase.from("tickets")
      .select("*", { count: "exact", head: true })
      .eq("agent", name).eq("status", "solved");

    await supabase.from("agent_metrics").upsert({
      agent_name: name, agent_email: email, metric_date: today,
      zendesk_tickets_open: openCount || 0,
      zendesk_tickets_solved: solvedCount || 0,
    }, { onConflict: "agent_name,metric_date" });
  }
}

// ── Main ───────────────────────────────────────────────────

serve(async (req: Request) => {
  const startTime = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const mode = body.ticket_id ? "webhook" : "cron";

    console.log(`[sync-zendesk] Mode: ${mode}`);

    let tickets: any[] = [];
    if (mode === "webhook") {
      const ticket = await fetchTicket(body.ticket_id);
      tickets = [ticket];
    } else {
      tickets = await fetchRecentTickets();
      console.log(`[sync-zendesk] Found ${tickets.length} recent tickets`);
    }

    // Resolve user emails in batch
    const allUserIds = tickets.flatMap((t) => [t.assignee_id, t.requester_id]).filter(Boolean);
    await resolveUserEmails([...new Set(allUserIds)] as number[]);

    let stats = { total: tickets.length, upserted: 0, alerts: 0, errors: 0 };
    const pendingAlerts: any[] = [];

    for (const ticket of tickets) {
      try {
        const { upserted, alert } = await processTicket(ticket);
        if (upserted) stats.upserted++;
        if (alert) pendingAlerts.push(alert);
      } catch (e) {
        stats.errors++;
        console.error(`Ticket ${ticket.id} error:`, e);
      }
    }

    await saveAlerts(pendingAlerts);
    stats.alerts = pendingAlerts.length;
    await updateAgentTicketMetrics();

    const elapsed = Date.now() - startTime;
    console.log(`[sync-zendesk] Done in ${elapsed}ms — ${stats.upserted} upserted`);

    return new Response(JSON.stringify({ ok: true, mode, stats, elapsed_ms: elapsed }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[sync-zendesk] Fatal: ${msg}`);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
