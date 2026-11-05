// Data layer. DEMO mode (no env vars) uses fake data; LIVE mode reads Supabase.
// Supabase layout (from Phase 2): table "docs" (desk_id, collection, doc_id, data jsonb).
// Field names are mapped defensively below; adjust map*() once real docs are confirmed.
import { createClient } from '@supabase/supabase-js'
import { DEMO, DEMO_USERS, DEMO_LIVE, DEMO_BRAIN, DEMO_USAGE, DEMO_PICKS_EXTRA } from './demo.js'

const URL = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
export const DEMO_MODE = !(URL && KEY)
export const supabase = DEMO_MODE ? null : createClient(URL, KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'parlay-desk-auth' },
})

const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0)
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined }

// When something was given/uploaded, as a number, so lists sort in true time order
// (mixed formats like "2026-11-04" vs full timestamps used to sort wrong as text).
// Order of preference: exact created/upload time → time inside the id → placed/game date.
const msOf = (v) => { if (v === null || v === undefined || v === '') return 0; if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  const s = String(v); const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s); return isNaN(t) ? 0 : t }
export function whenMs(x = {}, id = '') {
  const exact = msOf(x.createdAt) || msOf(x.loggedAt) || msOf(x.uploadedAt) || msOf(x.builtAt) || msOf(x.answeredAt)
  if (exact) return exact
  const m = String(id || x.id || '').match(/(1[6-9]\d{11})/)
  if (m) return Number(m[1])
  return msOf(x.placedAt) || msOf(x.date) || msOf(x.gameDate) || msOf(x.settledAt) || 0
}
export const newestFirst = (a, b) => whenMs(b, b.id) - whenMs(a, a.id)

// Parlay names always say how many legs: "7 Pick Parlay" / "7 leg parlay" → "7-Leg Parlay"
export const legLabel = (t) => String(t || '').replace(/\b(\d+)\s*[- ]?\s*(?:pick|leg)s?\s+(parlay|sgp)\b/gi, (m, n, k) => `${n}-Leg ${k.toUpperCase() === 'SGP' ? 'SGP' : 'Parlay'}`)
export const withLegs = (title, legCount) => { const t = legLabel(title); if (!(legCount > 1)) return t; return /\d+-Leg/i.test(t) ? t : `${t ? t + ' · ' : ''}${legCount}-Leg Parlay` }

// The desk uses several words for the same thing (pending, placed, live, win, loss, hit, miss, void...). Anything not settled = open.
const norm = (v) => { const raw = String(v || '').toLowerCase().trim()
  return /^(won|win|hit|cashed)$/.test(raw) ? 'won' : /^(lost|loss|lose|miss(ed)?)$/.test(raw) ? 'lost'
    : /^(push|void(ed)?|refund(ed)?|cancel(l)?ed)$/.test(raw) ? 'push' : /cash ?out/.test(raw) ? 'cashout' : 'open' }

// Leg type from its wording: player prop / moneyline / spread / total / other
export function legType(text) {
  const t = String(text || '').toLowerCase()
  if (/\d+\+|anytime|first td|first basket|goalscorer|scorer|rebounds|assists|receptions|receiving|rushing|passing|yards|shots on goal|\bsog\b|strikeouts|threes|3-pointers|\bpra\b|touchdown/.test(t)) return 'Player props'
  if (/\b(over|under|o\/u)\b|\btotal\b/.test(t)) return 'Totals'
  if (/\bml\b|moneyline|money line|to win\b/.test(t)) return 'Moneylines'
  if (/[+-]\d+(\.\d)?\b|spread|puck line|run line|handicap/.test(t)) return 'Spreads'
  return 'Other'
}

