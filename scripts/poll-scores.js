// Server-side live scoring poll — runs on a schedule (see .github/workflows/poll-scores.yml)
// completely independent of anyone having the app open. Ports the same logic
// used client-side in index.html's pollRealStats(), but:
//   - talks to Supabase's REST API directly with the service-role key (bypasses RLS)
//   - stores only RAW stat counts, never a scoring-rule-dependent fp value —
//     each league's client applies its OWN point values when it reads this data,
//     so this job doesn't need to know anyone's scoring settings.
//
// Requires one secret: SUPABASE_SERVICE_ROLE_KEY (the project URL is public —
// it's already embedded in index.html's client-side code — so it's hardcoded here).

const SUPABASE_URL = "https://qonkkpsgjlhinzknpckw.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

if (!SERVICE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY env var.");
  process.exit(1);
}

const TEAM_ID_BY_AB = {
  ATL:1, BUF:2, CHI:3, CIN:4, CLE:5, DAL:6, DEN:7, DET:8, GB:9, TEN:10,
  IND:11, KC:12, LV:13, LAR:14, MIA:15, MIN:16, NE:17, NO:18, NYG:19, NYJ:20,
  PHI:21, ARI:22, PIT:23, LAC:24, SF:25, SEA:26, TB:27, WSH:28, CAR:29, JAX:30,
  BAL:33, HOU:34,
};

// Mirrors index.html's SLOTS/defaultStarters exactly — used only to build a
// week-close snapshot for a manager who never opened the Team tab that
// week (so has no row in `lineups` at all) at the one moment it's
// guaranteed accurate: the instant the week actually closes.
const SLOTS = [
  { pos: ["QB"] }, { pos: ["RB"] }, { pos: ["RB"] }, { pos: ["WR"] }, { pos: ["WR"] },
  { pos: ["TE"] }, { pos: ["RB", "WR", "TE"] }, { pos: ["K"] }, { pos: ["DEF"] },
];
function defaultStartersFor(picks) {
  const assign = SLOTS.map(() => null); const used = new Set();
  SLOTS.forEach((slot, i) => {
    if (slot.pos.length > 1) return; // FLEX filled last, below
    const p = picks.find((x) => !used.has(x.player_id) && slot.pos.includes(x.pos));
    if (p) { assign[i] = p.player_id; used.add(p.player_id); }
  });
  const fi = SLOTS.findIndex((s) => s.pos.length > 1);
  const p = picks.find((x) => !used.has(x.player_id) && SLOTS[fi].pos.includes(x.pos));
  if (p) { assign[fi] = p.player_id; used.add(p.player_id); }
  return assign;
}

async function sb(path, opts) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts && opts.headers),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

function defBracket(pa) {
  if (pa <= 0) return 10; if (pa <= 6) return 7; if (pa <= 13) return 4;
  if (pa <= 20) return 1; if (pa <= 27) return 0; if (pa <= 34) return -1; return -4;
}

