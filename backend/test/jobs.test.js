/** Background jobs (E-01), failures to the reviewer queue (E-02), retention (E-05), generation (D-04). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pool } from '../src/db/pool.js';
import { newId } from '../src/ids.js';
import { setGenerator } from '../src/jobs/handlers.js';
import {
  backoffSeconds,
  enqueue,
  handlerFor,
  PermanentJobError,
  registerHandler,
  runDueJobs,
  runJob,
} from '../src/jobs/index.js';
import { api, DEMO, login, useTestServer } from './helpers.js';

const ctx = useTestServer();
const jobRow = async (id) => (await pool.query('SELECT * FROM jobs WHERE id = ?', [id]))[0][0];

describe('the jobs framework', () => {
  it('queues the same work once', async () => {
    const subject = newId();
    const a = await enqueue(pool, { kind: 'retention', subjectId: subject, dedupeKey: 'once' });
    const b = await enqueue(pool, { kind: 'retention', subjectId: subject, dedupeKey: 'once' });
    assert.equal(a, b);
  });

  it('retries with backoff, then gives up and hands over', async () => {
    let calls = 0;
    let deadWith = null;
    registerHandler('asset.build', {
      run: async () => {
        calls++;
        throw new Error('GPU out of memory');
      },
      onDead: async (_job, err) => {
        deadWith = err.message;
      },
    });
    const id = await enqueue(pool, { kind: 'asset.build', subjectId: newId() });

    assert.equal(await runJob(id), 'failed');
    let job = await jobRow(id);
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 1);
    assert.equal(job.enqueued_at, null, 'to be dispatched again');
    assert.ok(job.run_after > new Date(Date.now() + 20000), 'not before the backoff');
    // Not due yet, so nothing runs it.
    assert.equal(await runJob(id), null);
    assert.deepEqual([1, 2, 3, 8].map(backoffSeconds), [30, 60, 120, 3600]);

    for (let i = 2; i <= 5; i++) {
      await pool.query('UPDATE jobs SET run_after = UTC_TIMESTAMP(3) WHERE id = ?', [id]);
      await runJob(id);
    }
    job = await jobRow(id);
    assert.equal(job.status, 'dead');
    assert.equal(calls, 5);
    assert.equal(deadWith, 'GPU out of memory');
    assert.match(job.last_error, /GPU out of memory/);

    // A dead job may be queued again from scratch.
    const again = await enqueue(pool, { kind: 'asset.build', subjectId: job.subject_id, dedupeKey: job.dedupe_key });
    assert.equal(again, id);
    assert.deepEqual([(await jobRow(id)).status, (await jobRow(id)).attempts], ['queued', 0]);
    registerHandler('asset.build', { run: async () => {} });
    await runDueJobs();
    assert.equal((await jobRow(id)).status, 'succeeded');
  });

  it('a permanent error dies at once', async () => {
    registerHandler('asset.build', {
      run: async () => {
        throw new PermanentJobError('Bad input');
      },
    });
    const id = await enqueue(pool, { kind: 'asset.build', subjectId: newId() });
    assert.equal(await runJob(id), 'dead');
    registerHandler('asset.build', { run: async () => {} });
  });
});

describe('failures reach the reviewer queue (E-02)', () => {
  it('a plan that cannot be read goes to review with the reason', async () => {
    const v = DEMO.versions.ng3;
    await pool.query(`UPDATE plan_versions SET status = 'processing', submitted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [v]);
    await handlerFor('scan.read').onDead({ subject_id: v, attempts: 5 }, new Error('USDZ is corrupt'));

    const { accessToken } = await login(ctx, DEMO.reviewer);
    const { body } = await api(ctx).get('/v1/review/queue').set('Authorization', `Bearer ${accessToken}`).expect(200);
    const row = body.versions.find((x) => x.id === v);
    assert.ok(row, 'it is in the queue');
    assert.equal(row.openFlags, 1);
    const detail = await api(ctx).get(`/v1/review/versions/${v}`).set('Authorization', `Bearer ${accessToken}`).expect(200);
    assert.match(detail.body.plan.flags[0].detail, /failed after 5 attempts: USDZ is corrupt/);
  });

  it('a generation that keeps failing comes back as generation_failed, and can be retried', async () => {
    setGenerator(async () => {
      throw new PermanentJobError('Wall 7 has no height.');
    });
    const { accessToken: maya } = await login(ctx, DEMO.reviewer);
    const as = (m, p) => api(ctx)[m](p).set('Authorization', `Bearer ${maya}`);
    const v = DEMO.versions.ng2;

    // Clear the flags so the plan can be approved.
    const open = await as('get', `/v1/review/versions/${v}`).expect(200);
    const plan = open.body.plan;
    for (const f of plan.flags) Object.assign(f, { status: 'resolved', resolution: 'confirmed' });
    await as('put', `/v1/review/versions/${v}/plan`).send({ plan, revision: open.body.planRevision }).expect(200);

    const approved = await as('post', `/v1/review/versions/${v}/approve`).send({}).expect(200);
    assert.equal(approved.body.status, 'generation_failed');

    const queue = await as('get', '/v1/review/queue').expect(200);
    const row = queue.body.versions.find((x) => x.id === v);
    assert.equal(row.status, 'generation_failed');
    assert.match(row.failureReason, /Wall 7 has no height/);
    const owner = await api(ctx).get(`/v1/plans/${DEMO.plans.ng2}`).set('Authorization', `Bearer ${ctx.token}`).expect(200);
    assert.equal(owner.body.status, 'generation_failed');
    assert.equal(owner.body.walkthroughUrl, null);

    // Fixed: the reviewer tries again, and it is ready.
    setGenerator(async () => ({ glbKey: 'models/level.glb', bytes: 123456, triangleCount: 9000 }));
    const retried = await as('post', `/v1/review/versions/${v}/regenerate`).send({}).expect(200);
    assert.equal(retried.body.status, 'ready');
    const [[g]] = await pool.query('SELECT status, glb_key, bytes FROM generated_models WHERE plan_version_id = ?', [v]);
    assert.deepEqual({ ...g, bytes: Number(g.bytes) }, { status: 'ready', glb_key: 'models/level.glb', bytes: 123456 });
    const [log] = await pool.query(`SELECT action FROM audit_log WHERE target_id = ? ORDER BY created_at, id`, [DEMO.plans.ng2]);
    for (const a of ['APPROVED', 'GENERATION_FAILED', 'GENERATION_RETRIED', 'GENERATED']) {
      assert.ok(log.some((l) => l.action === a), `${a} is in the plan history`);
    }
    setGenerator(async () => ({ glbKey: null, bytes: null, triangleCount: null }));
  });
});

describe('retention (E-05)', () => {
  it('moves raw files to cold storage 90 days after approval, and leaves the rest', async () => {
    const [[v]] = await pool.query('SELECT capture_id FROM plan_versions WHERE id = ?', [DEMO.versions.eb0]);
    const key = `accounts/${DEMO.account}/captures/${v.capture_id}/scan.usdz`;
    await ctx.storage.createMultipart(key);
    const old = newId();
    const fresh = newId();
    await pool.query(
      `INSERT INTO capture_files (id, capture_id, kind, name, bytes, content_type, part_size, part_count, storage_key, upload_id, status)
       VALUES (?, ?, 'model', 'scan.usdz', 1, 'x', 1, 1, ?, 'u', 'stored'), (?, ?, 'source', 'plan.pdf', 1, 'x', 1, 1, ?, 'u', 'stored')`,
      [old, v.capture_id, key, fresh, v.capture_id, `${key}.pdf`],
    );
    // The local driver checks the object exists.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(path.dirname(path.join(ctx.dir, key)), { recursive: true });
    await writeFile(path.join(ctx.dir, key), 'x');

    await pool.query('UPDATE plan_versions SET reviewed_at = UTC_TIMESTAMP(3) - INTERVAL 91 DAY WHERE id = ?', [DEMO.versions.eb0]);
    const id = await enqueue(pool, { kind: 'retention', subjectId: newId(), dedupeKey: 'test-run' });
    assert.equal(await runJob(id), 'succeeded');
    const [rows] = await pool.query('SELECT id, archived_at FROM capture_files WHERE id IN (?, ?)', [old, fresh]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.archived_at]));
    assert.ok(byId[old], 'the raw scan went cold');
    assert.equal(byId[fresh], null, 'the drawing stays hot');
  });
});
