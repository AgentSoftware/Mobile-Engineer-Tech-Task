// All seed times are UK wall-clock times; the API returns UTC instants.
const TZ = 'Europe/London';
const DAY = 86_400_000;

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** 'YYYY-MM-DD' of an instant, in UK time. */
export const londonDate = (ms) => dateFormat.format(ms);

export const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);

export const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

const offsetAt = (ms) => {
  const p = Object.fromEntries(partsFormat.formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ms - (ms % 1000));
};

/** UK wall-clock 'YYYY-MM-DDTHH:mm[:ss]' to epoch ms, correct either side of a clock change. */
export function fromLondon(local) {
  const [date, time] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h, min, s = 0] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min, s);
  return guess - offsetAt(guess - offsetAt(guess));
}

/** A real calendar date in 'YYYY-MM-DD' form (rejects 2026-02-30, which Date.parse rolls over). */
export const isDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value);
};

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

/** 'HH:mm' of an instant, in UK time. */
export const londonTime = (ms) => timeFormat.format(ms);
