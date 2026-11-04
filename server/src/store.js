import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addDays, daysBetween, fromLondon, londonDate } from './time.js';

const DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));
// Seed data is written around this Monday; at boot it is moved by whole weeks so this week is the current week.
const ANCHOR = '2030-01-07';
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

const key = (type, id) => `${type}:${id}`;

export function createStore(now) {
  const shift = Math.floor(daysBetween(ANCHOR, londonDate(now)) / 7) * 7;
  const resources = new Map();

  for (const file of readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'))) {
    for (const resource of JSON.parse(readFileSync(`${DATA_DIR}/${file}`, 'utf8'))) {
      for (const [name, value] of Object.entries(resource.attributes)) {
        if (name.endsWith('At') && LOCAL_DATE_TIME.test(value ?? '')) {
          const [date, time] = value.split('T');
          resource.attributes[name] = new Date(fromLondon(`${addDays(date, shift)}T${time}`)).toISOString();
        }
      }
      resources.set(key(resource.type, resource.id), resource);
    }
  }

  const all = (type) => [...resources.values()].filter((r) => r.type === type);

  return {
    all,
    find: (type, id) => resources.get(key(type, id)),

    insert(type, attributes, relationships = {}) {
      const id = String(Math.max(0, ...all(type).map((r) => Number(r.id))) + 1);
      const resource = { type, id, attributes, relationships };
      resources.set(key(type, id), resource);
      return resource;
    },

    /** Every resource reachable through relationships from the primary data, each once. */
    included(primary) {
      const seen = new Set(primary.map((r) => key(r.type, r.id)));
      const out = [];
      const walk = (resource) => {
        for (const { data } of Object.values(resource.relationships ?? {})) {
          for (const ref of [data].flat()) {
            if (!ref || seen.has(key(ref.type, ref.id))) continue;
            seen.add(key(ref.type, ref.id));
            const related = resources.get(key(ref.type, ref.id));
            if (related) {
              out.push(related);
              walk(related);
            }
          }
        }
      };
      primary.forEach(walk);
      return out;
    },
  };
}
