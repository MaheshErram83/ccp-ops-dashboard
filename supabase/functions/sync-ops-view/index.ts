import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ZD_SUBDOMAIN = Deno.env.get("ZENDESK_SUBDOMAIN") ?? "";
const ZD_EMAIL = Deno.env.get("ZENDESK_EMAIL") ?? "";
const ZD_TOKEN = Deno.env.get("ZENDESK_API_TOKEN") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const VIEW_ID = "15701851537549";
const OPS_OWNER_FIELD_ID = 360051544471;
const PER_PAGE = 100;
const MAX_PAGES = 50;

function zdAuth(): string {
  return "Basic " + btoa(`${ZD_EMAIL}/token:${ZD_TOKEN}`);
}

function parseOrder(subject: string | null): string | null {
  if (!subject) return null;
  const m = subject.match(/\d{2}-\d{4,6}-\d{2}/);
  return m ? m[0] : null;
}

async function fetchPage(url: string) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: zdAuth(), "Content-Type": "application/json" },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || attempt * 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) { console.error(`view page fetch failed ${res.status}`); return null; }
    return await res.json();
  }
  return null;
}

Deno.serve(async () => {
  const base = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/views/${VIEW_ID}/tickets.json`;
  let url: string | null = `${base}?per_page=${PER_PAGE}`;
  let page = 0;
  const rows: any[] = [];

  while (url && page < MAX_PAGES) {
    const data: any = await fetchPage(url);
    if (!data || !Array.isArray(data.tickets)) break;

    for (const t of data.tickets) {
      let owner: string | null = null;
      if (Array.isArray(t.custom_fields)) {
        const f = t.custom_fields.find((c: any) => c.id === OPS_OWNER_FIELD_ID);
        if (f && f.value !== null && f.value !== undefined && f.value !== "") {
          owner = String(f.value).toLowerCase();
        }
      }
      rows.push({
        ticket_id: t.id,
        ops_owner: owner,
        status: t.status ? String(t.status).toLowerCase() : null,
        custom_status_id: t.custom_status_id ?? null,
        subject: t.subject ?? null,
        order_number: parseOrder(t.subject ?? null),
        zendesk_created_at: t.created_at ?? null,
        zendesk_updated_at: t.updated_at ?? null,
        synced_at: new Date().toISOString(),
      });
    }

    url = data.next_page ?? null;
    page++;
    await new Promise((r) => setTimeout(r, 300));
  }

  if (rows.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "no tickets pulled" }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }

  const { error: delErr } = await supabase.from("ops_view_tickets").delete().neq("ticket_id", -1);
  if (delErr) {
    return new Response(JSON.stringify({ ok: false, error: "clear failed: " + delErr.message }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error: insErr } = await supabase.from("ops_view_tickets").insert(chunk);
    if (insErr) console.error("insert chunk failed:", insErr.message);
    else inserted += chunk.length;
  }

  return new Response(JSON.stringify({ ok: true, pages: page, pulled: rows.length, inserted }), {
    status: 200, headers: { "content-type": "application/json" },
  });
});