import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicHistoryPage, readPublicCapabilityGapPage, readPublicCapabilityProposalPage,
  readPublicWorldV6Lifecycle } from '../src/public-world-evolution.js';

const worldId = '2d201354-78a9-4ead-9375-e79d78d4cc22';
const proposalId = '9251dd35-b5f0-4d4c-8a15-39206f9df335';
const gapId = 'f6ca8886-690c-4d06-bef5-7df41d3314de';

function makePageClient(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows };
    }
  };
}

test('public history page limits default and max size, and rejects invalid or cross-resource cursors', () => {
  assert.deepEqual(parsePublicHistoryPage({}, 'proposals'), { limit: 20, cursor: null });
  assert.equal(parsePublicHistoryPage({ limit: '100' }, 'gaps').limit, 100);
  assert.throws(() => parsePublicHistoryPage({ limit: '101' }, 'gaps'), /PUBLIC_HISTORY_LIMIT_OUT_OF_RANGE/);
  assert.throws(() => parsePublicHistoryPage({ limit: '0' }, 'gaps'), /PUBLIC_HISTORY_LIMIT_OUT_OF_RANGE/);
  assert.throws(() => parsePublicHistoryPage({ limit: '20x' }, 'gaps'), /PUBLIC_HISTORY_LIMIT_INVALID/);
  const cursor = Buffer.from(JSON.stringify({ version: 1, kind: 'gaps', minute: 99, id: gapId })).toString('base64url');
  assert.deepEqual(parsePublicHistoryPage({ cursor }, 'gaps'), { limit: 20, cursor: { minute: 99, id: gapId } });
  assert.throws(() => parsePublicHistoryPage({ cursor }, 'proposals'), /PUBLIC_HISTORY_CURSOR_INVALID/);
});

test('proposal pagination is newest-first, bounded in SQL, and returns a stable next cursor', async () => {
  const client = makePageClient([
    { id: proposalId, name: 'Newest', category: 'capability.test', problemStatement: 'A problem statement',
      expectedBenefit: 'Expected benefit', status: 'proposed', revision: 1, supportCount: 2, oppositionCount: 0,
      createdWorldMinute: 300, updatedWorldMinute: 300, creatorName: 'Resident', creatorOrganizationName: null,
      reviewCount: 2, organizationReviewCount: 0, latestReviewWorldMinute: 301 },
    { id: gapId, name: 'Next', category: 'capability.test', problemStatement: 'Another problem statement',
      expectedBenefit: 'Expected benefit', status: 'reviewed', revision: 1, supportCount: 1, oppositionCount: 0,
      createdWorldMinute: 200, updatedWorldMinute: 200, creatorName: 'Resident', creatorOrganizationName: null,
      reviewCount: 1, organizationReviewCount: 0, latestReviewWorldMinute: 201 },
    { id: worldId, name: 'Lookahead', category: 'capability.test', problemStatement: 'Not included',
      expectedBenefit: 'Expected benefit', status: 'proposed', revision: 1, supportCount: 0, oppositionCount: 0,
      createdWorldMinute: 100, updatedWorldMinute: 100, reviewCount: 0, organizationReviewCount: 0 }
  ]);
  const result = await readPublicCapabilityProposalPage(client, { worldId, limit: 2 });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].name, 'Newest');
  assert.equal(result.items[0].creatorName, 'Resident');
  assert.equal('creator_agent_id' in result.items[0], false);
  assert.ok(result.nextCursor);
  assert.deepEqual(parsePublicHistoryPage({ cursor: result.nextCursor }, 'proposals').cursor,
    { minute: 200, id: gapId });
  assert.match(client.calls[0].sql, /ORDER BY page\."createdWorldMinute" DESC,page\.id DESC/);
  assert.match(client.calls[0].sql, /LIMIT \$4/);
  assert.equal(client.calls[0].values[3], 3);
});

