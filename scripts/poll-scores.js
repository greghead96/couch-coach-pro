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
  // Inserts/upserts answer 201 with an EMPTY body (no return=representation),
  // and r.json() on an empty body throws "Unexpected end of JSON input".
  // That exception is what silently killed autoAdvanceWeeks every week (the
  // weekly_lineups snapshot upsert threw right before the current_week PATCH,
  // so leagues never advanced) and made every successful stats upsert log as
  // a failure. Parse only when there is something to parse.
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
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
  const byAthlete = {}, teamStats = {}, boxAthletes = {}, teamIds = [];
  ((d.boxscore && d.boxscore.players) || []).forEach((tm) => {
    const tid = String((tm.team && tm.team.id) || "");
    if (tid) { teamStats[tid] = tm.statistics || []; teamIds.push(tid); boxAthletes[tid] = boxAthletes[tid] || []; }
    (tm.statistics || []).forEach((g) => (g.athletes || []).forEach((a) => { const ath = a.athlete || {}; if (ath.id && tid && !boxAthletes[tid].some((x) => x.id === String(ath.id))) boxAthletes[tid].push({ id: String(ath.id), name: ath.displayName || "", first: ath.firstName, last: ath.lastName }); }));
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
  return { period, final, byAthlete, linescores, teamScores, teamStats, scoringPlays, drives: d.drives, boxAthletes, teamIds };
}
// ============================================================================
// CCF PLAY-BY-PLAY PARSER — shared verbatim between index.html and
// scripts/poll-scores.js (generated from the audit scratchpad; edit BOTH).
// Every rule exists because a real ESPN play broke the previous version.
// Reconciled 2026-09-23 against ESPN box scores for all 32 week 1–2 games:
// 590/590 offense players, 64/64 kickers, 64/64 defenses.
//
// Input: drives = ESPN summary.drives; athletesByTeam = { [espnTeamId]: [{id,name,first,last}] }
// built from the game's box score athletes MERGED with each team's full roster
// (so a surname-only fallback can tell "M.Brown" is Hollywood Brown).
// Output ids are ESPN athlete ids (no "e" prefix).
// ============================================================================
// Rewritten play-by-play stat parser (to be ported into index.html + poll-scores.js).
// Every rule below was added because a real ESPN play broke the previous
// version; see audit notes. Reconciled against ESPN per-player box scores.
//
// athletesByTeam: { [teamId]: [{ id, name, first?, last? }] } — from the game's
// own box score so names are ESPN's exact forms.

const SUFFIXES = new Set(["jr.", "jr", "sr.", "sr", "ii", "iii", "iv", "v"]);
const RUSH_VERB = "(?:up the middle|left (?:end|tackle|guard)|right (?:end|tackle|guard)|scrambles|kneels|rushes|runs|for -?\\d+ yards?|for no gain|pushed ob|ran ob)";

function splitName(a) {
  if (a.first && a.last) return { first: a.first, last: a.last.replace(/\s+(Jr\.|Sr\.|II|III|IV|V)$/i, "") };
  const parts = String(a.name || "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  let end = parts.length;
  if (SUFFIXES.has(parts[end - 1].toLowerCase()) && end > 2) end--;
  return { first: parts[0], last: parts.slice(1, end).join(" ") };
}
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function buildMatchers(athletes) {
  const abbrev = [], full = [], byLast = {};
  athletes.forEach((a) => {
    const nm = splitName(a); if (!nm) return;
    const first = nm.first.replace(/\./g, "");
    const prefixes = []; for (let i = 1; i <= Math.min(4, first.length); i++) prefixes.push(reEsc(first.slice(0, i)));
    abbrev.push({ a, re: new RegExp("^(?:" + prefixes.join("|") + ")\\." + reEsc(nm.last) + "(?![A-Za-z])"), lastRe: new RegExp("^[A-Z][a-z]{0,3}\\." + reEsc(nm.last) + "(?![A-Za-z])") });
    full.push({ a, re: new RegExp("^" + reEsc(String(a.name)) + "(?![A-Za-z])") });
    (byLast[nm.last] = byLast[nm.last] || []).push(a);
  });
  const longer = (x, y) => y.a.name.length - x.a.name.length;
  abbrev.sort(longer); full.sort(longer);
  return { abbrev, full, byLast };
}
// Which athlete's name begins at text[idx]? Tries exact "prefix.Last", then
// the full display name (ESPN's alternate scoring-play text format), then a
// last-name-only fallback when that surname is unique on the team (covers
// nickname players like Hollywood/"M.Brown", Bam/"Z.Knight").
function matchAt(M, text, idx) {
  const s = text.slice(idx);
  for (const m of M.abbrev) { const r = m.re.exec(s); if (r) return { a: m.a, len: r[0].length }; }
  for (const m of M.full) { const r = m.re.exec(s); if (r) return { a: m.a, len: r[0].length }; }
  for (const m of M.abbrev) { const r = m.lastRe.exec(s); if (r) { const cands = M.byLast[splitName(m.a).last]; if (cands && cands.length === 1) return { a: m.a, len: r[0].length }; } }
  return null;
}

function coreClause(text) {
  let t = String(text || "").trim();
  // Replay reversal: "... TOUCHDOWN.The Replay Official reviewed ..., and the
  // play was REVERSED.(Shotgun) J.Williams right tackle to NYG 1 for no gain"
  // — only the text after the LAST "REVERSED." describes the play that stands.
  const rv = t.lastIndexOf("REVERSED.");
  if (rv >= 0) t = t.slice(rv + "REVERSED.".length).trim();
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(/^\([^)]*\)\s*/, "");                              // (Shotgun) (No Huddle, Shotgun)
    // "L.Borom reported in as eligible." / "A, B and C reported in as eligible."
    // — lazy .*? because the names themselves contain dots.
    t = t.replace(/^.*?\breported (?:in )?as eligible\.\s*/, "");
    t = t.replace(/^Direct snap to \S+\.\s*/, "");                    // "Direct snap to D.Henry."
    if (t === before) break;
  }
  return t.trim();
}
function yardsFromText(t) {
  const m = /\bfor (-?\d+) (?:yards?|Yds?)\b/i.exec(t); if (m) return parseInt(m[1], 10);
  if (/\bfor no gain\b/i.test(t)) return 0;
  return null;
}
const NULLIFIED = /\bNo Play\b|NULLIFIED/i;

