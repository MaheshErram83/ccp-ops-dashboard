import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ZD_SUBDOMAIN = Deno.env.get("ZENDESK_SUBDOMAIN") ?? "";
const ZD_EMAIL = Deno.env.get("ZENDESK_EMAIL") ?? "";
const ZD_TOKEN = Deno.env.get("ZENDESK_API_TOKEN") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const OPS_OWNER_FIELD_ID = 360051544471;
const BATCH = 100;
const LOOKBACK_HOURS = 48;
const MAX_BATCHES = 10;

function zdAuth(): string {
  return "Basic " + btoa(`${ZD_EMAIL}/token:${ZD_TOKEN}`);
}

async function showMany(ids: number[]) {
  const url = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/show_many.json?ids=${ids.join(",")}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: zdAuth(), "Content-Type": "application/json" },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || attempt * 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      console.error(`show_many failed ${res.status}`);
      return null;
    }
    return await res.json();
  }
  return null;
}

Deno.serve(async () => {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from("ticket_events")
    .select("ticket_id")
    .is("ops_owner", null)
    .gte("received_at", since);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }

  const ids = Array.from(new Set((rows ?? []).map((r: any) => r.ticket_id))).filter(Boolean);
  if (ids.length === 0) {
    return new Response(JSON.stringify({ ok: true, updated: 0, note: "nothing to fill" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  let updatedTickets = 0;
  let processed = 0;

  for (let i = 0; i < ids.length && i / BATCH < MAX_BATCHES; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const data = await showMany(slice);
    if (!data || !Array.isArray(data.tickets)) continue;

    for (const t of data.tickets) {
      processed++;
      let owner: string | null = null;
      if (Array.isArray(t.custom_fields)) {
        const f = t.custom_fields.find((c: any) => c.id === OPS_OWNER_FIELD_ID);
        if (f && f.value !== null && f.value !== undefined && f.value !== "") {
          owner = String(f.value).toLowerCase();
        }
      }
      if (owner) {
        const { error: upErr } = await supabase
          .from("ticket_events")
          .update({ ops_owner: owner })
          .eq("ticket_id", t.id)
          .is("ops_owner", null);
        if (!upErr) updatedTickets++;
      }
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return new Response(
    JSON.stringify({ ok: true, tickets_seen: processed, tickets_updated: updatedTickets }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});