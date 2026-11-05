import React, { useEffect, useMemo, useState } from 'react'
import { DEMO_MODE, supabase, getProfile, listDesks, sendLoginLink, verifyLoginCode, signInWithPassword, setMyPassword, loadDesk, loadPicksExtra, loadLive, loadBrain, loadUsage, submitRequest, uploadSlips, submitEdit, loadPendingApp, loadTeams, loadMatt, saveMatt, stats, whenMs, newestFirst } from './data.js'
import { DEMO_USERS } from './demo.js'

const SPORTS = ['ALL', 'NFL', 'NBA', 'NHL', 'CFB', 'CBB', 'MLB', 'SOC']
const money = (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0)
const SRC = { claude: "Claude's picks", seb: "Seb's bets", gavin: "Gavin's plays", matt: "Matt's bets", steve: "Steve's bets", lela: "Lela's bets", uli: "Uli's bets", gabe: "Gabe's bets", ftd: 'First TD options', fbm: 'First Basket', others: 'Others', other: 'Others', self: 'My bets', app: 'My bets' }
const ago = (iso) => { if (!iso) return ''; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T12:00:00' : iso); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
// Date + time in Eastern, e.g. "Oct 28 · 5:03 PM ET". Date-only values just show the date.
const stamp = (iso) => { if (!iso) return ''; const s = String(iso); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ago(s); const d = new Date(s); if (isNaN(d)) return s
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET` }

export default function App() {
  const preset = DEMO_MODE ? (new URLSearchParams(window.location.search).get('as') || window.__PREVIEW_AS) : null
  const [profile, setProfile] = useState(preset ? DEMO_USERS.find((u) => u.id === preset) || null : null)
  const [ready, setReady] = useState(DEMO_MODE)

  useEffect(() => {
    if (DEMO_MODE) return
    getProfile().then((p) => { setProfile(p); setReady(true) })
    const { data } = supabase.auth.onAuthStateChange(() => getProfile().then(setProfile))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!ready) return <div className="center muted">Loading…</div>
  if (!profile) return <Login onDemoPick={setProfile} />
  if (!profile.desk) return <div className="center"><p>Your login works, but no desk is linked to it yet.</p><p className="muted">Ask Seb to link your account.</p></div>
  return <Desk profile={profile} onSignOut={async () => { if (!DEMO_MODE) await supabase.auth.signOut(); setProfile(null) }} />
}

function Login({ onDemoPick }) {
  const saved = (() => { try { return localStorage.getItem('pd-email') || '' } catch { return '' } })()
  const [email, setEmail] = useState(saved); const [pw, setPw] = useState('')
  const [mode, setMode] = useState('password'); const [sent, setSent] = useState(false)
  const [code, setCode] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  const remember = () => { try { localStorage.setItem('pd-email', email.trim()) } catch {} }
  const doPassword = async () => {
    setErr(''); setBusy(true); remember()
    const { error } = await signInWithPassword(email, pw); setBusy(false)
    if (error) setErr(error.message === 'Invalid login credentials' ? 'Wrong email or password. First time? Use "Email me a link" on your PC, then set a password in More.' : error.message)
  }
  const doSend = async () => {
    setErr(''); setBusy(true); remember()
    const { error } = await sendLoginLink(email.trim()); setBusy(false)
    error ? setErr(error.message) : setSent(true)
  }
  const doCode = async () => {
    setErr(''); setBusy(true)
    const { error } = await verifyLoginCode(email, code); setBusy(false)
    if (error) setErr(error.message)
  }
  return (
    <div className="login">
      <Banner title="PARLAY DESK" />
      <div className="login-card">
        <h1 className="h-italic">Sign in</h1>
        {DEMO_MODE ? (<>
          <p className="muted">Demo mode: sample data only. Pick who you are:</p>
          {DEMO_USERS.map((u) => <button key={u.id} className="btn big" onClick={() => onDemoPick(u)}>{u.name} <span className="muted">· {u.deskName}</span></button>)}
        </>) : mode === 'password' ? (<>
          <input className="input" type="email" autoComplete="username" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" type="password" autoComplete="current-password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doPassword()} />
          <button className="btn big" disabled={busy || !email || !pw} onClick={doPassword}>{busy ? 'Signing in…' : 'Sign in'}</button>
          {err && <p className="neg">{err}</p>}
          <button className="btn" onClick={() => { setMode('email'); setErr('') }}>No password yet? Email me a link</button>
          <p className="muted small">You stay signed in on this device.</p>
        </>) : sent ? (<>
          <p>We emailed <b>{email}</b>.</p>
          <p className="muted">Open the link on this device (best on your PC). Then go to <b>More → Set password</b> so you can sign in with a password on your phone.</p>
          <input className="input" inputMode="numeric" autoComplete="one-time-code" placeholder="Code (only if the email shows one)" value={code} onChange={(e) => setCode(e.target.value)} />
          {code && <button className="btn big" disabled={busy} onClick={doCode}>{busy ? 'Checking…' : 'Sign in with code'}</button>}
          <button className="btn" onClick={() => { setMode('password'); setSent(false); setCode('') }}>Back to password sign-in</button>
          {err && <p className="neg">{err}</p>}
        </>) : (<>
          <input className="input" type="email" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn big" disabled={busy || !email} onClick={doSend}>{busy ? 'Sending…' : 'Email me a link'}</button>
          <button className="btn" onClick={() => setMode('password')}>Back to password sign-in</button>
          {err && <p className="neg">{err}</p>}
        </>)}
      </div>
    </div>
  )
}

function Banner({ title, right }) {
  return <div className="banner"><div className="banner-top">{right}</div><div className="banner-title">★ {title}</div><div className="banner-stripe"><i /><b /></div></div>
}

function TitleRow({ title, d, name }) {
  // Same open-bet rule as the Live tab (unsettled, has a wager, last 3 days), across all sports
  const inPlay = d ? stats(d.bets || []).open.reduce((t, b) => t + b.stake, 0) : 0
  return (<div className="titlerow"><h1 className="h-title">{title}</h1>
    {d && <div className="bal"><div className="bal-v">{money(d.balance)} +</div><div className="bal-s">{money(inPlay)} in play</div></div>}
    <div className="avatar">{(name || '?')[0].toUpperCase()}<i /></div></div>)
}

function Desk({ profile, onSignOut }) {
  const isAdmin = profile.role === 'admin'
  const [desk, setDesk] = useState(profile.desk)
  const [desks, setDesks] = useState([])
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') || window.__PREVIEW_TAB || 'home')
  const [sport, setSport] = useState('ALL')
  const [data, setData] = useState(null)
  const [live, setLive] = useState([])
  const [err, setErr] = useState('')

  useEffect(() => { if (isAdmin) listDesks().then(setDesks) }, [isAdmin])
  useEffect(() => { setData(null); loadDesk(desk).then(setData).catch((e) => setErr(e.message)) }, [desk])
  // Keep the desk fresh: quiet reload every 60s and whenever the app comes back to the front (new slips, settled bets)
  useEffect(() => {
    const f = () => { if (document.visibilityState === 'visible') loadDesk(desk).then(setData).catch(() => {}) }
    const t = setInterval(f, 60000); document.addEventListener('visibilitychange', f)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', f) }
  }, [desk])
  useEffect(() => { const f = () => loadLive().then(setLive).catch(() => {}); f(); const t = setInterval(f, 60000); return () => clearInterval(t) }, [])

  const deskName = (desks.find((d) => d.desk === desk) || {}).deskName || (desk === profile.desk ? profile.deskName : desk)
  const bets = useMemo(() => (data?.bets || []).filter((b) => sport === 'ALL' || b.sport === sport || (sport === 'MLB' && b.sport.startsWith('MLB'))), [data, sport])
  const s = useMemo(() => stats(bets), [bets])

  return (
    <div className="app">
      <Banner title={(deskName || 'My Desk').toUpperCase()} right={isAdmin && desks.length > 1 ? (
        <select className="desk-switch" value={desk} onChange={(e) => setDesk(e.target.value)}>{desks.map((d) => <option key={d.desk} value={d.desk}>{d.deskName}</option>)}</select>) : null} />
      {DEMO_MODE && <div className="demo-bar">DEMO · sample data only · nothing here is real</div>}
      <TitleRow title={{ home: 'Home', live: 'Live', activity: 'My Activity', picks: 'Picks', more: 'More' }[tab]} d={data} name={profile.name} />
      {!['more', 'activity', 'picks'].includes(tab) && <div className="chips">{SPORTS.map((x) => { const c = (data?.bets || []).filter((b) => x === 'ALL' || b.sport === x).length
        return <button key={x} className={`chip ${sport === x ? 'on' : ''} ${x === 'ALL' ? 'all' : ''}`} onClick={() => setSport(x)}><span className="chip-box">{x === 'SOC' ? 'FUT' : x}{c > 0 && <b className="badge">{c}</b>}</span><span className="chip-l">{x === 'ALL' ? 'All' : x === 'SOC' ? 'Soccer' : x}</span></button> })}</div>}
      <main className="content">
        {err && <p className="neg">{err}</p>}
        {!data ? <p className="muted">Loading desk…</p> : (
          tab === 'home' ? <Home d={data} s={s} sport={sport} desk={desk} profile={profile} canEdit={desk === profile.desk} /> :
          tab === 'live' ? <Live open={s.open} stale={s.stale} desk={desk} stamp={data} /> :
          tab === 'activity' ? <Activity bets={bets} isAdmin={isAdmin && desk === profile.desk} name={profile.name} desk={desk} profile={profile} canEdit={desk === profile.desk} /> :
          tab === 'picks' ? <Picks d={data} desk={desk} profile={profile} canEdit={desk === profile.desk} /> :
          <More profile={profile} desk={desk} isAdmin={isAdmin} onSignOut={onSignOut} />
        )}
      </main>
      <nav className="nav">
        {[['home', '⌂', 'Home'], ['live', '◉', 'Live'], ['activity', '▤', 'My Activity'], ['picks', '★', 'Picks'], ['more', '≡', 'More']].map(([k, i, l]) => (
          <button key={k} className={`nav-btn ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            <span className="nav-ico">{i}{k === 'live' && live.filter((g) => g.live).length > 0 && <b className="badge">{live.filter((g) => g.live).length}</b>}</span>{l}
          </button>))}
      </nav>
    </div>
  )
}