// Raw stat deltas only — no scoring-rule math here (that happens client-side).
function boxAthleteRaw(groupName, labels, stats) {
  const gi = (lbl) => { const i = labels.indexOf(lbl); return i >= 0 ? (parseFloat(String(stats[i] || "0").replace(/,/g, "")) || 0) : 0; };
  if (groupName === "passing") return { passYds: gi("YDS"), passTD: gi("TD"), passInt: gi("INT") };
  // Gated on the actual attempt count (CAR/REC) — ESPN has occasionally
  // listed a player under "rushing" with zero real carries but that same
  // game's receiving yards/TD copied in (mirrored fix in index.html's
  // boxAthleteFP, found live on Germie Bernard's box score). A genuine
  // zero-attempt line is 0 everything anyway, so this never drops real stats.
  if (groupName === "rushing") { const car = gi("CAR"); return car > 0 ? { rushYds: gi("YDS"), rushTD: gi("TD") } : {}; }
  if (groupName === "receiving") { const rec = gi("REC"); return rec > 0 ? { rec, recYds: gi("YDS"), recTD: gi("TD") } : {}; }
  if (groupName === "fumbles") return { fumLost: gi("LOST") };
  return {};
}
function parseMadeAttempted(str) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(str || "").trim());
  return m ? { made: parseInt(m[1], 10), attempted: parseInt(m[2], 10) } : { made: 0, attempted: 0 };
}
// The box score's "kicking" group only exposes aggregate FG made/attempted
// (e.g. "2/3") and the longest make — no per-kick distance. scoringPlays
// (same summary response, no extra fetch) lists each successful FG with a
// parseable text description and a clean scoringType flag, which is enough
// to bucket makes by distance band. Missed FGs never appear as scoring
// plays at all, so those come from the aggregate made/attempted gap
// instead — misses aren't distance-banded anyway (flat penalty).
function fgBandsFromScoringPlays(scoringPlays, teamId, kickerName, aggregateMade) {
  const bands = { fg0_39: 0, fg40_49: 0, fg50p: 0 };
  let matched = 0;
  (scoringPlays || []).forEach((p) => {
    if (!p.scoringType || p.scoringType.name !== "field-goal") return;
    if (!p.team || String(p.team.id) !== String(teamId)) return;
    const m = /^(.+?)\s+(\d+)\s+Yd Field Goal/.exec(p.text || "");
    if (!m || m[1].trim() !== kickerName) return;
    matched++;
    const dist = parseInt(m[2], 10);
    if (dist >= 50) bands.fg50p++; else if (dist >= 40) bands.fg40_49++; else bands.fg0_39++;
  });
  // Never silently drop credit for a make we couldn't classify (e.g. a
  // name-formatting mismatch) — attribute any leftover makes to the
  // cheapest band rather than losing the points entirely.
  bands.fg0_39 += Math.max(0, aggregateMade - matched);
  return bands;
}
function kickerRawFromBox(labels, stats, scoringPlays, teamId, kickerName) {
  const gi = (lbl) => { const i = labels.indexOf(lbl); return i >= 0 ? String(stats[i] || "0/0") : "0/0"; };
  const fg = parseMadeAttempted(gi("FG"));
  const xp = parseMadeAttempted(gi("XP"));
  const bands = fgBandsFromScoringPlays(scoringPlays, teamId, kickerName, fg.made);
  return {
    fgMade0_39: bands.fg0_39, fgMade40_49: bands.fg40_49, fgMade50p: bands.fg50p,
    fgMissed: Math.max(0, fg.attempted - fg.made),
    xpMade: xp.made, xpMissed: Math.max(0, xp.attempted - xp.made),
  };
}
function qualifyingTDCount(raw) { return (raw.rushTD || 0) + (raw.recTD || 0); }

function teamDefenseBonusRaw(statGroups) {
  let sacks = 0, defTD = 0, ints = 0, intTD = 0;
  (statGroups || []).forEach((g) => {
    const labels = g.labels || [];
    const gi = (a, lbl) => { const i = labels.indexOf(lbl); return i >= 0 ? (parseFloat(String((a.stats || [])[i] || "0").replace(/,/g, "")) || 0) : 0; };
    if (g.name === "defensive") (g.athletes || []).forEach((a) => { sacks += gi(a, "SACKS"); defTD += gi(a, "TD"); });
    else if (g.name === "interceptions") (g.athletes || []).forEach((a) => { ints += gi(a, "INT"); intTD += gi(a, "TD"); });
  });
  return { sacks, ints, td: defTD + intTD };
}

// Thrown for a 429 specifically, so callers can distinguish "back off" from
// an ordinary transient failure worth just retrying next cycle.
class RateLimitedError extends Error {}
async function espnFetch(url) {
  const r = await fetch(url);
  if (r.status === 429) throw new RateLimitedError(`429 from ${url}`);
  if (!r.ok) throw new Error(`${r.status} from ${url}`);
  return r.json();
}

const gameIdCache = {};
async function findGameId(teamId, wk, seasonType) {
  const ck = `${teamId}_${wk}_${seasonType}`;
  if (gameIdCache[ck] !== undefined) return gameIdCache[ck];
  const sd = await espnFetch(`${ESPN}/teams/${teamId}/schedule`);
  const ev = (sd.events || []).find((e) => e.week && e.week.number === wk && e.seasonType && e.seasonType.type === seasonType);
  gameIdCache[ck] = ev ? ev.id : null;
  return gameIdCache[ck];
}
// Cheap single check: is there any real reason to be polling right now at all?
// Cuts request volume by well over 90% outside actual game windows, which is
// the main thing that could ever get this rate-limited or blocked.
async function anyGameLiveOrStartingSoon() {
  const d = await espnFetch(`${ESPN}/scoreboard`);
  const now = Date.now();
  return (d.events || []).some((e) => {
    const state = e.status && e.status.type && e.status.type.state;
    if (state === "in") return true;
    if (state === "pre") return new Date(e.date).getTime() - now < 30 * 60 * 1000;
    return false;
  });
}