test('gap pagination has stable newest-first cursor and materializes only the requested page', async () => {
  const gapRows = [
    { id: gapId, gapKey: 'gap.new', category: 'market.test', problemStatement: 'A recent observed gap', status: 'open',
      observationCount: 4, firstObservedWorldMinute: 100, latestObservedWorldMinute: 500,
      awareResidentCount: 2, awareOrganizationCount: 1, awarenessSources: ['public_market'], decisionEventCount: 3,
      candidateCycles: 2, residentIgnoreEvents: 1, organizationRetainEvents: 0, selectedCandidate: false, proposalCount: 1 },
    { id: proposalId, gapKey: 'gap.next', category: 'market.test', problemStatement: 'An older observed gap', status: 'open',
      observationCount: 2, firstObservedWorldMinute: 10, latestObservedWorldMinute: 400,
      awareResidentCount: 1, awareOrganizationCount: 0, awarenessSources: [], decisionEventCount: 1,
      candidateCycles: 1, residentIgnoreEvents: 0, organizationRetainEvents: 1, selectedCandidate: false, proposalCount: 0 },
    { id: worldId, gapKey: 'gap.lookahead', category: 'market.test', problemStatement: 'Not included', status: 'open',
      observationCount: 2, firstObservedWorldMinute: 10, latestObservedWorldMinute: 300,
      awareResidentCount: 1, awareOrganizationCount: 0, awarenessSources: [], decisionEventCount: 0,
      candidateCycles: 0, residentIgnoreEvents: 0, organizationRetainEvents: 0, selectedCandidate: false, proposalCount: 0 }
  ];
  const client = makePageClient(gapRows);
  const result = await readPublicCapabilityGapPage(client, { worldId, limit: 2, worldMinute: 2_000 });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].gapKey, 'gap.new');
  assert.equal(result.items[0].candidateCycles, 2);
  assert.equal(result.items[0].validNoAction, 1);
  assert.equal(result.items[1].validNoAction, 1);
  assert.ok(result.nextCursor);
  assert.deepEqual(parsePublicHistoryPage({ cursor: result.nextCursor }, 'gaps').cursor,
    { minute: 400, id: proposalId });
  assert.match(client.calls[0].sql, /ORDER BY page\."latestObservedWorldMinute" DESC,page\.id DESC/);
  assert.match(client.calls[0].sql, /LIMIT \$4/);
  assert.equal(client.calls[0].values[3], 3);
});

test('cursor pages bind both ordering columns so timestamp ties cannot repeat or skip rows', async () => {
  const client = makePageClient([]);
  await readPublicCapabilityGapPage(client, { worldId, limit: 7, worldMinute: 2_000,
    cursor: { minute: 400, id: proposalId } });
  assert.match(client.calls[0].sql, /page\."latestObservedWorldMinute" DESC,page\.id DESC/);
  assert.match(client.calls[0].sql, /\(gap\.last_observed_world_minute,gap\.id\)<\(\$2::bigint,\$3::uuid\)/);
  assert.deepEqual(client.calls[0].values, [worldId, 400, proposalId, 8]);
});