function mapBetRaw(id, x = {}) {
  const legsRaw = pick(x, 'legs', 'legList', 'selections') || []
  const legs = Array.isArray(legsRaw) ? legsRaw.map((l) => typeof l === 'string'
    ? { text: l, status: 'open' }
    : { text: pick(l, 'text', 'label', 'leg', 'name', 'desc') || '', status: norm(pick(l, 'status', 'result', 'outcome', 'grade')) }) : []
  const s1 = norm(x.status), s2 = norm(x.result)
  const status = s1 !== 'open' ? s1 : s2 !== 'open' ? s2 : (x.settledAt && n(x.ret) > 0 ? 'won' : x.settledAt ? 'lost' : 'open')
  return {
    id, legs, status, review: /review/i.test(String(x.status || '') + String(x.result || '')),
    sport: (() => { const sp = String(pick(x, 'sport', 'league') || '').toUpperCase(); return /^(NCAAB|NCAAM|CBB|MENS-COLLEGE-BASKETBALL|COLLEGE BASKETBALL|NCAA BASKETBALL)$/.test(sp) ? 'CBB' : sp })(),
    title: legLabel(pick(x, 'title', 'name', 'label', 'ticket') || (legs.length > 1 ? `${legs.length}-Leg Parlay` : 'Bet')),
    stake: n(pick(x, 'stake', 'risk', 'wager', 'amount', 'wagered', 'wagerAmount', 'betAmount', 'stakeAmount', 'risked')),
    ret: n(pick(x, 'ret', 'payout', 'return', 'toReturn')),
    odds: pick(x, 'odds', 'price', 'americanOdds') || '',
    source: (pick(x, 'source', 'by', 'owner', 'from') || '').toString().toLowerCase(),
    settledAt: pick(x, 'settledAt', 'settled_at'),
    placedAt: pick(x, 'placedAt', 'createdAt', 'created_at', 'date'),
    toPay: n(pick(x, 'toPay', 'toWin', 'potentialPayout', 'potential', 'payoutIfWin', 'pays')),
    gameEnd: pick(x, 'lastStart', 'firstStart', 'gameDate', 'date') || '',
    loggedAt: pick(x, 'createdAt', 'created_at', 'uploadedAt', 'loggedAt') || ((String(id).match(/(\d{13})/) || [])[1] ? new Date(Number(String(id).match(/(\d{13})/)[1])).toISOString() : ''),
    hasSlip: !!(x.shots && x.shots.length) || !!x.hasSlip, readBy: pick(x, 'readBy') || '',
    keepOut: !!pick(x, 'keepOutOfBalance', 'excludeFromBalance', 'keepOut'), isPrivate: !!x.private, live: !!x.live,
    units: pick(x, 'units') ?? '', matt: !!pick(x, 'matt', 'isMatt'), bonus: !!pick(x, 'bonus', 'bonusBet', 'isBonus', 'freeBet'), protected: !!pick(x, 'protected', 'earlyProtection', 'injuryProtection'),
    sgp: !!pick(x, 'sgp', 'isSgp'), origOdds: pick(x, 'origOdds', 'originalOdds') || '',
    boost: pick(x, 'boost', 'promo') || '', tag: pick(x, 'tag', 'tier') || '', game: pick(x, 'game', 'matchup') || '',
  }
}

async function docs(desk, collection) {
  const { data, error } = await supabase.from('docs').select('doc_id,data').eq('desk_id', desk).eq('collection', collection)
  if (error) throw error
  return data || []
}

// Try a dedicated table first (learning_log etc.), fall back to a docs collection.
async function tableOrDocs(table, desk) {
  const t = await supabase.from(table).select('*').limit(200)
  if (!t.error) return (t.data || []).filter((r) => !r.desk_id || !desk || r.desk_id === desk)
  return (await docs(desk, table)).map((r) => ({ id: r.doc_id, ...r.data }))
}

// ---------- auth / profile ----------
export async function getProfile() {
  if (DEMO_MODE) return null
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase.from('profiles').select('*').eq('user_id', user.id).maybeSingle()
  return data ? {
    id: user.id, email: user.email,
    name: data.display_name || data.name || user.email,
    desk: data.desk_id, deskName: data.desk_name || `${data.display_name || 'My'}'s Desk`,
    role: data.role || 'friend', label: data.label || data.display_name,
  } : { id: user.id, email: user.email, name: user.email, desk: null, role: 'friend' }
}

export async function listDesks() {
  if (DEMO_MODE) return DEMO_USERS.map((u) => ({ desk: u.desk, deskName: u.deskName }))
  const { data } = await supabase.from('profiles').select('desk_id,desk_name,display_name')
  const seen = new Map()
  ;(data || []).forEach((p) => { if (p.desk_id && !seen.has(p.desk_id)) seen.set(p.desk_id, { desk: p.desk_id, deskName: p.desk_name || `${p.display_name}'s Desk` }) })
  return [...seen.values()]
}

// Password sign-in (works inside the iPhone home-screen app, no email needed)
export const signInWithPassword = (email, password) =>
  supabase.auth.signInWithPassword({ email: email.trim(), password })
export const setMyPassword = (password) => supabase.auth.updateUser({ password })

// Sign in with the code from the email (works inside the iPhone home-screen app)
export const verifyLoginCode = (email, code) =>
  supabase.auth.verifyOtp({ email: email.trim(), token: String(code).replace(/\s/g, ''), type: 'email' })

export const sendLoginLink = (email) =>
  supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } })

