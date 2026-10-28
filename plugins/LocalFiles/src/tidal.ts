// Makes local files behave like Tidal tracks: they live in Tidal's redux store, play through Tidal's own player
// (stream urls point at the local server from scan.native.ts) and can be added to Tidal playlists (stored locally).
import type { LunaUnloads } from "@luna/core";
import { ContentBase, redux } from "@luna/lib";

import { trace } from ".";
import { isLocalId, localId } from "./ids";
import { albumKey, audioUrl, coverTrackId, coverUrl, getTrack, storage } from "./library";
import type { LocalTrack } from "./types";

// #region Tidal objects
/** Tidal builds cover urls as `${resourcesUrl}/images/${cover.replace(/-/g, "/")}/${size}.jpg` */
// Tidal only accepts hex uuids as covers, so the cover track id is encoded as `10ca1f11-0000-4000-8000-<id in hex>`
const COVER_PREFIX = "10ca1f11-0000-4000-8000-";
const COVER_PATH = "/images/10ca1f11/0000/4000/8000/";
const COVER_URL_REGEX = /https?:\/\/[^\s"',]*\/images\/10ca1f11\/0000\/4000\/8000\/([0-9a-f]{12})\/[^\s"',]*/g;
/** Fake Tidal cover uuid for the cover of `coverId` (0 = no cover) */
const coverUuid = (coverId?: number) => `${COVER_PREFIX}${(coverId ?? 0).toString(16).padStart(12, "0")}`;
/** Replaces fake cover urls with the local server (or a placeholder) */
const replaceCoverUrls = (value: string) =>
	value.replace(COVER_URL_REGEX, (_, hex: string) => {
		const id = parseInt(hex, 16);
		return id === 0 ? PLACEHOLDER_COVER : coverUrl(id);
	});
// URL encoded instead of base64, btoa can't handle "♪"
const PLACEHOLDER_COVER =
	"data:image/svg+xml;charset=utf-8," +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#2a2a30"/><text x="50" y="64" font-size="40" text-anchor="middle" fill="#8a8a96" font-family="sans-serif">♪</text></svg>`,
	);

const iso = (year?: string) => (year && /^\d{4}$/.test(year) ? `${year}-01-01T00:00:00.000+0000` : "2000-01-01T00:00:00.000+0000");

export const toTidalTrack = (track: LocalTrack) => {
	const artist = { id: localId(`artist:${track.artist}`), name: track.artist, type: "MAIN", picture: null, handle: null };
	const cover = coverTrackId(track);
	return {
		contentType: "track",
		id: track.id,
		title: track.title,
		version: null,
		duration: Math.round(track.duration ?? 0),
		trackNumber: track.trackNumber ?? 0,
		volumeNumber: track.discNumber ?? 1,
		streamStartDate: iso(track.year),
		releaseDate: iso(track.year),
		explicit: false,
		popularity: 0,
		artist,
		artists: [artist],
		album: {
			id: localId(`album:${albumKey(track)}`),
			title: track.album,
			cover: coverUuid(cover),
			vibrantColor: "#8a8a96",
			videoCover: null,
			releaseDate: track.year ?? null,
		},
		mixes: null,
		url: `http://www.tidal.com/track/${track.id}`,
		replayGain: 0,
		peak: 1,
		editable: false,
		audioQuality: track.format === "flac" ? "LOSSLESS" : "HIGH",
		audioModes: ["STEREO"],
		mediaMetadata: { tags: track.format === "flac" ? ["LOSSLESS"] : [] },
		isrc: null,
		copyright: null,
		bpm: null,
		upload: false,
		allowStreaming: true,
		streamReady: true,
		adSupportedStreamReady: true,
		djReady: false,
		stemReady: false,
		payToStream: false,
		premiumStreamingOnly: false,
		spotlighted: false,
	};
};

const known = new Set<number>();
/**
 * Puts local tracks into Tidal's redux store so the UI (player bar, queue, playlists) can show them
 */
export const registerInStore = (tracks: LocalTrack[]) => {
	const missing = tracks.filter((track) => !known.has(track.id) || !(String(track.id) in redux.store.getState().content.mediaItems));
	if (missing.length === 0) return;
	redux.actions["content/LAZY_LOAD_MEDIA_ITEMS_SUCCESS"](<any>missing.map((track) => ({ type: "track", item: toTidalTrack(track) })));
	for (const track of missing) known.add(track.id);
};
// #endregion