function Home({ d, s, sport, desk, profile, canEdit }) {
  const [wdAmt, setWdAmt] = useState(''); const [wdDate, setWdDate] = useState(() => new Date().toISOString().slice(0, 10)); const [wdMsg, setWdMsg] = useState('')
  const [view, setView] = useState('pnl')
  const [showWd, setShowWd] = useState(false)
  const [showMatt, setShowMatt] = useState(false)
  const [matt, setMatt] = useState(null); const [mattAmt, setMattAmt] = useState(''); const [mattNote, setMattNote] = useState(''); const [mattMsg, setMattMsg] = useState('')
  useEffect(() => { loadMatt(desk).then(setMatt).catch(() => {}) }, [desk])
  // Matt's bets = ticked "This is a Matt bet" on upload (or source matt)
  const mattBets = d.bets.filter((b) => b.matt || b.source === 'matt').sort(newestFirst)
  const [balAmt, setBalAmt] = useState(''); const [balMsg, setBalMsg] = useState('')
  const key = 'pd-start-' + (d.deskKey || 'me')
  const [startOverride, setStartOverride] = useState(() => { try { return Number(localStorage.getItem(key)) || 0 } catch { return 0 } })
  const start = d.startBalance || (d.synced ? 0 : startOverride)
  // Balance = start + deposits - withdrawals + all-time P&L (unless the desk has a synced DraftKings balance)
  const balance = d.synced || (start + (d.deposited || 0) - (d.withdrawn || 0) + (d.pnlAll ?? s.pnl))
  const toGoal = Math.max(0, d.goal - balance)
  const editStart = () => { const v = window.prompt('Starting balance (what you started the desk with):', start || ''); if (v === null) return; const num = Number(String(v).replace(/[$,]/g, '')); if (!isNaN(num)) { setStartOverride(num); try { localStorage.setItem(key, String(num)) } catch {} } }
  const claude = s.bySource.claude || { w: 0, l: 0 }
  const label = sport === 'ALL' ? '' : (sport === 'SOC' ? 'SOCCER ' : sport + ' ')
  const parlays = d.bets.filter((b) => b.legs.length > 1 && ['won', 'lost'].includes(b.status))
  return (<>
    <div className="hero">
      <div className="hero-cell"><div className="hk">CLAUDE'S {label}PICKS</div><div className="hv">{claude.w}-{claude.l}</div><div className="hs">main picks + every pick you bet</div></div>
      <div className="hero-cell"><div className="hk">PLAYS THAT HIT</div><div className="hv">{pct(s.won, s.won + s.lost)}%</div><div className="hs">{s.won} of {s.won + s.lost} settled plays</div></div>
      <div className="hero-cell"><div className="hk">LOST BY ONE LEG</div><div className="hv">{s.lostByOne.length}</div><div className="hs">near misses</div></div>
      <div className="hero-cell"><div className="hk">LEGS HIT</div><div className="hv">{pct(s.legsWon, s.legsTotal)}%</div><div className="hs">{s.legsWon} of {s.legsTotal} graded legs</div></div>
      <div className="hero-cell"><div className="hk">BEST LEG TYPE</div><div className="hv sm">{s.bestLeg ? s.bestLeg.type : '—'}</div><div className="hs">{s.bestLeg ? `${pct(s.bestLeg.w, s.bestLeg.n)}% · ${s.bestLeg.w} of ${s.bestLeg.n} legs` : 'needs 10+ graded legs'}</div></div>
      <div className="hero-cell"><div className="hk">PARLAYS HIT</div><div className="hv">{pct(parlays.filter((b) => b.status === 'won').length, parlays.length)}%</div><div className="hs">{parlays.filter((b) => b.status === 'won').length} of {parlays.length} parlays cashed</div></div>
    </div>
    <div className="toggle">{['pnl', 'feed'].map((v) => <button key={v} className={`tog ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{v === 'pnl' ? 'PNL' : 'Feed'}</button>)}</div>
    {view === 'pnl' ? (<>
      <div className="label">DRAFTKINGS PROFIT AND LOSS</div>
      <div className="h-sec">PNL</div>
      {start > 0 && <div className="muted small">Started with {money(start)}{d.startDate ? ` on ${ago(d.startDate)}` : ''}</div>}
      <div className="grid">
        <Card k="DraftKings balance" v={money(balance)} neg={balance < 0} sub={d.synced ? `matched to DraftKings${d.anchorDate ? ` ${ago(d.anchorDate)}` : ''} + results since` : 'start + results − withdrawals'} />
        <Card k={`Goal ${money(d.goal)}`} v={`${pct(balance, d.goal)}%`} sub={`${money(toGoal)} to go${d.goalDate ? ` by ${ago(d.goalDate)}` : ''}`} bar={pct(balance, d.goal)} />
        <Card k="Net profit / loss" v={money(s.pnl)} neg={s.pnl < 0} pos={s.pnl > 0} sub={`settled bets`} />
        <button className="card wd-card" onClick={() => setShowWd(!showWd)}>
          <div className="card-k">Withdrawals</div>
          <div className="card-v pos">{money(d.withdrawn || 0)}</div>
          <div className="card-sub">{(d.withdrawals || []).length} withdrawal{(d.withdrawals || []).length === 1 ? '' : 's'} · tap to {showWd ? 'hide' : 'see'}</div>
        </button>
        <Card k="In play" v={money(s.open.reduce((t, b) => t + b.stake, 0))} sub={`${s.open.length} open bets`} />
        <Card k="Bets settled" v={`${s.won}-${s.lost}-${s.push}`} sub="all-time" />
        {Object.entries(s.bySource).filter(([k]) => k !== 'matt').map(([k, v]) => <Card key={k} k={`From ${SRC[k] || k}`} v={`${v.pnl >= 0 ? '+' : ''}${money(v.pnl)}`} neg={v.pnl < 0} pos={v.pnl > 0} sub={`${v.n} settled · all-time ${v.w}-${v.l}`} />)}
        {(mattBets.length > 0 || matt) && (() => { const v = s.bySource.matt || { pnl: 0, n: 0, w: 0, l: 0 }; const openN = mattBets.filter((b) => b.status === 'open').length
          return <button className="card wd-card" onClick={() => setShowMatt(!showMatt)}>
            <div className="card-k">{matt ? "Matt's money" : `From ${SRC.matt}`}</div>
            {matt ? <div className="card-v">{money(matt.amount)}</div>
              : <div className={`card-v ${v.pnl < 0 ? 'neg' : v.pnl > 0 ? 'pos' : ''}`}>{v.pnl >= 0 ? '+' : ''}{money(v.pnl)}</div>}
            <div className="card-sub">{matt ? `updated ${stamp(matt.createdAt)} · ` : ''}{v.n} settled · {v.w}-{v.l}{openN ? ` · ${openN} open` : ''} · tap to {showMatt ? 'hide' : 'see/edit'}</div>
          </button> })()}
      </div>
      {showMatt && <div className="card wd-list">
        <div className="card-k">Matt's money</div>
        <div className="muted small" style={{ margin: '4px 0' }}>{matt ? <>Now <b>{money(matt.amount)}</b> · set {stamp(matt.createdAt)}{matt.note ? ` · ${matt.note}` : ''}</> : 'Not set yet.'} This is just Matt's tally — it never changes your balance or PNL.</div>
        {canEdit && <div className="wd-form">
          <input className="input mini" inputMode="decimal" placeholder="Matt's money $" value={mattAmt} onChange={(e) => setMattAmt(e.target.value)} />
          <input className="input mini" placeholder="Note (optional)" value={mattNote} onChange={(e) => setMattNote(e.target.value)} />
          <button className="act" disabled={mattAmt === ''} onClick={async () => {
            const amt = Number(String(mattAmt).replace(/[$,]/g, '')); if (isNaN(amt)) { setMattMsg('Enter a dollar amount.'); return }
            try { const r = await saveMatt(desk, profile, amt, mattNote); setMattMsg(r.demo ? 'Demo: not saved.' : 'Saved.'); setMattAmt(''); setMattNote(''); setMatt({ amount: amt, note: mattNote, createdAt: new Date().toISOString() }) }
            catch (e) { setMattMsg(/row-level|policy|permission/i.test(e.message) ? 'Not allowed yet: run app-sql-5-matt-ledger.sql in Supabase once.' : e.message) }
          }}>Update</button>
        </div>}
        {mattMsg && <p className="note">{mattMsg}</p>}
        <div className="card-k" style={{ marginTop: 12 }}>Matt's bets — placed with Matt's money</div>
        <p className="muted small" style={{ margin: '4px 0 8px' }}>Tap any bet's buttons to update it (stake, Won/Lost/Push, cash-out). Changes save to the desk within a few minutes.</p>
        {mattBets.map((b) => <UploadRow key={b.id} b={b} desk={desk} profile={profile} canEdit={canEdit} />)}
      </div>}
      {showWd && <div className="card wd-list">
        <div className="card-k">Withdrawals — taken out of your balance</div>
        {(d.withdrawals || []).length === 0 ? <p className="muted small">No withdrawals logged yet. Log them on your Sebas Desk for now.</p> :
          d.withdrawals.map((w) => <div key={w.id} className="wd-row"><span>{ago(w.date)}{w.note ? ` · ${w.note}` : ''}</span><b className="pos">{money(w.amount)}</b></div>)}
        <div className="wd-row tot"><span>Total withdrawn</span><b className="pos">{money(d.withdrawn || 0)}</b></div>
        {canEdit && <div className="wd-add">
          <div className="card-k" style={{ marginTop: 10 }}>Log a withdrawal</div>
          <div className="wd-form">
            <input className="input mini" inputMode="decimal" placeholder="Amount $" value={wdAmt} onChange={(e) => setWdAmt(e.target.value)} />
            <input className="input mini" type="date" value={wdDate} onChange={(e) => setWdDate(e.target.value)} />
            <button className="act" disabled={!wdAmt} onClick={async () => {
              const amt = Number(String(wdAmt).replace(/[$,]/g, '')); if (!amt) return
              try { const r = await submitEdit(desk, profile, 'pnlEntries/new', 'withdrawal', { amount: amt, date: wdDate, desc: 'Withdrawal' }); setWdMsg(r.demo ? 'Demo: not saved.' : SYNC_NOTE); setWdAmt('') } catch (e) { setWdMsg(e.message) }
            }}>Log withdrawal</button>
          </div>
          {wdMsg && <p className="note">{wdMsg}</p>}
        </div>}
      </div>}
      {canEdit && <div className="card wd-add">
        <div className="card-k">Match my DraftKings balance</div>
        <div className="muted small">Type what DraftKings shows as your balance right now. Open bets are already out of it.</div>
        <div className="wd-form">
          <input className="input mini" inputMode="decimal" placeholder="Balance $" value={balAmt} onChange={(e) => setBalAmt(e.target.value)} />
          <button className="act" disabled={!balAmt} onClick={async () => {
            const amt = Number(String(balAmt).replace(/[$,]/g, '')); if (isNaN(amt) || amt < 0) { setBalMsg('Enter a dollar amount.'); return }
            if (!window.confirm(`Set your balance to ${money(amt)} to match DraftKings?`)) return
            try {
              const r = await submitEdit(desk, profile, 'pnlEntries/new', 'balanceUpdate', { setTo: amt, createdAt: new Date().toISOString(), desc: `Balance update: set to $${amt.toFixed(2)} to match DraftKings` })
              setBalMsg(r.demo ? 'Demo: not saved.' : 'Saved. Your balance updates in a few minutes.'); setBalAmt('')
            } catch (e) { setBalMsg(e.message) }
          }}>Update balance</button>
        </div>
        {balMsg && <p className="note">{balMsg}</p>}
      </div>}
      <BalanceChart d={{ ...d, balance }} />
      {s.lostByOne.length > 0 && (<><div className="label">LOST BY ONE LEG</div>{s.lostByOne.slice(0, 3).map((b) => <BetRow key={b.id} b={b} />)}</>)}
    </>) : (<>
      <div className="label">LATEST</div>
      {[...d.bets].sort(newestFirst).slice(0, 8).map((b) => <BetRow key={b.id} b={b} />)}
    </>)}
  </>)
}

const SPORT_COLOR = { NFL: '#3b82f6', NBA: '#a78bfa', NHL: '#22d3ee', CFB: '#f97316', CBB: '#eab308', MLB: '#ef4444', SOC: '#22c55e' }
function BalanceChart({ d }) {
  const settled = d.bets.filter((b) => b.settledAt).sort((a, b) => a.settledAt.localeCompare(b.settledAt))
  if (settled.length < 2) return null
  let bal = d.startBalance || 0
  const pts = settled.map((b) => { bal += b.status === 'push' ? 0 : b.ret - b.stake; return { bal, b } })
  const vals = [d.startBalance || 0, ...pts.map((p) => p.bal)]
  const min = Math.min(...vals), max = Math.max(...vals), W = 320, H = 140, pad = 8
  const x = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2)
  const y = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - pad * 2)
  const bySport = {}
  settled.forEach((b) => { const k = b.sport || 'OTHER'; bySport[k] = bySport[k] || { pnl: 0, w: 0, l: 0 }; bySport[k].pnl += b.status === 'push' ? 0 : b.ret - b.stake; if (b.status === 'won') bySport[k].w++; if (b.status === 'lost') bySport[k].l++ })
  return (<div className="card chart-card">
    <div className="chart-title">Your balance, bet by bet</div>
    <div className="muted small">Balance {money(d.balance)}</div>
    <svg viewBox={`0 0 ${W} ${H}`} className="spark">
      <line x1={pad} x2={W - pad} y1={y(d.startBalance || 0)} y2={y(d.startBalance || 0)} stroke="#facc15" strokeDasharray="3 3" strokeWidth="1" opacity=".7" />
      <polyline fill="none" stroke="#cbd5e1" strokeWidth="1.2" points={pts.map((p, i) => `${x(i)},${y(p.bal)}`).join(' ')} />
      {pts.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.bal)} r="3.2" fill={p.b.status === 'won' ? (SPORT_COLOR[p.b.sport] || '#94a3b8') : '#0a1230'} stroke={SPORT_COLOR[p.b.sport] || '#94a3b8'} strokeWidth="1.5" />)}
    </svg>
    <div className="muted small">Each dot is a settled bet: color is the sport, filled is a win, hollow is a loss.</div>
    <div className="legend">{Object.entries(bySport).map(([k, v]) => <span key={k}><i style={{ background: SPORT_COLOR[k] || '#94a3b8' }} />{k === 'SOC' ? 'Soccer' : k} <b className={v.pnl < 0 ? 'neg' : 'pos'}>{v.pnl >= 0 ? '+' : ''}{money(v.pnl)}</b> {v.w}-{v.l}</span>)}</div>
  </div>)
}

function Card({ k, v, sub, neg, pos, bar }) {
  return <div className="card"><div className="card-k">{k}</div><div className={`card-v ${neg ? 'neg' : ''} ${pos ? 'pos' : ''}`}>{v}</div>{bar !== undefined && <div className="bar"><i style={{ width: `${Math.min(100, bar)}%` }} /></div>}<div className="card-sub">{sub}</div></div>
}

function BetRow({ b }) {
  const [open, setOpen] = useState(b.status === 'open' || !!b.protected)
  const toPay = b.status === 'open' ? toPayout(b) : b.ret
  const ee = !!b.protected && b.status === 'won'   // DraftKings "Early Exit Win"
  return (
    <div className="slip">
      <div className="slip-top">{b.sgp && <span className="sgp">SGP</span>}<span className="slip-title">{b.legs.length > 1 ? `${b.legs.length}-Leg Parlay` : b.title}</span>
        {b.origOdds && <s className="muted">{b.origOdds}</s>}{b.odds && <span className="odds-b">{b.odds}</span>}
        {ee ? <span className="st st-won">Early Exit Win</span> : <span className={`st st-${b.status}`}>{cap(b.status)}</span>}</div>
      <div className="muted small">{b.game || b.title}{b.sport ? ` · ${b.sport}` : ''}</div>
      {(b.source || b.tag) && <span className="who">{SRC[b.source] || b.source}{b.tag ? ` · ${b.tag}` : ''}</span>}
      <div className="wager">{b.bonus ? 'Bonus bet' : 'Wager'}: <b>{money(b.bonus ? (b.bonusStake || 0) : b.stake)}</b> <span className="muted">|</span> {b.status === 'open' ? 'To Pay' : ee ? 'Paid' : 'Returned'}: <b>{money(toPay)}</b></div>
      {b.boost && <span className="boost">{b.boost}</span>}
      {ee && <div className="ee-box"><span className="ee-tag">Early Exit Protected</span>
        <div className="muted small">One or more legs qualified for Early Exit protection. The payout above is what DraftKings paid.</div></div>}
      {open && <ul className="legs">{b.legs.map((l, i) => {
        const voided = /void|protect/i.test(l.status)
        return <li key={i} className={`leg leg-${voided ? 'protected' : l.status}`}>{voided ? <span className="ee-shield">⛨</span> : <i />}
          <span>{l.text}{voided && <><br /><span className="ee-tag sm">Early Exit Protected</span></>}</span></li>
      })}</ul>}
      <div className="slip-foot"><span className="muted small">Placed {stamp(b.loggedAt || b.placedAt)}{b.status !== 'open' && b.settledAt ? ` · settled ${stamp(b.settledAt)}` : ''}</span><button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide Legs ⌃' : 'View Legs ⌄'}</button></div>
    </div>)
}
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1)
function toPayout(b) { if (b.toPay > 0) return b.toPay; if (b.ret > b.stake) return b.ret; const o =parseInt(String(b.odds).replace('+', ''), 10); if (!o) return b.stake; return b.stake + (o > 0 ? b.stake * o / 100 : b.stake * 100 / Math.abs(o)) }

function Live({ open, stale = [], desk, stamp }) {
  // Slips just uploaded that Claude hasn't read yet: show them right away; they turn into open bets once read
  const [reading, setReading] = useState([])
  useEffect(() => {
    const f = () => loadPendingApp(desk).then((p) => setReading((p.uploads || []).filter((u) => ['pending', 'processing'].includes(u.status)))).catch(() => {})
    f(); const t = setInterval(f, 30000); return () => clearInterval(t)
  }, [desk, stamp])
  const sorted = [...open].sort(newestFirst)
  return (<>
    <div className="grid">
      <Card k="Open bets" v={open.length} sub={reading.length ? `+${reading.length} slip${reading.length > 1 ? 's' : ''} being read` : 'right now'} />
      <Card k="Money in play" v={money(open.reduce((t, b) => t + b.stake, 0))} sub="" />
      <Card k="Pays if all hit" v={money(open.reduce((t, b) => t + toPayout(b), 0))} sub="" />
    </div>
    {reading.length > 0 && (<><div className="label">READING YOUR SLIP</div>{reading.map((u) => (
      <div key={u.id} className="card"><div className="bet-top"><span className="pill">NEW</span>
        <span className="bet-title">{(u.files || []).length || 1} screenshot(s){u.units ? ` · ${u.units}` : ''}</span>
        <span className="odds">{u.status === 'processing' ? 'Reading…' : 'Waiting'}</span></div>
        <div className="card-sub">Shows up as an open bet below in a few minutes.</div></div>))}</>)}
    {sorted.length > 0 && (<><div className="label">OPEN BETS</div>{sorted.map((b) => <BetRow key={b.id} b={b} />)}</>)}
    {sorted.length === 0 && reading.length === 0 && <p className="muted">No open bets right now.</p>}
    {stale.length > 0 && <p className="muted">{stale.length} older bet{stale.length > 1 ? 's' : ''} still {stale.length > 1 ? 'have' : 'has'} no result (not counted here). Ask Claude to grade {stale.length > 1 ? 'them' : 'it'}.</p>}
  </>)
}

const SOURCES = [
  ['claude', '🤖', "Claude's bets"], ['seb', '😎', "Seb's bets"], ['ftd', '🏈', 'First TD options'], ['gabe', '🧢', "Gabe's bets"],
  ['steve', '🏀', "Steve's plays"], ['lela', '⚽', 'Lela'], ['gavin', '📣', "Gavin's plays"], ['matt', '💰', "Matt's bets (his money)"],
]
const UNITS = ['Not set', '1u', '2u', '3u', 'Lotto']

function Activity({ bets, isAdmin, name, desk, profile, canEdit }) {
  const [sub, setSub] = useState(() => new URLSearchParams(window.location.search).get('sub') || window.__PREVIEW_SUB || 'bets')
  const sorted = [...bets].sort(newestFirst)
  return (<>
    <div className="subtabs">{[['bets', 'Bets'], ['uploads', 'Uploads']].map(([k, l]) => <button key={k} className={`subtab ${sub === k ? 'on' : ''}`} onClick={() => setSub(k)}>{l}</button>)}</div>
    {sub === 'bets'
      ? (sorted.length === 0 ? <p className="muted">No bets yet.</p> : sorted.map((b) => <BetRow key={b.id} b={b} />))
      : <Uploads bets={sorted} isAdmin={isAdmin} name={name} desk={desk} profile={profile} canEdit={canEdit} />}
  </>)
}

function Uploads({ bets, isAdmin, name, desk, profile, canEdit }) {
  // Seb sees every source; friends never see Seb-only sources (Gabe, Matt, Gavin, other friends)
  // Friends can also mark a bet as tailing Seb ("Seb's bets") — that posts "Steve tailed Seb's bet" instead of the full slip
  const sources = isAdmin ? SOURCES : [['self', '🙋', `${name || 'My'} bets`], ['seb', '😎', "Seb's bets"], ['claude', '🤖', "Claude's picks"], ['ftd', '🏈', 'First TD options']]
  const [src, setSrc] = useState(isAdmin ? 'seb' : 'self'); const [live, setLive] = useState(false); const [cashed, setCashed] = useState(false)
  const [unit, setUnit] = useState('Not set'); const [files, setFiles] = useState([]); const [priv, setPriv] = useState(false); const [matt, setMatt] = useState(false); const [bonus, setBonus] = useState(false)
  const [note, setNote] = useState('')
  const uploads = bets.filter((b) => b.hasSlip || b.readBy).sort(newestFirst)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState([])
  useEffect(() => { loadPendingApp(desk).then((p) => setPending(p.uploads.filter((u) => !['read', 'done', 'cancelled', 'canceled', 'skipped', 'duplicate'].includes(String(u.status || '').toLowerCase()) && (u.files || []).length > 0))).catch(() => {}) }, [desk, note])
  const pick = (list) => setFiles([...list].filter((f) => f.type.startsWith('image/')).map((f) => ({ name: f.name, url: URL.createObjectURL(f), file: f })))
  const doUpload = async () => {
    if (!canEdit) { setNote(OTHER_DESK); return }
    setBusy(true); setNote('')
    try {
      const unitsMap = { 'Not set': '', '1u': 1, '2u': 2, '3u': 3, Lotto: 'lotto' }
      const r = await uploadSlips(desk, profile, files.map((f) => f.file), { who: src, units: unitsMap[unit] ?? '', live, cashedOut: cashed, private: priv, matt, bonus })
      setNote(r.demo ? 'Demo: nothing uploaded.' : `Uploaded ${files.length} screenshot${files.length > 1 ? 's' : ''}. Claude reads it at the next sync (top of the hour, or tap Run now on the Post-Cutover Sync) and it shows up below.`)
      if (!r.demo) { setFiles([]); setLive(false); setCashed(false); setPriv(false); setMatt(false); setBonus(false) }
    } catch (e) { setNote(e.message) }
    setBusy(false)
  }
  return (<>
    <div className="label">DRAFTKINGS SCREENSHOTS</div>
    <div className="h-sec">Uploads</div>
    <p className="muted small">Upload a bet slip, pick who gave you the bet, and it counts in your PNL under that name.</p>
    <div className="card up-card">
      <div className="step">1 · WHO GAVE YOU THIS BET? (TAP ONE)</div>
      <div className="src-row">{sources.map(([k, ico, l]) => (
        <button key={k} className={`src-btn ${src === k ? 'on' : ''}`} onClick={() => setSrc(k)}><span className="src-ico">{ico}</span><span>{l}</span></button>))}</div>
      <div className="src-row">
        <button className={`src-btn ${live ? 'on' : ''}`} onClick={() => setLive(!live)}><span className="src-ico">🔴</span><span>In live</span></button>
        <button className={`src-btn ${cashed ? 'on' : ''}`} onClick={() => setCashed(!cashed)}><span className="src-ico">💵</span><span>Cashed out</span></button>
      </div>
      <div className="step">UNIT SIZE</div>
      <select className="input unit" value={unit} onChange={(e) => setUnit(e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
      <div className="step">2 · SCREENSHOT</div>
      <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files) }}>
        <input type="file" accept="image/*" multiple hidden onChange={(e) => pick(e.target.files)} />
        <b>Choose screenshots</b><span className="muted small">or drag them here</span>
      </label>
      {files.length > 0 && <div className="thumbs">{files.map((f) => <img key={f.url} src={f.url} alt={f.name} />)}</div>}
      <button className={`src-btn lock ${priv ? 'on' : ''}`} onClick={() => setPriv(!priv)}><span className="src-ico">🔒</span><span>Private bet</span></button>
      {isAdmin && <label className="check"><input type="checkbox" checked={matt} onChange={(e) => setMatt(e.target.checked)} /> <span><b>This is a Matt bet.</b> Placed with Matt's money: it goes to Matt's bets on the PNL page, and anything it wins adds to his balance.</span></label>}
      <label className="check"><input type="checkbox" checked={bonus} onChange={(e) => setBonus(e.target.checked)} /> <span><b>This is a bonus bet.</b> DraftKings gave you this bet for free: it doesn't take anything off your balance. If it wins, only the winnings are added.</span></label>
      <p className="muted small">Claude reads every bet on the screenshot (a slip or a My Bets list) and fills in the stake, odds, legs and result. A bet you already uploaded is skipped.</p>
      <button className="btn big" disabled={!files.length || busy} onClick={doUpload}>{busy ? 'Uploading…' : 'Upload and let Claude read it'}</button>
      {note && <p className="note">{note}</p>}
    </div>
    {pending.length > 0 && (<><div className="label">WAITING FOR CLAUDE TO READ</div>
      {pending.map((u) => <div key={u.id} className="slip"><div className="slip-top"><span className="who">{u.who || 'upload'}</span>
        <span className={`st ${u.status === 'failed' ? 'st-lost' : 'st-open'}`}>{u.status === 'failed' ? 'Failed' : 'Waiting'}</span></div>
        <div className="muted small">{(u.files || []).length} screenshot(s) · {stamp(u.createdAt)}{u.reason ? ` · ${u.reason}` : ''}</div></div>)}</>)}
    <div className="h-sec" style={{ marginTop: 16 }}>Your uploads</div>
    {uploads.length === 0 ? <p className="muted">No uploads yet.</p> : uploads.map((b) => <UploadRow key={b.id} b={b} desk={desk} profile={profile} canEdit={canEdit} />)}
  </>)
}

function UploadRow({ b, desk, profile, canEdit }) {
  const [msg, setMsg] = useState(''); const [stake, setStake] = useState(''); const [cash, setCash] = useState('')
  const [prot, setProt] = useState(false); const [voided, setVoided] = useState([]); const [paid, setPaid] = useState('')
  const act = async (action, value = null) => {
    if (!canEdit) { setMsg(OTHER_DESK); return }
    if (action === 'delete' && !window.confirm('Delete this bet from your desk?')) return
    try { const r = await submitEdit(desk, profile, `pnlEntries/${b.id}`, action, value); setMsg(r.demo ? 'Demo: not saved.' : SYNC_NOTE) } catch (e) { setMsg(e.message) }
  }
  const pl = b.status === 'push' ? 0 : b.status === 'open' ? null : b.ret - b.stake
  return (<div className="slip">
    <div className="slip-top">
      <span className="who">{SRC[b.source] || b.source || 'Seb\'s bets'}</span>
      <span className={`st inline st-${b.status}`}>{cap(b.status)}{b.protected && b.status === 'won' ? ' · Early Exit' : ''}</span>
      {!b.keepOut && b.status !== 'open' && <span className="tag-pnl">In PNL</span>}
      {b.live && <span className="tag-live">● In live</span>}
      {b.isPrivate && <span className="tag-priv">🔒 Private</span>}
      {b.bonus && <span className="tag-live" style={{ color: '#1E9E5A' }}>🎁 Bonus bet</span>}
      {pl !== null && <span className={`pl ${pl < 0 ? 'neg' : 'pos'}`}>{pl >= 0 ? '+' : '-'}${Math.abs(pl).toFixed(2)}</span>}
    </div>
    {b.readBy && <div className="readby">Read by {cap(b.readBy)}</div>}
    <div className="slip-title">{b.legs.length > 1 ? `${b.legs.length}-Leg Parlay${b.sgp ? ' (SGPx)' : ''}` : b.title}{b.title && b.legs.length > 1 ? `: ${b.title}` : ''}</div>
    <ul className="legs plain">{b.legs.map((l, i) => <li key={i} className={`leg leg-${l.status}`}><i />{l.text}{/void/.test(l.status) ? ' — Early Exit Protected' : ['won', 'lost'].includes(l.status) ? ` — ${l.status === 'won' ? 'hit' : 'miss'}` : ''}</li>)}</ul>
    <div className="muted small">{stamp(b.loggedAt || b.placedAt || b.settledAt)} · ${(b.bonus ? b.bonusStake || 0 : b.stake).toFixed(2)}{b.bonus ? ' bonus' : ''} at {b.odds || '—'}{b.units !== '' ? ` · ${b.units}${/^\d/.test(String(b.units)) ? 'u' : ''}` : ''}</div>
    <div className="actions">
      <input className="input mini" inputMode="decimal" placeholder={`Stake $${b.stake.toFixed(2)}`} value={stake} onChange={(e) => setStake(e.target.value)} />
      <button className="act" disabled={!stake} onClick={() => act('stake', Number(String(stake).replace(/[$,]/g, '')))}>Save stake</button>
      <button className="act" onClick={() => act('live', !b.live)}>{b.live ? 'Not in live' : 'Mark as in live'}</button>
      <button className="act" onClick={() => act('private', !b.isPrivate)}>{b.isPrivate ? 'Make public' : 'Make private'}</button>
      <button className="act" onClick={() => act('keepOut', !b.keepOut)}>{b.keepOut ? 'Count in balance' : 'Keep out of balance'}</button>
      <button className="act" onClick={() => act('bonus', !b.bonus)}>{b.bonus ? 'Not a bonus bet' : 'Mark as bonus bet'}</button>
      <button className="act" onClick={() => act('won')}>Won</button>
      <button className="act" onClick={() => act('lost')}>Lost</button>
      <button className="act" onClick={() => act('push')}>Push</button>
      <input className="input mini" inputMode="decimal" placeholder="Cash-out $" value={cash} onChange={(e) => setCash(e.target.value)} />
      <button className="act" disabled={!cash} onClick={() => act('cashout', Number(String(cash).replace(/[$,]/g, '')))}>Cash out</button>
      <button className="act" onClick={() => { setProt(!prot); setVoided([]); setPaid('') }}>{prot ? 'Cancel Early Exit' : 'Early Exit Win'}</button>
      <button className="act" onClick={() => act('pending')}>Back to pending</button>
      <button className="act del" onClick={() => act('delete')}>Delete</button>
    </div>
    {prot && <div className="card form" style={{ marginTop: 8 }}>
      <div className="card-k">Early Exit Win</div>
      <p className="muted small" style={{ margin: 0 }}>Tap the leg(s) DraftKings marked Early Exit Protected, then enter what you were actually paid.</p>
      {b.legs.length === 0 ? <p className="muted small">No legs on this bet yet.</p> : b.legs.map((l, i) => (
        <label key={i} className="muted small" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={voided.includes(i)} onChange={() => setVoided(voided.includes(i) ? voided.filter((x) => x !== i) : [...voided, i])} />
          <span style={voided.includes(i) ? { textDecoration: 'line-through' } : {}}>{l.text}</span></label>))}
      <input className="input" inputMode="decimal" placeholder="Paid $ (total payout DraftKings gave you)" value={paid} onChange={(e) => setPaid(e.target.value)} />
      <button className="btn" disabled={!voided.length || !paid} onClick={async () => {
        const amt = Number(String(paid).replace(/[$,]/g, '')); if (!amt) { setMsg('Enter the payout amount.'); return }
        await act('wonProtected', { paid: amt, voidedLegs: voided.sort((x, y) => x - y), voidedText: voided.map((i) => b.legs[i]?.text || '') })
        setProt(false)
      }}>Save as Early Exit Win</button>
    </div>}
    {msg && <p className="note">{msg}</p>}
  </div>)
}

const LEAGUES = ['NFL', 'Soccer', 'NBA', 'CBB', 'CFB', 'NHL', 'MLB', 'UFC']
const CBB_PLAYS = ['Full game (ML / spread / total)', '1st half (ML / spread / total)', '2nd half (ML / spread / total)', 'Mix of full game + halves']
const Sel = ({ label, value, onChange, opts, hint }) => (<label className="fld"><span className="fld-l">{label}</span>
  <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>{opts.map((o) => <option key={o}>{o}</option>)}</select>
  {hint && <span className="fld-h">{hint}</span>}</label>)
const Txt = ({ label, value, onChange, ph, area, hint, type }) => (<label className="fld"><span className="fld-l">{label}</span>
  {area ? <textarea className="input" rows="2" placeholder={ph} value={value} onChange={(e) => onChange(e.target.value)} />
    : <input className="input" type={type || 'text'} placeholder={ph} value={value} onChange={(e) => onChange(e.target.value)} />}
  {hint && <span className="fld-h">{hint}</span>}</label>)
const todayStr = () => new Date().toISOString().slice(0, 10)
const LIVE_NOTE = 'Sending from the app turns on with instant picks (after go-live). For now, send this on your Sebas Desk. The answer shows up here too.'
const SYNC_NOTE = 'Saved. It goes into your desk at the next sync (top of the hour), or right away if you tap Run now on the Post-Cutover Sync.'
const OTHER_DESK = 'You can only change your own desk.'

function Picks({ d, desk, profile, canEdit }) {
  const [sub, setSub] = useState(() => new URLSearchParams(window.location.search).get('psub') || window.__PREVIEW_PSUB || 'claude')
  const [x, setX] = useState(null)
  useEffect(() => { setX(null); loadPicksExtra(desk).then(setX).catch(() => setX({ requests: [], ftd: [], fbm: [] })) }, [desk])
  const tabs = [['claude', "Claude's picks"], ['request', 'Request a pick'], ['prime', 'Prime time NFL'], ['ftd', 'First TD'], ['fbm', 'FBM']]
  return (<>
    <div className="subtabs scroll">{tabs.map(([k, l]) => <button key={k} className={`subtab ${sub === k ? 'on' : ''}`} onClick={() => setSub(k)}>{l}</button>)}</div>
    {sub === 'request' && <RequestPick requests={(x?.requests || []).filter((r) => !r.prime)} desk={desk} profile={profile} canEdit={canEdit} />}
    {sub === 'prime' && <PrimeTime requests={(x?.requests || []).filter((r) => r.prime)} desk={desk} profile={profile} canEdit={canEdit} />}
    {sub === 'ftd' && <Candidates title="First TD options" kind="FTD" list={x?.ftd} record={x?.ftdRecord} loading={!x} empty="No First TD options for this week yet. They land Thursday morning (TNF) and Sunday morning (Sunday slate)." />}
    {sub === 'fbm' && <Candidates title="First Basket (FBM)" kind="FBM" list={x?.fbm} record={x?.fbmRecord} loading={!x} empty="No First Basket picks yet. The FBM refresh runs daily at 4 PM ET." />}
    {sub === 'claude' && <ClaudePicks picks={d.picks} />}
  </>)
}

function HowCards({ items }) {
  return <div className="how">{items.map(([t, b]) => <div key={t} className="how-card"><b>{t}</b><span>{b}</span></div>)}</div>
}

const COMPETITIONS = ['All (Premier League, La Liga, Serie A, Bundesliga)', 'Champions League', 'Premier League', 'La Liga', 'Serie A', 'Bundesliga',
  'Ligue 1', 'Europa League', 'Copa Libertadores / Sudamericana', 'FPC (Colombia)', 'Liga Argentina', 'MLS', 'International', 'Other']
const SLOTS = {
  NFL: ['TNF', 'Sunday', 'SNF', 'MNF', 'Saturday', 'Holiday'],
  CFB: ['Saturday', 'Weeknight', 'Bowl game', 'Playoff'],
  NBA: ['Regular season', 'NBA Cup', 'Play-in', 'Playoffs'],
  CBB: ['Regular season', 'Conference tournament', 'NCAA tournament (March Madness)', 'NIT / other'],
  NHL: ['Regular season', 'Playoffs'],
  MLB: ['Regular season', 'Postseason'],
  UFC: ['Main card', 'Prelims', 'Full card'],
}
const GAME_PH = { NFL: 'Seahawks at Broncos', CFB: 'Georgia at Alabama', NBA: 'Knicks vs Celtics', CBB: 'Duke vs North Carolina', NHL: 'Rangers vs Bruins', MLB: 'Yankees vs Dodgers', Soccer: 'Arsenal vs Chelsea', UFC: 'Main event fighters' }

function RequestPick({ requests, desk, profile, canEdit }) {
  const [f, setF] = useState({ league: 'Multi-league', pos: 'Parlay', legs: ['NFL', 'NBA'], play: 'Mixed (props, ML, spreads, totals)', bet: 'Bet the board',
    other: '', comp: COMPETITIONS[0], slot: '', game: '', date: todayStr(), kickoff: 'All games', kickoffEt: '', risk: '1 Unit', minOdds: '', nLegs: '3 or more, Claude decides', news: '', must: '', leave: '' })
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }))
  const [msg, setMsg] = useState(''); const [sending, setSending] = useState(false)
  const multi = f.league === 'Multi-league'
  const has = (l) => f.league === l || (multi && f.legs.includes(l))
  const isNfl = has('NFL')
  const isSgp = f.bet.startsWith('Same game')
  // Bet types: the anytime TD parlay only makes sense when football is in the mix
  const betOpts = ['Same game parlay (SGP)', 'Bet the board', ...(has('NFL') || has('CFB') ? ['Anytime TD parlay (across the board)'] : [])]
  const slotOpts = multi ? (isNfl ? SLOTS.NFL : []) : (SLOTS[f.league] || [])
  const slot = slotOpts.includes(f.slot) ? f.slot : (slotOpts[0] || '')
  const bet = betOpts.includes(f.bet) ? f.bet : 'Bet the board'
  return (<>
    <HowCards items={[['1 · FILL IT IN', 'The game, how much risk, any boost, and news you’ve heard.'],
      ['2 · SEND IT', 'Claude researches live injuries and DraftKings lines, using your rules and lessons.'],
      ['3 · GET THE PICK', 'It shows up below and on the Tracker in a few minutes, with a push to your phone.']]} />
    <div className="h-sec">Request a pick</div>
    <div className="card form">
      <Sel label="League" value={f.league} onChange={set('league')} opts={['Multi-league', ...LEAGUES]} />
      <Sel label="Parlay or single" value={f.pos} onChange={set('pos')} opts={['Parlay', 'Single']} />
      {multi && <div className="fld"><span className="fld-l">Leagues for this parlay (pick 2 or more)</span>
        <div className="checks">{LEAGUES.map((l) => <label key={l} className="chk"><input type="checkbox" checked={f.legs.includes(l)} onChange={(e) => set('legs')(e.target.checked ? [...f.legs, l] : f.legs.filter((v) => v !== l))} />{l}</label>)}</div></div>}
      {f.league === 'CBB'
        ? <Sel label="Type of play (college basketball)" value={CBB_PLAYS.includes(f.play) ? f.play : CBB_PLAYS[0]} onChange={set('play')} opts={CBB_PLAYS}
            hint="NCAAB: moneyline, spread and totals only, full game or halves. No props. New York and New Jersey schools are excluded." />
        : <Sel label="Type of play" value={f.play} onChange={set('play')} opts={['Mixed (props, ML, spreads, totals)', 'Player props', 'ML / spreads / totals']}
            hint={multi && f.legs.includes('CBB') ? 'College basketball legs stay ML / spread / total (full game or halves), no props; NY/NJ schools excluded.' : undefined} />}
      <Sel label="Bet type" value={bet} onChange={set('bet')} opts={betOpts} />
      <Txt label="Other (optional)" area value={f.other} onChange={set('other')} ph="Only soccer games that start before 11am, and you can add props from the London NFL game too" hint="Anything extra, written like you'd text it. It adds to the bet type above: pick Bet the board and Claude still looks at the whole board, then follows what you write here." />
      {has('Soccer') && <Sel label="Competition" value={f.comp} onChange={set('comp')} opts={COMPETITIONS} />}
      {slotOpts.length > 0 && <Sel label="Slot" value={slot} onChange={set('slot')} opts={slotOpts} />}
      {isSgp && <Txt label="Game" value={f.game} onChange={set('game')} ph={GAME_PH[multi ? 'NFL' : f.league] || 'Team A vs Team B'} hint="Same game parlay: which game?" />}
      <Txt label="Date" type="date" value={f.date} onChange={set('date')} />
      {isSgp ? <Txt label="Kickoff (ET)" value={f.kickoffEt} onChange={set('kickoffEt')} ph="7:30 PM" />
        : isNfl && <Sel label="Kickoff" value={f.kickoff} onChange={set('kickoff')} opts={['All games', '9:30 AM (London)', '1 PM games', '4 PM games', 'Night game']} />}
      <Sel label="Risk" value={f.risk} onChange={set('risk')} opts={['1 Unit', '2 Units', '3 Units', 'Lotto parlay']}
        hint={{ '1 Unit': 'Small stake, high reward: +800 or longer.', '2 Units': 'Middle ground.', '3 Units': 'Biggest stake: about -120 to +130.', 'Lotto parlay': 'Reasonable legs, big total (lotto-module).' }[f.risk]} />
      <Txt label="Minimum odds" value={f.minOdds} onChange={set('minOdds')} ph="+300" />
      <Sel label="Number of legs (3 minimum)" value={f.nLegs} onChange={set('nLegs')} opts={['3 or more, Claude decides', '3', '4', '5', '6', '7', '8', '10']} />
      <Txt label="News you’ve heard" value={f.news} onChange={set('news')} ph="Lamar out, DJ Moore questionable, rain after 10pm..." />
      <Txt label="Must include" value={f.must} onChange={set('must')} ph="An anytime TD, Allen rushing..." />
      <Txt label="Leave out" value={f.leave} onChange={set('leave')} ph="Any spread, a player..." />
      <button className="btn big send" disabled={sending} onClick={async () => {
        if (!canEdit) { setMsg(OTHER_DESK); return }
        if (multi && f.legs.length < 2) { setMsg('Pick at least 2 leagues for a multi-league parlay.'); return }
        setSending(true)
        try { const r = await submitRequest(desk, profile, { ...f, bet, slot, ...(f.league === 'CBB' ? { play: CBB_PLAYS.includes(f.play) ? f.play : CBB_PLAYS[0] } : {}), ...(has('CBB') ? { leagueNote: "CBB = NCAAB men's college basketball: ML / spread / total, full game or 1st/2nd half only, no props; NY/NJ schools excluded (ncaab-ny-nj-exclusion)." } : {}) }, 'pick'); setMsg(r.demo ? 'Demo: not sent.' : 'Sent to Claude. It builds your pick at the next sync (top of the hour), or right away if you tap Run now on the Post-Cutover Sync. You\'ll see it below and get a Telegram ping.') } catch (e) { setMsg(e.message) }
        setSending(false)
      }}>{sending ? 'Sending…' : 'Send to Claude'}</button>
      {msg && <p className="note">{msg}</p>}
    </div>
    <RequestList title="Your requests" list={requests} />
  </>)
}

function PrimeTime({ requests, desk, profile, canEdit }) {
  const [f, setF] = useState({ slot: 'TNF', game: '', date: todayStr(), kickoff: '', week: '', atd: 'Yes, add them', risk: 'Classic: Safer, Main, Bigger', q: '', news: '', must: '', leave: '' })
  const set = (k) => (v) => setF({ ...f, [k]: v })
  const [msg, setMsg] = useState(''); const [sending, setSending] = useState(false)
  return (<>
    <HowCards items={[['PRIME TIME ONLY', 'TNF, SNF, MNF, holiday, Saturday and playoff NFL games.'],
      ['THE CLASSIC WAY', 'Built like before the Desk: one game script, correlated legs spread across both teams, a risk tag on every leg.'],
      ['THREE TICKETS', 'Safer, Main and Bigger. They land below and on the Tracker, with a push to your phone.']]} />
    <div className="h-sec">Request a prime time NFL pick</div>
    <div className="card form">
      <Sel label="Slot" value={f.slot} onChange={set('slot')} opts={['TNF', 'SNF', 'MNF', 'Saturday', 'Holiday', 'Playoffs']} />
      <Txt label="Game" value={f.game} onChange={set('game')} ph="Seahawks at Broncos" />
      <Txt label="Date" type="date" value={f.date} onChange={set('date')} />
      <Txt label="Kickoff (ET)" value={f.kickoff} onChange={set('kickoff')} ph="8:15 PM" />
      <Txt label="Week of the season" value={f.week} onChange={set('week')} ph="8" />
      <Sel label="Anytime TDs" value={f.atd} onChange={set('atd')} opts={['Yes, add them', 'No anytime TDs']} />
      <Sel label="Risk" value={f.risk} onChange={set('risk')} opts={['Classic: Safer, Main, Bigger', '1 Unit', '2 Units', '3 Units', 'Lotto parlay']} />
      <Txt label="Your question" area value={f.q} onChange={set('q')} ph="Can you create a same game parlay for tonight's game..." />
      <Txt label="News you’ve heard" value={f.news} onChange={set('news')} ph="Sutton out, wind after halftime..." />
      <Txt label="Must include" value={f.must} onChange={set('must')} ph="Walker rushing, an anytime TD..." />
      <Txt label="Leave out" value={f.leave} onChange={set('leave')} ph="Any spread, a player..." />
      <button className="btn big send" disabled={sending} onClick={async () => {
        if (!canEdit) { setMsg(OTHER_DESK); return }
        if (!f.game) { setMsg('Add the game first.'); return }
        setSending(true)
        try { const r = await submitRequest(desk, profile, { ...f, league: 'NFL' }, 'prime'); setMsg(r.demo ? 'Demo: not sent.' : 'Sent to Claude. Your Safer / Main / Bigger tickets build at the next sync (or tap Run now on the Post-Cutover Sync).') } catch (e) { setMsg(e.message) }
        setSending(false)
      }}>{sending ? 'Sending…' : 'Send to Claude'}</button>
      {msg && <p className="note">{msg}</p>}
    </div>
    <RequestList title="Your prime time requests" list={requests} />
  </>)
}

function RequestList({ title, list }) {
  return (<>
    <div className="h-sec" style={{ marginTop: 16 }}>{title}</div>
    {!list?.length ? <p className="muted">No requests yet.</p> : list.map((r) => (
      <div key={r.id} className="slip">
        <div className="slip-top"><span className="muted small">Requested {stamp(r.createdAt || r.date)}{r.answeredAt ? ` · answered ${stamp(r.answeredAt)}` : ''}{r.league ? ` · ${r.league}` : ''}{r.slot ? ` · ${r.slot}` : ''}</span>
          <span className={`st ${r.status === 'answered' ? 'st-won' : 'st-open'}`}>{cap(String(r.status))}</span></div>
        <div className="slip-title">{r.game || r.question || 'Request'}</div>
        {r.risk && <span className="who">{r.risk}</span>}
        {r.question && r.game && <p className="muted small">{r.question}</p>}
        {(r.tickets && r.tickets.length ? r.tickets : (r.ticket ? [r.ticket] : [])).map((tk, n) => <div key={tk.id || n} className="ticket"><div className="ticket-h">★ SEBAS DESK PICKS{r.tickets && r.tickets.length > 1 ? ` · ${n + 1} of ${r.tickets.length}` : ''}</div>
          <div className="slip-top"><b>{tk.title}</b>{tk.legs.length > 0 && <span className="pill" style={{ marginLeft: 6 }}>{tk.legs.length} leg{tk.legs.length === 1 ? '' : 's'}</span>}{tk.odds && <span className="odds-b">{tk.odds}</span>}</div>
          <ul className="legs plain">{tk.legs.map((l, i) => <li key={i} className="leg"><i />{l}</li>)}</ul></div>)}
        {r.status === 'answered' && !(r.tickets && r.tickets.length) && !r.ticket && r.answer && <p className="muted small">{r.answer}</p>}
      </div>))}
  </>)
}

// Model track record for First TD / FBM: every pick it gave, graded, whether or not it was bet
function ModelRecord({ record = [], kind }) {
  const [open, setOpen] = useState(false)
  if (!record.length) return null
  const dec = (o) => { const v = parseInt(String(o || '').replace(/[^-\d]/g, ''), 10); return !v ? 0 : v > 0 ? v / 100 : 100 / Math.abs(v) }
  const sum = (rows) => { const w = rows.filter((r) => r.result === 'won'), l = rows.filter((r) => r.result === 'lost')
    const priced = rows.filter((r) => dec(r.odds))
    const units = priced.reduce((t, r) => t + (r.result === 'won' ? dec(r.odds) : -1), 0)
    return { w: w.length, l: l.length, pct: rows.length ? Math.round((w.length / rows.length) * 100) : 0, units, priced: priced.length } }
  const cutoff = Date.now() - 7 * 86400000
  const recent = record.filter((r) => Date.parse(String(r.date).slice(0, 10) + 'T23:59:59') >= cutoff)
  const all = sum(record), wk = sum(recent)
  const tiers = ['safe', 'medium', 'lotto'].map((t) => [t, sum(record.filter((r) => String(r.tier).toLowerCase() === t))]).filter(([, s]) => s.w + s.l > 0)
  const u = (s) => s.priced ? ` · ${s.units >= 0 ? '+' : ''}${s.units.toFixed(1)}u` : ''
  return (<button className="card wd-card" style={{ width: '100%', textAlign: 'left', marginBottom: 8 }} onClick={() => setOpen(!open)}>
    <div className="card-k">{kind === 'FTD' ? 'First TD' : 'First Basket'} model record · every pick, bet or not</div>
    <div className={`card-v ${all.units > 0 ? 'pos' : all.units < 0 ? 'neg' : ''}`}>{all.w}-{all.l} <span className="muted small">({all.pct}% hit{u(all)})</span></div>
    <div className="card-sub">Last 7 days: {wk.w}-{wk.l}{u(wk)} · tap for {open ? 'less' : 'by tier'}</div>
    {open && <div style={{ marginTop: 6 }}>{tiers.length ? tiers.map(([t, s]) => <div key={t} className="muted small">{t.charAt(0).toUpperCase() + t.slice(1)}: <b>{s.w}-{s.l}</b> ({s.pct}%{u(s)})</div>) : <div className="muted small">No tier info on older picks.</div>}
      <div className="muted small" style={{ marginTop: 4 }}>"u" = profit if you'd put 1 unit on every pick at its listed odds.</div></div>}
  </button>)
}

function Candidates({ title, kind, list, loading, empty, record }) {
  const [tier, setTier] = useState('All')
  if (loading) return <p className="muted">Loading…</p>
  const tiers = ['All', 'Safe', 'Medium', 'Lotto']
  // First TD: only this NFL week (since the most recent Tuesday); older options are stale
  const weekStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 5) % 7)); return d.toISOString().slice(0, 10) })()
  // First Basket: only the newest day's picks (yesterday's drop off once today's are built)
  const fbmDay = kind === 'FBM' ? (list || []).map((c) => String(c.date || '').slice(0, 10)).filter(Boolean).sort().pop() : ''
  const current = (list || []).filter((c) => kind === 'FBM' ? (!fbmDay || String(c.date || '').slice(0, 10) === fbmDay)
    : (kind !== 'FTD' || !c.date || String(c.date).slice(0, 10) >= weekStart))
  const shown = current.filter((c) => tier === 'All' || String(c.tier).toLowerCase() === tier.toLowerCase())
  const byDate = shown.reduce((m, c) => { const k = String(c.date || '').slice(0, 10) || 'Undated'; (m[k] = m[k] || []).push(c); return m }, {})
  return (<>
    <div className="h-sec">{title}</div>
    <ModelRecord record={record} kind={kind} />
    {<div className="subtabs">{tiers.map((t) => <button key={t} className={`subtab ${tier === t ? 'on' : ''}`} onClick={() => setTier(t)}>{t}</button>)}</div>}
    {!shown.length ? <p className="muted">{empty}</p> : Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).map(([dt, items]) => (<div key={dt}>
      <div className="label">{dt === 'Undated' ? 'UNDATED' : ago(dt).toUpperCase()}</div>
      {items.map((c) => (<div key={c.id} className="cand">
        <div className="cand-main"><b>{c.player}</b><span className="muted small">{[c.team, c.game].filter(Boolean).join(' · ')}</span>
          {c.reason && <span className="muted small">{c.reason}</span>}</div>
        <div className="cand-side">
          {c.tier && <span className={`tier t-${String(c.tier).toLowerCase()}`}>{c.tier}</span>}
          <span className="odds">{c.odds || (c.share ? `${(c.share * 100).toFixed(1)}%` : '—')}</span>
          {c.odds && c.share ? <span className="muted small">{(c.share * 100).toFixed(1)}% model</span> : !c.odds && c.share ? <span className="muted small">model share (unpriced)</span> : null}
          {['won', 'lost'].includes(c.status) && <span className={`st inline st-${c.status}`}>{c.status === 'won' ? 'Hit' : 'Miss'}</span>}
        </div></div>))}
    </div>))}
    <p className="muted small">{kind === 'FBM' ? 'First Basket picks follow fbm-model-spec.' : 'First TD picks follow ftd-model-spec.'} They stay on their own model, separate from lotto-module and no-shared-legs.</p>
  </>)
}

function ClaudePicks({ picks }) {
  return (<>
    {picks.length === 0 ? <p className="muted">No picks yet.</p> : picks.map((p) => (
      <div key={p.id} className="card pick"><div className="bet-top"><span className="pill">{p.sport}</span><span className="bet-title">{p.title}</span>{p.legs.length > 0 && <span className="pill" style={{ marginLeft: 6 }}>{p.legs.length} leg{p.legs.length === 1 ? '' : 's'}</span>}<span className="odds">{p.odds}</span></div>
        <ul className="legs">{p.legs.map((l, i) => <li key={i} className="leg">{l}</li>)}</ul>
        <div className="card-sub">{p.createdAt ? `Built ${stamp(p.createdAt)} · ` : ''}{p.confidence ? `Confidence ${Math.round(p.confidence * 100)}% · ` : ''}{p.model}</div>
        {p.sources?.length > 0 && <div className="sources">{p.sources.map((s, i) => <span key={i} className="src">{typeof s === 'string' ? s : s.label || s.type}</span>)}</div>}
      </div>))}
  </>)
}

function More({ profile, desk, isAdmin, onSignOut }) {
  const [page, setPage] = useState(null)
  if (page === 'brain') return <Brain desk={desk} isAdmin={isAdmin} back={() => setPage(null)} />
  if (page === 'usage') return <Usage back={() => setPage(null)} />
  if (page === 'trackers') return <Trackers back={() => setPage(null)} />
  return (<>
    
    <button className="row-btn" onClick={() => setPage('brain')}>🧠 Model Brain <span className="muted">what the model is learning</span></button>
    {isAdmin && <button className="row-btn" onClick={() => setPage('usage')}>📈 Usage <span className="muted">Claude runs and weekly %</span></button>}
    <button className="row-btn" onClick={() => setPage('trackers')}>📊 Team trackers <span className="muted">NBA · CBB · CFB · NHL · Soccer · NFL</span></button>
    <div className="row-btn static">First TD · First Basket <span className="muted">under Picks</span></div>
    {!DEMO_MODE && <SetPassword />}
    <div className="card-sub" style={{ margin: '16px 4px' }}>Signed in as {profile.name}{profile.email ? ` (${profile.email})` : ''}</div>
    <button className="btn" onClick={onSignOut}>Sign out</button>
  </>)
}

function SetPassword() {
  const [pw, setPw] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false)
  return (<div className="card form">
    <div className="card-k">Set password</div>
    <p className="muted small" style={{ margin: 0 }}>Use it to sign in on your phone's home-screen app (no email needed).</p>
    <input className="input" type="password" autoComplete="new-password" placeholder="New password (8+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
    <button className="btn big" disabled={busy || pw.length < 8} onClick={async () => { setBusy(true); const { error } = await setMyPassword(pw); setBusy(false); setMsg(error ? error.message : 'Password saved. Use it to sign in on your phone.'); if (!error) setPw('') }}>{busy ? 'Saving…' : 'Save password'}</button>
    {msg && <p className="muted small">{msg}</p>}
  </div>)
}

function Brain({ desk, isAdmin, back }) {
  const [b, setB] = useState(null)
  useEffect(() => { loadBrain(desk).then(setB) }, [desk])
  return (<>
    <button className="back" onClick={back}>‹ More</button>
    <h1 className="h-italic">Model Brain</h1>
    {!b ? <p className="muted">Loading…</p> : (<>
      {b.models.length > 0 && (<><div className="label">HIT RATE BY MODEL</div>
        <div className="card"><table className="tbl"><thead><tr><th>Model</th><th>7d</th><th>30d</th><th>n</th></tr></thead><tbody>
          {b.models.map((m) => <tr key={m.name}><td>{m.name} <span className="muted">{m.version}</span></td><td>{Math.round(m.hit7 * 100)}%</td><td>{Math.round(m.hit30 * 100)}%</td><td className="muted">{m.n30}</td></tr>)}
        </tbody></table></div></>)}
      <div className="label">WHAT IT LEARNED</div>
      {b.learning.length === 0 ? <p className="muted">Nothing logged yet.</p> : b.learning.map((l, i) => (
        <div key={i} className="card"><div className="card-k">{ago(l.date)} · {l.task}</div><div className="learn">{l.text}</div>{l.source && <div className="sources"><span className="src">Source: {l.source}</span></div>}</div>))}
      {(isAdmin || b.versions.length > 0) && (<><div className="label">MODEL CHANGES</div>
        {b.versions.map((v, i) => <div key={i} className="card"><div className="card-k">{ago(v.date)} · {v.model}</div><div className="learn">{v.from} → {v.to}: {v.change}</div>{v.status && <span className={`st st-${v.status === 'live' ? 'won' : 'open'}`}>{v.status.toUpperCase()}</span>}</div>)}</>)}
    </>)}
  </>)
}

// ---------- Team trackers (read-only, engine data, no Claude usage) ----------
const tv = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return '' }
const wins = (rec) => { const m = String(rec || '').match(/^(\d+)-(\d+)/); return m ? Number(m[1]) / Math.max(1, Number(m[1]) + Number(m[2])) : 0 }
const num = (v) => { const n = parseFloat(String(v).replace('%', '')); return isNaN(n) ? -1e9 : n }
const TRACKERS = {
  NBA: { coll: 'nbaTeams', cols: [['Rec', (t) => tv(t, 'record', 'rec')], ['Off', (t) => tv(t, 'offRank') && `#${tv(t, 'offRank')}`], ['Def', (t) => tv(t, 'defRank') && `#${tv(t, 'defRank')}`], ['Pace', (t) => tv(t, 'pace')]],
    sort: (a, b) => wins(tv(b, 'record', 'rec')) - wins(tv(a, 'record', 'rec')) },
  NHL: { coll: 'nhlTeams', cols: [['Rec', (t) => tv(t, 'record', 'rec')], ['Pts', (t) => tv(t, 'points', 'pts')], ['GF', (t) => tv(t, 'goalsFor', 'gf', 'GF')], ['GA', (t) => tv(t, 'goalsAgainst', 'ga', 'GA')], ['PP%', (t) => tv(t, 'ppPct', 'powerPlayPct', 'pp')], ['PK%', (t) => tv(t, 'pkPct', 'penaltyKillPct', 'pk')]],
    sort: (a, b) => num(tv(b, 'points', 'pts')) - num(tv(a, 'points', 'pts')) },
  Soccer: { coll: 'soccerTeams', group: (t) => tv(t, 'comp', 'league', 'competition') || 'Other', cols: [['#', (t) => tv(t, 'rank')], ['Pts', (t) => tv(t, 'pts', 'points')], ['GD', (t) => tv(t, 'gd')], ['Rec', (t) => tv(t, 'rec', 'record')]],
    sort: (a, b) => num(tv(a, 'rank')) - num(tv(b, 'rank')) },
  CBB: { coll: 'cbbTeams', cols: [['AP', (t) => tv(t, 'apRank', 'rank', 'ap') && `#${tv(t, 'apRank', 'rank', 'ap')}`], ['Rec', (t) => tv(t, 'record', 'rec')], ['Pace', (t) => tv(t, 'pace', 'tempo')], ['Off', (t) => tv(t, 'offEff', 'offRtg', 'adjO')], ['Def', (t) => tv(t, 'defEff', 'defRtg', 'adjD')]],
    sort: (a, b) => { const ra = num(tv(a, 'apRank', 'rank', 'ap')), rb = num(tv(b, 'apRank', 'rank', 'ap')); const A = ra > 0 ? ra : 999, Bv = rb > 0 ? rb : 999; return A !== Bv ? A - Bv : wins(tv(b, 'record', 'rec')) - wins(tv(a, 'record', 'rec')) } },
  CFB: { coll: 'cfbTeams', cols: [['AP', (t) => tv(t, 'apRank', 'rank', 'ap') && `#${tv(t, 'apRank', 'rank', 'ap')}`], ['Rec', (t) => tv(t, 'record', 'rec')], ['Conf', (t) => tv(t, 'conf', 'conference')], ['PF', (t) => tv(t, 'ptsFor', 'pf', 'ppg')], ['PA', (t) => tv(t, 'ptsAgainst', 'pa', 'oppPpg')]],
    sort: (a, b) => { const ra = num(tv(a, 'apRank', 'rank', 'ap')), rb = num(tv(b, 'apRank', 'rank', 'ap')); const A = ra > 0 ? ra : 999, Bv = rb > 0 ? rb : 999; return A !== Bv ? A - Bv : wins(tv(b, 'record', 'rec')) - wins(tv(a, 'record', 'rec')) } },
  NFL: { coll: 'nflTeams', cols: [['Rec', (t) => tv(t, 'record', 'rec')], ['PF', (t) => tv(t, 'ptsFor', 'pf')], ['PA', (t) => tv(t, 'ptsAgainst', 'pa')]],
    sort: (a, b) => wins(tv(b, 'record', 'rec')) - wins(tv(a, 'record', 'rec')) },
}

function Trackers({ back }) {
  const [sport, setSport] = useState('NBA'); const [rows, setRows] = useState(null); const [err, setErr] = useState('')
  const [comp, setComp] = useState(''); const [open, setOpen] = useState(null)
  const cfg = TRACKERS[sport]
  useEffect(() => { setRows(null); setErr(''); setOpen(null); loadTeams(cfg.coll).then(setRows).catch((e) => { setErr(e.message); setRows([]) }) }, [sport])
  const comps = cfg.group ? Array.from(new Set((rows || []).map(cfg.group))).sort() : []
  const curComp = cfg.group ? (comps.includes(comp) ? comp : (comps.find((c) => /premier/i.test(c)) || comps[0] || '')) : ''
  const shown = (rows || []).filter((t) => !cfg.group || cfg.group(t) === curComp).sort(cfg.sort)
  const updated = (rows || []).map((t) => String(tv(t, 'updatedAt', 'lastUpdated'))).filter(Boolean).sort().pop()
  return (<>
    <button className="back" onClick={back}>‹ More</button>
    <h1 className="h-italic">Team trackers</h1>
    <div className="subtabs">{Object.keys(TRACKERS).map((k) => <button key={k} className={`subtab ${sport === k ? 'on' : ''}`} onClick={() => setSport(k)}>{k}</button>)}</div>
    {cfg.group && comps.length > 0 && <select className="input" value={curComp} onChange={(e) => setComp(e.target.value)}>{comps.map((c) => <option key={c}>{c}</option>)}</select>}
    {err && <p className="neg small">{/permission|denied|rls/i.test(err) ? 'Team trackers aren\'t shared with this login yet.' : err}</p>}
    {!rows ? <p className="muted">Loading…</p> : shown.length === 0 ? <p className="muted">No {sport} team data yet.</p> : (
      <div className="card"><table className="tbl"><thead><tr><th>Team</th>{cfg.cols.map(([h]) => <th key={h}>{h}</th>)}</tr></thead><tbody>
        {shown.map((t) => (<React.Fragment key={t.id}>
          <tr onClick={() => setOpen(open === t.id ? null : t.id)} style={{ cursor: 'pointer' }}>
            <td><b>{tv(t, 'abbr', 'short', 'name', 'team') || t.id}</b></td>{cfg.cols.map(([h, f]) => <td key={h}>{f(t) || '—'}</td>)}</tr>
          {open === t.id && <tr><td colSpan={cfg.cols.length + 1} className="muted small">
            {[tv(t, 'name', 'team'), tv(t, 'identity'), tv(t, 'note', 'notes')].filter(Boolean).join(' · ') || 'No notes yet.'}</td></tr>}
        </React.Fragment>))}
      </tbody></table></div>)}
    <p className="muted small">{updated ? `Updated ${stamp(updated)}. ` : ''}Tap a team for its identity and notes. Refreshed nightly by the engine (no Claude usage).</p>
  </>)
}

function Usage({ back }) {
  const [u, setU] = useState([])
  useEffect(() => { loadUsage().then(setU) }, [])
  const max = Math.max(1, ...u.map((x) => x.runs))
  const last = u[u.length - 1]
  return (<>
    <button className="back" onClick={back}>‹ More</button>
    <h1 className="h-italic">Usage</h1>
    <div className="grid"><Card k="Weekly usage" v={last?.pct != null ? `${last.pct}%` : '—'} sub="reply /usage 47 to the bot to update" /><Card k="Claude runs today" v={last ? last.runs : '—'} neg={last?.runs > 40} sub={last?.runs > 40 ? 'above 40, check tasks' : 'target: 40 or less'} /></div>
    <div className="label">RUNS PER DAY</div>
    <div className="card chart">{u.map((x) => <div key={x.date} className="col"><i style={{ height: `${(x.runs / max) * 100}%` }} className={x.runs > 40 ? 'hot' : ''} /><span>{x.runs}</span><small>{x.date}</small></div>)}</div>
  </>)
}
