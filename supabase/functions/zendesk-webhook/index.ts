import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("ZENDESK_WEBHOOK_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const KNOWN_AGENTS = ["leo","oscar","smith","richard","jason","jasond","liam","patrick"];
const VALID_STATUSES = ["new","open","pending","hold","on-hold","solved","closed"];

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim();
  if (!WEBHOOK_SECRET || provided !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  const d = body.detail ?? {};
  const ticketId = d.id ?? body.ticket_id ?? body.id ?? null;
  const eventType = body.type ?? "ticket.event";

  // Only trust a status value when this is genuinely a status-change event.
  // For all other event types, event.current is NOT a status (it's an id,
  // subject, due date, etc.), so we leave status null and fall back to
  // detail.status only if it is a real status word.
  let statusNorm: string | null = null;
  const isStatusEvent = eventType.includes("status_changed") && !eventType.includes("custom_status");
  if (isStatusEvent && body.event?.current) {
    statusNorm = String(body.event.current).toLowerCase();
  } else if (d.status && VALID_STATUSES.includes(String(d.status).toLowerCase())) {
    statusNorm = String(d.status).toLowerCase();
  }
  // Guard: if somehow not a valid status, null it out.
  if (statusNorm && !VALID_STATUSES.includes(statusNorm)) statusNorm = null;

  const eventTime = body.time ?? d.updated_at ?? new Date().toISOString();

  let ownerHint: string | null = null;
  if (Array.isArray(d.tags)) {
    const hit = d.tags.find((t: string) => KNOWN_AGENTS.includes(String(t).toLowerCase()));
    if (hit) ownerHint = String(hit).toLowerCase();
  }

  if (ticketId) {
    const { error } = await supabase.from("ticket_events").insert({
      ticket_id: Number(ticketId),
      ops_owner: ownerHint,
      status: statusNorm,
      event_type: eventType,
      updated_by: null,
      zendesk_updated_at: eventTime,
      raw_payload: body,
    });
    if (error && error.code !== "23505") {
      console.error("insert error (non-fatal):", JSON.stringify(error));
    }
  }

  return new Response(JSON.stringify({ ok: true, ticket_id: ticketId, owner_hint: ownerHint }), {
    status: 200, headers: { "content-type": "application/json" },
  });
});