// #region Playback
export const playTracks = (tracks: LocalTrack[], startIndex: number = 0, shuffle: boolean = false) => {
	if (tracks.length === 0) return;
	registerInStore(tracks);
	redux.actions["playQueue/ADD_NOW"]({
		context: { type: "UNKNOWN" },
		mediaItemIds: tracks.map((track) => track.id),
		fromIndex: startIndex,
		overwritePlayQueue: true,
	});
	if (shuffle) redux.actions["playQueue/ENABLE_SHUFFLE_MODE_AND_SHUFFLE_ITEMS"]({ shuffleSeed: Math.random() });
};

/**
 * When Tidal advances from a track on its native player (lossless) to a local track it has to switch to its
 * built in player, which leaves playback stuck. Re-selecting the queue entry (like clicking it) fixes that.
 */
export const fixAutoplay = (unloads: LunaUnloads) => {
	let lastItemId: unknown;
	let wantedPlaying = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const currentItemId = () => {
		const { playQueue } = redux.store.getState();
		return playQueue.elements[playQueue.currentIndex]?.mediaItemId;
	};
	const unsubscribe = redux.store.subscribe(() => {
		const itemId = currentItemId();
		if (itemId !== lastItemId) {
			const advancedWhilePlaying = wantedPlaying;
			lastItemId = itemId;
			clearTimeout(timer);
			if (advancedWhilePlaying && isLocalId(itemId)) {
				timer = setTimeout(() => {
					const { playQueue, playbackControls } = redux.store.getState();
					if (currentItemId() !== itemId || playbackControls.playbackState === "PLAYING") return;
					redux.actions["playQueue/MOVE_TO"](playQueue.currentIndex);
				}, 2500);
			}
		}
		wantedPlaying = redux.store.getState().playbackControls.desiredPlaybackState === "PLAYING";
	});
	unloads.add(() => {
		unsubscribe();
		clearTimeout(timer);
	});
};

export const openContextMenu =(track: LocalTrack, event: { clientX: number; clientY: number }) => {
	registerInStore([track]);
	redux.actions["contextMenu/OPEN_MEDIA_ITEM"]({
		id: track.id,
		type: "MEDIA_ITEM",
		position: [event.clientX, event.clientY],
		canBlock: false,
		contextMenuLocation: "trackList",
		sourceContext: { type: "UNKNOWN" },
	});
};

const btsManifest = (track: LocalTrack) =>
	btoa(
		JSON.stringify({
			mimeType: track.format === "flac" ? "audio/flac" : "audio/mpeg",
			codecs: track.format,
			encryptionType: "NONE",
			urls: [audioUrl(track)],
		}),
	);
// #endregion

