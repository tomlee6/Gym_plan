/**
 * The 3D work's metrics (N-03): what the 3D alarms watch. A failure is
 * counted by its reason, and again as a fault when it is ours to look at
 * rather than the plan's or the recording's.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GenerationError } from '../src/generator/index.js';
import { setGenerator } from '../src/jobs/handlers.js';
import { catchMetrics, levelFailed, metric3d, modelFailed, PLAN_REASONS } from '../src/metrics3d.js';
import { api, DEMO, login, useTestServer } from './helpers.js';

const ctx = useTestServer();

/** What the 3D metrics publish while `fn` runs, each as 'Name' or 'Name:dimension value'. */
async function published(fn) {
  const caught = catchMetrics();
  try {
    await fn();
  } finally {
    caught.stop();
  }
  return caught.seen.map(({ name, value, unit, namespace, ...dims }) => [name, ...Object.values(dims)].join(':'));
}

describe('3D metrics (N-03)', () => {
  it('are CloudWatch embedded metrics in the FlexGym/3D namespace', async () => {
    const caught = catchMetrics();
    metric3d('LevelsFailed', { Reason: 'too_large' });
    metric3d('OldestBuildSeconds', {}, { value: 5400, unit: 'Seconds' });
    caught.stop();
    assert.deepEqual(caught.seen, [
      { namespace: 'FlexGym/3D', name: 'LevelsFailed', value: 1, unit: 'Count', Reason: 'too_large' },
      { namespace: 'FlexGym/3D', name: 'OldestBuildSeconds', value: 5400, unit: 'Seconds' },
    ]);
  });

  it('counts a level that fails by its J-09 code, and as a fault unless the reviewer fixes it in the plan', async () => {
    assert.deepEqual(PLAN_REASONS, ['too_few_walls', 'open_outline']);
    for (const code of PLAN_REASONS) {
      assert.deepEqual(await published(() => levelFailed(new GenerationError(code, 'Fix the plan.'))), [`LevelsFailed:${code}`]);
    }
    for (const code of ['too_large', 'no_plan', 'build_error']) {
      assert.deepEqual(await published(() => levelFailed(new GenerationError(code, 'Tell the 3D team.'))), [`LevelsFailed:${code}`, 'LevelFaults']);
    }
    const unsaved = new Error('The model could not be saved to storage (SlowDown). [store_failed]');
    assert.deepEqual(await published(() => levelFailed(unsaved)), ['LevelsFailed:store_failed', 'LevelFaults']);
    // No code at all: something we did not foresee, so ours.
    assert.deepEqual(await published(() => levelFailed(new Error('Connection lost'))), ['LevelsFailed:other', 'LevelFaults']);
  });

  it('counts a machine model that fails by its cause, and as a fault unless the recording was the problem', async () => {
    assert.deepEqual(await published(() => modelFailed('input')), ['ModelsFailed:input']);
    for (const cause of ['gpu', 'ready', 'lost', 'job']) {
      assert.deepEqual(await published(() => modelFailed(cause)), [`ModelsFailed:${cause}`, 'ModelFaults']);
    }
  });

  it('a level that fails for good is counted once, when it goes back to the reviewer; one built, as built', async () => {
    const { accessToken: maya } = await login(ctx, DEMO.reviewer);
    const as = (m, p) => api(ctx)[m](p).set('Authorization', `Bearer ${maya}`);
    const v = DEMO.versions.ng2;
    const open = await as('get', `/v1/review/versions/${v}`).expect(200);
    const plan = open.body.plan;
    for (const f of plan.flags) Object.assign(f, { status: 'resolved', resolution: 'confirmed' });
    await as('put', `/v1/review/versions/${v}/plan`).send({ plan, revision: open.body.planRevision }).expect(200);

    // The plan's fault: the reviewer's to fix, no alarm.
    setGenerator(async () => {
      throw new GenerationError('open_outline', 'The walls do not close round the floor.');
    });
    let response;
    assert.deepEqual(
      await published(async () => {
        response = await as('post', `/v1/review/versions/${v}/approve`).send({}).expect(200);
      }),
      ['LevelsFailed:open_outline'],
    );
    assert.equal(response.body.status, 'generation_failed');

    // Ours: the alarm's.
    setGenerator(async () => {
      throw new GenerationError('build_error', 'The 3D build hit a problem it cannot get past.');
    });
    assert.deepEqual(
      await published(() => as('post', `/v1/review/versions/${v}/regenerate`).send({}).expect(200)),
      ['LevelsFailed:build_error', 'LevelFaults'],
    );

    setGenerator(async () => ({ glbKey: 'models/level.glb', bytes: 123456, triangleCount: 9000 }));
    assert.deepEqual(await published(() => as('post', `/v1/review/versions/${v}/regenerate`).send({}).expect(200)), ['LevelsBuilt']);
    setGenerator(async () => ({ glbKey: null, bytes: null, triangleCount: null }));
  });
});