test('public lifecycle summary emits exact totals and at most 20 records without full-history queries', async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('to_regclass')) return { rows: [{ dependencies: true, v7: true }] };
      if (sql.includes('FROM world_runtime_state')) return { rows: [{ worldMinute: 2_000,
        epochs: [{ code: 'V7', startedWorldMinute: 1_500 }] }] };
      if (sql.includes('AS "staleGaps"')) return { rows: [{ gaps: 566, staleGaps: 5, matureGaps: 500,
        immatureGaps: 61, observationCount: 3_716, proposals: 3_716, candidateCycles: 90, validNoAction: 40,
        experiments: 10, adoptedCapabilities: 3, capabilityUses: 17, capabilityUseSuccesses: 13,
        capabilityUseFailures: 4, experimentUses: 5, experimentFailures: 2, experimentParticipantUses: 3,
        experimentNonParticipantUses: 2, postAdoptionUses: 4, postAdoptionSuccesses: 3, postAdoptionFailures: 1,
        runningExperiments: 2, completedExperiments: 7, failedExperiments: 2, evaluatedExperiments: 7,
        proposedAwaitingExperiment: 1 }] };
      if (sql.includes('review.review_stage AS stage')) return { rows: [
        { stage: 'proposal', decision: 'support', organizationResponse: false, count: 4 },
        { stage: 'experiment', decision: 'modify', organizationResponse: true, count: 2 }
      ] };
      if (sql.includes('FROM world_agent_concepts')) return { rows: [{ concepts: 9, selfGeneratedGoals: 8,
        policyExperiments: 3, extensionRequests: 1, v7CapabilityEvents: 2 }] };
      if (sql.includes('SELECT id,name,creator_type AS "creatorType"')) return { rows: [
        { id: gapId, name: 'Public test capability', creatorType: 'resident', createdWorldMinute: 1_600, adoptedWorldMinute: null,
          status: 'experimental', parentCapabilityId: null }
      ] };
      if (sql.includes('SELECT dependency.capability_id')) return { rows: [] };
      if (sql.includes('WITH observation_counts AS')) return { rows: [{ noResidentAwarenessRecorded: 0,
        noDecisionEventRecorded: 2, selectedCandidateWithoutProposal: 0,
        proposalPastExpiryWithoutNextState: 0, experimentPastWindowUnevaluated: 0,
        adoptedCapabilityWithoutPostAdoptionUse: 0, invalidDependencyReferences: 0,
        duplicateTerminalLifecycleTransition: 0 }] };
      if (sql.includes('WITH page') && sql.includes('world_capability_gaps')) return { rows: [{
        id: gapId, gapKey: 'recent.gap', category: 'market.test', problemStatement: 'A recent observed gap', status: 'open',
        observationCount: 3, firstObservedWorldMinute: 100, latestObservedWorldMinute: 1_900,
        awareResidentCount: 1, awareOrganizationCount: 0, awarenessSources: ['market'], decisionEventCount: 2,
        candidateCycles: 1, residentIgnoreEvents: 1, organizationRetainEvents: 0,
        selectedCandidate: false, proposalCount: 1
      }] };
      if (sql.includes('WITH page') && sql.includes('expected_benefit')) return { rows: [{
        id: proposalId, name: 'Recent proposal', category: 'market.test', problemStatement: 'A proposal problem',
        expectedBenefit: 'A benefit', status: 'proposed', revision: 1, supportCount: 2, oppositionCount: 0,
        createdWorldMinute: 1_900, updatedWorldMinute: 1_900, creatorName: 'Resident',
        creatorOrganizationName: null, reviewCount: 1, organizationReviewCount: 0, latestReviewWorldMinute: 1_950
      }] };
      throw new Error(`Unexpected query in test: ${sql.slice(0, 100)}`);
    }
  };

  const summary = await readPublicWorldV6Lifecycle(client, { worldId, worldMinute: 2_000 });

  assert.equal(summary.counts.gaps, 566);
  assert.equal(summary.counts.proposals, 3_716);
  assert.equal(summary.counts.matureGaps, 500);
  assert.equal(summary.counts.candidateCycles, 90);
  assert.equal(summary.recentGaps.length, 1);
  assert.equal(summary.recentProposals.length, 1);
  assert.equal(summary.recentGaps[0].gapKey, 'recent.gap');
  assert.equal(summary.proposalFunnel[0].proposalCount, 1);
  assert.equal(summary.reviews.proposal.support, 4);
  assert.equal(summary.reviews.experiment.revision, 2);
  assert.equal(summary.experiments.lifecycleCounts.proposed, 1);
  assert.equal(summary.integrity.findingCount, 2);
  assert.equal(summary.integrity.countsByCode.NO_DECISION_EVENT_RECORDED, 2);
  assert.equal(summary.integrity.countsByCode.PROPOSAL_PAST_EXPIRY_WITHOUT_NEXT_STATE, 0);
  const historyQueries = calls.filter(({ sql }) => sql.includes('WITH page'));
  assert.equal(historyQueries.length, 2);
  assert.ok(historyQueries.every(({ sql, values }) => sql.includes('LIMIT $4') && values[3] === 21));
  assert.ok(!('proposals' in summary) && !('gaps' in summary), 'unbounded lifecycle arrays are not part of the public response');
});
