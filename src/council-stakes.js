// gambit1 P1: "what does this change mean for ME" — a resident's personal stake in a council lever change,
// estimated from that resident's own income structure over the last world day. Pure and approximate:
// it only informs the resident's vote; no engine rule reads it.
import { wealthTaxDue } from './treasury.js';

const big = (value) => { try { return BigInt(String(value ?? '0')); } catch { return 0n; } };
const sync = (raw) => Math.round(Number(raw) / 1e4) / 100;

export function personalLeverImpact(resident, proposal, stats = {}) {
  const lever = String(proposal?.lever_key || proposal?.lever || '');
  const from = proposal?.previous_value || {};
  const to = proposal?.proposed_value || proposal?.value || {};
  const income = big(resident?.incomeRaw);
  const balance = big(resident?.balanceRaw);
  const out = (deltaRaw, basis) => ({ dailySyncDelta: sync(deltaRaw), direction: deltaRaw > 0n ? 'gain' : deltaRaw < 0n ? 'loss' : 'neutral', basis });
  if (lever === 'tax.income') {
    const delta = BigInt(Math.trunc(Number(to.bps ?? 0) - Number(from.bps ?? 0)));
    return out(-(income * delta) / 10_000n, 'income tax on your reward income last world day');
  }
  if (lever === 'tax.wealth') {
    return out(wealthTaxDue(balance, Number(from.bps ?? 0)) - wealthTaxDue(balance, Number(to.bps ?? 0)), 'daily wealth tax on your current balance');
  }
  if (lever === 'tax.sales') {
    const members = Math.max(1, Number(stats?.memberCount) || (stats?.residents || []).length || 1);
    const perResident = big(stats?.spendingTotalRaw) / BigInt(members);
    const delta = BigInt(Math.trunc(Number(to.bps ?? 0) - Number(from.bps ?? 0)));
    return { ...out(-(perResident * delta) / 10_000n, 'sales tax on an average resident\'s spending (your own spending is not tracked)'), approximate: true };
  }
  if (lever.startsWith('multiplier.')) {
    const source = lever.slice('multiplier.'.length);
    const own = big(resident?.incomeBySourceRaw?.[source]);
    const fromMilli = BigInt(Math.trunc(Number(from.milli ?? 1000))), toMilli = BigInt(Math.trunc(Number(to.milli ?? 1000)));
    if (fromMilli <= 0n) return { dailySyncDelta: null, direction: 'unclear', basis: 'no baseline' };
    return out(own * (toMilli - fromMilli) / fromMilli, `your ${source} income last world day`);
  }
  if (lever.startsWith('price.')) {
    const service = lever.slice('price.'.length);
    const owner = (resident?.ownedServiceTypes || []).includes(service);
    const up = Number(to.milli ?? 1000) > Number(from.milli ?? 1000);
    return { dailySyncDelta: null, direction: owner === up ? 'gain' : 'loss',
      basis: owner ? `you sell ${service}: a higher price earns you more per sale` : `you would pay ${up ? 'more' : 'less'} for ${service}` };
  }
  return { dailySyncDelta: null, direction: 'unclear', basis: lever.startsWith('good.') ? 'depends on whether you buy this good' : 'indirect (treasury spending)' };
}
