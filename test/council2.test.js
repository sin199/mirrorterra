// council2 (kept parts under council3): no treasury ceiling (0029) and price competition between owners.
// council3 removed the recirculation (grants, prizes, purchases, bounties, any-work contracts); see council3.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as treasuryModule from '../src/treasury.js';
import { COUNCIL_ACTIONS, COUNCIL_GOVERNOR_ID, ownerPriceDecisions, ownerPriceOptions } from '../src/council.js';
import { treasuryFreeBalance } from '../src/treasury.js';
import { quoteSyncInternalServicePrice, syncInternalSellerValueRanks } from '../src/world-businesses.js';

const ids = Array.from({ length: 10 }, (_, i) => (i === 0 ? COUNCIL_GOVERNOR_ID
  : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));

test('no ceiling: 0029 drops only the daily ceiling, keeps every overdraft rule; no ceiling left in code', async () => {
  const strip = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const sql = strip(await readFile(new URL('../migrations/0029_council_recirculation.sql', import.meta.url), 'utf8'));
  assert.match(sql, /CREATE OR REPLACE FUNCTION validate_world_sync_treasury_entry\(\)/);
  assert.doesNotMatch(sql, /50000000|daily ceiling|spent_today/);
  assert.match(sql, /RAISE EXCEPTION 'SYNC treasury entry exceeds the resident balance'/);
  assert.match(sql, /RAISE EXCEPTION 'SYNC treasury entry exceeds the treasury balance'/);
  assert.match(sql, /RAISE EXCEPTION 'SYNC treasury entries are append-only'/);
  assert.doesNotMatch(sql, /DROP (TABLE|VIEW|COLUMN|CONSTRAINT|TRIGGER|FUNCTION)/i);
  assert.doesNotMatch(sql, /arc_sync_payout_outbox|arc_sync_ledger_postings|planned_action|world_treasury_bounties/);
  assert.doesNotMatch(sql, /GRANT[^;]*(UPDATE|DELETE)[^;(]*ON world_sync_treasury_entries/);
  assert.equal(treasuryModule.TREASURY_DAILY_CEILING_RAW, undefined);
  assert.equal(treasuryModule.governorDailyAllowance, undefined);
  const council = await readFile(new URL('../src/council.js', import.meta.url), 'utf8');
  assert.doesNotMatch(council, /TREASURY_DAILY_CEILING|governorDailyAllowance|governorAllowance\(/);
  assert.equal(treasuryFreeBalance({ treasuryBalanceRaw: 10n, escrowRaw: 30n }), 0n, 'never negative');
});

test('price competition: excess stock undercuts, scarcity raises, buyers prefer the better value, prices spread and move', () => {
  const sellers = [
    { serviceId: 'a', serviceType: 'food_service', ownerAgentId: ids[2], stockUnits: 6, priceMilli: 1000 },
    { serviceId: 'b', serviceType: 'food_service', ownerAgentId: ids[3], stockUnits: 0, priceMilli: 1000 },
    { serviceId: 'c', serviceType: 'food_service', ownerAgentId: ids[4], stockUnits: 1, priceMilli: 900 },
    { serviceId: 'd', serviceType: 'social_service', ownerAgentId: ids[5], stockUnits: 1, priceMilli: 1000 }];
  const first = Object.fromEntries(ownerPriceDecisions({ services: sellers, demandByType: { food_service: 4, social_service: 5 },
    worldMinute: 600 }).map((decision) => [decision.serviceId, decision]));
  assert.equal(first.a.toMilli, 850, 'undercuts the cheapest competitor (900) by one step');
  assert.match(first.a.reason, /undercutting/);
  assert.equal(first.d.toMilli, 1100, 'demand far above stock raises by two steps');
  assert.equal(first.b, undefined, 'no excess and demand (4) below total stock (7): unchanged');
  assert.equal(first.c.toMilli, 950, 'nearly sold out (1 left) and below the rivals\' median: prices back up');
  // bounds hold
  const floor = ownerPriceDecisions({ services: [{ ...sellers[0], priceMilli: 520 }, { ...sellers[2], priceMilli: 500 }],
    demandByType: { food_service: 0 }, worldMinute: 600 });
  assert.ok(floor.every((decision) => decision.toMilli >= 500 && decision.toMilli <= 2000));
  // cognition-set prices are held for 6 world hours
  assert.equal(ownerPriceDecisions({ services: [{ ...sellers[0], setBy: 'owner_cognition', updatedWorldMinute: 500 }, sellers[2]],
    demandByType: { food_service: 1 }, worldMinute: 600 }).filter((decision) => decision.serviceId === 'a').length, 0);
  // quote uses the owner price within 0.5x-2x of the council-adjusted base
  assert.equal(quoteSyncInternalServicePrice({ serviceType: 'food_service', ownerPriceMilli: 850 }).priceRaw, '102000');
  assert.equal(quoteSyncInternalServicePrice({ serviceType: 'food_service', ownerPriceMilli: 9_999, priceMultiplierMilli: 2000 }).priceRaw, '480000');
  assert.equal(quoteSyncInternalServicePrice({ serviceType: 'food_service', ownerPriceMilli: 1, priceMultiplierMilli: 500 }).priceRaw, '30000');
  assert.equal(quoteSyncInternalServicePrice({ serviceType: 'food_service', ownerPriceMilli: 850, publishedPriceRaw: '7' }).priceRaw, '7');
  // buyers: the better value seller gets the score bonus
  const services = [
    { id: 'a', service_type: 'food_service', business_id: 'ba', businessStatus: 'active', stock_units: 3, syncInternalPriceRaw: '102000', founder_agent_id: ids[2] },
    { id: 'c', service_type: 'food_service', business_id: 'bc', businessStatus: 'active', stock_units: 3, syncInternalPriceRaw: '108000', founder_agent_id: ids[4] },
    { id: 'e', service_type: 'food_service', business_id: 'be', businessStatus: 'active', stock_units: 3, syncInternalPriceRaw: '110000', founder_agent_id: ids[6] }];
  const ranks = syncInternalSellerValueRanks(services, [{ id: 'ba', reputation: 0 }, { id: 'bc', reputation: 0 }, { id: 'be', reputation: 100 }], ids[9]);
  assert.equal(ranks.get('e').rank, 0, 'reputation 100 makes 0.11 SYNC the best value (0.088 effective)');
  assert.equal(ranks.get('a').rank, 1);
  assert.ok(ranks.get('e').bonus > ranks.get('a').bonus && ranks.get('a').bonus > ranks.get('c').bonus);
  // a small market over 12 hours: prices move and spread
  let market = sellers.slice(0, 3).map((seller) => ({ ...seller }));
  const seen = new Set();
  for (let hour = 0; hour < 12; hour += 1) {
    const decisions = ownerPriceDecisions({ services: market, demandByType: { food_service: hour < 6 ? 2 : 9 }, worldMinute: hour * 60 });
    for (const decision of decisions) market.find((seller) => seller.serviceId === decision.serviceId).priceMilli = decision.toMilli;
    market = market.map((seller, index) => ({ ...seller, stockUnits: hour < 6 ? seller.stockUnits + index : Math.max(0, seller.stockUnits - 2) }));
    seen.add(market.map((seller) => seller.priceMilli).join(','));
  }
  assert.ok(seen.size >= 4, 'prices move hour to hour');
  const options = ownerPriceOptions(market.map((seller) => ({ ...seller, serviceName: 'Meals', demandCount: 9 })));
  assert.ok(options.some((option) => option.direction === 'lower') && options.some((option) => option.direction === 'raise'));
  assert.ok(COUNCIL_ACTIONS.includes('business_sync_price'));
});