// Settled bets must always carry the money they returned. Graders sometimes set only the status,
// so fill the payout from the slip: won = to-pay (or stake x odds), push/void = stake back, lost = 0.
const decOdds = (o) => { const v = parseInt(String(o || '').replace(/[^-\d]/g, ''), 10); return !v ? 0 : v > 0 ? 1 + v / 100 : 1 + 100 / Math.abs(v) }
export function mapBet(id, x = {}) {
  const b = mapBetRaw(id, x)
  if (b.status === 'won' && !(b.ret > 0)) b.ret = b.toPay > 0 ? b.toPay : (decOdds(b.odds) ? Math.round(b.stake * decOdds(b.odds) * 100) / 100 : b.ret)
  if (b.status === 'push' && !(b.ret > 0)) b.ret = b.stake
  if (b.status === 'lost') b.ret = 0
  // DraftKings bonus bet: the stake is DK's money, so it never comes out of the balance,
  // and a win pays only the winnings (no stake back). Lost = no change at all.
  if (b.bonus) {
    const bonusStake = b.stake, dec = decOdds(b.odds)
    b.bonusStake = bonusStake; b.stake = 0
    if (b.status === 'won') {
      const full = dec ? bonusStake * dec : 0
      // DK slips for bonus bets usually show the payout WITHOUT the stake; if the number includes it, take it out
      const fromSlip = b.toPay > 0 ? (full && Math.abs(b.toPay - full) < Math.abs(b.toPay - (full - bonusStake)) ? b.toPay - bonusStake : b.toPay) : 0
      b.ret = Math.round((dec ? bonusStake * (dec - 1) : fromSlip || Math.max(0, b.ret - bonusStake)) * 100) / 100
    } else if (b.status === 'cashout') b.ret = Math.max(0, b.ret)
    else b.ret = 0
  }
  return b
}

// ---------- desk data ----------
// Claude's picks = tickets Claude built. Leaves out uploaded slips and other people's plays (Seb, Gabe, Gavin, Matt, friends).
const NOT_CLAUDE = /^(seb|self|me|gabe|gavin|matt|steve|lela|uli|others?|manual|upload|slip)/i
function isClaudePick(r, answered = new Set()) {
  const x = r.data || {}
  // A ticket Claude built to answer a request is always a Claude pick
  const forced = answered.has(r.doc_id)
  if (!forced && ((x.shots && x.shots.length) || x.fromSlip || x.placedFromSlip || x.uploaded || x.fromSeb || x.fromShared)) return false
  // Who placed it: only the source/by fields (owner = whose desk it is, e.g. "steve" on Steve's desk, not who made it)
  const who = String(x.source || x.by || '')
  if (!forced && (NOT_CLAUDE.test(who) || /gabe|gavin|matt/i.test(String(x.label || '')))) return false
  // First Basket / First TD picks live in their own tabs, not here
  const kind = [x.market, x.betType, x.label, x.slot, x.type, x.builtWith, x.model, r.doc_id].join(' ')
  if (!forced && /first ?basket|fbm|first ?td|ftd/i.test(kind)) return false
  // Only current picks: from the last 3 days (by game date or when it was built). Older ones are stale.
  const s = String(x.date || x.gameDate || x.createdAt || '')
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T23:59:59' : s) || (String(r.doc_id).match(/(20\d{6})/) ? Date.parse(String(r.doc_id).match(/(20\d{6})/)[1].replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3T23:59:59')) : 0)
  if (t && Date.now() - t > 3 * 24 * 3600 * 1000) return false
  return true
}

