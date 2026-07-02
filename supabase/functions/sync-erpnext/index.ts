import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ERP_URL = Deno.env.get('ERP_URL')!
const ERP_KEY = Deno.env.get('ERP_API_KEY')!
const ERP_SECRET = Deno.env.get('ERP_API_SECRET')!
const ZD_SUBDOMAIN = Deno.env.get('ZENDESK_SUBDOMAIN')!
const ZD_EMAIL = Deno.env.get('ZENDESK_EMAIL')!
const ZD_TOKEN = Deno.env.get('ZENDESK_API_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const AGENTS: Record<string, string> = {
  'Leo': 'leo@cozycornerpatios.com',
  'Oscar': 'oscar@cozycornerpatios.com',
  'Smith': 'smith@cozycornerpatios.com',
  'Richard': 'richard@cozycornerpatios.com',
  'Jason': 'jason@cozycornerpatios.com',
  'Liam': 'liam@cozycornerpatios.com',
}

const ZD_SUPPORT_ACCOUNTS = [
  'support01@cozycornerpatios.com',
  'support02@cozycornerpatios.com',
]

async function fetchERP(doctype: string, filters: any[], fields: string[]) {
  const url = ERP_URL + '/api/resource/' + encodeURIComponent(doctype)
    + '?filters=' + encodeURIComponent(JSON.stringify(filters))
    + '&fields=' + encodeURIComponent(JSON.stringify(fields))
    + '&limit_page_size=0'
  const resp = await fetch(url, {
    headers: { 'Authorization': 'token ' + ERP_KEY + ':' + ERP_SECRET },
  })
  if (resp.status === 417) throw new Error('Invalid field name in ' + doctype)
  if (!resp.ok) throw new Error('ERPNext error ' + resp.status)
  const data = await resp.json()
  return data.data || []
}

function toIST(utcStr: string): string {
  if (!utcStr) return ''
  const d = new Date(utcStr.replace(' ', 'T') + 'Z')
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
}

function daysPending(utcStr: string): number {
  if (!utcStr) return 0
  const created = new Date(utcStr.replace(' ', 'T') + 'Z')
  return Math.floor((Date.now() - created.getTime()) / 86400000)
}

function classifyOrder(name: string): string {
  if (/^(F-53-|C-53-)/.test(name)) return 'Cover'
  if (/^F-40/.test(name)) return 'Marketplace'
  return 'Cushion'
}

const ZD_BASE = 'https://' + ZD_SUBDOMAIN + '.zendesk.com/api/v2'
const ZD_AUTH = btoa(ZD_EMAIL + '/token:' + ZD_TOKEN)

async function fetchZendeskTickets(accountEmail: string): Promise<any[]> {
  const query = 'type:ticket assignee:' + accountEmail + ' status<closed'
  const url = ZD_BASE + '/search.json?query=' + encodeURIComponent(query) + '&per_page=100'
  const resp = await fetch(url, {
    headers: { 'Authorization': 'Basic ' + ZD_AUTH, 'Content-Type': 'application/json' },
  })
  if (resp.status === 429) throw new Error('Zendesk rate limited for ' + accountEmail)
  if (!resp.ok) throw new Error('Zendesk error ' + resp.status)
  const data = await resp.json()
  return data.results || []
}

