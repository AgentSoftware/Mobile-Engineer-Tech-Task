import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { createStore } from './store.js';
import { isDate, londonDate, londonTime } from './time.js';

const JSON_API = 'application/vnd.api+json';
const PASSWORD = 'doorstep';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_NOTES = 1000;

class ApiError extends Error {
  constructor(status, errors) {
    super(errors[0].title);
    this.status = status;
    this.errors = errors;
  }
}

const error = (status, code, title, extra = {}) => ({ status: String(status), code, title, ...extra });
const fail = (status, code, title, extra) => {
  throw new ApiError(status, [error(status, code, title, extra)]);
};
const failAll = (errors) => {
  if (errors.length) throw new ApiError(422, errors);
};
const pointer = (path) => ({ source: { pointer: path } });
const parameter = (name) => ({ source: { parameter: name } });
const invalid = (path, title) => error(422, 'invalid_field', title, pointer(path));
const ref = (type, id) => ({ type, id });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Instants must carry an offset so there is no doubt which time is meant. */
const parseInstant = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(Z|[+-]\d{2}:?\d{2})$/.test(value) ? Date.parse(value) : NaN;

const readable = (url) => {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
};

export function buildApp({ now = () => Date.now(), latency = [0, 0], failureRate = 0, logRequests = false } = {}) {
  const store = createStore(now());
  const sessions = new Map();
  const app = Fastify();

  app.addContentTypeParser(JSON_API, { parseAs: 'string' }, app.getDefaultJsonParser('ignore', 'ignore'));
  app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public/images', import.meta.url)),
    prefix: '/images/',
    maxAge: '1d',
  });

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/images/')) return;
    const [min, max] = latency;
    if (max > 0) await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
    if (Math.random() < failureRate) fail(503, 'service_unavailable', 'Service temporarily unavailable');
    for (const [name, value] of Object.entries(req.query ?? {})) {
      if (Array.isArray(value)) fail(400, 'invalid_parameter', `${name} must only be given once`, parameter(name));
    }
    if (path === '/' || path === '/auth/token') return;

    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const session = sessions.get(token);
    if (!session || session.expiresAt <= now()) fail(401, 'unauthenticated', 'Missing, invalid or expired access token');
    req.agent = store.find('agents', session.agentId);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (String(reply.getHeader('content-type')).startsWith('application/json')) reply.type(JSON_API);
    return payload;
  });

  if (logRequests) {
    app.addHook('onResponse', async (req, reply) => {
      console.log(`${req.method} ${readable(req.url)} → ${reply.statusCode} (${reply.elapsedTime.toFixed(0)}ms)`);
    });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      if (err.status === 401) reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(err.status).send({ errors: err.errors });
    }
    if (err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ errors: [error(err.statusCode, 'bad_request', err.message)] });
    }
    console.error(err);
    return reply.code(500).send({ errors: [error(500, 'server_error', 'Something went wrong')] });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ errors: [error(404, 'not_found', 'Not found')] }));

  // --- document helpers -------------------------------------------------------------------------

  const origin = (req) => `${req.protocol}://${req.host}`;
  const render = (req, r) =>
    r.type === 'images' ? { ...r, attributes: { ...r.attributes, url: origin(req) + r.attributes.url } } : r;
  const document = (req, data, extra = {}) => ({
    data: Array.isArray(data) ? data.map((r) => render(req, r)) : render(req, data),
    included: store.included([data].flat()).map((r) => render(req, r)),
    ...extra,
  });

  const findOr404 = (type, id) => store.find(type, id) ?? fail(404, 'not_found', `No ${type} with id ${id}`);

  const positiveInt = (req, name, fallback) => {
    const value = req.query[name];
    if (value === undefined) return fallback;
    return /^[1-9]\d*$/.test(value) ? Number(value) : fail(400, 'invalid_parameter', `${name} must be a positive integer`, parameter(name));
  };

  const paginate = (req, items) => {
    const size = Math.min(positiveInt(req, 'page[size]', 20), 50);
    const number = positiveInt(req, 'page[number]', 1);
    const last = Math.max(1, Math.ceil(items.length / size));
    const link = (n) => {
      const url = new URL(req.url, origin(req));
      url.searchParams.set('page[number]', n);
      url.searchParams.set('page[size]', size);
      return url.href;
    };
    return {
      page: items.slice((number - 1) * size, number * size),
      links: {
        self: link(number),
        first: link(1),
        last: link(last),
        prev: number > 1 ? link(Math.min(number - 1, last)) : null,
        next: number < last ? link(number + 1) : null,
      },
      meta: { total: items.length },
    };
  };

  const resourceFrom = (req, type) => {
    const data = req.body?.data;
    if (!isObject(data)) fail(400, 'invalid_document', 'Request body must have a data object', pointer('/data'));
    for (const member of ['attributes', 'relationships']) {
      if (member in data && !isObject(data[member])) {
        fail(400, 'invalid_document', `data.${member} must be an object`, pointer(`/data/${member}`));
      }
    }
    if (data.type !== type) fail(409, 'type_mismatch', `Expected a resource of type "${type}"`, pointer('/data/type'));
    return { id: data.id, attributes: data.attributes ?? {}, relationships: data.relationships ?? {} };
  };

  const lookup = (category, id) => {
    const found = store.find('lookups', String(id));
    return found?.attributes.category === category ? found : undefined;
  };
  const isDuration = (minutes) =>
    store.all('lookups').some((l) => l.attributes.category === 'viewing-duration' && l.attributes.value === minutes);

  const fullName = (r) => `${r.attributes.firstName} ${r.attributes.lastName}`;

  /** Throws 409 when the slot overlaps a live viewing of the same property, applicant or agent. */
  const assertSlotFree = (start, end, { propertyId, applicantId, agentIds }, ignoreId) => {
    for (const v of store.all('viewings')) {
      if (v.id === ignoreId || v.attributes.status === 'cancelled') continue;
      const [vStart, vEnd] = [Date.parse(v.attributes.startsAt), Date.parse(v.attributes.endsAt)];
      if (!(vStart < end && start < vEnd)) continue;
      const when = `${londonDate(vStart)} ${londonTime(vStart)}–${londonTime(vEnd)}`;
      const meta = { meta: { viewingId: v.id } };
      if (v.relationships.property.data.id === propertyId) {
        fail(409, 'property_unavailable', 'The property already has a viewing at this time', { detail: `Booked ${when}`, ...meta });
      }
      if (v.relationships.applicant.data.id === applicantId) {
        fail(409, 'applicant_unavailable', 'The applicant already has a viewing at this time', { detail: `Booked ${when}`, ...meta });
      }
      const agent = v.relationships.agents.data.find((a) => agentIds.includes(a.id));
      if (agent) {
        const name = fullName(store.find('agents', agent.id));
        fail(409, 'agent_unavailable', `${name} already has a viewing at this time`, { detail: `Booked ${when}`, ...meta });
      }
    }
  };

  // --- routes -----------------------------------------------------------------------------------

  app.get('/', async () => ({ meta: { name: 'Doorstep API', serverTime: new Date(now()).toISOString() } }));

  app.post('/auth/token', async (req, reply) => {
    const { email, password } = req.body ?? {};
    const agent = store
      .all('agents')
      .find((a) => a.attributes.email.toLowerCase() === String(email ?? '').trim().toLowerCase());
    if (!agent || password !== PASSWORD) fail(401, 'invalid_credentials', 'Email or password is incorrect');

    const accessToken = randomUUID();
    const expiresAt = now() + TOKEN_TTL_MS;
    sessions.set(accessToken, { agentId: agent.id, expiresAt });
    const token = {
      type: 'tokens',
      id: randomUUID(),
      attributes: { accessToken, tokenType: 'Bearer', expiresAt: new Date(expiresAt).toISOString() },
      relationships: { agent: { data: ref('agents', agent.id) } },
    };
    return reply.code(201).send(document(req, token));
  });

  app.get('/me', async (req) => document(req, req.agent));

  app.get('/agents', async (req) => document(req, store.all('agents')));

  app.get('/lookups', async (req) => {
    const category = req.query['filter[category]'];
    const lookups = store
      .all('lookups')
      .filter((l) => !category || l.attributes.category === category)
      .sort((a, b) => a.attributes.category.localeCompare(b.attributes.category) || a.attributes.sortOrder - b.attributes.sortOrder);
    return document(req, lookups);
  });

  app.get('/viewings', async (req) => {
    const q = req.query;
    const has = (name) => q[name] !== undefined;
    if (has('filter[date]') && (has('filter[from]') || has('filter[to]'))) {
      fail(400, 'invalid_parameter', 'Use filter[date], or filter[from] with filter[to], not both', parameter('filter[date]'));
    }
    if (has('filter[from]') !== has('filter[to]')) {
      fail(400, 'invalid_parameter', 'filter[from] and filter[to] must be used together', parameter(has('filter[from]') ? 'filter[to]' : 'filter[from]'));
    }
    const from = q['filter[date]'] ?? q['filter[from]'] ?? londonDate(now());
    const to = q['filter[date]'] ?? q['filter[to]'] ?? from;
    const named = has('filter[date]') ? [['filter[date]', from]] : [['filter[from]', from], ['filter[to]', to]];
    for (const [name, value] of named) {
      if (!isDate(value)) fail(400, 'invalid_parameter', 'Dates must be real dates in YYYY-MM-DD form', parameter(name));
    }
    if (to < from) fail(400, 'invalid_parameter', 'filter[to] must not be before filter[from]', parameter('filter[to]'));

    const viewings = store
      .all('viewings')
      .filter((v) => v.relationships.agents.data.some((a) => a.id === req.agent.id))
      .filter((v) => {
        const day = londonDate(Date.parse(v.attributes.startsAt));
        return day >= from && day <= to;
      })
      .sort((a, b) => Date.parse(a.attributes.startsAt) - Date.parse(b.attributes.startsAt));
    return document(req, viewings);
  });

  app.get('/viewings/:id', async (req) => document(req, findOr404('viewings', req.params.id)));

  app.post('/viewings', async (req, reply) => {
    const { attributes: a, relationships: rel } = resourceFrom(req, 'viewings');
    const errors = [];

    const property = store.find('properties', rel.property?.data?.id);
    if (!property) errors.push(invalid('/data/relationships/property', 'Choose a property'));
    const applicant = store.find('people', rel.applicant?.data?.id);
    if (!applicant?.attributes.roles.includes('applicant')) errors.push(invalid('/data/relationships/applicant', 'Choose an applicant'));
    const extraAgents = [rel.agents?.data ?? []].flat();
    if (extraAgents.some((r) => !store.find('agents', r?.id))) errors.push(invalid('/data/relationships/agents', 'Unknown agent'));

    const start = parseInstant(a.startsAt);
    if (Number.isNaN(start)) errors.push(invalid('/data/attributes/startsAt', 'startsAt must be an ISO 8601 date-time with an offset'));
    else if (start <= now()) errors.push(invalid('/data/attributes/startsAt', 'Viewings must be booked in the future'));
    const duration = a.durationMinutes ?? 30;
    if (!isDuration(duration)) errors.push(invalid('/data/attributes/durationMinutes', 'Choose one of the viewing-duration lookups'));
    if (a.notes != null && (typeof a.notes !== 'string' || a.notes.length > MAX_NOTES)) {
      errors.push(invalid('/data/attributes/notes', `Notes must be at most ${MAX_NOTES} characters`));
    }
    failAll(errors);

    const agentIds = [...new Set([req.agent.id, ...extraAgents.map((r) => String(r.id))])];
    const end = start + duration * 60_000;
    assertSlotFree(start, end, { propertyId: property.id, applicantId: applicant.id, agentIds });

    const viewing = store.insert(
      'viewings',
      {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        status: 'unconfirmed',
        cancellationReason: null,
        notes: a.notes ?? null,
      },
      {
        property: { data: ref('properties', property.id) },
        applicant: { data: ref('people', applicant.id) },
        agents: { data: agentIds.map((id) => ref('agents', id)) },
        feedback: { data: null },
      },
    );
    return reply.code(201).send(document(req, viewing));
  });

  app.patch('/viewings/:id', async (req) => {
    const viewing = findOr404('viewings', req.params.id);
    const { id, attributes: a } = resourceFrom(req, 'viewings');
    if (id !== viewing.id) fail(409, 'id_mismatch', 'data.id must match the URL', pointer('/data/id'));
    if (viewing.attributes.status === 'cancelled') fail(422, 'viewing_cancelled', 'A cancelled viewing cannot be changed');

    const errors = [];
    if ('status' in a && !['confirmed', 'cancelled'].includes(a.status)) {
      errors.push(invalid('/data/attributes/status', 'status must be "confirmed" or "cancelled"'));
    }
    if (a.status === 'cancelled' && !lookup('cancellation-reason', a.cancellationReason)) {
      errors.push(invalid('/data/attributes/cancellationReason', 'Choose a cancellation reason'));
    }
    const currentDuration = (Date.parse(viewing.attributes.endsAt) - Date.parse(viewing.attributes.startsAt)) / 60_000;
    const duration = a.durationMinutes ?? currentDuration;
    const rescheduling = 'startsAt' in a || 'durationMinutes' in a;
    const start = 'startsAt' in a ? parseInstant(a.startsAt) : Date.parse(viewing.attributes.startsAt);
    if (rescheduling) {
      if (Number.isNaN(start)) errors.push(invalid('/data/attributes/startsAt', 'startsAt must be an ISO 8601 date-time with an offset'));
      else if (start <= now()) errors.push(invalid('/data/attributes/startsAt', 'Viewings must be rescheduled to a future time'));
    }
    if ('durationMinutes' in a && !isDuration(duration)) {
      errors.push(invalid('/data/attributes/durationMinutes', 'Choose one of the viewing-duration lookups'));
    }
    if (a.notes != null && (typeof a.notes !== 'string' || a.notes.length > MAX_NOTES)) {
      errors.push(invalid('/data/attributes/notes', `Notes must be at most ${MAX_NOTES} characters`));
    }
    failAll(errors);

    if (rescheduling) {
      const end = start + duration * 60_000;
      assertSlotFree(
        start,
        end,
        {
          propertyId: viewing.relationships.property.data.id,
          applicantId: viewing.relationships.applicant.data.id,
          agentIds: viewing.relationships.agents.data.map((r) => r.id),
        },
        viewing.id,
      );
      // A new time has to be agreed again.
      Object.assign(viewing.attributes, { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), status: 'unconfirmed' });
    }
    if ('notes' in a) viewing.attributes.notes = a.notes || null;
    if (a.status) viewing.attributes.status = a.status;
    if (a.status === 'cancelled') viewing.attributes.cancellationReason = String(a.cancellationReason);
    return document(req, viewing);
  });

  app.post('/viewings/:id/feedback', async (req, reply) => {
    const viewing = findOr404('viewings', req.params.id);
    const { attributes: a } = resourceFrom(req, 'feedback');
    if (viewing.attributes.status === 'cancelled') fail(422, 'viewing_cancelled', 'Feedback cannot be recorded for a cancelled viewing');
    if (Date.parse(viewing.attributes.startsAt) > now()) {
      fail(422, 'viewing_not_started', 'Feedback can be recorded once the viewing has started');
    }
    if (viewing.relationships.feedback.data) fail(409, 'feedback_exists', 'Feedback has already been recorded for this viewing');

    const errors = [];
    if (!lookup('interest-level', a.interestLevel)) errors.push(invalid('/data/attributes/interestLevel', 'Choose an interest level'));
    const quickResponses = a.quickResponses ?? [];
    if (!Array.isArray(quickResponses) || quickResponses.some((id) => !lookup('feedback-quick-response', id))) {
      errors.push(invalid('/data/attributes/quickResponses', 'Unknown quick response'));
    }
    if (a.notes != null && (typeof a.notes !== 'string' || a.notes.length > MAX_NOTES)) {
      errors.push(invalid('/data/attributes/notes', `Notes must be at most ${MAX_NOTES} characters`));
    }
    failAll(errors);

    const feedback = store.insert('feedback', {
      interestLevel: String(a.interestLevel),
      quickResponses: quickResponses.map(String),
      notes: a.notes || null,
      submittedAt: new Date(now()).toISOString(),
    });
    viewing.relationships.feedback = { data: ref('feedback', feedback.id) };
    return reply.code(201).send(document(req, feedback));
  });

  app.get('/properties', async (req) => {
    const q = req.query['filter[q]']?.trim().toLowerCase();
    const market = req.query['filter[market]'];
    if (market && !['sales', 'lettings'].includes(market)) {
      fail(400, 'invalid_parameter', 'filter[market] must be "sales" or "lettings"', parameter('filter[market]'));
    }
    const properties = store
      .all('properties')
      .filter((p) => !market || p.attributes.market === market)
      .filter((p) => {
        const { line1, line2, town, postcode } = p.attributes.address;
        return !q || [line1, line2, town, postcode].join(' ').toLowerCase().includes(q);
      });
    const { page, ...rest } = paginate(req, properties);
    return document(req, page, rest);
  });

  app.get('/properties/:id', async (req) => document(req, findOr404('properties', req.params.id)));

  app.get('/people', async (req) => {
    const q = req.query['filter[q]']?.trim().toLowerCase();
    const role = req.query['filter[role]'];
    const digits = q?.replace(/\D/g, '');
    const people = store
      .all('people')
      .filter((p) => !role || p.attributes.roles.includes(role))
      .filter((p) => {
        if (!q) return true;
        const { email, phone } = p.attributes;
        return (
          fullName(p).toLowerCase().includes(q) ||
          email?.toLowerCase().includes(q) ||
          (digits.length >= 3 && phone?.replace(/\D/g, '').includes(digits))
        );
      })
      .sort((a, b) => a.attributes.lastName.localeCompare(b.attributes.lastName) || a.attributes.firstName.localeCompare(b.attributes.firstName));
    const { page, ...rest } = paginate(req, people);
    return document(req, page, rest);
  });

  app.get('/people/:id', async (req) => document(req, findOr404('people', req.params.id)));

  app.post('/people', async (req, reply) => {
    const { attributes: a } = resourceFrom(req, 'people');
    const text = (value) => (typeof value === 'string' ? value.trim() : '');
    const [firstName, lastName, email, phone] = [a.firstName, a.lastName, a.email, a.phone].map(text);
    const errors = [];
    if (!firstName) errors.push(invalid('/data/attributes/firstName', 'First name is required'));
    if (!lastName) errors.push(invalid('/data/attributes/lastName', 'Last name is required'));
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(invalid('/data/attributes/email', 'Enter a valid email address'));
    if (phone && !/^(?:\+44|0)\d{9,10}$/.test(phone.replace('(0)', '').replace(/[\s()-]/g, ''))) {
      errors.push(invalid('/data/attributes/phone', 'Enter a valid UK phone number'));
    }
    if (!email && !phone) errors.push(invalid('/data/attributes', 'Add a phone number or an email address'));
    failAll(errors);

    const duplicate = email && store.all('people').find((p) => p.attributes.email?.toLowerCase() === email.toLowerCase());
    if (duplicate) {
      fail(409, 'duplicate_person', `${fullName(duplicate)} already uses this email address`, {
        ...pointer('/data/attributes/email'),
        meta: { personId: duplicate.id },
      });
    }

    const person = store.insert('people', {
      firstName,
      lastName,
      email: email || null,
      phone: phone || null,
      roles: ['applicant'],
      requirements: null,
    });
    return reply.code(201).send(document(req, person));
  });

  return app;
}