async function fetchGameBox(eventId) {
  const d = await espnFetch(`${ESPN}/summary?event=${eventId}`);
  const comp = (d.header && d.header.competitions && d.header.competitions[0]) || {};
  const status = comp.status || {};
  const state = status.type && status.type.state;
  const final = !!(status.type && status.type.completed);
  // Pregame has no real period — defaulting to 1 would misreport "already
  // in Q1" for a game that hasn't kicked off (same bug fixed client-side).
  const period = final ? 4 : state === "pre" ? 0 : (status.period || 1);
  const scoringPlays = d.scoringPlays || [];
  const byAthlete = {}, teamStats = {};
  ((d.boxscore && d.boxscore.players) || []).forEach((tm) => {
    const tid = String((tm.team && tm.team.id) || "");
    if (tid) teamStats[tid] = tm.statistics || [];
    (tm.statistics || []).forEach((g) => {
      (g.athletes || []).forEach((a) => {
        const id = String((a.athlete && a.athlete.id) || ""); if (!id) return;
        const name = (a.athlete && a.athlete.displayName) || "";
        const raw = g.name === "kicking"
          ? kickerRawFromBox(g.labels || [], a.stats || [], scoringPlays, tid, name)
          : boxAthleteRaw(g.name, g.labels || [], a.stats || []);
        if (!byAthlete[id]) byAthlete[id] = { raw: {}, qtd: 0, name };
        Object.keys(raw).forEach((k) => { byAthlete[id].raw[k] = (byAthlete[id].raw[k] || 0) + raw[k]; });
        byAthlete[id].qtd += qualifyingTDCount(raw);
      });
    });
  });
  const linescores = {}, teamScores = {};
  (comp.competitors || []).forEach((c) => {
    const tid = String((c.team && c.team.id) || "");
    linescores[tid] = (c.linescores || []).map((l) => l.value || 0);
    // Mirrors index.html's fetchGameBoxFP — "points allowed so far" reads
    // more reliably from the opponent's current overall score than a sum
    // of per-quarter linescores, since ESPN doesn't always fill in the
    // CURRENT (still in progress) quarter's linescore entry until it ends.
    teamScores[tid] = Number(c.score) || 0;
  });
  return { period, final, byAthlete, linescores, teamScores, teamStats, scoringPlays };
}
// Real quarter (1-4, chronological) of each of this athlete's touchdown
// scoring plays, matched by role — mirrors index.html's identical
// function (matchingTDPeriods), verified against live ESPN data there.
// Kept in sync manually since this file has no shared-module setup with
// the client script.
function matchingTDPeriods(scoringPlays, name, role) {
  if (!name) return [];
  return (scoringPlays || []).filter((p) => {
    const t = (p.type && p.type.text) || "", txt = p.text || "";
    if (role === "passer") return t === "Passing Touchdown" && txt.indexOf("from " + name + " (") >= 0;
    if (role === "receiver") return t === "Passing Touchdown" && txt.indexOf(name + " ") === 0;
    if (role === "rusher") return t === "Rushing Touchdown" && txt.indexOf(name + " ") === 0;
    return false;
  }).map((p) => (p.period && p.period.number) || null);
}