// #region Fetch interception
const json = (body: unknown, status: number = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const getHeader = (input: RequestInfo | URL, init: RequestInit | undefined, name: string) => {
	if (init?.headers !== undefined) {
		const value = new Headers(init.headers).get(name);
		if (value !== null) return value;
	}
	return input instanceof Request ? input.headers.get(name) : null;
};

/** Real (server side) item counts of playlists, needed to map indices to local items */
const serverTotals = new Map<string, number>();

const PLAYLIST_ITEMS_REGEX = /\/playlists\/([0-9a-f-]{36})\/items$/;

const handleRequest = (url: URL, method: string, input: RequestInfo | URL, init?: RequestInit): Response | undefined => {
	const path = url.pathname;

	// Legacy stream info, used when the native player is preferred
	let match = /\/tracks\/(\d+)\/playbackinfo/.exec(path);
	if (match && isLocalId(match[1])) {
		const track = getTrack(match[1]);
		// Only Tidal's player sends a streaming session. Other requests (e.g. Luna's MediaItem used by downloader plugins)
		// would download the file and pipe it through a FLAC tagger, which crashes on mp3s.
		const streamingSessionId = getHeader(input, init, "x-tidal-streamingsessionid");
		if (track === undefined || streamingSessionId === null) return json({ status: 404, subStatus: 2001, userMessage: "Not available for local files" }, 404);
		return json({
			trackId: track.id,
			assetPresentation: "FULL",
			audioMode: "STEREO",
			// HIGH makes Tidal use its built in (shaka) player which can play mp3 & flac
			audioQuality: "HIGH",
			manifestMimeType: "application/vnd.tidal.bts",
			manifestHash: `local-${track.id}`,
			manifest: btsManifest(track),
			albumReplayGain: 0,
			albumPeakAmplitude: 1,
			trackReplayGain: 0,
			trackPeakAmplitude: 1,
			bitDepth: track.bitDepth ?? null,
			sampleRate: track.sampleRate ?? null,
			streamingSessionId,
		});
	}

	// OpenAPI stream info
	match = /\/trackManifests\/(\d+)$/.exec(path);
	if (match && isLocalId(match[1])) {
		const track = getTrack(match[1]);
		if (track === undefined) return json({ errors: [{ status: "404", code: "NOT_FOUND" }] }, 404);
		const normalization = { replayGain: 0, peakAmplitude: 1 };
		return json({
			data: {
				id: String(track.id),
				type: "trackManifests",
				attributes: {
					trackPresentation: "FULL",
					uri: `data:application/vnd.tidal.bts;base64,${btsManifest(track)}`,
					hash: `local-${track.id}`,
					// AACLC => HIGH => built in (shaka) player
					formats: ["AACLC"],
					trackAudioNormalizationData: normalization,
					albumAudioNormalizationData: normalization,
				},
			},
		});
	}

	// Track metadata
	match = /\/tracks\/(\d+)$/.exec(path);
	if (match && isLocalId(match[1]) && method === "GET") {
		const track = getTrack(match[1]);
		if (track !== undefined) return json(toTidalTrack(track));
	}

	// Anything else about local items (lyrics, credits, mixes, album/artist pages...) doesn't exist
	if (path.split("/").some(isLocalId)) return json({ status: 404, subStatus: 2001, userMessage: "Not available for local files" }, 404);
};

/** Appends local items to Tidal playlist pages */
const augmentPlaylistItems = async (uuid: string, url: URL, res: Response) => {
	const localIds = storage.playlistItems[uuid];
	if (!res.ok) return res;
	const body = await res.clone().json();
	if (!Array.isArray(body?.items) || typeof body.totalNumberOfItems !== "number") return res;

	const serverTotal = body.totalNumberOfItems;
	serverTotals.set(uuid, serverTotal);
	if (!localIds?.length) return res;

	const tracks = localIds.map(getTrack).filter((track): track is LocalTrack => track !== undefined);
	registerInStore(tracks);
	const offset = Number(url.searchParams.get("offset") ?? body.offset ?? 0);
	const limit = Number(url.searchParams.get("limit") ?? body.limit ?? 50);
	// Local items occupy indices [serverTotal, serverTotal + tracks.length)
	const from = Math.max(0, offset - serverTotal);
	const to = Math.max(0, offset + limit - serverTotal);
	const dateAdded = new Date().toISOString();
	body.items.push(...tracks.slice(from, to).map((track) => ({ item: toTidalTrack(track), type: "track", cut: null, dateAdded })));
	body.totalNumberOfItems = serverTotal + tracks.length;
	const headers = new Headers(res.headers);
	headers.delete("content-length");
	return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
};

// #region OpenAPI (v2) playlist items, JSON:API format
const V2_PLAYLIST_ITEMS_REGEX = /\/playlists\/([0-9a-f-]{36})\/relationships\/items$/;
type ItemRef = { id: string; type: string; meta?: { itemId?: string } };
type Resource = { id: string; type: string; attributes?: Record<string, unknown>; relationships?: Record<string, unknown> };

const LOCAL_ITEM_PREFIX = "luna-local-";
const isoDuration = (seconds?: number) => {
	const s = Math.round(seconds ?? 0);
	return `PT${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}H` : ""}${Math.floor((s % 3600) / 60)}M${s % 60}S`;
};
const COVER_SIZES = [1280, 640, 320, 160, 80];

/** JSON:API resources Tidal expects in `included` for a track */
const toV2Resources = (track: LocalTrack): Resource[] => {
	const artistId = String(localId(`artist:${track.artist}`));
	const albumId = String(localId(`album:${albumKey(track)}`));
	const coverId = coverTrackId(track);
	const artworkId = `${LOCAL_ITEM_PREFIX}art-${coverId ?? 0}`;
	const createdAt = "2000-01-01T00:00:00Z";
	const releaseDate = track.year && /^\d{4}$/.test(track.year) ? `${track.year}-01-01` : null;
	const mediaTags = track.format === "flac" ? ["LOSSLESS"] : [];
	return [
		{
			id: String(track.id),
			type: "tracks",
			attributes: {
				title: track.title,
				version: null,
				isrc: "",
				duration: isoDuration(track.duration),
				copyright: { text: "" },
				explicit: false,
				ai: false,
				popularity: 0,
				accessType: "PUBLIC",
				availability: ["STREAM"],
				mediaTags,
				toneTags: [],
				externalLinks: [],
				spotlighted: false,
				createdAt,
			},
			relationships: {
				artists: { data: [{ id: artistId, type: "artists" }] },
				albums: { data: [{ id: albumId, type: "albums" }] },
				providers: { data: [] },
				replacement: { data: null },
				usageRules: { data: { id: `${LOCAL_ITEM_PREFIX}usage`, type: "usageRules" } },
			},
		},
		{
			id: albumId,
			type: "albums",
			attributes: {
				title: track.album,
				barcodeId: "",
				numberOfVolumes: 1,
				numberOfItems: 1,
				duration: isoDuration(track.duration),
				explicit: false,
				ai: false,
				releaseDate,
				copyright: { text: "" },
				popularity: 0,
				accessType: "PUBLIC",
				availability: ["STREAM"],
				mediaTags,
				externalLinks: [],
				type: "ALBUM",
				albumType: "ALBUM",
				createdAt,
			},
			relationships: { coverArt: { data: [{ id: artworkId, type: "artworks" }] } },
		},
		{
			id: artworkId,
			type: "artworks",
			attributes: {
				mediaType: "IMAGE",
				// Same fake resources url as the v1 covers, swapped for the local server by fixCovers
				files: COVER_SIZES.map((size) => ({
					href: `https://resources.tidal.com/images/${coverUuid(coverId).replace(/-/g, "/")}/${size}x${size}.jpg`,
					type: "image/jpeg",
					meta: { width: size, height: size },
				})),
				visualMetadata: { selectedPaletteColor: "#8a8a96", status: "OK" },
			},
		},
		{
			id: artistId,
			type: "artists",
			attributes: {
				name: track.artist,
				popularity: 0,
				numberOfFollowers: 0,
				externalLinks: [],
				spotlighted: false,
				contributionsEnabled: false,
				ownerType: "LABEL",
			},
		},
		{
			id: `${LOCAL_ITEM_PREFIX}usage`,
			type: "usageRules",
			attributes: { countryCode: "DE", paid: [], subscription: ["STREAM"], free: ["STREAM"], validFrom: "2000-01-01T00:00:00Z" },
		},
	];
};

