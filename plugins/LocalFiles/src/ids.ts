// Shared between the renderer and the native module.

/**
 * Local items get ids in [LOCAL_ID_BASE, LOCAL_ID_BASE + 1e12), far above real Tidal ids.
 */
export const LOCAL_ID_BASE = 9_000_000_000_000;

// rizz hash, small but gets the job done
const fnv1a = (str: string, seed: number) => {
	let hash = seed >>> 0;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
};

/** Stable numeric id derived from `key` (e.g. a file path) */
export const localId = (key: string) => LOCAL_ID_BASE + (fnv1a(key, 0x811c9dc5) % 1_000_000) * 1_000_000 + (fnv1a(key, 0x01234567) % 1_000_000);

export const isLocalId = (id: unknown) => {
	const num = typeof id === "number" ? id : typeof id === "string" && /^\d+$/.test(id) ? Number(id) : NaN;
	return num >= LOCAL_ID_BASE && num < LOCAL_ID_BASE + 1e12;
};