export async function loadDesk(desk) {
  if (DEMO_MODE) return structuredClone(DEMO[desk] || DEMO.MAIN)
  const [pnl, parlays, cfg, pnlDocs, reqs] = await Promise.all([
    docs(desk, 'pnlEntries'), docs(desk, 'parlays').catch(() => []),
    docs(desk, 'taskConfig').catch(() => []), docs(desk, 'pnl').catch(() => []),
    docs(desk, 'requests').catch(() => []),
  ])
  // Only the app's Prime time form counts as prime (form/kind = 'prime'); regular requests always go to Claude's picks
  const isPrimeReq = (x) => x.form === 'prime' || x.kind === 'prime' || x.prime === true
  const reqTickets = (x) => [x.ticketId, x.answerTicketId, ...(Array.isArray(x.ticketIds) ? x.ticketIds : []), ...(Array.isArray(x.answerTicketIds) ? x.answerTicketIds : [])].filter(Boolean)
  // Prime time tickets stay under the Prime time tab only, never in Claude's picks
  const primeIds = new Set(reqs.flatMap((r) => isPrimeReq(r.data || {}) ? [...reqTickets(r.data || {}), r.doc_id, (r.data || {}).realRequestId].filter(Boolean) : []))
  const answered = new Set(reqs.flatMap((r) => isPrimeReq(r.data || {}) ? [] : reqTickets(r.data || {})))
  const ticketById = Object.fromEntries(parlays.map((r) => [r.doc_id, r.data || {}]))
  // Bets: entries of type "bet" (or no type). Legs/sport fall back to the linked ticket.
  // A row is cash (balance update / withdrawal / deposit) only if it says so; everything else is a bet,
  // whatever "type" the slip reader gave it (bet, parlay, sgp, slip...)
  const isCash = (r) => /^(adj|wd|dep)-/i.test(r.doc_id) || /adjust|balance|sync|withdraw|deposit|cash ?move/i.test(String(r.data?.type || ''))
  const betRows = pnl.filter((r) => !isCash(r))
  const bets = betRows.map((r) => {
    const t = ticketById[r.data?.ticketId] || {}
    // Dates and status always come from the bet itself, never from the linked ticket
    // (a slip can be linked to an older Claude ticket; its date must not leak onto the bet)
    const own = r.data || {}
    const merged = { ...t, ...own, placedAt: own.placedAt || own.createdAt || own.date || '', createdAt: own.createdAt || '',
      date: own.date || '', settledAt: own.settledAt || '', status: own.status || own.result || 'open', result: own.result || '',
      legs: (own.legs && own.legs.length) ? own.legs : t.legs,
      sport: r.data?.sport || r.data?.league || t.league || t.sport, title: r.data?.desc || t.game || t.label || r.data?.title }
    const b = mapBet(r.doc_id, merged)
    if (r.data?.units !== undefined) b.tag = b.tag || String(r.data.units)
    return b
  })
  const picks = parlays
    .filter((r) => !r.data?.private && !primeIds.has(r.doc_id) && !primeIds.has(r.data?.requestId) && !primeIds.has(r.data?.realRequestId) && !r.data?.prime && isClaudePick(r, answered))
    .sort((a, b) => whenMs(b.data || {}, b.doc_id) - whenMs(a.data || {}, a.doc_id))
    .slice(0, 20).map((r) => {
      const b = mapBet(r.doc_id, { ...r.data, sport: r.data?.league || r.data?.sport, title: r.data?.label || r.data?.game })
      return { id: b.id, sport: b.sport, title: withLegs(b.title, b.legs.length), legs: b.legs.map((l) => l.text), odds: b.odds,
        createdAt: pick(r.data, 'createdAt', 'builtAt') || '', confidence: n(pick(r.data, 'confidence', 'conf')), model: pick(r.data, 'builtWith', 'model', 'modelVersion') || '', sources: pick(r.data, 'sources') || [] }
    })
  // Settings can live in a few places (pnl/settings, taskConfig, ...): look for any "settings" doc too
  const extraSettings = await supabase.from('docs').select('collection,doc_id,data').eq('desk_id', desk)
    .in('doc_id', ['settings', 'pnlSettings', 'pnl-settings', 'bankroll']).then((r) => r.data || []).catch(() => [])
  const settingsDoc = (pnlDocs.find((r) => r.doc_id === 'settings') || {}).data || {}
  const settings = Object.assign({}, ...cfg.map((r) => r.data || {}), ...extraSettings.map((r) => r.data || {}), settingsDoc)
  const start = n(pick(settings, 'start', 'startBalance', 'startingBalance', 'starting', 'startAmount', 'startingBankroll', 'bankroll', 'initialBalance'))
  // Cash moves (withdrawals/deposits) that aren't bets
  const ts = (v) => { if (!v) return 0; const str = String(v); const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(str) ? str + 'T23:59:59' : str); return isNaN(t) ? 0 : t }
  const isAdj = (r) => /^adj-/i.test(r.doc_id) || /adjust|balance|sync/i.test(String(r.data?.type || ''))
  const cashRows = pnl.filter(isCash).map((r) => ({
    id: r.doc_id, type: isAdj(r) ? 'adjust' : (/withdraw/i.test(r.data?.type) || /^wd-/i.test(r.doc_id)) ? 'withdrawal' : (/deposit/i.test(r.data?.type) || /^dep-/i.test(r.doc_id)) ? 'deposit' : 'other',
    amount: Math.abs(n(pick(r.data, 'amount', 'value', 'stake'))), date: pick(r.data, 'date', 'createdAt', 'settledAt') || '', exact: ts(r.data?.createdAt),
    note: pick(r.data, 'note', 'desc', 'label') || '' }))
  const withdrawals = cashRows.filter((c) => c.type === 'withdrawal').sort((x, y) => String(y.date).localeCompare(String(x.date)))
  const withdrawn = withdrawals.reduce((t, c) => t + c.amount, 0)
  const deposited = cashRows.filter((c) => c.type === 'deposit').reduce((t, c) => t + c.amount, 0)
  const settled = bets.filter((b) => ['won', 'lost', 'push', 'cashout'].includes(b.status))
  const pnlAll = settled.reduce((t, b) => t + (b.status === 'push' ? 0 : b.ret - b.stake), 0)
  // Balance anchor: the latest "Balance update: set to $X" entry (how the desk pins its balance to DraftKings).
  // Balance = X + what happened after it: payouts of bets that were open at the anchor, full result of bets placed
  // after it (open ones count as money already out), minus withdrawals / plus deposits after it.
  const adjRows = pnl.filter(isAdj).map((r) => {
    const x = r.data || {}
    let val = n(pick(x, 'setTo', 'balance', 'newBalance', 'target', 'value'))
    if (!val) { const m = String(x.desc || x.note || '').match(/set to \$?([\d,]+(?:\.\d+)?)/i); if (m) val = Number(m[1].replace(/,/g, '')) }
    const exact = ts(x.createdAt || x.updatedAt)
    const day = String(x.date || (r.doc_id.match(/(\d{8})/)?.[1] || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))
    const dayStart = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day + 'T00:00:00') : 0
    // t = when new bets start counting; tSettle = from when payouts of earlier bets count (start of that day if no exact time)
    return { val, day, t: exact || ts(day), tSettle: exact || dayStart }
  }).filter((a) => a.val && a.t).sort((a, b) => b.t - a.t)
  const anchor = adjRows[0]
  let anchored = 0
  if (anchor) {
    anchored = anchor.val
    bets.forEach((b) => {
      const placed = ts(b.placedAt), settledT = ts(b.settledAt)
      const done = ['won', 'lost', 'push', 'cashout'].includes(b.status)
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(b.placedAt || ''))
      // Date-only bets: a later day is new; the SAME day as the balance update is new only if it was logged after the update
      const sameDay = dateOnly && String(b.placedAt) === String(anchor.day).slice(0, 10)
      const logged = Date.parse(b.loggedAt || '') || 0
      const isNew = placed && (dateOnly ? (String(b.placedAt) > String(anchor.day).slice(0, 10) || (sameDay && logged > anchor.t)) : placed > anchor.t)
      b.afterAnchor = !!isNew
      if (isNew) { anchored += done ? (b.ret - b.stake) : -b.stake }
      else if (done && settledT >= anchor.tSettle) {
        // A bet placed before the balance update only adds its payout if its GAME ended after the update.
        // If the game was already over, DraftKings had already paid it — it's inside the balance you typed in.
        // (Late grading on our side must not count that money twice.)
        const gs = String(b.gameEnd || '')
        const gameOver = /^\d{4}-\d{2}-\d{2}$/.test(gs) ? Date.parse(gs + 'T23:59:59') : (Date.parse(gs) ? Date.parse(gs) + 4 * 3600 * 1000 : 0)
        if (!(gameOver && gameOver < anchor.t)) anchored += b.ret
      }
    })
    cashRows.forEach((c) => {
      // Cash moves with only a date: count them only if they're on a LATER day than the balance update
      // (same-day withdrawals are already inside the DraftKings balance the update was set to).
      const after = c.exact ? c.exact > anchor.t : (String(c.date).slice(0, 10) > String(anchor.day).slice(0, 10))
      if (after && c.type !== 'adjust') anchored += c.type === 'withdrawal' ? -c.amount : c.type === 'deposit' ? c.amount : 0
    })
    anchored = Math.round(anchored * 100) / 100
  }
  const synced = anchored || n(pick(settings, 'balance', 'dkBalance', 'syncedBalance'))
  return {
    balance: synced || (start + deposited - withdrawn + pnlAll), synced, startBalance: start, startDate: pick(settings, 'date', 'startDate') || '',
    pnlAll, withdrawals, withdrawn, deposited, deskKey: desk, anchorDate: anchor ? new Date(anchor.t).toISOString() : '',
    goal: n(pick(settings, 'goal', 'goalAmount', 'target')) || 10000, goalDate: pick(settings, 'goalDate', 'goalBy', 'targetDate') || '',
    bets, picks,
  }
}