/** Appends local items to the last page of a v2 playlist items response */
const augmentPlaylistItemsV2 = async (uuid: string, res: Response) => {
	const localIds = storage.playlistItems[uuid];
	if (!res.ok || !localIds?.length) return res;
	const body = await res.clone().json();
	// Only the last page gets the local items
	if (!Array.isArray(body?.data) || body.links?.next) return res;

	const tracks = localIds.map(getTrack).filter((track): track is LocalTrack => track !== undefined);
	registerInStore(tracks);
	const addedAt = new Date().toISOString();
	body.data.push(...tracks.map((track, i) => ({ id: String(track.id), type: "tracks", meta: { itemId: `${LOCAL_ITEM_PREFIX}${i}-${track.id}`, addedAt } })));
	const included: Resource[] = Array.isArray(body.included) ? body.included : [];
	const seen = new Set(included.map((resource) => `${resource.type}:${resource.id}`));
	for (const resource of tracks.flatMap(toV2Resources)) {
		const key = `${resource.type}:${resource.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		included.push(resource);
	}
	body.included = included;
	return json(body, res.status);
};

const readBody = async (input: RequestInfo | URL, init?: RequestInit) => {
	const text = init?.body !== undefined ? String(init.body) : input instanceof Request ? await input.clone().text() : "";
	return JSON.parse(text || "{}");
};
/** Sends `input` again with a different JSON body */
const resend = (send: typeof window.fetch, input: RequestInfo | URL, init: RequestInit | undefined, body: unknown) =>
	input instanceof Request ? send(new Request(input, { body: JSON.stringify(body) })) : send(input, { ...init, body: JSON.stringify(body) });

/**
 * Tidal's "Add to playlist" posts `{ data: [{ id, type }], meta }` to the OpenAPI.
 * Local items are stored locally, only real Tidal items are sent on.
 */
const addPlaylistItems = async (uuid: string, input: RequestInfo | URL, init: RequestInit | undefined, send: typeof window.fetch) => {
	const body = await readBody(input, init);
	const items: ItemRef[] = Array.isArray(body?.data) ? body.data : [];
	const localItems = items.filter((item) => isLocalId(item.id));
	if (localItems.length === 0) return send(input, init);

	const existing = storage.playlistItems[uuid] ?? [];
	const allowDupes = body?.meta?.onDuplicates === "ADD";
	const added = localItems.filter((item) => allowDupes || !existing.includes(Number(item.id)));
	setPlaylistItems(uuid, [...existing, ...added.map((item) => Number(item.id))]);
	if (added.length < localItems.length) trace.msg.log(`${localItems.length - added.length} local track(s) already in this playlist`);
	setTimeout(() => reloadPlaylist(uuid), 500);

	// Duplicates are reported as added too, Tidal would otherwise show an error
	const remoteItems = items.filter((item) => !isLocalId(item.id));
	if (remoteItems.length === 0) return json({ data: localItems, meta: {} }, 201);

	// Forward the real Tidal items and report the local ones as added too
	const res = await resend(send, input, init, { ...body, data: remoteItems });
	if (!res.ok) return res;
	const resBody = await res.json().catch(() => ({}));
	resBody.data = [...(Array.isArray(resBody.data) ? resBody.data : []), ...localItems];
	return json(resBody, res.status);
};

/**
 * Removing from a playlist deletes `{ data: [{ id, type, meta: { itemId } }] }`
 */
const removePlaylistItems = async (uuid: string, input: RequestInfo | URL, init: RequestInit | undefined, send: typeof window.fetch) => {
	const body = await readBody(input, init);
	const items: ItemRef[] = Array.isArray(body?.data) ? body.data : [];
	const isLocalItem = (item: ItemRef) => isLocalId(item.id) || item.meta?.itemId?.startsWith(LOCAL_ITEM_PREFIX);
	const localItems = items.filter(isLocalItem);
	if (localItems.length === 0) return send(input, init);

	// itemId is "luna-local-<index>-<id>", fall back to the first entry with that id
	const remaining: (number | undefined)[] = [...(storage.playlistItems[uuid] ?? [])];
	for (const item of localItems) {
		const index = /^luna-local-(\d+)-/.exec(item.meta?.itemId ?? "")?.[1];
		const i = index !== undefined && remaining[Number(index)] === Number(item.id) ? Number(index) : remaining.indexOf(Number(item.id));
		if (i !== -1) remaining[i] = undefined;
	}
	setPlaylistItems(
		uuid,
		remaining.filter((id): id is number => id !== undefined),
	);

	const remoteItems = items.filter((item) => !isLocalItem(item));
	if (remoteItems.length === 0) return new Response(null, { status: 204 });
	return resend(send, input, init, { ...body, data: remoteItems });
};
// #endregion

export const interceptFetch = (unloads: LunaUnloads) => {
	const originalFetch = window.fetch;
	const lunaFetch: typeof window.fetch = async function (this: unknown, input, init) {
		try {
			const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(href, location.href);
			const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
			const handled = handleRequest(url, method, input, init);
			if (handled !== undefined) return handled;

			const playlist = method === "GET" ? PLAYLIST_ITEMS_REGEX.exec(url.pathname) : null;
			if (playlist !== null) return augmentPlaylistItems(playlist[1], url, await originalFetch.call(this, input, init));

			const v2Items = V2_PLAYLIST_ITEMS_REGEX.exec(url.pathname);
			if (v2Items !== null) {
				const send = originalFetch.bind(window);
				if (method === "GET") return augmentPlaylistItemsV2(v2Items[1], await send(input, init));
				if (method === "POST") return addPlaylistItems(v2Items[1], input, init, send);
				if (method === "DELETE") return removePlaylistItems(v2Items[1], input, init, send);
			}
		} catch (err) {
			trace.err.withContext("fetch")(err);
		}
		return originalFetch.call(this, input, init);
	};
	window.fetch = lunaFetch;
	unloads.add(() => {
		if (window.fetch === lunaFetch) window.fetch = originalFetch;
	});
};
// #endregion

// #region Covers
const fixImage = (img: HTMLImageElement) => {
	if (img.src.includes(COVER_PATH)) img.src = replaceCoverUrls(img.src);
	if (img.srcset.includes(COVER_PATH)) img.srcset = replaceCoverUrls(img.srcset);
};
const fixImages = (root: ParentNode) => {
	for (const img of root.querySelectorAll<HTMLImageElement>(`img[src*="${COVER_PATH}"], img[srcset*="${COVER_PATH}"]`)) fixImage(img);
};

/**
 * Tidal can't load covers of local tracks, swap their image urls for the local server
 */
export const fixCovers = (unloads: LunaUnloads) => {
	// Other Luna plugins (CoverTheme, DiscordRPC...) build cover urls via ContentBase.formatCoverUrl
	const originalFormatCoverUrl = ContentBase.formatCoverUrl;
	ContentBase.formatCoverUrl = function (uuid, opts) {
		if (uuid?.startsWith(COVER_PREFIX)) {
			const id = parseInt(uuid.slice(COVER_PREFIX.length), 16);
			return id === 0 ? undefined : coverUrl(id);
		}
		return originalFormatCoverUrl.call(this, uuid, opts);
	};
	unloads.add(() => {
		ContentBase.formatCoverUrl = originalFormatCoverUrl;
	});

	const observer = new MutationObserver((records) => {
		for (const record of records) {
			if (record.type === "attributes") {
				if (record.target instanceof HTMLImageElement) fixImage(record.target);
				continue;
			}
			for (const node of record.addedNodes) {
				if (node instanceof HTMLImageElement) fixImage(node);
				else if (node instanceof Element) fixImages(node);
			}
		}
	});
	observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset"] });
	fixImages(document);
	unloads.add(() => observer.disconnect());
};
// #endregion

// #region Playlists
const reloadPlaylist = (uuid: string) => {
	const listName = `playlists/${uuid}`;
	const list = redux.store.getState().content.trackLists?.[listName];
	redux.actions["content/LOAD_LIST_ITEMS_PAGE"](<any>{
		listName,
		listType: "mediaItems",
		order: list?.currentOrder ?? "INDEX",
		orderDirection: list?.currentDirection ?? "ASC",
		persistSort: false,
		reset: true,
	});
};

const setPlaylistItems = (uuid: string, ids: number[]) => {
	const playlistItems = { ...storage.playlistItems };
	if (ids.length === 0) delete playlistItems[uuid];
	else playlistItems[uuid] = ids;
	storage.playlistItems = playlistItems;
};

export const interceptPlaylists = (unloads: LunaUnloads) => {
	// Adding is handled in addPlaylistItems (fetch level), Tidal calls that saga directly without dispatching
	redux.intercept("content/REMOVE_MEDIA_ITEMS_FROM_PLAYLIST", unloads, (payload) => {
		const uuid = String(payload.playlistUUID);
		const localIds = storage.playlistItems[uuid];
		const serverTotal = serverTotals.get(uuid);
		const removeIndices: number[] = (<any>payload).removeIndices ?? [];
		if (!localIds?.length || serverTotal === undefined) return;

		const localIndices = new Set(removeIndices.filter((i) => i >= serverTotal).map((i) => i - serverTotal));
		if (localIndices.size === 0) return;
		setPlaylistItems(
			uuid,
			localIds.filter((_, i) => !localIndices.has(i)),
		);

		const remoteIndices = removeIndices.filter((i) => i < serverTotal);
		if (remoteIndices.length > 0) setTimeout(() => redux.actions["content/REMOVE_MEDIA_ITEMS_FROM_PLAYLIST"](<any>{ ...payload, removeIndices: remoteIndices }));
		else reloadPlaylist(uuid);
		return true;
	});

	// Tidal can't favorite local tracks
	redux.intercept(["content/ADD_MEDIA_ITEM_IDS_TO_FAVORITES", "content/TOGGLE_FAVORITE_ITEMS"], unloads, (payload: any) => {
		const ids: unknown[] = payload?.mediaItemIds ?? payload?.items?.map((item: any) => item?.itemId ?? item?.id) ?? [];
		if (!ids.some(isLocalId)) return;
		trace.msg.warn("Local files can't be added to My Collection, add them to a playlist instead");
		return true;
	});
};
// #endregion
