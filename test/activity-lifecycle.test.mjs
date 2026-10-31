import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLifecycle } from '../lib/activity-lifecycle.js';

test('new ongoing states and actions inherit update boundaries without teaching the updater their names', async () => {
  const activity = new ActivityLifecycle();
  activity.registerState('reading_club', { label: '参加读书会', resumable: true });
  activity.registerAction('reading_chapter', '读完当前一章');
  activity.start('reading_club');
  const finishChapter = activity.begin('reading_chapter');
  activity.requestPause(); assert.equal(activity.canPark(), false);
  const signal = new AbortController().signal;
  assert.equal(await activity.checkpoint(signal), false);
  finishChapter();
  const waiting = activity.checkpoint(signal);
  assert.equal(activity.parked, true);
  assert.throws(() => activity.begin('reply'), /invalid_activity_action/);
  activity.cancelPause(); assert.equal(await waiting, true);
  assert.equal(activity.view().state, 'reading_club'); assert.equal(activity.parked, false);
});

test('nested work and a whole game hold the boundary even between turns; errors release only their own action', async () => {
  const activity = new ActivityLifecycle(); activity.start('game');
  const endGame = activity.begin('game'); activity.requestPause();
  await assert.rejects(activity.run('game_step', async () => { throw new Error('fixture'); }), /fixture/);
  assert.deepEqual(activity.view().actions.map(a => a.type), ['game']);
  assert.equal(activity.canPark(), false); endGame(); assert.equal(activity.canPark(), true);
  const abort = new AbortController(), paused = activity.checkpoint(abort.signal);
  abort.abort(); await assert.rejects(paused); assert.equal(activity.parked, false);
});

test('one-shot operations are allowed to finish and never become a persistent activity', async () => {
  const activity = new ActivityLifecycle(); activity.start('publish_post'); activity.requestPause();
  assert.equal(activity.requested, false); assert.equal(activity.resumable(), false);
});