async function pollLeague(league) {
  const wk = league.current_week;
  if (!wk || wk < 1) return;
  const testPreseason = !!(league.settings && league.settings.league && league.settings.league.testPreseason);
  const seasonType = testPreseason ? 1 : 2;
  const picks = await sb(`draft_picks?select=player_id,pos,team&league_id=eq.${league.id}`);
  const offense = picks.filter((p) => p.pos !== "DEF" && p.team && TEAM_ID_BY_AB[p.team]);
  const defenses = picks.filter((p) => p.pos === "DEF" && p.team && TEAM_ID_BY_AB[p.team]);
  const byTeam = {};
  [...offense, ...defenses].forEach((p) => { (byTeam[p.team] = byTeam[p.team] || []).push(p); });

  const updates = [];
  for (const ab of Object.keys(byTeam)) {
    const teamId = TEAM_ID_BY_AB[ab];
    let eventId;
    try { eventId = await findGameId(teamId, wk, seasonType); }
    catch (e) { if (e instanceof RateLimitedError) throw e; console.error(`schedule fetch failed for ${ab}`, e.message); continue; }
    if (!eventId) continue;
    let box;
    try { box = await fetchGameBox(eventId); }
    catch (e) { if (e instanceof RateLimitedError) throw e; console.error(`box fetch failed for ${ab}`, e.message); continue; }
    for (const p of byTeam[ab]) {
      if (p.pos === "DEF") {
        const athleteId = `def_${teamId}`;
        const opp = Object.keys(box.teamScores).find((t) => t !== String(teamId));
        const totalAllowed = opp != null ? (box.teamScores[opp] || 0) : 0;
        const bonus = teamDefenseBonusRaw(box.teamStats[String(teamId)]);
        updates.push({ athleteId, week: wk, period: box.period, isDef: true, totalAllowed, bonus });
      } else {
        const espnId = String(p.player_id || "").replace(/^e/, "");
        const r = box.byAthlete[espnId]; if (!r) continue;
        updates.push({ athleteId: p.player_id, week: wk, period: box.period, isDef: false, raw: r.raw, qtd: r.qtd, name: r.name, scoringPlays: box.scoringPlays });
      }
    }
  }
  if (!updates.length) { console.log(`league ${league.id}: nothing to poll (week ${wk})`); return; }

  const ids = updates.map((u) => u.athleteId);
  const existing = await sb(`player_week_stats?select=*&athlete_id=in.(${ids.join(",")})&week=eq.${wk}`);
  const byId = {}; (existing || []).forEach((r) => { byId[r.athlete_id] = r; });

  const rows = updates.map((u) => {
    const prev = byId[u.athleteId];
    const qpts = (prev && prev.q_pts) ? { ...prev.q_pts } : {};
    const prevStats = (prev && prev.prev_stats) ? prev.prev_stats : {};
    let prevQtd = prev ? (prev.prev_qtd || 0) : 0, prevBonus = prev ? (prev.prev_bonus || 0) : 0, newPrevStats = prevStats, prevTotalOut = 0;
    const hadQtdBefore = prevQtd > 0; // captured before prevQtd gets reused below to hold the new cumulative total
    if (u.isDef) {
      qpts.pa = { allowed: u.totalAllowed, fp: defBracket(u.totalAllowed) };
      const curBonusFp = u.bonus.sacks + u.bonus.ints * 2 + u.bonus.td * 6; // informational only, clients recompute with real settings
      const bonusDelta = Math.max(0, curBonusFp - prevBonus);
      const tdDelta = Math.max(0, u.bonus.td - prevQtd);
      const sackDelta = Math.max(0, u.bonus.sacks - (prevStats.sacks || 0));
      const intDelta = Math.max(0, u.bonus.ints - (prevStats.ints || 0));
      const cur = qpts[u.period] || { fp: 0, qtd: 0, stats: {} };
      qpts[u.period] = {
        fp: Math.round((cur.fp + bonusDelta) * 10) / 10,
        qtd: (cur.qtd || 0) + tdDelta,
        stats: { sacks: (cur.stats && cur.stats.sacks || 0) + sackDelta, ints: (cur.stats && cur.stats.ints || 0) + intDelta, defTD: (cur.stats && cur.stats.defTD || 0) + tdDelta },
      };
      prevBonus = curBonusFp; prevQtd = u.bonus.td;
      newPrevStats = { sacks: u.bonus.sacks, ints: u.bonus.ints };
    } else {
      const curFp = (u.raw.passYds || 0) / 25 + (u.raw.passTD || 0) * 4 + (u.raw.passInt || 0) * -2
        + (u.raw.rushYds || 0) / 10 + (u.raw.rushTD || 0) * 6
        + (u.raw.rec || 0) * 0.5 + (u.raw.recYds || 0) / 10 + (u.raw.recTD || 0) * 6
        + (u.raw.fumLost || 0) * -2
        + (u.raw.fgMade0_39 || 0) * 3 + (u.raw.fgMade40_49 || 0) * 4 + (u.raw.fgMade50p || 0) * 5
        + (u.raw.fgMissed || 0) * -1 + (u.raw.xpMade || 0) * 1; // informational only, clients recompute with real settings
      const prevTotal = prev ? (prev.prev_total || 0) : 0;
      const totalDelta = Math.max(0, curFp - prevTotal);
      const statsDelta = {};
      Object.keys(u.raw).forEach((k) => { statsDelta[k] = Math.max(0, (u.raw[k] || 0) - (prevStats[k] || 0)); });
      // TDs placed in their REAL quarter (via scoringPlays), not "whichever
      // quarter is live right now" — mirrors index.html's identical fix
      // (matchingTDPeriods), same root cause: a TD near the end of a
      // quarter can go unpolled until after that quarter ends.
      const tdFields = [
        { key: "passTD", role: "passer", pts: 4, qualifies: false },
        { key: "rushTD", role: "rusher", pts: 6, qualifies: true },
        { key: "recTD", role: "receiver", pts: 6, qualifies: true },
      ];
      let tdPointsTotal = 0;
      tdFields.forEach(({ key, role, pts, qualifies }) => {
        const n = statsDelta[key] || 0; if (!n) return;
        const already = prevStats[key] || 0;
        const periods = matchingTDPeriods(u.scoringPlays, u.name, role).slice(already, already + n);
        while (periods.length < n) periods.push(null); // never drop credit if scoringPlays can't confirm it
        periods.forEach((per) => {
          const q = (per >= 1 && per <= 4) ? per : u.period;
          const bucket = qpts[q] || { fp: 0, qtd: 0, stats: {} };
          bucket.fp = Math.round((bucket.fp + pts) * 10) / 10;
          if (qualifies) bucket.qtd = (bucket.qtd || 0) + 1;
          bucket.stats = { ...bucket.stats, [key]: ((bucket.stats && bucket.stats[key]) || 0) + 1 };
          qpts[q] = bucket;
          tdPointsTotal += pts;
        });
      });
      const remainingFp = Math.max(0, Math.round((totalDelta - tdPointsTotal) * 10) / 10);
      const remainingStatsDelta = { ...statsDelta };
      tdFields.forEach(({ key }) => { delete remainingStatsDelta[key]; });
      const cur = qpts[u.period] || { fp: 0, qtd: 0, stats: {} };
      const mergedStats = { ...(cur.stats || {}) };
      Object.keys(remainingStatsDelta).forEach((k) => { mergedStats[k] = (mergedStats[k] || 0) + remainingStatsDelta[k]; });
      qpts[u.period] = { fp: Math.round((cur.fp + remainingFp) * 10) / 10, qtd: cur.qtd || 0, stats: mergedStats };
      prevQtd = u.qtd; prevBonus = 0; newPrevStats = u.raw;
      prevTotalOut = curFp; // true cumulative fp-to-date, needed for next run's delta calc
    }
    // Hot Start needs real chronological order across DIFFERENT games (a Q1
    // score in the 8pm game happens later in real time than a Q4 score in a
    // 1pm game), which quarter number alone can't express. Stamped once,
    // the first time this player's cumulative qualifying-TD count goes from
    // zero to nonzero — close enough given the ~20s live poll cadence — and
    // never overwritten after that.
    const firstQtdAt = (prev && prev.first_qtd_at) ? prev.first_qtd_at
      : (!hadQtdBefore && prevQtd > 0) ? new Date().toISOString() : null;
    return {
      athlete_id: u.athleteId, week: wk, season: 2026, q_pts: qpts,
      prev_total: u.isDef ? 0 : prevTotalOut, prev_qtd: prevQtd, prev_bonus: prevBonus, prev_stats: newPrevStats,
      first_qtd_at: firstQtdAt, season_type: testPreseason ? "preseason" : "regular",
    };
  });

  await sb("player_week_stats", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows) });
  console.log(`league ${league.id}: polled ${rows.length} players for week ${wk}`);
}

