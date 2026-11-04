import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { fromLondon, londonDate, londonTime } from '../src/time.js';

// Wednesday 4 November 2026, 12:00 UK time (GMT).
const NOW = Date.UTC(2026, 10, 4, 12, 0);
const seedTime = Object.fromEntries(
  JSON.parse(readFileSync(new URL('../data/viewings.json', import.meta.url), 'utf8')).map((v) => [v.id, v.attributes.startsAt.slice(11, 16)]),
);

async function signedIn(now = NOW) {
  const app = buildApp({ now: () => now });
  const res = await app.inject({
    method: 'POST',
    url: '/auth/token',
    payload: { email: 'alex.morgan@example.com', password: 'doorstep' },
  });
  const { accessToken } = res.json().data.attributes;
  const call = (method, url, payload) =>
    app.inject({
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/vnd.api+json', host: 'api.test:3000' },
    });
  return { app, call };
}

const viewingBody = (attributes, relationships) => ({ data: { type: 'viewings', attributes, relationships } });

test('fromLondon handles both sides of a clock change', () => {
  assert.equal(fromLondon('2026-12-01T10:30'), Date.UTC(2026, 11, 1, 10, 30));
  assert.equal(fromLondon('2026-07-01T10:30'), Date.UTC(2026, 6, 1, 9, 30));
});

test('rejects requests without a valid token', async () => {
  const app = buildApp({ now: () => NOW });
  const res = await app.inject({ method: 'GET', url: '/viewings' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['www-authenticate'], 'Bearer');
  assert.equal(res.json().errors[0].code, 'unauthenticated');

  const bad = await app.inject({ method: 'POST', url: '/auth/token', payload: { email: 'alex.morgan@example.com', password: 'nope' } });
  assert.equal(bad.statusCode, 401);
});

test("today's diary has the signed-in agent's viewings for today, with related resources", async () => {
  const { call } = await signedIn();
  const res = await call('GET', '/viewings');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^application\/vnd\.api\+json/);

  const { data, included } = res.json();
  assert.ok(data.length > 0);
  for (const v of data) {
    assert.equal(londonDate(Date.parse(v.attributes.startsAt)), '2026-11-04');
    assert.ok(v.relationships.agents.data.some((a) => a.id === '1'));
  }
  const types = new Set(included.map((r) => r.type));
  for (const type of ['properties', 'people', 'agents', 'images']) assert.ok(types.has(type), `includes ${type}`);
  const image = included.find((r) => r.type === 'images');
  assert.match(image.attributes.url, /^http:\/\/api\.test:3000\/images\/photo-\d+\.jpg$/);
});

test('seed times keep their UK wall-clock time in summer', async () => {
  const summer = Date.UTC(2026, 6, 1, 6, 0); // Wednesday 1 July 2026, 07:00 BST
  const { call } = await signedIn(summer);
  const { data } = (await call('GET', '/viewings')).json();
  assert.ok(data.length > 0);
  for (const v of data) {
    assert.equal(londonTime(Date.parse(v.attributes.startsAt)), seedTime[v.id], `viewing ${v.id}`);
  }
});

test('every day of the current week has viewings', async () => {
  const { call } = await signedIn();
  for (const date of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']) {
    const { data } = (await call('GET', `/viewings?filter[date]=${date}`)).json();
    assert.ok(data.length > 0, `viewings on ${date}`);
  }
});

test('rejects bad date filters', async () => {
  const { call } = await signedIn();
  const res = await call('GET', '/viewings?filter[date]=tomorrow');
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json().errors[0].source, { parameter: 'filter[date]' });
});

test('booking a viewing adds it to the diary and blocks the slot', async () => {
  const { call } = await signedIn();
  const applicant = (await call('GET', '/people?filter[role]=applicant')).json().data[0];
  const property = (await call('GET', `/properties?filter[market]=${applicant.attributes.requirements.market}`)).json().data[0];
  const relationships = {
    property: { data: { type: 'properties', id: property.id } },
    applicant: { data: { type: 'people', id: applicant.id } },
  };
  // 07:00 on 9 Nov, before anything in the seed starts.
  const startsAt = '2026-11-09T07:00:00Z';

  const created = await call('POST', '/viewings', viewingBody({ startsAt, durationMinutes: 30 }, relationships));
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().data.attributes.status, 'unconfirmed');

  const diary = (await call('GET', '/viewings?filter[date]=2026-11-09')).json();
  assert.ok(diary.data.some((v) => v.id === created.json().data.id));

  const clash = await call('POST', '/viewings', viewingBody({ startsAt: '2026-11-09T07:15:00Z' }, relationships));
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.json().errors[0].code, 'property_unavailable');

  const past = await call('POST', '/viewings', viewingBody({ startsAt: '2026-11-01T10:00:00Z' }, relationships));
  assert.equal(past.statusCode, 422);
  assert.equal(past.json().errors[0].source.pointer, '/data/attributes/startsAt');

  const noOffset = await call('POST', '/viewings', viewingBody({ startsAt: '2026-11-09T09:00' }, relationships));
  assert.equal(noOffset.statusCode, 422);
});

