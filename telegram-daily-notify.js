/**
 * Daily draw-risk → Telegram notifier (standalone, zero dependencies).
 * Designed to run from GitHub Actions (free) on a daily cron schedule.
 *
 * Required env vars:
 *   FOOTBALL_DATA_API_KEY  – football-data.org API key
 *   TELEGRAM_BOT_TOKEN     – token from @BotFather
 *   TELEGRAM_CHAT_ID       – your chat id
 *   RISK_THRESHOLD         – (optional) minimum risk score, default 50
 */

const LEAGUES = { 'EPL': 'PL', 'La Liga': 'PD', 'Serie A': 'SA', 'Ligue 1': 'FL1' };
const BASE_URL = 'https://api.football-data.org/v4';
const DRAW_THRESHOLD = 2;
const DAYS_BACK = 90;

const {
  FOOTBALL_DATA_API_KEY: apiKey,
  TELEGRAM_BOT_TOKEN: botToken,
  TELEGRAM_CHAT_ID: chatId,
  RISK_THRESHOLD: thresholdEnv,
} = process.env;

const RISK_THRESHOLD = Number(thresholdEnv) || 50;

if (!apiKey || !botToken || !chatId) {
  console.error('Missing FOOTBALL_DATA_API_KEY, TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
  process.exit(1);
}

async function apiGet(endpoint, params, attempt = 0) {
  const url = new URL(BASE_URL + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: { 'X-Auth-Token': apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429 && attempt < 3) {
    const wait = 15000 * (attempt + 1);
    console.log(`Rate limited on ${endpoint}, waiting ${wait / 1000}s...`);
    await new Promise((r) => setTimeout(r, wait));
    return apiGet(endpoint, params, attempt + 1);
  }
  if (!res.ok) return null;
  return res.json();
}

function getTeamDrawStats(teamName, league, history) {
  const leagueMatches = (history[teamName] || []).filter((m) => m.league === league);
  if (!leagueMatches.length) {
    return { total_matches: 0, draws: 0, draw_rate: 0, consecutive_draws: 0, recent_trend: 'N/A', form: 'unknown' };
  }
  const recent = leagueMatches.slice(0, 10);
  const draws = recent.filter((m) => m.gf === m.ga).length;
  const drawRate = (draws / recent.length) * 100;
  let consecutive = 0;
  for (const m of recent) {
    if (m.gf === m.ga) consecutive++;
    else break;
  }
  let trend = 'limited data';
  if (recent.length >= 6) {
    const firstThree = recent.slice(-3).filter((m) => m.gf === m.ga).length;
    const lastThree = recent.slice(0, 3).filter((m) => m.ga != null && m.gf === m.ga).length;
    trend = lastThree > firstThree ? '↑ increasing' : lastThree < firstThree ? '↓ decreasing' : '→ stable';
  }
  const form = drawRate >= 40 ? 'very_draw_prone' : drawRate >= 25 ? 'draw_prone' : drawRate >= 15 ? 'normal' : 'rarely_draws';
  return {
    total_matches: recent.length,
    draws,
    draw_rate: Math.round(drawRate * 10) / 10,
    consecutive_draws: consecutive,
    recent_trend: trend,
    form,
  };
}

function calcRisk(homeTeam, awayTeam, league, homeStats, awayStats) {
  let risk = 0;
  const factors = [];
  if (homeStats.consecutive_draws >= DRAW_THRESHOLD) {
    risk += 35;
    factors.push(`${homeTeam} has ${homeStats.consecutive_draws} consecutive ${league} draws`);
  }
  if (awayStats.consecutive_draws >= DRAW_THRESHOLD) {
    risk += 35;
    factors.push(`${awayTeam} has ${awayStats.consecutive_draws} consecutive ${league} draws`);
  }
  if (homeStats.draw_rate >= 30) {
    risk += 15;
    factors.push(`${homeTeam} draws ${homeStats.draw_rate.toFixed(1)}% (very draw-prone)`);
  } else if (homeStats.draw_rate >= 20) {
    risk += 10;
    factors.push(`${homeTeam} draws ${homeStats.draw_rate.toFixed(1)}% (draw-prone)`);
  }
  if (awayStats.draw_rate >= 30) {
    risk += 15;
    factors.push(`${awayTeam} draws ${awayStats.draw_rate.toFixed(1)}% (very draw-prone)`);
  } else if (awayStats.draw_rate >= 20) {
    risk += 10;
    factors.push(`${awayTeam} draws ${awayStats.draw_rate.toFixed(1)}% (draw-prone)`);
  }
  if (homeStats.recent_trend.includes('increasing')) {
    risk += 8;
    factors.push(`${homeTeam}'s draw trend is increasing`);
  }
  if (awayStats.recent_trend.includes('increasing')) {
    risk += 8;
    factors.push(`${awayTeam}'s draw trend is increasing`);
  }
  if (homeStats.form === 'very_draw_prone' && awayStats.form === 'very_draw_prone') {
    risk += 10;
    factors.push('Both teams are highly draw-prone');
  }
  return { risk: Math.min(100, risk), factors };
}

async function main() {
  const now = new Date();
  const target = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - DAYS_BACK * 86400000).toISOString().slice(0, 10);

  const failedLeagues = [];
  const leagueMatches = [];
  for (const [key, code] of Object.entries(LEAGUES)) {
    const data = await apiGet(`/competitions/${code}/matches`, { dateFrom: start, dateTo: target });
    if (data?.matches) leagueMatches.push([key, data.matches]);
    else failedLeagues.push(key);
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (leagueMatches.length === 0) {
    throw new Error(`No league data returned (failed: ${failedLeagues.join(', ')})`);
  }

  const todayMatches = [];
  const results = [];
  leagueMatches.forEach(([key, ms]) => {
    for (const m of ms) {
      const date = (m.utcDate || '').slice(0, 10);
      const score = m.score?.fullTime || {};
      if (m.status === 'FINISHED' && score.home != null && score.away != null) {
        results.push({ league: key, team: m.homeTeam?.name, opponent: m.awayTeam?.name, gf: score.home, ga: score.away, date });
        results.push({ league: key, team: m.awayTeam?.name, opponent: m.homeTeam?.name, gf: score.away, ga: score.home, date });
      } else if ((m.status === 'SCHEDULED' || m.status === 'TIMED') && date === target) {
        todayMatches.push({
          league: key,
          home: m.homeTeam?.name,
          away: m.awayTeam?.name,
          time: (m.utcDate || '').slice(11, 16) || 'TBC',
        });
      }
    }
  });
  results.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const history = {};
  for (const r of results) {
    if (!history[r.team]) history[r.team] = [];
    history[r.team].push(r);
  }

  const high = todayMatches
    .map((m) => {
      const homeStats = getTeamDrawStats(m.home, m.league, history);
      const awayStats = getTeamDrawStats(m.away, m.league, history);
      const { risk, factors } = calcRisk(m.home, m.away, m.league, homeStats, awayStats);
      return { ...m, risk, factors };
    })
    .filter((m) => m.risk >= RISK_THRESHOLD)
    .sort((a, b) => b.risk - a.risk);

  console.log(`Target ${target}: ${todayMatches.length} fixtures, ${high.length} at risk >= ${RISK_THRESHOLD}${failedLeagues.length ? `, failed leagues: ${failedLeagues.join(', ')}` : ''}`);

  let text;
  if (high.length === 0) {
    text = `⚽ Draw Risk Alert — ${target}\n\nNo matches with risk >= ${RISK_THRESHOLD} today.`;
  } else {
    text = `⚽ Draw Risk Alert — ${target}\n${high.length} high-risk match(es):\n\n`;
    high.forEach((m, i) => {
      text += `${i + 1}. ${m.home} vs ${m.away} (${m.league}) ${m.time} UTC\n   Risk: ${m.risk}/100\n`;
      m.factors.forEach((f) => { text += `   • ${f}\n`; });
      text += '\n';
    });
  }
  if (failedLeagues.length) text += `⚠️ Data unavailable for: ${failedLeagues.join(', ')}`;
  if (text.length > 4000) text = text.slice(0, 4000) + '\n…';

  const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const tg = await tgRes.json();
  if (!tg.ok) throw new Error(`Telegram error: ${tg.description}`);
  console.log('Telegram notification sent');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