async function pollOnce() {
  const leagues = await sb("leagues?select=id,settings,current_week&current_week=not.is.null");
  for (const league of leagues) {
    try { await pollLeague(league); }
    catch (e) { if (e instanceof RateLimitedError) throw e; console.error(`league ${league.id} failed:`, e.message); }
  }
  return leagues.length;
}

// ESPN moves its own "current week" scoreboard forward automatically once
// Monday's late game wraps — no query params needed, it always reflects
// today's date. Piggybacking on that means we don't have to hand-roll a
// "Tuesday after MNF" calendar rule ourselves.
async function getEspnRegularSeasonWeek() {
  const d = await espnFetch(`${ESPN}/scoreboard`);
  const wk = d.week && d.week.number;
  const seasonType = d.season && d.season.type;
  if (!wk || seasonType !== 2) return null; // preseason/postseason/off — nothing to auto-advance to
  return wk;
}

// Advances real-season leagues to match the NFL's actual current week, same
// snapshot-then-advance behavior as the set_week() RPC, but run with the
// service role so it works unattended (the RPC requires an authenticated
// commissioner, which no one is at 3am on a Tuesday).
// Leagues in preseason-testing mode are left alone — the commissioner still
// drives those manually since preseason weeks don't map onto ESPN's regular-
// season week counter.
async function autoAdvanceWeeks() {
  let espnWk;
  try { espnWk = await getEspnRegularSeasonWeek(); }
  catch (e) { console.log(`auto-advance: scoreboard check failed (${e.message}) — skipping`); return; }
  if (!espnWk) { console.log("auto-advance: NFL not in regular season right now — skipping"); return; }

  const leagues = await sb("leagues?select=id,settings,current_week&current_week=not.is.null");
  for (const league of leagues) {
    const testPreseason = !!(league.settings && league.settings.league && league.settings.league.testPreseason);
    if (testPreseason) continue;
    if (!(espnWk > league.current_week)) continue;
    try {
      const lineups = await sb(`lineups?select=user_id,starters&league_id=eq.${league.id}`);
      const rows = lineups.map((l) => ({ league_id: league.id, week: league.current_week, user_id: l.user_id, starters: l.starters }));
      // A manager who never opened the Team tab this week has no row in
      // `lineups` at all — without this, they'd get no snapshot, and
      // retroactive scoring (getRealStandings) would fall back to
      // computing a default lineup from CURRENT draft_picks at query time,
      // which is wrong if their roster changed since (a trade/waiver) this
      // week actually happened. Computing their default HERE, at the exact
      // moment the week closes, is the only point it's guaranteed accurate.
      const snapshotted = new Set(lineups.map((l) => l.user_id));
      const members = await sb(`league_members?select=user_id&league_id=eq.${league.id}`);
      const missing = members.filter((m) => !snapshotted.has(m.user_id));
      if (missing.length) {
        const picks = await sb(`draft_picks?select=user_id,player_id,pos&league_id=eq.${league.id}&order=pick_no.asc`);
        for (const m of missing) {
          const mine = picks.filter((p) => p.user_id === m.user_id);
          if (mine.length) rows.push({ league_id: league.id, week: league.current_week, user_id: m.user_id, starters: defaultStartersFor(mine) });
        }
      }
      if (rows.length) {
        await sb("weekly_lineups", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows) });
      }
      await sb(`leagues?id=eq.${league.id}`, { method: "PATCH", body: JSON.stringify({ current_week: espnWk }) });
      console.log(`auto-advance: league ${league.id} week ${league.current_week} -> ${espnWk}`);
      // Trades accepted while a locked player was involved wait in
      // accepted_pending_week until the week actually turns over — this is
      // the automatic (non-commissioner) advance path, so it needs its own
      // copy of the same due-trade sweep set_week() does for the manual
      // path. execute_trade is security-definer and revoked from
      // anon/authenticated, but this poller authenticates with the service
      // role, which bypasses that revoke same as it bypasses RLS.
      const dueTrades = await sb(`trades?select=id&league_id=eq.${league.id}&status=eq.accepted_pending_week&execute_after_week=lt.${espnWk}`);
      for (const dt of dueTrades) {
        try { await sb("rpc/execute_trade", { method: "POST", body: JSON.stringify({ tid: dt.id }) }); }
        catch (e) { console.error(`auto-advance: trade ${dt.id} execute failed:`, e.message); }
      }
    } catch (e) {
      console.error(`auto-advance: league ${league.id} failed:`, e.message);
    }
  }
}

