// Horários no fuso da pessoa (padrão: Brasília). O banco guarda tudo em UTC.

export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

function localParts(date, timeZone) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}

function offsetMs(instant, timeZone) {
  const parts = localParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

// Converte um horário local (ano, mês, dia, hora, minuto) daquele fuso para um instante UTC.
export function zonedToUtc({ year, month, day, hour, minute }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall - offsetMs(wall, timeZone);
  instant = wall - offsetMs(instant, timeZone);
  const back = localParts(new Date(instant), timeZone);
  if (back.year !== year || back.month !== month || back.day !== day || back.hour !== hour || back.minute !== minute) {
    throw new Error('Esse horário não existe nesse fuso (data inválida ou mudança de horário).');
  }
  return new Date(instant);
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/;
const BRAZILIAN = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(?:às\s+)?(\d{1,2})(?::|h)(\d{2})?$/i;

// Aceita "2026-11-20 09:00", "20/11/2026 09:00", "20/11 9h30", ISO com fuso ou "agora".
export function parseWhen(text, timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  if (!value) throw new Error('Informe o horário, por exemplo: --quando "2026-11-20 09:00".');
  if (/^agora$/i.test(value)) return new Date(now);
  if (ISO_WITH_ZONE.test(value)) return new Date(value);
  const iso = value.match(ISO_LOCAL);
  if (iso) {
    const [, year, month, day, hour, minute] = iso.map(Number);
    return zonedToUtc({ year, month, day, hour, minute }, timeZone);
  }
  const brazilian = value.match(BRAZILIAN);
  if (brazilian) {
    const [, day, month, year, hour, minute] = brazilian;
    const fullYear = year ? Number(year) : localParts(now, timeZone).year;
    return zonedToUtc({ year: fullYear, month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute || 0) }, timeZone);
  }
  throw new Error(`Não entendi o horário "${value}". Use, por exemplo, "2026-11-20 09:00" ou "20/11/2026 09:00".`);
}

export function formatWhen(value, timeZone = DEFAULT_TIME_ZONE) {
  if (!value) return '';
  const format = new Intl.DateTimeFormat('pt-BR', {
    timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return format.format(new Date(value)).replace(', ', ' às ');
}
