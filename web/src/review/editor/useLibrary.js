import { EQUIPMENT_LIBRARY, LIBRARY_CATEGORIES } from '@shared/plan/index.js';
import { useEffect, useState } from 'react';

import { libraryApi } from '../../lib/client.js';

/**
 * A library row from the API as the editor uses it. `key` must be unique
 * in the list (it is the drag payload and the React key), and the same
 * library key may be used by a generic machine and by a maker's, so the
 * row id is the key; `libraryKey` keeps the library's own.
 */
export function fromApi(item) {
  return { ...item, key: item.id, libraryKey: item.key };
}

/** The groups to list, the usual ones first, then any an admin added. */
export function categoriesOf(items) {
  const extra = [...new Set(items.map((i) => i.category))].filter((c) => !LIBRARY_CATEGORIES.includes(c)).sort();
  return [...LIBRARY_CATEGORIES.filter((c) => items.some((i) => i.category === c)), ...extra];
}

/**
 * The equipment library from the database. Until it arrives, and if it
 * cannot be had (offline, an older API), the built-in list stands in, so
 * the editor's library and fit-out schedule keep working either way.
 * `live` says which one is showing.
 */
export function useLibrary(load = libraryApi.list) {
  const [state, setState] = useState({ items: EQUIPMENT_LIBRARY, live: false, failed: false });
  useEffect(() => {
    let current = true;
    load().then(
      (body) => {
        if (!current) return;
        const items = (body?.items ?? []).map(fromApi);
        // An empty database would leave nothing to place: keep the built-in list.
        setState(items.length ? { items, live: true, failed: false } : { items: EQUIPMENT_LIBRARY, live: false, failed: false });
      },
      () => current && setState({ items: EQUIPMENT_LIBRARY, live: false, failed: true }),
    );
    return () => {
      current = false;
    };
  }, [load]);
  return state;
}