// Requests, First TD queue and First Basket (FBM) picks. Collection names vary, so try several.
async function firstNonEmpty(desk, names) {
  for (const c of names) {
    const rows = await docs(desk, c).catch(() => [])
    if (rows.length) return rows.map((r) => ({ id: r.doc_id, ...(r.data || {}) }))
  }
  return []
}
function mapCandidate(x) {
  return {
    id: x.id, player: pick(x, 'player', 'name', 'scorer', 'pick', 'label') || '', team: pick(x, 'team', 'teamAbbr') || '',
    game: pick(x, 'game', 'matchup', 'event') || '', odds: pick(x, 'odds', 'price', 'dkOdds') || '',
    share: n(pick(x, 'share', 'modelShare', 'prob', 'probability', 'modelProb')), tier: pick(x, 'tier', 'bucket') || '',
    date: pick(x, 'date', 'gameDate', 'createdAt') || '', status: String(pick(x, 'status', 'result') || 'open').toLowerCase(),
    reason: pick(x, 'reason', 'why', 'note', 'notes', 'analysis') || '',
  }
}
export async function loadPicksExtra(desk) {
  if (DEMO_MODE) return DEMO_PICKS_EXTRA
  const [reqs, ftdRaw, fbmRaw, parlays, ftdHist, fbmHist, archive] = await Promise.all([
    docs(desk, 'requests').catch(() => []),
    firstNonEmpty(desk, ['ftd', 'ftdQueue', 'firstTd', 'firstTD', 'ftdCandidates', 'firstTdQueue']),
    firstNonEmpty(desk, ['fbm', 'fbmPicks', 'fbmQueue', 'firstBasket', 'fbmCandidates']),
    docs(desk, 'parlays').catch(() => []),
    docs(desk, 'ftdHistory').catch(() => []),
    docs(desk, 'fbmHistory').catch(() => []),
    docs(desk, 'parlaysArchive').catch(() => []),
  ])
  const tickets = parlays.map((r) => ({ id: r.doc_id, ...(r.data || {}) }))
  const txt = (t) => [t.market, t.betType, t.label, t.slot, t.type, t.builtWith].join(' ')
  const isFtd = (t) => /first ?td|ftd/i.test(txt(t))
  const isFbm = (t) => /first ?basket|fbm/i.test(txt(t))
  const flatten = (list) => list.flatMap((t) => (Array.isArray(t.legs) ? t.legs.map((l, i) => ({
    id: `${t.id}-${i}`, player: typeof l === 'string' ? l : (l.text || l.label || l.player || ''), team: '', game: t.game || '',
    odds: (typeof l === 'object' && (l.odds || l.price)) || '', share: 0, tier: t.tier || '',
    date: t.date || t.createdAt || '', status: String((typeof l === 'object' && l.status) || t.status || 'open').toLowerCase(), reason: '' })) : []))
  const ftd = ftdRaw.length ? ftdRaw.map(mapCandidate) : flatten(tickets.filter(isFtd))
  const fbm = fbmRaw.length ? fbmRaw.map(mapCandidate) : flatten(tickets.filter(isFbm))
  // Full graded history for the record cards — every pick the model gave, bet or not
  const archived = archive.map((r) => ({ id: r.doc_id, ...(r.data || {}) }))
  const hist = (current, histRows, test) => {
    const all = [...current, ...histRows.map((r) => mapCandidate({ id: r.doc_id, ...(r.data || {}) })),
      ...flatten(tickets.filter(test)), ...flatten(archived.filter(test))]
    const seen = new Set()
    return all.map((c) => ({ ...c, result: /^(won|win|hit)$/.test(c.status) ? 'won' : /^(lost|loss|miss)$/.test(c.status) ? 'lost' : '' }))
      .filter((c) => { if (!c.result) return false; const k = `${String(c.player).toLowerCase().replace(/[^a-z]/g, '').slice(0, 24)}|${String(c.date).slice(0, 10)}`; if (seen.has(k)) return false; seen.add(k); return true })
  }
  const ftdRecord = hist(ftd, ftdHist, isFtd)
  const fbmRecord = hist(fbm, fbmHist, isFbm)
  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]))
  const requests = reqs.map((r) => {
    const x = r.data || {}
    // All tickets that answer this request (prime time = Safer / Main / Bigger), not just the first
    const ids = [x.ticketId, x.answerTicketId, ...(Array.isArray(x.ticketIds) ? x.ticketIds : []), ...(Array.isArray(x.answerTicketIds) ? x.answerTicketIds : [])].filter(Boolean)
    const linked = tickets.filter((tk) => [tk.requestId, tk.realRequestId, tk.answersRequest].some((v) => v && (v === r.doc_id || v === x.realRequestId)))
    const all = [...ids.map((id) => byId[id]).filter(Boolean), ...linked].filter((tk, i, a) => a.findIndex((o) => o.id === tk.id) === i)
    const mapT = (t) => ({ id: t.id, title: withLegs(t.label || t.game || 'Ticket', (t.legs || []).length), odds: t.odds || '', legs: (t.legs || []).map((l) => (typeof l === 'string' ? l : l.text || l.label || '')) })
    const t = all[0] || null
    return { id: r.doc_id, date: x.date || x.createdAt || '', createdAt: x.createdAt || '', answeredAt: x.answeredAt || x.answered_at || '', league: x.league || '', slot: x.slot || '', game: x.game || '', risk: x.risk || x.units || '',
      status: x.status || (t ? 'answered' : 'working'), question: x.question || x.note || x.other || '',
      prime: x.form === 'prime' || x.kind === 'prime' || x.prime === true,
      ticket: t ? mapT(t) : null, tickets: all.map(mapT), answer: x.answer || x.reason || '' }
  }).sort(newestFirst)
  return { requests, ftd, fbm, ftdRecord, fbmRecord }
}