// Spot foul on the offense DURING a run / catch-and-run ("PENALTY on CAR-R.Hunt,
// Offensive Holding, 10 yards, enforced at CAR 36."): the play is not nullified,
// but official yardage only counts from the line of scrimmage to the spot of the
// foul. ESPN's box score does exactly this; play text still says "for 12 yards".
// Returns the credited yards. Defensive penalties never reduce credit.
// Offense-relative field position helpers. start.yardLine is an absolute
// field coordinate (flips by possession); yardsToEndzone is always
// offense-relative, so LOS = 100 - yardsToEndzone. The offense's abbreviation
// in play TEXT (ESPN uses "BLT"/"HST"/"WAS"/"ARZ"/"CLV", not the API codes) is
// read off possessionText: "KC 29" with LOS 29 → KC is the offense.
function fieldCtx(play, text) {
  const st = play && play.start; if (!st || typeof st.yardsToEndzone !== "number") return null;
  const los = 100 - st.yardsToEndzone;
  // Which text abbreviation is the offense? Solve it from the play's own
  // "(to|at) ABBR N for K yards" clause: the side that makes N - LOS === K.
  // (possessionText uses API codes like "ARI"/"LAR"; play text uses "ARZ"/"LA".)
  let offAbbr = null;
  const m = /\b(?:to|at) ([A-Z]{2,3}) (\d+) for (?:(-?\d+) yards?|(no gain))/.exec(String(text || ""));
  if (m) {
    const n = +m[2], k = m[4] ? 0 : +m[3];
    if (n !== 50) { if (n - los === k) offAbbr = m[1]; else if ((100 - n) - los === k) offAbbr = "!" + m[1]; }
  }
  return { los, offAbbr };
}
// Convert "ABBR N" from text to offense-relative yards; null when unknown.
function spotYards(ctx, abbr, n) {
  if (!abbr) return 50;
  if (!ctx.offAbbr) return null;
  if (ctx.offAbbr[0] === "!") return abbr === ctx.offAbbr.slice(1) ? 100 - n : n;
  return abbr === ctx.offAbbr ? n : 100 - n;
}

// Spot foul on the offense DURING a run / catch-and-run ("PENALTY on CAR-R.Hunt,
// Offensive Holding, 10 yards, enforced at CAR 36."): the play is not nullified,
// but official yardage only counts from the line of scrimmage to the spot of the
// foul. ESPN's box score does exactly this; play text still says "for 12 yards".
// Returns the credited yards. Defensive penalties never reduce credit.
function spotFoulCredit(M, full, play, yards) {
  if (yards == null || !/\bPENALTY on\b/.test(full)) return yards;
  const ctx = fieldCtx(play, full); if (!ctx) return yards;
  const re = /PENALTY on ([A-Z]{2,3})-([^,]+),[^.]*?enforced at (?:([A-Z]{2,3}) )?(\d+)/g;
  let m;
  while ((m = re.exec(full))) {
    // Must be the OFFENSE's penalty: team abbreviation must match the offense
    // when known, and the player must be on the offense roster.
    const isOff = ctx.offAbbr ? (ctx.offAbbr[0] === "!" ? m[1] !== ctx.offAbbr.slice(1) : m[1] === ctx.offAbbr) : !!matchAt(M, m[2].trim(), 0);
    if (!isOff) continue;
    const spot = spotYards({ los: ctx.los, offAbbr: ctx.offAbbr || m[1] }, m[3], parseInt(m[4], 10));
    if (spot == null) continue;
    const credit = spot - ctx.los;
    return credit < yards ? Math.max(0, credit) : yards;
  }
  return yards;
}