// ============================ WAIVERS ============================
// Weekly waiver processing — piggybacks on this same job (see main()) rather
// than a separate schedule. Runs unconditionally (not gated on a live game),
// same as autoAdvanceWeeks. FORCE_WAIVERS=true (set via workflow_dispatch
// input) bypasses the once-a-week timing check for on-demand testing.
const FORCE_WAIVERS = process.env.FORCE_WAIVERS === "true";
const MIN_WAIVER_GAP_MS = 5 * 24 * 60 * 60 * 1000; // don't reprocess the same week twice

// Fires once we're at least 5 days past the last run AND into the "Tuesday
// night / rest of week" window (Tue 09:00 UTC ~= Tue ~4-5am ET, after MNF).
function isWaiverDue(lastIso) {
  const last = lastIso ? new Date(lastIso).getTime() : 0;
  if (Date.now() - last < MIN_WAIVER_GAP_MS) return false;
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun ... 2=Tue ... 6=Sat
  const hour = now.getUTCHours();
  if (day === 2) return hour >= 9;
  return day === 3 || day === 4 || day === 5 || day === 6 || day === 0 || day === 1;
}

// One attempt at one claim — delegates the whole check-then-execute
// sequence to process_one_waiver_claim (single atomic Postgres transaction,
// row-locked on the claim). This used to be done here via several separate
// REST round-trips (drop, insert, status patch), which meant: a pick_no
// collision against a live user's concurrent make_pick/add_free_agent call
// threw all the way up and aborted the rest of the run; a cancel_waiver_claim
// call could race the swap already being in flight; and two of a manager's
// own pending claims dropping the same player could both "succeed" against
// stale in-memory bookkeeping even though the roster only actually had room
// for one. Locking + doing it all in one transaction server-side closes
// all three at once.
async function tryClaim(claim) {
  try {
    const rows = await sb("rpc/process_one_waiver_claim", { method: "POST", body: JSON.stringify({ cid: claim.id }) });
    const r = (rows && rows[0]) || {};
    return { status: r.result_status || "failed", fail_reason: r.result_reason || "No result from processing" };
  } catch (e) {
    return { status: "failed", fail_reason: `Processing error: ${e.message}` };
  }
}