export async function loadLive() {
  if (DEMO_MODE) return DEMO_LIVE
  const rows = await docs('shared', 'liveScores').catch(() => [])
  const all = rows.length ? rows : await supabase.from('docs').select('doc_id,data').eq('collection', 'liveScores').then((r) => r.data || [])
  const games = []
  all.forEach((r) => {
    const list = Array.isArray(r.data?.games) ? r.data.games : [r.data]
    list.forEach((g, i) => g && games.push({
      id: `${r.doc_id}-${i}`, sport: (g.sport || g.league || '').toUpperCase(),
      away: g.away || g.awayTeam || g.awayAbbr || '?', home: g.home || g.homeTeam || g.homeAbbr || '?',
      awayScore: n(g.awayScore), homeScore: n(g.homeScore),
      status: g.status || g.detail || g.clock || '', live: !!(g.live || g.inProgress || g.state === 'in'),
    }))
  })
  return games
}

export async function loadBrain(desk) {
  if (DEMO_MODE) return DEMO_BRAIN
  const [learning, versions] = await Promise.all([tableOrDocs('learning_log', desk), tableOrDocs('model_versions', desk)])
  return {
    models: [],
    learning: learning.map((x) => ({ date: x.created_at || x.date, task: x.task, text: x.text || x.lesson || x.summary, source: x.source || x.data_used })),
    versions: versions.map((x) => ({ date: x.created_at || x.date, model: x.model || x.spec, from: x.from_version || x.from, to: x.to_version || x.version, change: x.change || x.what_changed, status: x.status || '' })),
  }
}

