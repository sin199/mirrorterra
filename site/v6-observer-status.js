import { getLocale, translateText } from './i18n.js?v=growth4-20261022';

function sampleTime(value, locale) {
  if (!value) return translateText('pending', locale);
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? translateText('unknown', locale) : timestamp.toLocaleString(locale);
}

export function formatV6LifecycleObserverStatus(status, locale = getLocale()) {
  const t = (value) => translateText(value, locale);
  if (!status) return t('Observer status not reported by API');
  const lastSample = `${t('Last sample')}: ${sampleTime(status?.lastSampleAt, locale)}`;
  const worldMinute = status?.lastSampleWorldMinute == null
    ? `${t('World minute')}: ${t('pending')}` : `${t('World minute')}: ${status.lastSampleWorldMinute}`;
  const findings = status?.lastFindingCount == null
    ? `${t('Integrity findings')}: ${t('pending')}` : `${t('Integrity findings')}: ${status.lastFindingCount}`;

  if (!status?.available || !status.running) {
    const reason = status?.reason || 'runtime_not_registered';
    const error = status?.lastError ? ` · ${t('Last error')}: ${status.lastError}` : '';
    return `${t('Observer unavailable')} · ${reason} · ${lastSample} · ${worldMinute}${error}`;
  }

  const error = status.lastError ? ` · ${t('Last error')}: ${status.lastError}` : '';
  const source = status.sourceOfTruth === 'database' ? t('Database source of truth') : t('Source of truth unknown');
  return `${t('Running')} · ${t('Read-only')} · ${source} · ${lastSample} · ${worldMinute} · ${findings}${error}`;
}