// Reverse Standings: worst record (then worst point differential) picks
// first — recomputed fresh from standings_cache every run, never persisted.
// Rolling: a persistent list; only successful claims move a team to the
// back, standings never factor in. Either way, within a SINGLE run, winning
// a claim sends that manager to the back of the order for their remaining
// claims (so one favorable position can't sweep every top target) — the
// next week's Reverse Standings run still starts over from fresh standings.
function buildPriorityOrder(league, memberIds, draftOrder) {
  const method = (league.settings && league.settings.league && league.settings.league.waiver) || "Reverse standings";
  // Reverse Standings normally recomputes fresh every run from current
  // standings — EXCEPT within the same week: the whole point of "you moved
  // up because managers ahead of you didn't claim" is that it STICKS for
  // the rest of that week instead of sliding back the moment the next run
  // recomputes from standings. waiver_priority_week marks which week the
  // persisted waiver_priority reflects — matches league.current_week means
  // "carry forward what last run ended with", a mismatch means "new week,
  // recompute fresh" (handled below).
  const sameWeek = league.waiver_priority_week != null && league.waiver_priority_week === league.current_week;
  if (method === "Rolling priority" || sameWeek) {
    const saved = Array.isArray(league.waiver_priority) ? league.waiver_priority.filter((u) => memberIds.includes(u)) : [];
    const missing = memberIds.filter((u) => !saved.includes(u));
    return { method, order: [...saved, ...missing] };
  }
  const cache = Array.isArray(league.standings_cache) ? league.standings_cache : [];
  const byUid = {}; cache.forEach((r) => { byUid[r.uid] = r; });
  // Before any real week has been played every team is tied 0-0-0 in the
  // cache — with no further tiebreak, sorting an all-tied array "worst
  // first" comes out identical to "best first", so Reverse Standings
  // looked exactly like regular standings during preseason testing. Falls
  // back to reversed original draft order for ties (last drafter picks
  // first pre-Week-1), mirrored from index.html's computeWaiverOrder.
  const order_ = Array.isArray(draftOrder) ? draftOrder : [];
  const draftIdx = (uid) => { const i = order_.indexOf(uid); return i < 0 ? order_.length : i; };
  const order = memberIds.slice().sort((a, b) => {
    const ra = byUid[a] || { w: 0, pf: 0, pa: 0 }, rb = byUid[b] || { w: 0, pf: 0, pa: 0 };
    return (ra.w - rb.w) || ((ra.pf - ra.pa) - (rb.pf - rb.pa)) || (draftIdx(b) - draftIdx(a));
  });
  return { method, order };
}

async function processLeagueWaivers(league) {
  const claims = await sb(`waiver_claims?select=*&league_id=eq.${league.id}&status=eq.pending&order=priority.asc`);
  const members = await sb(`league_members?select=user_id,team_name&league_id=eq.${league.id}`);
  const memberIds = members.map((m) => m.user_id);
  league.memberNames = {}; members.forEach((m) => { league.memberNames[m.user_id] = m.team_name || "A team"; });
  const drafts = await sb(`drafts?select=member_order&league_id=eq.${league.id}`);
  const draftOrder = (drafts[0] && drafts[0].member_order) || [];
  const { method, order } = buildPriorityOrder(league, memberIds, draftOrder);

  let currentOrder = order.slice();
  if (claims.length) {
    const queues = {}; claims.forEach((c) => { (queues[c.user_id] = queues[c.user_id] || []).push(c); });

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < currentOrder.length; i++) {
        const uid = currentOrder[i];
        const queue = queues[uid];
        if (!queue || !queue.length) continue;
        const claim = queue.shift();
        const outcome = await tryClaim(claim); // status + fail_reason already persisted by the RPC itself
        progressed = true;
        if (outcome.status === "successful") { currentOrder.splice(i, 1); currentOrder.push(uid); }
        break; // order changed (or a claim was consumed) — restart the scan
      }
    }
  }
  // Persisted unconditionally (both methods, even a zero-claim run) — a
  // Reverse Standings league needs this week's "effective order" on record
  // even when nobody claimed, so a manager who skipped this run while
  // others ahead claimed shows correctly bumped up for the REST of the
  // week, not just for the instant this run finished.
  await sb(`leagues?id=eq.${league.id}`, { method: "PATCH", body: JSON.stringify({
    waiver_priority: currentOrder, waiver_priority_week: league.current_week,
    last_waiver_process: new Date().toISOString() }) });
  console.log(`waivers: league ${league.id} processed (${method}), ${claims.length} claim(s)`);
}