Deno.serve(async (_req) => {
  const startTime = Date.now()
  const errors: string[] = []
  let totalOrders = 0
  let totalTickets = 0

  try {
    const allOrders: any[] = []

    for (const [agentName, agentEmail] of Object.entries(AGENTS)) {
      try {
        const orders = await fetchERP('Sales Order', [
          ['_assign', 'like', '%' + agentEmail + '%'],
          ['docstatus', '=', 1],
          ['custom_ops_status', 'not in', ['COMPLETED', 'CANCELLED']],
        ], [
          'name', 'custom_ops_status', 'creation', 'total_qty',
          'custom_shopify_fulfilment_status',
        ])
        for (const o of orders) {
          allOrders.push({
            order_name: o.name,
            agent: agentName,
            ops_status: o.custom_ops_status || 'NEW',
            order_type: classifyOrder(o.name),
            creation_ist: toIST(o.creation),
            days_pending: daysPending(o.creation),
            total_qty: o.total_qty || 0,
            is_rush: false,
            shopify_fulfilment_status: o.custom_shopify_fulfilment_status || '',
            aggregate_production_status: '',
            synced_at: new Date().toISOString(),
          })
        }
      } catch (err) {
        errors.push('Orders/' + agentName + ': ' + (err as Error).message)
      }
    }

    await supabase.from('orders').delete().neq('id', 0)
    for (let i = 0; i < allOrders.length; i += 100) {
      const batch = allOrders.slice(i, i + 100)
      const { error } = await supabase.from('orders').insert(batch)
      if (error) errors.push('Insert orders batch ' + i + ': ' + error.message)
    }
    totalOrders = allOrders.length

    // ZENDESK: Search by shared support accounts (not per-agent)
    const allTickets: any[] = []
    for (const zdEmail of ZD_SUPPORT_ACCOUNTS) {
      try {
        await new Promise((r) => setTimeout(r, 2000))
        const tickets = await fetchZendeskTickets(zdEmail)
        for (const t of tickets) {
          allTickets.push({
            ticket_id: String(t.id),
            agent: 'OPS Team',
            subject: (t.subject || '').slice(0, 200),
            status: t.status || 'unknown',
            priority: t.priority || 'normal',
            created_at_ist: toIST(t.created_at),
            updated_at_ist: toIST(t.updated_at),
            ticket_url: 'https://' + ZD_SUBDOMAIN + '.zendesk.com/agent/tickets/' + t.id,
            synced_at: new Date().toISOString(),
          })
        }
      } catch (err) {
        errors.push('Tickets/' + zdEmail + ': ' + (err as Error).message)
      }
    }

    await supabase.from('tickets').delete().neq('id', 0)
    for (let i = 0; i < allTickets.length; i += 100) {
      const batch = allTickets.slice(i, i + 100)
      const { error } = await supabase.from('tickets').insert(batch)
      if (error) errors.push('Insert tickets batch ' + i + ': ' + error.message)
    }
    totalTickets = allTickets.length

    try {
      const comms = await fetchERP('Factory to Ops Communication', [
        ['creation', '>=', new Date(Date.now() - 48 * 3600000).toISOString().slice(0, 10)],
      ], ['name', 'creation', 'acknowledged'])
      const commRows = comms.map((c: any) => ({
        comm_name: c.name,
        reference_order: '',
        agent: '',
        creation_ist: toIST(c.creation),
        acknowledged: c.acknowledged === 1,
        synced_at: new Date().toISOString(),
      }))
      await supabase.from('communications').delete().neq('id', 0)
      for (let i = 0; i < commRows.length; i += 100) {
        const batch = commRows.slice(i, i + 100)
        const { error } = await supabase.from('communications').insert(batch)
        if (error) errors.push('Insert comms batch ' + i + ': ' + error.message)
      }
    } catch (err) {
      errors.push('Communications: ' + (err as Error).message)
    }

    // SOD/EOD SNAPSHOT LOGIC
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    for (const agentName of Object.keys(AGENTS)) {
      const agentOrders = allOrders.filter((o) => o.agent === agentName)
      const agentTickets = allTickets.filter((t) => t.agent === agentName)
      const currentNewCount = agentOrders.filter((o) => o.ops_status === 'NEW').length

      const { data: existing } = await supabase
        .from('daily_snapshots')
        .select('sod_new_count')
        .eq('snapshot_date', today)
        .eq('agent', agentName)
        .limit(1)

      const sodCount = (existing && existing.length > 0 && existing[0].sod_new_count > 0)
        ? existing[0].sod_new_count
        : currentNewCount

      const snapshot = {
        snapshot_date: today,
        agent: agentName,
        sod_new_count: sodCount,
        new_count: currentNewCount,
        pending_count: agentOrders.filter((o) => o.ops_status === 'CONFIRMATION PENDING').length,
        approved_count: agentOrders.filter((o) => o.ops_status === 'APPROVED').length,
        review_count: agentOrders.filter((o) => o.ops_status === 'OPS REVIEW').length,
        failed_count: agentOrders.filter((o) => o.ops_status === 'FAILED').length,
        handled_count: agentTickets.filter((t) => t.status === 'solved').length,
        missed_count: agentTickets.filter((t) => t.status === 'open').length,
        total_orders: agentOrders.length,
      }
      await supabase.from('daily_snapshots').upsert(snapshot, { onConflict: 'snapshot_date,agent' })
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    return new Response(JSON.stringify({
      success: true, orders_synced: totalOrders, tickets_synced: totalTickets,
      agents: Object.keys(AGENTS).length, duration_sec: duration,
      errors: errors.length > 0 ? errors : 'none',
    }), { headers: { 'Content-Type': 'application/json' } })

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