test('feedback is only accepted once a viewing has started, and only once', async () => {
  const { call } = await signedIn();
  const week = (await call('GET', '/viewings?filter[from]=2026-10-26&filter[to]=2026-11-08')).json().data;
  const live = week.filter((v) => v.attributes.status !== 'cancelled' && !v.relationships.feedback.data);
  const past = live.find((v) => Date.parse(v.attributes.startsAt) < NOW);
  const future = live.find((v) => Date.parse(v.attributes.startsAt) > NOW);
  const body = { data: { type: 'feedback', attributes: { interestLevel: '13', quickResponses: ['15'], notes: 'Keen' } } };

  const early = await call('POST', `/viewings/${future.id}/feedback`, body);
  assert.equal(early.statusCode, 422);
  assert.equal(early.json().errors[0].code, 'viewing_not_started');

  const invalid = await call('POST', `/viewings/${past.id}/feedback`, { data: { type: 'feedback', attributes: {} } });
  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.json().errors[0].source.pointer, '/data/attributes/interestLevel');

  const ok = await call('POST', `/viewings/${past.id}/feedback`, body);
  assert.equal(ok.statusCode, 201);
  const detail = (await call('GET', `/viewings/${past.id}`)).json();
  assert.equal(detail.data.relationships.feedback.data.id, ok.json().data.id);

  const again = await call('POST', `/viewings/${past.id}/feedback`, body);
  assert.equal(again.statusCode, 409);
});

test('cancelling needs a reason; rescheduling needs re-confirming', async () => {
  const { call } = await signedIn();
  const upcoming = (await call('GET', '/viewings?filter[from]=2026-11-09&filter[to]=2026-11-15')).json().data;
  const [first, second] = upcoming.filter((v) => v.attributes.status !== 'cancelled');
  const patch = (v, attributes) => call('PATCH', `/viewings/${v.id}`, { data: { type: 'viewings', id: v.id, attributes } });

  const noReason = await patch(first, { status: 'cancelled' });
  assert.equal(noReason.statusCode, 422);
  assert.equal(noReason.json().errors[0].source.pointer, '/data/attributes/cancellationReason');

  const cancelled = await patch(first, { status: 'cancelled', cancellationReason: '1' });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().data.attributes.status, 'cancelled');
  assert.equal((await patch(first, { status: 'confirmed' })).statusCode, 422);

  const moved = await patch(second, { startsAt: '2026-11-20T06:00:00Z' });
  assert.equal(moved.statusCode, 200);
  assert.equal(moved.json().data.attributes.status, 'unconfirmed');
  assert.equal(moved.json().data.attributes.startsAt, '2026-11-20T06:00:00.000Z');

  const mismatch = await call('PATCH', `/viewings/${second.id}`, { data: { type: 'viewings', id: first.id, attributes: {} } });
  assert.equal(mismatch.statusCode, 409);
});

test('property search is paginated and filterable', async () => {
  const { call } = await signedIn();
  const first = (await call('GET', '/properties?page[size]=15')).json();
  assert.equal(first.data.length, 15);
  assert.equal(first.meta.total, 40);
  assert.equal(first.links.prev, null);
  assert.ok(first.links.next.includes('page%5Bnumber%5D=2'));

  const last = (await call('GET', '/properties?page[size]=15&page[number]=3')).json();
  assert.equal(last.data.length, 10);
  assert.equal(last.links.next, null);

  const lettings = (await call('GET', '/properties?filter[market]=lettings&page[size]=50')).json();
  assert.ok(lettings.data.every((p) => p.attributes.market === 'lettings'));
  assert.ok(lettings.included.some((r) => r.type === 'people'));

  const town = lettings.data[0].attributes.address.town;
  const byTown = (await call('GET', `/properties?filter[q]=${encodeURIComponent(town.toLowerCase())}`)).json();
  assert.ok(byTown.data.length > 0 && byTown.data.every((p) => p.attributes.address.town === town));
});