export async function loadUsage() {
  if (DEMO_MODE) return DEMO_USAGE
  const { data, error } = await supabase.from('usage_log').select('*').order('date', { ascending: true }).limit(14)
  if (error) return []
  return (data || []).map((r) => ({ date: r.date, runs: n(r.total_runs ?? r.runs), pct: r.usage_pct ?? r.pct }))
}

// ---------- app writes (Session B contract) ----------
// The app only INSERTS into docs (requests / appUploads / appEdits) and uploads slip images to the private
// "slips" bucket. The Post-Cutover Sync (Phase 0) copies them into the real desk; results sync back to the app.
const nowIso = () => new Date().toISOString()
const who = (profile) => profile?.label || profile?.name || profile?.email || 'app'

async function insertDoc(desk, collection, docId, data) {
  const { error } = await supabase.from('docs').insert({ desk_id: desk, collection, doc_id: docId, data })
  if (error) throw new Error(error.message)
  return { ok: true, id: docId }
}

// Matt's money: a simple manual ledger (latest entry wins). App-only, never touches Seb's balance/PNL, no Claude.
export async function loadMatt(desk) {
  if (DEMO_MODE) return null
  const { data } = await supabase.from('docs').select('doc_id,data').eq('desk_id', desk).eq('collection', 'mattLedger')
  const rows = (data || []).map((r) => ({ id: r.doc_id, ...(r.data || {}) })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return rows[0] || null
}
export async function saveMatt(desk, profile, amount, note) {
  if (DEMO_MODE) return { ok: true, demo: true }
  return insertDoc(desk, 'mattLedger', `ml-${Date.now()}`, { amount, note: note || '', by: who(profile), createdAt: nowIso() })
}

export async function submitRequest(desk, profile, form, kind = 'pick') {
  const doc = { status: 'queued', source: 'app', requested_by: who(profile), form: kind, ...form, createdAt: nowIso() }
  if (DEMO_MODE) return { ok: true, demo: true, doc }
  return insertDoc(desk, 'requests', `req-${Date.now()}`, doc)
}

export async function uploadSlips(desk, profile, files, meta) {
  if (DEMO_MODE) return { ok: true, demo: true }
  const docId = `up-${Date.now()}`
  const paths = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const ext = ((f.name || '').split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    const path = `${desk}/${docId}-${i + 1}.${ext}`
    const { error } = await supabase.storage.from('slips').upload(path, f, { contentType: f.type || 'image/jpeg', upsert: false })
    if (error) throw new Error(`Upload failed: ${error.message}`)
    paths.push(path)
  }
  return insertDoc(desk, 'appUploads', docId, { status: 'pending', source: 'app', files: paths, ...meta, uploadedBy: who(profile), createdAt: nowIso() })
}

export async function submitEdit(desk, profile, target, action, value = null) {
  if (DEMO_MODE) return { ok: true, demo: true }
  return insertDoc(desk, 'appEdits', `ed-${Date.now()}`, { status: 'pending', source: 'app', target, action, value, by: who(profile), createdAt: nowIso() })
}

// Pending app actions (so the app can show "waiting for sync")
// Team trackers are shared (one set for everyone), stored on desk 'main' and refreshed nightly by the engine
export async function loadTeams(collection) {
  if (DEMO_MODE) return []
  const { data, error } = await supabase.from('docs').select('doc_id,data').eq('desk_id', 'main').eq('collection', collection)
  if (error) throw error
  return (data || []).map((r) => ({ id: r.doc_id, ...(r.data || {}) }))
}

export async function loadPendingApp(desk) {
  if (DEMO_MODE) return { requests: [], uploads: [], edits: [] }
  const [reqs, ups, eds] = await Promise.all([docs(desk, 'requests').catch(() => []), docs(desk, 'appUploads').catch(() => []), docs(desk, 'appEdits').catch(() => [])])
  const pend = (rows) => rows.map((r) => ({ id: r.doc_id, ...(r.data || {}) }))
  return {
    requests: pend(reqs).filter((x) => x.source === 'app' && ['queued'].includes(x.status)),
    uploads: pend(ups).sort(newestFirst),
    edits: pend(eds).filter((x) => x.status === 'pending'),
  }
}

// ---------- stats ----------
function isRecent(b) {
  // Anything placed after the last "match DraftKings" balance update is real money in play, however old the game date
  // (except bets stuck in "needs review" — those only count while their own date is recent)
  if (b.afterAnchor && !b.review) return true
  const s = String(b.placedAt || b.loggedAt || '')
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s) || Date.parse(b.loggedAt || '') || 0
  return !t || Date.now() - t < 3 * 24 * 3600 * 1000
}

