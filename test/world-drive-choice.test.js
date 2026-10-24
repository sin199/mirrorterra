import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDrivesToCandidates, driveActivityBonus, DRIVE_BONUS_MAX, weatherPlaceBonus } from '../src/world-drive-choice.js';

const lonely = { survival: 0, security: 0.2, belonging: 0.95, esteem: 0.3, curiosity: 0.2, creation: 0.2, mastery: 0.2, contribution: 0.3 };
const curious = { survival: 0, security: 0.2, belonging: 0.1, esteem: 0.3, curiosity: 0.95, creation: 0.5, mastery: 0.8, contribution: 0.2 };

test('a lonely resident leans toward meeting people, a curious one toward studying', () => {
  const social = { action: 'socialize', targetLocation: 'Cafe', socialPartnerId: 'b' };
  const learn = { action: 'learn', targetLocation: 'Library' };
  assert.ok(driveActivityBonus(social, lonely) > driveActivityBonus(learn, lonely));
  assert.ok(driveActivityBonus(learn, curious) > driveActivityBonus(social, curious));
});

test('the drive bonus is bounded', () => {
  const max = { survival: 1, security: 1, belonging: 1, esteem: 1, curiosity: 1, creation: 1, mastery: 1, contribution: 1 };
  const min = Object.fromEntries(Object.keys(max).map((key) => [key, 0]));
  for (const action of ['eat', 'rest', 'socialize', 'cooperate', 'learn', 'work']) {
    assert.ok(Math.abs(driveActivityBonus({ action, targetLocation: 'X', socialPartnerId: 'p' }, max)) <= DRIVE_BONUS_MAX);
    assert.ok(Math.abs(driveActivityBonus({ action, targetLocation: 'X' }, min)) <= DRIVE_BONUS_MAX);
  }
});

test('a heatwave pulls residents to the beach and the cafe', () => {
  const beach = { sceneType: 'beach' }, cafe = { sceneType: 'cafe' }, garden = { sceneType: 'garden' };
  const hot = { temperatureC: 33, condition: 'heatwave' };
  assert.equal(weatherPlaceBonus({ action: 'rest' }, beach, hot), 10);
  assert.equal(weatherPlaceBonus({ action: 'eat' }, cafe, hot), 5);
  assert.equal(weatherPlaceBonus({ action: 'work' }, garden, hot), -5);
  assert.equal(weatherPlaceBonus({ action: 'rest' }, beach, { temperatureC: 20, condition: 'clear' }), 0);
});

test('applying drives keeps every option and can be switched off', () => {
  const scenes = [{ name: 'Cafe', sceneType: 'cafe' }, { name: 'Library', sceneType: 'library' }];
  const agent = { energy: 80, food: 80, social: 10, happiness: 60, hygiene: 80, fun: 70, goal: 'community' };
  const options = [{ action: 'socialize', targetLocation: 'Cafe', socialPartnerId: 'b', score: 50 },
    { action: 'learn', targetLocation: 'Library', score: 50 }];
  applyDrivesToCandidates(options, agent, scenes, { personality: { sociability: 0.9, curiosity: 0.2, discipline: 0.4, ambition: 0.4 } });
  assert.equal(options.length, 2);
  assert.ok(options[0].score > options[1].score);
  process.env.MIRRORTERRA_DRIVE_CHOICE = 'off';
  const untouched = [{ action: 'learn', targetLocation: 'Library', score: 50 }];
  applyDrivesToCandidates(untouched, agent, scenes, {});
  assert.equal(untouched[0].score, 50);
  delete process.env.MIRRORTERRA_DRIVE_CHOICE;
});
