export type LocalTrack = {
	/** Fake Tidal track id, derived from the path (see ids.ts) */
	id: number;
	/** Absolute file path */
	path: string;
	format: "mp3" | "flac";
	/** File size in bytes */
	size: number;
	title: string;
	artist: string;
	album: string;
	albumArtist?: string;
	trackNumber?: number;
	discNumber?: number;
	year?: string;
	/** Duration in seconds */
	duration?: number;
	hasCover: boolean;
	/** Sample rate & bit depth (FLAC only) */
	sampleRate?: number;
	bitDepth?: number;
};

export type ServerInfo = {
	/** e.g. http://127.0.0.1:51234/<token> */
	baseUrl: string;
};
