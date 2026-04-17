const { portalTz } = require('./roomQuote');
const { getDayTimeline } = require('./roomDayTimeline');

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {import('pg').Pool|import('pg').PoolClient} client
 * @param {string} roomId
 * @param {number} year
 * @param {number} month 1–12
 * @param {string} minBookDate YYYY-MM-DD (hub today)
 */
async function getMonthDayStates(client, roomId, year, month, minBookDate) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const anchor = `${year}-${pad2(month)}-01`;
  const { rows: fw } = await client.query(
    `SELECT EXTRACT(DOW FROM (($1::text || ' 12:00:00')::timestamp AT TIME ZONE $2::text))::int AS wd`,
    [anchor, portalTz()]
  );
  const firstWeekday = Number(fw[0].wd);
  const days = {};
  for (let d = 1; d <= lastDay; d += 1) {
    const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
    if (dateStr < minBookDate) {
      days[dateStr] = 'unavailable';
      continue;
    }
    const tl = await getDayTimeline(client, roomId, dateStr);
    if (tl.past || tl.closed || tl.noHours || !tl.slots || !tl.slots.length) {
      days[dateStr] = 'unavailable';
      continue;
    }
    const nowMs = Date.now() - 60 * 1000;
    const futureSlots = tl.slots.filter((s) => new Date(s.starts_at).getTime() >= nowMs);
    const futureOpen = futureSlots.some((s) => s.state === 'open');
    if (!futureOpen) {
      days[dateStr] = 'unavailable';
      continue;
    }
    const futureBusy = futureSlots.some((s) =>
      ['block', 'booked', 'pending'].includes(s.state)
    );
    days[dateStr] = futureBusy ? 'partial' : 'full';
  }
  return { year, month, tz: portalTz(), firstWeekday, daysInMonth: lastDay, days };
}

module.exports = { getMonthDayStates };