export function stats(bets) {
  const settled = bets.filter((b) => ['won', 'lost', 'push', 'cashout'].includes(b.status))
  const won = settled.filter((b) => b.status === 'won' || (b.status === 'cashout' && b.ret > b.stake)).length
  const push = settled.filter((b) => b.status === 'push').length
  const lost = settled.length - won - push
  const profit = (b) => (b.status === 'push' ? 0 : b.ret - b.stake)
  const bySource = {}
  settled.forEach((b) => { const k = b.matt ? 'matt' : (b.source || 'other'); bySource[k] = bySource[k] || { pnl: 0, n: 0, w: 0, l: 0 }; bySource[k].pnl += profit(b); bySource[k].n++; if (b.status === 'won') bySource[k].w++; else if (b.status === 'lost') bySource[k].l++ })
  const legs = settled.flatMap((b) => b.legs).filter((l) => ['won', 'lost'].includes(l.status))
  const legsWon = legs.filter((l) => l.status === 'won').length
  const lostByOne = settled.filter((b) => b.status === 'lost' && b.legs.length > 1 && b.legs.filter((l) => l.status === 'lost').length === 1)
  // Best leg type = highest hit rate among types with at least 10 graded legs
  const byType = {}
  legs.forEach((l) => { const k = legType(l.text); byType[k] = byType[k] || { w: 0, n: 0 }; byType[k].n++; if (l.status === 'won') byType[k].w++ })
  const ranked = Object.entries(byType).filter(([k, v]) => k !== 'Other' && v.n >= 10).sort((a, b) => b[1].w / b[1].n - a[1].w / a[1].n)
  const bestLeg = ranked.length ? { type: ranked[0][0], w: ranked[0][1].w, n: ranked[0][1].n } : null
  return { settled: settled.length, won, lost, push, pnl: settled.reduce((s, b) => s + profit(b), 0), bySource,
    legsWon, legsTotal: legs.length, lostByOne, bestLeg, byType,
    // Live = real money still riding: unsettled, has a wager, placed in the last 3 days.
    // Older unsettled bets are almost always ones that never got graded; they go in "stale" instead of inflating Live.
    open: bets.filter((b) => b.status === 'open' && (b.stake > 0 || b.bonus) && isRecent(b)),
    stale: bets.filter((b) => b.status === 'open' && (b.stake > 0 || b.bonus) && !isRecent(b)) }
}
