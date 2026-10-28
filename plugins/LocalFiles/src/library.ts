import { ReactiveStore } from "@luna/core";
import { showOpenDialog } from "@luna/lib.native";

import { trace } from ".";
import { registerFiles, scanFolder, startServer } from "./scan.native";
import type { LocalTrack } from "./types";

type Storage = {
	folder?: string;
	recursive: boolean;
	scanOnStartup: boolean;
	lastScan?: number;
	/** Cached scan result so the library is available instantly on startup */
	tracks: LocalTrack[];
	/** Local track ids added to Tidal playlists, by playlist uuid */
	playlistItems: Record<string, number[]>;
};
export const storage = await ReactiveStore.getPluginStorage<Storage>("LocalFiles", {
	recursive: true,
	scanOnStartup: true,
	tracks: [],
	playlistItems: {},
});

// Started once, serves audio & covers to Tidal's player
export const server = await startServer();

// #region Change listeners (used by react components)
type Listener = () => void;
const listeners = new Set<Listener>();
export const onLibraryChange = (listener: Listener) => {
	listeners.add(listener);
	return () => void listeners.delete(listener);
};
const emit = () => listeners.forEach((listener) => listener());

export const libraryState = { scanning: false, error: undefined as string | undefined };
// #endregion

// #region Lookup
let byId = new Map<number, LocalTrack>();
/** Track id with an embedded cover for each album */
let albumCovers = new Map<string, number>();

export const albumKey = (track: LocalTrack) => `${track.albumArtist ?? track.artist}\0${track.album}`;

const index = () => {
	byId = new Map(storage.tracks.map((track) => [track.id, track]));
	albumCovers = new Map();
	for (const track of storage.tracks) if (track.hasCover && !albumCovers.has(albumKey(track))) albumCovers.set(albumKey(track), track.id);
	registerFiles(storage.tracks.map(({ id, path }) => ({ id, path })));
};

export const getTracks = (): LocalTrack[] => storage.tracks;
export const getTrack = (id: unknown) => byId.get(Number(id));

/** Id of the track whose embedded cover is used for `track`, if any */
export const coverTrackId = (track: LocalTrack) => (track.hasCover ? track.id : albumCovers.get(albumKey(track)));
export const coverUrl = (trackId: number) => `${server.baseUrl}/cover/${trackId}`;
export const audioUrl = (track: LocalTrack) => `${server.baseUrl}/audio/${track.id}.${track.format}`;
// #endregion

export const sortTracks = (tracks: LocalTrack[]) =>
	[...tracks].sort(
		(a, b) =>
			(a.albumArtist ?? a.artist).localeCompare(b.albumArtist ?? b.artist, undefined, { sensitivity: "base" }) ||
			a.album.localeCompare(b.album, undefined, { sensitivity: "base" }) ||
			(a.discNumber ?? 1) - (b.discNumber ?? 1) ||
			(a.trackNumber ?? 0) - (b.trackNumber ?? 0) ||
			a.title.localeCompare(b.title),
	);

export const chooseFolder = async () => {
	const { canceled, filePaths } = await showOpenDialog({ title: "Choose your music folder", properties: ["openDirectory"] });
	if (canceled || filePaths[0] === undefined) return;
	storage.folder = filePaths[0];
	emit();
	await rescan();
	return storage.folder;
};

const scanListeners = new Set<(tracks: LocalTrack[]) => void>();
/** Called after every (re)scan and on startup with the cached library */
export const onScanned = (listener: (tracks: LocalTrack[]) => void) => {
	scanListeners.add(listener);
	return () => void scanListeners.delete(listener);
};

export const rescan = async () => {
	if (storage.folder === undefined || libraryState.scanning) return;
	libraryState.scanning = true;
	libraryState.error = undefined;
	emit();
	try {
		const tracks = await scanFolder(storage.folder, storage.recursive);
		storage.tracks = sortTracks(tracks);
		storage.lastScan = Date.now();
		index();
		scanListeners.forEach((listener) => listener(storage.tracks));
		trace.msg.log(`Found ${tracks.length} local files`);
	} catch (err) {
		libraryState.error = err instanceof Error ? err.message : String(err);
		trace.msg.err(`Failed to scan ${storage.folder}: ${libraryState.error}`);
	} finally {
		libraryState.scanning = false;
		emit();
	}
};

/**
 * Loads the cached library, rescanning if needed.
 */
export const initLibrary = async () => {
	// Caches from older versions have no ids
	if (storage.tracks.some((track) => typeof track.id !== "number")) storage.tracks = [];
	index();
	scanListeners.forEach((listener) => listener(storage.tracks));
	if (storage.scanOnStartup || (storage.tracks.length === 0 && storage.folder !== undefined)) await rescan();
};