test('creating an applicant validates fields and spots duplicates', async () => {
  const { call } = await signedIn();
  const post = (attributes) => call('POST', '/people', { data: { type: 'people', attributes } });

  const empty = await post({});
  assert.equal(empty.statusCode, 422);
  const pointers = empty.json().errors.map((e) => e.source.pointer);
  assert.deepEqual(pointers, ['/data/attributes/firstName', '/data/attributes/lastName', '/data/attributes']);

  const badPhone = await post({ firstName: 'Sam', lastName: 'Lee', phone: '12345' });
  assert.equal(badPhone.json().errors[0].source.pointer, '/data/attributes/phone');

  const created = await post({ firstName: 'Sam', lastName: 'Lee', phone: '07700 900999', email: 'sam.lee@example.com' });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().data.attributes.roles, ['applicant']);

  const duplicate = await post({ firstName: 'Samuel', lastName: 'Lee', email: 'SAM.LEE@example.com' });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().errors[0].meta.personId, created.json().data.id);

  const found = (await call('GET', '/people?filter[q]=900999')).json();
  assert.equal(found.data[0].id, created.json().data.id);
});

test('lookups, agents and unknown routes', async () => {
  const { call } = await signedIn();
  const reasons = (await call('GET', '/lookups?filter[category]=cancellation-reason')).json().data;
  assert.equal(reasons.length, 9);
  assert.equal((await call('GET', '/agents')).json().data.length, 3);

  const missing = await call('GET', '/viewings/99999');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().errors[0].status, '404');
});

test('malformed requests get a 4xx, never a 500', async () => {
  const { call } = await signedIn();
  const expect = async (status, method, url, payload) => {
    const res = await call(method, url, payload);
    assert.equal(res.statusCode, status, `${method} ${url} → ${res.body}`);
  };
  await expect(400, 'PATCH', '/viewings/1', { data: { type: 'viewings', id: '1', attributes: 'x' } });
  await expect(400, 'POST', '/people', { data: [] });
  await expect(400, 'GET', '/people?filter[q]=a&filter[q]=b');
  await expect(400, 'GET', '/viewings?filter[date]=2026-02-30');
  await expect(400, 'GET', '/viewings?filter[date]=');
  await expect(400, 'GET', '/viewings?filter[from]=2026-11-01');
  await expect(400, 'GET', '/viewings?filter[date]=2026-11-04&filter[from]=2026-11-01&filter[to]=2026-11-05');
  await expect(422, 'POST', '/viewings', viewingBody({ startsAt: '+275760-09-13T00:00:00Z' }, {}));
});

test('agent ids are normalised and de-duplicated', async () => {
  const { call } = await signedIn();
  const applicant = (await call('GET', '/people?filter[role]=applicant')).json().data[1];
  const property = (await call('GET', `/properties?filter[market]=${applicant.attributes.requirements.market}`)).json().data[1];
  const res = await call(
    'POST',
    '/viewings',
    viewingBody(
      { startsAt: '2026-11-10T07:00:00Z' },
      {
        property: { data: { type: 'properties', id: property.id } },
        applicant: { data: { type: 'people', id: applicant.id } },
        agents: { data: [{ type: 'agents', id: 2 }, { type: 'agents', id: '2' }, { type: 'agents', id: 1 }] },
      },
    ),
  );
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json().data.relationships.agents.data.map((a) => a.id), ['1', '2']);
});

test('PATCH can change only the duration or the notes', async () => {
  const { call } = await signedIn();
  const upcoming = (await call('GET', '/viewings?filter[from]=2026-11-16&filter[to]=2026-11-22')).json().data;
  const v = upcoming.find((x) => x.attributes.status !== 'cancelled');
  const res = await call('PATCH', `/viewings/${v.id}`, { data: { type: 'viewings', id: v.id, attributes: { durationMinutes: 15, notes: 'Bring keys' } } });
  assert.equal(res.statusCode, 200);
  const { startsAt, endsAt, notes } = res.json().data.attributes;
  assert.equal(startsAt, v.attributes.startsAt);
  assert.equal(Date.parse(endsAt) - Date.parse(startsAt), 15 * 60_000);
  assert.equal(notes, 'Bring keys');
});

test('images are served without auth', async () => {
  const app = buildApp({ now: () => NOW });
  const res = await app.inject({ method: 'GET', url: '/images/photo-01.jpg' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
});