async function processWaivers() {
  const leagues = await sb("leagues?select=id,settings,waiver_priority,waiver_priority_week,current_week,standings_cache,last_waiver_process");
  for (const league of leagues) {
    if (!FORCE_WAIVERS && !isWaiverDue(league.last_waiver_process)) continue;
    try { await processLeagueWaivers(league); }
    catch (e) { console.error(`waivers: league ${league.id} failed:`, e.message); }
  }
}

// ============================ TRADE REVIEW TIMEOUT ============================
// A trade under "Commissioner" or "League vote" review can otherwise sit
// forever if nobody acts — a 48h safety valve force-resolves it. Approves
// by default (silence = no objections) unless a strict majority of votes
// actually CAST are against it; a commissioner override (review_trade) or
// a vote reaching decisive majority of all eligible voters (vote_trade)
// can still resolve it earlier — this is only the fallback for what's left
// stuck at the 48h mark.
const TRADE_REVIEW_HOURS = 48;
async function resolveExpiredTradeReviews() {
  const cutoff = new Date(Date.now() - TRADE_REVIEW_HOURS * 60 * 60 * 1000).toISOString();
  let trades;
  try { trades = await sb(`trades?select=*&status=eq.pending_review&review_started_at=lt.${cutoff}`); }
  catch (e) { console.error("trade review timeout: fetch failed:", e.message); return; }

  for (const t of trades) {
    try {
      const votes = await sb(`trade_votes?select=approve&trade_id=eq.${t.id}`);
      const votesFor = votes.filter((v) => v.approve).length;
      const votesAgainst = votes.filter((v) => !v.approve).length;
      if (votesAgainst > votesFor) {
        // Guarded by status=eq.pending_review: if a vote or commissioner
        // action already resolved this trade in the gap between our SELECT
        // above and now, this PATCH just matches zero rows instead of
        // stomping an already-decided outcome back to "rejected".
        await sb(`trades?id=eq.${t.id}&status=eq.pending_review`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
        console.log(`trade ${t.id}: review window expired, rejected (${votesAgainst} against vs ${votesFor} for)`);
        continue;
      }
      // Auto-approve path delegates to the same execute_trade() every other
      // approval path uses (respond_trade/review_trade/vote_trade) — one
      // atomic Postgres transaction instead of separate REST calls per
      // player, so a mid-swap failure can't leave rosters half-swapped.
      // It also re-validates status/ownership itself, so the race above
      // is covered here too (raises "not awaiting execution" harmlessly
      // if something else already resolved it, caught below).
      await sb("rpc/execute_trade", { method: "POST", body: JSON.stringify({ tid: t.id }) });
      console.log(`trade ${t.id}: review window expired, auto-approve attempted (${votesFor} for vs ${votesAgainst} against)`);
    } catch (e) {
      console.error(`trade ${t.id}: resolution failed:`, e.message);
    }
  }
}

// The GitHub Actions trigger only fires every 5 minutes (its own minimum), but
// each run loops internally every ~20s for its own ~4.5-minute window before
// exiting — so the next scheduled run picks up right as this one finishes,
// giving near-continuous ~20s-cadence polling instead of one-shot-every-5-min.
// Public repos get unlimited free Actions minutes, so the frequency itself
// costs nothing — the actual safeguard against ever being rate-limited is
// doing this ONLY while a game is actually live (see anyGameLiveOrStartingSoon
// above), which cuts total request volume by 90%+ compared to running 24/7.
const LOOP_BUDGET_MS = 270_000; // 4.5 min — leaves headroom before the next 5-min trigger
const POLL_INTERVAL_MS = 20_000;

async function main() {
  await autoAdvanceWeeks();
  await processWaivers();
  await resolveExpiredTradeReviews();

  let live;
  try { live = await anyGameLiveOrStartingSoon(); }
  catch (e) {
    console.log(`scoreboard check failed (${e.message}) — skipping this run, next one retries in 5 min.`);
    return;
  }
  if (!live) { console.log("no NFL games live or starting soon — skipping this run."); return; }

  const start = Date.now();
  let cycle = 0;
  while (true) {
    cycle++;
    try {
      const n = await pollOnce();
      console.log(`cycle ${cycle}: polled ${n} league(s), ${((Date.now() - start) / 1000).toFixed(0)}s elapsed`);
    } catch (e) {
      if (e instanceof RateLimitedError) {
        console.log(`Got a 429 from ESPN on cycle ${cycle} — backing off for the rest of this run. Next scheduled run retries in ~5 min.`);
        break;
      }
      console.error(`cycle ${cycle} failed:`, e.message);
    }
    if (Date.now() - start >= LOOP_BUDGET_MS) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