// Fumble plays. ESPN's box score does NOT simply use the "for N yards" of the
// first sentence. Convention observed across every week 1–2 fumble (25+ plays):
//   fumbleSpot = the "touched at X" spot when present, else the recovery spot
//   carrier recovers it himself ("and recovers at"): credit = (his advance end ?? recovery spot) - LOS
//     "to DAL 31 for 7 yards. FUMBLES, and recovers at DAL 29. C.Skattebo to DAL 28 for 1 yard" → 10
//   anyone else recovers (teammate or opponent): credit = min(text yards, fumbleSpot - LOS)
//     "to TB 32 for 7 yards. FUMBLES, RECOVERED by CIN-B.Mafe at TB 33"        → 7
//     "to ARZ 31 for -1 yards. FUMBLES, RECOVERED by ARZ-W.Johnson at ARZ 34"  → -4
//     "to CLV 36 for 17 yards. FUMBLES, recovered by JAX-B.Tuten at CLV 41"    → 12
//     "to GB 43 for -3 yards. FUMBLES, touched at GB 42, recovered by GB-J.Love at GB 38" → -4
// clauseIdx: where the parsed rush/catch clause starts; the rule only applies
// when that clause comes BEFORE the FUMBLES (the fumbler's own play).
function fumbleSpotYards(M, text, play, carrier, textYards, clauseIdx) {
  const ctx = fieldCtx(play, text); if (!ctx) return null;
  const fm = /\bFUMBLES\b/.exec(text); if (!fm) return null;
  if (clauseIdx != null && clauseIdx > fm.index) return null;
  const tail = text.slice(fm.index);
  const rm = /(?:recovered by [A-Z]{2,3}-\S+ at|(and )?recovers at) (?:([A-Z]{2,3}) )?(\d+)/i.exec(tail);
  if (!rm) return null;
  const selfRecovery = /recovers at/i.test(rm[0]);
  const tm = /\btouched at (?:([A-Z]{2,3}) )?(\d+)/.exec(tail.slice(0, rm.index));
  let spot = spotYards(ctx, rm[2], +rm[3]); if (spot == null) return null;
  if (!selfRecovery) {
    if (tm) { const ts = spotYards(ctx, tm[1], +tm[2]); if (ts != null) spot = ts; }
    return textYards == null ? spot - ctx.los : Math.min(textYards, spot - ctx.los);
  }
  const after = tail.slice(rm.index + rm[0].length);
  const am = /^\.\s+(?=[A-Z])/.exec(after);
  if (am && carrier) {
    const who = matchAt(M, after, am[0].length);
    if (who && who.a.id === carrier.a.id) {
      const adv = /^\s*(?:to|pushed ob at|ran ob at) (?:([A-Z]{2,3}) )?(\d+) for /.exec(after.slice(am[0].length + who.len));
      if (adv) { const s2 = spotYards(ctx, adv[1], +adv[2]); if (s2 != null) spot = s2; }
    }
  }
  return spot - ctx.los;
}
function statsFromDrives(drives, athletesByTeam) {
  const Mby = {}; Object.keys(athletesByTeam).forEach((t) => { Mby[t] = buildMatchers(athletesByTeam[t]); });
  const out = {}; const unmatched = [];
  const ensure = (id) => { if (!out[id]) out[id] = { quarters: { 1: { stats: {} }, 2: { stats: {} }, 3: { stats: {} }, 4: { stats: {} } }, qtdEvents: [] }; return out[id]; };
  const bump = (id, q, key, amt) => { const b = ensure(id).quarters[q]; b.stats[key] = (b.stats[key] || 0) + amt; };
  const markTd = (id, q, wc) => { ensure(id).qtdEvents.push({ period: q, wallclock: wc }); };

  const list = [...((drives && drives.previous) || []), ...(drives && drives.current ? [drives.current] : [])];
  const seen = new Set();
  list.forEach((d) => (d.plays || []).forEach((play) => {
    if (play.id) { if (seen.has(play.id)) return; seen.add(play.id); }
    const type = (play.type && play.type.text) || "";
    const rawPeriod = (play.period && play.period.number) || 0;
    if (rawPeriod < 1) return;
    const q = Math.min(4, rawPeriod); // overtime folds into Q4
    const wc = play.wallclock || null;
    const off = (play.teamParticipants || []).find((t) => t.type === "offense");
    const teamId = off ? String(off.id) : (d.team && String(d.team.id)) || null;
    const M = teamId && Mby[teamId]; if (!M) return;
    const full = String(play.text || "");
    if (type === "Penalty" || NULLIFIED.test(full)) return; // play didn't count

    // The 2-pt conversion text is appended after the TD sentence; split it off.
    const [mainText, twoPtText] = full.split(/TWO-POINT CONVERSION ATTEMPT\./);
    const text = coreClause(mainText);
    const isRushType = type === "Rush" || type === "Rushing Touchdown";
    const isPassType = type === "Pass Reception" || type === "Passing Touchdown";
    const isFumbleType = /^Fumble Recovery|^Muffed Punt|^Sack Opp Fumble/.test(type);
    const isTd = /Touchdown$/.test(type) || /\bTOUCHDOWN\b/.test(text);

    // ---- completion: "{Passer} pass … to {Receiver} … for N yards" (anywhere in clause on fumble plays) ----
    let handled = false;
    let carrier = null, carrierIdx = -1; // for fumLost attribution
    if (isPassType || isFumbleType) {
      const pm = /(^|\.\s+)((?:[A-Z][A-Za-z'-]*\.)?[A-Z][A-Za-z.' -]*?) pass (?!incomplete)/.exec(text);
      if (pm && !/\bintended for\b|\bINTERCEPTED\b/.test(text.slice(pm.index, pm.index + 120))) {
        const passer = matchAt(M, text, pm.index + pm[1].length);
        const afterPass = pm.index + pm[0].length;
        const rel = text.slice(afterPass).search(/\bto\s+[A-Z]/);
        if (passer && rel >= 0) {
          const recvIdx = afterPass + rel + 3;
          const receiver = matchAt(M, text, recvIdx);
          const rawYds = yardsFromText(text.slice(afterPass)) ?? ((isPassType && play.statYardage != null) ? play.statYardage : 0);
          let yds = spotFoulCredit(M, full, play, rawYds);
          if (isFumbleType && receiver) { const fy = fumbleSpotYards(M, text, play, receiver, rawYds, pm.index); if (fy != null) yds = fy; }
          // Lateral after the catch: "... to K.Coleman to HST 33 for 1 yard.
          // Lateral to K.Shakir pushed ob at HST 23 for 10 yards" — lateral yards
          // are receiving yards for the lateral recipient (no catch) and passing
          // yards for the QB.
          let latYds = 0, lateral = null;
          const lm = /\bLateral to\s+(?=[A-Z])/.exec(text.slice(afterPass));
          if (lm) { lateral = matchAt(M, text, afterPass + lm.index + lm[0].length); latYds = yardsFromText(text.slice(afterPass + lm.index)) || 0; }
          bump(passer.a.id, q, "passYds", yds + latYds); if (isTd) bump(passer.a.id, q, "passTD", 1);
          if (receiver) { bump(receiver.a.id, q, "rec", 1); bump(receiver.a.id, q, "recYds", yds); if (isTd && !lateral) { bump(receiver.a.id, q, "recTD", 1); markTd(receiver.a.id, q, wc); } }
          else unmatched.push({ why: "receiver", type, text: full });
          carrier = lateral || receiver; carrierIdx = pm.index;
          if (lateral) { bump(lateral.a.id, q, "recYds", latYds); if (isTd) { bump(lateral.a.id, q, "recTD", 1); markTd(lateral.a.id, q, wc); } }
          handled = true;
        } else if (isPassType) unmatched.push({ why: "passer", type, text: full });
      }
      // ESPN alternate formats: "R 46 Yd pass from P (K Kick)" / "P Pass Complete for 21 Yds to R …"
      if (!handled) {
        let am = /^(.+?) (\d+) Yd pass from (.+?)(?: \(|$)/.exec(text);
        if (am) {
          const recv = matchAt(M, am[1], 0), pass = matchAt(M, am[3], 0), yds = +am[2];
          if (pass) { bump(pass.a.id, q, "passYds", yds); if (isTd) bump(pass.a.id, q, "passTD", 1); }
          if (recv) { bump(recv.a.id, q, "rec", 1); bump(recv.a.id, q, "recYds", yds); if (isTd) { bump(recv.a.id, q, "recTD", 1); markTd(recv.a.id, q, wc); } }
          handled = !!(pass || recv); if (recv) { carrier = recv; carrierIdx = 0; }
        }
        am = /^(.+?) Pass Complete for (-?\d+) Yds to (.+?)(?:\s\1|\s[A-Z][a-z]+ [A-Z][a-z]+ Fumble|$)/.exec(text);
        if (!handled && am) {
          const pass = matchAt(M, am[1], 0), yds = +am[2];
          const recv = matchAt(M, am[3], 0);
          if (pass) { bump(pass.a.id, q, "passYds", yds); if (isTd) bump(pass.a.id, q, "passTD", 1); }
          if (recv) { bump(recv.a.id, q, "rec", 1); bump(recv.a.id, q, "recYds", yds); if (isTd) { bump(recv.a.id, q, "recTD", 1); markTd(recv.a.id, q, wc); } }
          handled = !!(pass || recv); if (recv) { carrier = recv; carrierIdx = 0; }
        }
      }
    }
    // ---- rush: "{Rusher} <rush verb> … for N yards" — verb required so aborted snaps ("C.Humphrey to KC 46") don't count ----
    // Aborted snap the QB recovers and ADVANCES ("C.Williams FUMBLES (Aborted) at
    // CHI 37, and recovers at CHI 36. C.Williams to MIN 45 for 19 yards") is an
    // official rush from the line of scrimmage — statYardage carries that. A
    // plain recovery with no advance is not a rush.
    if (!handled && isFumbleType && /FUMBLES \(Aborted\)/.test(text)) {
      const am = /(?:recovers|RECOVERED by [A-Z]{2,3}-)[^.]*\.\s+(?=[A-Z])/.exec(text);
      if (am) {
        const adv = matchAt(M, text, am.index + am[0].length);
        const rest = adv ? text.slice(am.index + am[0].length + adv.len) : "";
        if (adv && /^\s+(?:to|pushed ob|ran ob)\b.*\bfor (-?\d+) yards?/.test(rest) && play.statYardage != null) {
          bump(adv.a.id, q, "rushYds", play.statYardage); if (isTd) { bump(adv.a.id, q, "rushTD", 1); markTd(adv.a.id, q, wc); }
          handled = true;
        }
      }
    }
    if (!handled && (isRushType || isFumbleType) && !/\bsacked\b|FUMBLES \(Aborted\)/.test(text.slice(0, 80))) {
      const rusher = matchAt(M, text, 0);
      if (rusher && new RegExp("^\\s*" + RUSH_VERB).test(text.slice(rusher.len))) {
        const rawYds = yardsFromText(text) ?? ((isRushType && play.statYardage != null) ? play.statYardage : 0);
        let yds = spotFoulCredit(M, full, play, rawYds);
        if (isFumbleType) { const fy = fumbleSpotYards(M, text, play, rusher, rawYds, 0); if (fy != null) yds = fy; }
        bump(rusher.a.id, q, "rushYds", yds); if (isTd) { bump(rusher.a.id, q, "rushTD", 1); markTd(rusher.a.id, q, wc); }
        carrier = rusher; carrierIdx = 0;
        handled = true;
      } else if (!handled) {
        const am = /^(.+?) (\d+) Yd (?:Rush|Run)\b/.exec(text); // alternate format
        if (am) { const r = matchAt(M, am[1], 0); if (r) { bump(r.a.id, q, "rushYds", +am[2]); if (isTd) { bump(r.a.id, q, "rushTD", 1); markTd(r.a.id, q, wc); } carrier = r; carrierIdx = 0; handled = true; } }
        if (!handled && isRushType) unmatched.push({ why: "rusher", type, text: full });
      }
    }
    // ---- interception thrown (incl. pick-six) ----
    if (type === "Pass Interception Return" || type === "Interception Return Touchdown") {
      const pm = /(^|\.\s+)((?:[A-Z][A-Za-z'-]*\.)?[A-Z][A-Za-z.' -]*?) pass /.exec(text);
      const passer = pm && matchAt(M, text, pm.index + pm[1].length);
      if (passer) bump(passer.a.id, q, "passInt", 1); else unmatched.push({ why: "int-passer", type, text: full });
    }
    // ---- fumble lost (recovered by the other team) ----
    const fIdx = text.search(/\bFUMBLES\b/);
    if (fIdx >= 0) {
      const lostTypes = /\(Opponent\)|^Sack Opp Fumble Recovery$/.test(type);
      if (lostTypes) {
        let fumbler = null;
        if (carrier && carrierIdx >= 0 && carrierIdx < fIdx) fumbler = carrier;
        else {
          // start of the sentence containing FUMBLES, then the one before it
          const starts = [0]; const re = /\.\s+(?=[A-Z(])/g; let m2;
          while ((m2 = re.exec(text))) starts.push(m2.index + m2[0].length);
          const before = starts.filter((i) => i <= fIdx);
          for (let i = before.length - 1; i >= 0 && !fumbler && i >= before.length - 2; i--) {
            const cc = coreClause(text.slice(before[i]));
            const at = text.indexOf(cc, before[i]);
            fumbler = matchAt(M, text, at >= 0 ? at : before[i]);
          }
        }
        if (fumbler) bump(fumbler.a.id, q, "fumLost", 1); else unmatched.push({ why: "fumbler", type, text: full });
      }
    }
    // Alternate-format text has "Fumble" (no FUMBLES): the parsed carrier lost it.
    if (fIdx < 0 && /\(Opponent\)/.test(type) && /\bFumble\b/.test(text) && carrier) bump(carrier.a.id, q, "fumLost", 1);
    // Kickoff / punt return fumble recovered by the kicking team (the play's "offense"):
    // the returner is on the defense side of the play.
    if (fIdx >= 0 && (type === "Kickoff" || type === "Punt")) {
      const rm = /RECOVERED by [A-Z]{2,3}-(\S+) at\b/.exec(text.slice(fIdx)); // greedy: the name itself contains a dot
      // ESPN's "offense" on a kick play isn't reliably the kicking team, so find
      // which side the recoverer is on; the returner is on the other side.
      const dfnId0 = Object.keys(athletesByTeam).find((t) => t !== teamId);
      let recoverer = rm ? matchAt(M, rm[1], 0) : null, MM = dfnId0 && Mby[dfnId0];
      if (!recoverer && rm && MM) { const r2 = matchAt(MM, rm[1], 0); if (r2) { recoverer = r2; MM = M; } }
      if (recoverer) {
        let returner = null;
        if (MM) {
          const starts = [0]; const re = /\.\s+(?=[A-Z(])/g; let m2;
          while ((m2 = re.exec(text))) starts.push(m2.index + m2[0].length);
          const before = starts.filter((i) => i <= fIdx);
          for (let i = before.length - 1; i >= 0 && !returner && i >= before.length - 2; i--) returner = matchAt(MM, text, before[i]);
        }
        if (returner) bump(returner.a.id, q, "fumLost", 1); else unmatched.push({ why: "returner", type, text: full });
      }
    }
    // Muffed punt / kickoff: the returner (on the play's DEFENSE side) loses it when the kicking team recovers.
    if (/\bMUFFS\b/.test(text) && /\(Opponent\)/.test(type)) {
      const mIdx = text.search(/\s+MUFFS\b/);
      const toks = text.slice(0, mIdx).trim().split(/\s+/);
      const dfnId = Object.keys(athletesByTeam).find((t) => t !== teamId);
      const MM = dfnId && Mby[dfnId];
      let who = null;
      for (let n = 1; n <= 3 && !who && MM; n++) { const cand = toks.slice(-n).join(" "); const r = matchAt(MM, cand, 0); if (r && r.len === cand.length) who = r; }
      if (who) bump(who.a.id, q, "fumLost", 1); else unmatched.push({ why: "muffer", type, text: full });
    }
    // ---- two-point conversion: passer + converter each get credit (ESPN default) ----
    if (twoPtText && /ATTEMPT SUCCEEDS/.test(twoPtText)) {
      const c = twoPtText.split("ATTEMPT SUCCEEDS")[0].trim();
      const who = matchAt(M, c, 0);
      const toIdx = c.search(/\bto\s+[A-Z]/);
      if (/\spass\s/.test(" " + c)) { if (who) bump(who.a.id, q, "twoPt", 1); const r = toIdx >= 0 ? matchAt(M, c, toIdx + 3) : null; if (r) bump(r.a.id, q, "twoPt", 1); }
      else if (who) bump(who.a.id, q, "twoPt", 1);
    }
  }));
  return { out, unmatched };
}

// Kicker + team-defense per-quarter stats from play-by-play (companion to parser2.js).
// Kicker stat keys match the app (fgMade0_39, fgMade40_49, fgMade50p, fgMissed, xpMade, xpMissed).
// DEF keys: sacks, ints, defTD (what the app scores today) plus fumRec, defSafety,
// blockedKick (in league settings but never auto-scored by the app — reported separately).

function kickDefFromDrives(drives, athletesByTeam, teamIds) {
  const Mby = {}; Object.keys(athletesByTeam).forEach((t) => { Mby[t] = buildMatchers(athletesByTeam[t]); });
  const k = {}, def = {};
  const ensureK = (id) => (k[id] = k[id] || { quarters: { 1: { stats: {} }, 2: { stats: {} }, 3: { stats: {} }, 4: { stats: {} } } });
  const ensureD = (t) => (def[t] = def[t] || { quarters: { 1: { stats: {} }, 2: { stats: {} }, 3: { stats: {} }, 4: { stats: {} } }, tdEvents: [] });
  const bumpK = (id, q, key) => { const b = ensureK(id).quarters[q].stats; b[key] = (b[key] || 0) + 1; };
  const bumpD = (t, q, key) => { const b = ensureD(t).quarters[q].stats; b[key] = (b[key] || 0) + 1; };
  teamIds.forEach(ensureD);
  const unmatched = [];

  const list = [...((drives && drives.previous) || []), ...(drives && drives.current ? [drives.current] : [])];
  const seen = new Set();
  list.forEach((d) => (d.plays || []).forEach((play) => {
    if (play.id) { if (seen.has(play.id)) return; seen.add(play.id); }
    const type = (play.type && play.type.text) || "";
    const rawPeriod = (play.period && play.period.number) || 0;
    if (rawPeriod < 1) return;
    const q = Math.min(4, rawPeriod);
    const full = String(play.text || "");
    const offP = (play.teamParticipants || []).find((t) => t.type === "offense");
    const off = offP ? String(offP.id) : (d.team && String(d.team.id)) || null;
    const dfn = teamIds.find((t) => t !== off) || null;
    if (!off || !dfn) return;
    const M = Mby[off];
    if (type === "Penalty" || NULLIFIED.test(full)) return;
    const text = coreClause(full.split(/TWO-POINT CONVERSION ATTEMPT\./)[0]);
    const isTd = /\bTOUCHDOWN\b/.test(text);

    // ---------------- kicker ----------------
    if (type === "Field Goal Good" || type === "Field Goal Missed" || type === "Blocked Field Goal") {
      const km = /^(.+?) (\d+) yard field goal is (GOOD|No Good|BLOCKED)/i.exec(text);
      const who = km && M ? matchAt(M, km[1], 0) : null;
      if (who) {
        if (/^GOOD$/i.test(km[3])) { const dist = +km[2]; bumpK(who.a.id, q, dist >= 50 ? "fgMade50p" : dist >= 40 ? "fgMade40_49" : "fgMade0_39"); }
        else bumpK(who.a.id, q, "fgMissed");
      } else unmatched.push({ why: "kicker-fg", type, text: full });
      if (type === "Blocked Field Goal") bumpD(dfn, q, "blockedKick");
    }
    // XP: the kicker's name is the token(s) right before "extra point is". The
    // kicking team is whoever scored the TD — the OFFENSE normally, but the
    // DEFENSE on a pick-six / fumble-return TD. Injury sentences can sit between
    // the TD and the XP ("MIN-I.Rodgers was injured during the play. T.Smack
    // extra point is No Good"), so walk back from the phrase instead of
    // anchoring on sentence starts.
    const xm = /\s+extra point is (GOOD|No Good|Blocked|Aborted)/.exec(text);
    if (xm) {
      const toks = text.slice(0, xm.index).trim().split(/\s+/);
      let who = null, kickTeam = null;
      for (const tid of [off, dfn]) {
        const MM = Mby[tid]; if (!MM) continue;
        for (let n = 1; n <= 3 && !who; n++) { const cand = toks.slice(-n).join(" "); const r = matchAt(MM, cand, 0); if (r && r.len === cand.length) { who = r; kickTeam = tid; } }
        if (who) break;
      }
      if (who) bumpK(who.a.id, q, xm[1] === "GOOD" ? "xpMade" : "xpMissed"); else unmatched.push({ why: "kicker-xp", type, text: full });
      if (xm[1] === "Blocked" && kickTeam) bumpD(teamIds.find((t) => t !== kickTeam), q, "blockedKick");
    }
    // ESPN's alternate scoring-play text: "Denzel Boston 46 Yd pass from Deshaun
    // Watson (Andre Szmyt Kick)" / "(Spencer Shrader PAT Failed)" — full names.
    const pm2 = /\(([A-Z][^()]*?) (Kick|PAT Failed|Kick Failed|PAT Blocked|PAT Missed)\)\.?\s*$/.exec(text);
    if (pm2 && !xm) {
      let who = null;
      for (const tid of [off, dfn]) { const MM = Mby[tid]; if (!MM) continue; const r = matchAt(MM, pm2[1], 0); if (r && r.len === pm2[1].length) { who = r; break; } }
      if (who) bumpK(who.a.id, q, pm2[2] === "Kick" ? "xpMade" : "xpMissed"); else unmatched.push({ why: "kicker-xp-paren", type, text: full });
    }

    // ---------------- defense (the team NOT on offense for this play) ----------------
    // Sacks by TEXT, not type: a QB "sacked … FUMBLES … recovered by [own team]" is
    // typed "Fumble Recovery (Own)", and one was even typed "Pass Incompletion".
    // Team sacks with no credited tackler ("B.Nix sacked at KC 15 for -6 yards.")
    // are real sacks too — the per-player box score omits them (the app's old
    // box-score path under-counted DEF sacks for exactly that reason).
    if (/\bsacked\b/.test(text)) bumpD(dfn, q, "sacks");
    if (type === "Pass Interception Return" || type === "Interception Return Touchdown") bumpD(dfn, q, "ints");
    if (type === "Fumble Recovery (Opponent)" || type === "Sack Opp Fumble Recovery") bumpD(dfn, q, "fumRec");
    if (type === "Blocked Punt") bumpD(dfn, q, "blockedKick");
    if (/\bSAFETY\b/.test(text) && !/NULLIFIED/.test(full)) bumpD(dfn, q, "defSafety");
    // Defensive TD: a touchdown on a turnover / blocked-kick play belongs to the defense.
    if (isTd && (type === "Interception Return Touchdown" || type === "Fumble Recovery (Opponent)" || type === "Sack Opp Fumble Recovery" || type === "Blocked Punt" || type === "Blocked Field Goal")) {
      bumpD(dfn, q, "defTD"); ensureD(dfn).tdEvents.push({ period: q, wallclock: play.wallclock || null });
    }
    // Muffed punt recovered by the punting team for a TD is that team's D/ST TD (punting team is "offense" on the play).
    if (isTd && type === "Muffed Punt Recovery (Opponent)") { bumpD(off, q, "defTD"); bumpD(off, q, "fumRec"); }
    else if (type === "Muffed Punt Recovery (Opponent)") bumpD(off, q, "fumRec");
  }));
  return { k, def, unmatched };
}
// ============================== END SHARED PARSER ==============================

// Full ESPN roster for one team (all groups incl. IR/practice squad), cached
// per session. Merged with the game's own box-score athletes to form the name
// universe the parser matches play text against.
async function getTeamRosterAthletes(teamId){
  const cache=(globalThis.__rosterCache=globalThis.__rosterCache||{});
  if(cache[teamId]) return cache[teamId];
  try{
    const d=await espnFetch(`${ESPN}/teams/${teamId}/roster`);
    const all=[];
    (d.athletes||[]).forEach(g=>(g.items||[]).forEach(a=>{ if(a&&a.id) all.push({id:String(a.id), name:a.displayName||((a.firstName||"")+" "+(a.lastName||"")).trim(), first:a.firstName, last:a.lastName}); }));
    cache[teamId]=all;
  }catch(e){ cache[teamId]=[]; } // fall back to box-score athletes only
  return cache[teamId];
}
async function athletesByTeamForGame(box){
  const out={};
  for(const tid of box.teamIds){
    const roster=(await getTeamRosterAthletes(tid)).slice();
    (box.boxAthletes[tid]||[]).forEach(a=>{ if(!roster.some(x=>x.id===a.id)) roster.push(a); });
    out[tid]=roster;
  }
  return out;
}
function countPlays(drives){ let n=0; [...((drives&&drives.previous)||[]), ...(drives&&drives.current?[drives.current]:[])].forEach(d=>{ n+=(d.plays||[]).length; }); return n; }
// Same hardcoded "informational only" point values used elsewhere in this
// file (real per-league settings are applied client-side) — position-
// agnostic since a stats object only ever has the fields relevant to
// whoever it belongs to populated in the first place.
function infoFpFromStats(stats) {
  return Math.round(((stats.passYds || 0) / 25 + (stats.passTD || 0) * 4 + (stats.passInt || 0) * -2
    + (stats.rushYds || 0) / 10 + (stats.rushTD || 0) * 6
    + (stats.rec || 0) * 0.5 + (stats.recYds || 0) / 10 + (stats.recTD || 0) * 6
    + (stats.fumLost || 0) * -2 + (stats.twoPt || 0) * 2
    + (stats.fgMade0_39 || 0) * 3 + (stats.fgMade40_49 || 0) * 4 + (stats.fgMade50p || 0) * 5 + (stats.fgMissed || 0) * -1 + (stats.xpMade || 0)
    + (stats.sacks || 0) + (stats.ints || 0) * 2 + (stats.defTD || 0) * 6 + (stats.fumRec || 0) * 2 + (stats.defSafety || 0) * 2 + (stats.blockedKick || 0) * 2) * 10) / 10;
}

async function pollLeague(league) {
  const wk = league.current_week;
  if (!wk || wk < 1) return;
  const testPreseason = !!(league.settings && league.settings.league && league.settings.league.testPreseason);
  const seasonType = testPreseason ? 1 : 2;
  if (testPreseason && globalThis.__regularSeasonLive) { console.log(`league ${league.id}: preseason-test league skipped during the regular season (shared stat rows)`); return; }
  const picks = await sb(`draft_picks?select=player_id,player_name,pos,team&league_id=eq.${league.id}`);
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
    // Name universe for this game: both teams' full rosters (cached per run) + box athletes.
    let athletesByTeam;
    try { athletesByTeam = await athletesByTeamForGame(box); } catch (e) { console.error(`roster build failed for ${ab}`, e.message); continue; }
    if (!(box.period > 0)) continue; // pregame: nothing to record yet (a DEF row now would show +10 points allowed before kickoff)
    // A live game whose play list came back EMPTY is a transient/partial ESPN
    // response — writing it would zero everyone. Skip this team this cycle.
    if (box.period > 0 && countPlays(box.drives) === 0) { console.log(`${ab}: empty play list, skipping this cycle`); continue; }
    // EVERYTHING comes from play-by-play, recomputed fresh from the complete
    // play list every cycle (mirrors index.html's pollRealStats exactly).
    const offense = statsFromDrives(box.drives, athletesByTeam).out;
    const kdef = kickDefFromDrives(box.drives, athletesByTeam, box.teamIds);
    for (const p of byTeam[ab]) {
      if (p.pos === "DEF") {
        const athleteId = `def_${teamId}`;
        const opp = Object.keys(box.teamScores).find((t) => t !== String(teamId));
        const d = kdef.def[String(teamId)] || { quarters: { 1: { stats: {} }, 2: { stats: {} }, 3: { stats: {} }, 4: { stats: {} } }, tdEvents: [] };
        updates.push({ athleteId, isDef: true, quarters: d.quarters, tdEvents: d.tdEvents || [], totalAllowed: opp != null ? (box.teamScores[opp] || 0) : 0 });
      } else {
        const espnId = String(p.player_id || "").replace(/^e/, "");
        const o = offense[espnId], k = kdef.k[espnId];
        if (!o && !k && !box.byAthlete[espnId]) continue; // not in this game (inactive) — leave row absent
        const quarters = {};
        for (let q = 1; q <= 4; q++) quarters[q] = { stats: { ...((o && o.quarters[q].stats) || {}), ...((k && k.quarters[q].stats) || {}) } };
        updates.push({ athleteId: p.player_id, isDef: false, quarters, tdEvents: (o && o.qtdEvents) || [] });
      }
    }
  }
  if (!updates.length) { console.log(`league ${league.id}: nothing to poll (week ${wk})`); return; }

  const ids = updates.map((u) => u.athleteId);
  const existing = await sb(`player_week_stats?select=*&athlete_id=in.(${ids.join(",")})&week=eq.${wk}`);
  const byId = {}; (existing || []).forEach((r) => { byId[r.athlete_id] = r; });

  const rows = updates.map((u) => {
    const prev = byId[u.athleteId];
    const qpts = {}; let total = 0, tds = 0, bonus = 0; const sum = {};
    for (let q = 1; q <= 4; q++) {
      const stats = {}; Object.keys(u.quarters[q].stats).forEach((k) => { if (u.quarters[q].stats[k] !== 0) stats[k] = u.quarters[q].stats[k]; });
      Object.keys(stats).forEach((k) => { sum[k] = (sum[k] || 0) + stats[k]; });
      const fp = infoFpFromStats(stats); // informational — clients recompute with league settings
      const qtd = u.isDef ? (stats.defTD || 0) : (stats.rushTD || 0) + (stats.recTD || 0);
      qpts[q] = { fp, qtd, stats }; total += fp; tds += qtd; if (u.isDef) bonus += fp;
    }
    if (u.isDef) {
      const allowed = Math.max(u.totalAllowed, (prev && prev.q_pts && prev.q_pts.pa && prev.q_pts.pa.allowed) || 0);
      qpts.pa = { allowed, fp: defBracket(allowed) }; total += qpts.pa.fp;
    }
    // Hot Start: real chronological moment of the first qualifying TD, from the
    // play's own wallclock, recomputed every cycle from the full play list.
    const earliest = u.tdEvents.reduce((min, e) => (e.wallclock && (!min || e.wallclock < min)) ? e.wallclock : min, null);
    return {
      athlete_id: u.athleteId, week: wk, season: 2026, q_pts: qpts,
      prev_total: Math.round(total * 10) / 10, prev_qtd: tds, prev_bonus: Math.round(bonus * 10) / 10, prev_stats: sum,
      first_qtd_at: earliest || (prev && prev.first_qtd_at) || null, season_type: testPreseason ? "preseason" : "regular",
    };
  }).filter(Boolean);
  if (!rows.length) { console.log(`league ${league.id}: nothing to write for week ${wk} (all rows guarded/skipped)`); return; }
  if (process.env.DRY_RUN) { console.log(`DRY_RUN league ${league.id} week ${wk}: ${rows.length} rows`); globalThis.__dryRows = (globalThis.__dryRows || []).concat(rows); return; }

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
// One scheduled run now covers an entire game window. GitHub's cron proved
// unreliable (2026-09-21: from ~6 runs/hour to ~1 run every 3–5 hours, mid
// Monday-night game), so instead of trusting the next trigger to show up in 5
// minutes, a run keeps cycling while any game is live, keeps going through a
// final pass after the LAST game ends (so the closing plays / overtime land),
// and only then exits. Hard cap sits under GitHub's 6-hour job limit; the
// `concurrency` group in the workflow queues the next trigger behind us.
const LOOP_BUDGET_MS = 5 * 60 * 60 * 1000 + 40 * 60 * 1000; // 5h40m
const POLL_INTERVAL_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 120_000;

async function main() {
  if (!process.env.DRY_RUN) { // DRY_RUN=<file>: compute rows only, write nothing anywhere
    await autoAdvanceWeeks();
    await processWaivers();
    await resolveExpiredTradeReviews();
  }
  try { globalThis.__regularSeasonLive = (await getEspnRegularSeasonWeek()) != null; } catch (e) { globalThis.__regularSeasonLive = true; }

  let live;
  try { live = await anyGameLiveOrStartingSoon(); }
  catch (e) {
    console.log(`scoreboard check failed (${e.message}) — skipping this run, next one retries in 5 min.`);
    return;
  }
  if (!live && !process.env.DRY_RUN) { console.log("no NFL games live or starting soon — skipping this run."); return; }

  const start = Date.now();
  let cycle = 0, quietChecks = 0;
  while (true) {
    cycle++;
    try {
      const n = await pollOnce();
      console.log(`cycle ${cycle}: polled ${n} league(s), ${((Date.now() - start) / 1000).toFixed(0)}s elapsed`);
    } catch (e) {
      if (e instanceof RateLimitedError) {
        console.log(`429 from ESPN on cycle ${cycle} — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s.`);
        await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
      } else console.error(`cycle ${cycle} failed:`, e.message);
    }
    if (process.env.DRY_RUN) break;
    if (Date.now() - start >= LOOP_BUDGET_MS) { console.log("run budget reached — next scheduled run takes over."); break; }
    // Stop only after two consecutive "nothing live" checks following the last
    // poll, so the final whistle's plays are captured by one more full cycle.
    let stillLive = true;
    try { stillLive = await anyGameLiveOrStartingSoon(); } catch (e) { stillLive = true; }
    if (stillLive) quietChecks = 0; else if (++quietChecks >= 2) { console.log("no games live — final pass done, exiting."); break; }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (process.env.DRY_RUN) require("fs").writeFileSync(process.env.DRY_RUN, JSON.stringify(globalThis.__dryRows || []));
}

main().catch((e) => { console.error(e); process.exit(1); });
