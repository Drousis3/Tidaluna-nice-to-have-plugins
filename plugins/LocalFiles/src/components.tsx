import React from "react";

import { PlayState, redux } from "@luna/lib";

import { chooseFolder, coverTrackId, coverUrl, getTracks, libraryState, onLibraryChange, rescan, storage } from "./library";
import { openContextMenu, playTracks } from "./tidal";
import type { LocalTrack } from "./types";

export const formatTime = (seconds?: number) => {
	if (seconds === undefined || !Number.isFinite(seconds)) return "–:––";
	seconds = Math.round(seconds);
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = String(seconds % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

// #region Hooks
const useLibrary = () => {
	const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
	React.useEffect(() => onLibraryChange(forceUpdate), []);
	return { tracks: getTracks(), ...libraryState, folder: storage.folder };
};

/** Currently playing media item id & state from Tidal's player */
const useNowPlaying = () => {
	const select = () => {
		const { playbackControls } = redux.store.getState();
		return `${playbackControls.playbackContext?.actualProductId ?? ""}|${playbackControls.desiredPlaybackState}`;
	};
	const value = React.useSyncExternalStore(redux.store.subscribe, select);
	const [id, state] = value.split("|");
	return { id: Number(id), playing: state === "PLAYING" };
};
// #endregion

const Cover = ({ track, size }: { track?: LocalTrack; size: number }) => {
	const coverId = track && coverTrackId(track);
	return (
		<div className="lf-cover" style={{ width: size, height: size }}>
			{coverId !== undefined ? <img src={coverUrl(coverId)} loading="lazy" /> : <span>♪</span>}
		</div>
	);
};

type SortKey = "default" | "title" | "artist" | "album" | "duration";
const sorters: Record<Exclude<SortKey, "default">, (a: LocalTrack, b: LocalTrack) => number> = {
	title: (a, b) => a.title.localeCompare(b.title),
	artist: (a, b) => a.artist.localeCompare(b.artist),
	album: (a, b) => a.album.localeCompare(b.album),
	duration: (a, b) => (a.duration ?? 0) - (b.duration ?? 0),
};

// main character page
export const LocalFilesPage = () => {
	const { tracks, scanning, error, folder } = useLibrary();
	const nowPlaying = useNowPlaying();
	const [filter, setFilter] = React.useState("");
	const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({ key: "default", desc: false });

	const visibleTracks = React.useMemo(() => {
		const query = filter.trim().toLowerCase();
		let result = query === "" ? tracks : tracks.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(query));
		if (sort.key !== "default") {
			result = [...result].sort(sorters[sort.key]);
			if (sort.desc) result.reverse();
		}
		return result;
	}, [tracks, filter, sort]);

	const totalDuration = React.useMemo(() => tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0), [tracks]);
	const headerCover = tracks.find((t) => t.id === nowPlaying.id) ?? tracks.find((t) => t.hasCover);

	const toggleSort = (key: SortKey) =>
		setSort((prev) => (prev.key !== key ? { key, desc: false } : prev.desc ? { key: "default", desc: false } : { key, desc: true }));
	const sortIndicator = (key: SortKey) => (sort.key === key ? (sort.desc ? " ▾" : " ▴") : "");

	const playFrom = (index: number) => playTracks(visibleTracks, index);
	const togglePlayback = () => (nowPlaying.playing ? PlayState.pause() : PlayState.play());

	return (
		<div className="lf-page">
			<header className="lf-header">
				<Cover track={headerCover} size={180} />
				<div className="lf-header-info">
					<div className="lf-label">PLAYLIST</div>
					<h1>Local Files</h1>
					<div className="lf-meta">
						{tracks.length} tracks · {formatTime(totalDuration)}
						{folder && <span className="lf-folder"> · {folder}</span>}
					</div>
					<div className="lf-actions">
						<button className="lf-btn lf-primary" disabled={tracks.length === 0} onClick={() => playFrom(0)}>
							▶ Play
						</button>
						<button className="lf-btn" disabled={tracks.length === 0} onClick={() => playTracks(visibleTracks, Math.floor(Math.random() * visibleTracks.length), true)}>
							⤮ Shuffle
						</button>
						<button className="lf-btn" onClick={chooseFolder} disabled={scanning}>
							{folder ? "Change folder" : "Choose folder"}
						</button>
						{folder && (
							<button className="lf-btn" onClick={rescan} disabled={scanning}>
								{scanning ? "Scanning..." : "↻ Rescan"}
							</button>
						)}
					</div>
				</div>
			</header>

			{error && <div className="lf-error">Scan failed: {error}</div>}

			{folder === undefined ? (
				<div className="lf-empty">
					Choose a folder with your MP3 and FLAC files to get started.
					<br />
					<button className="lf-btn lf-primary" onClick={chooseFolder}>
						Choose folder
					</button>
				</div>
			) : tracks.length === 0 ? (
				<div className="lf-empty">{scanning ? "Scanning your folder..." : "No MP3 or FLAC files found in this folder."}</div>
			) : (
				<>
					<div className="lf-toolbar">
						<input className="lf-filter" placeholder="Filter local files" value={filter} onChange={(e) => setFilter(e.target.value)} />
						<span className="lf-hint">Right click a track to add it to a playlist</span>
					</div>
					<div className="lf-table">
						<div className="lf-row lf-head">
							<span>#</span>
							<span onClick={() => toggleSort("title")}>Title{sortIndicator("title")}</span>
							<span onClick={() => toggleSort("artist")}>Artist{sortIndicator("artist")}</span>
							<span onClick={() => toggleSort("album")}>Album{sortIndicator("album")}</span>
							<span>Format</span>
							<span onClick={() => toggleSort("duration")}>Time{sortIndicator("duration")}</span>
						</div>
						{visibleTracks.map((track, index) => {
							const isCurrent = nowPlaying.id === track.id;
							return (
								<div
									key={track.id}
									className={`lf-row${isCurrent ? " lf-current" : ""}`}
									title={track.path}
									onDoubleClick={() => playFrom(index)}
									onContextMenu={(e) => {
										e.preventDefault();
										openContextMenu(track, e);
									}}
								>
									<span className="lf-index" onClick={() => (isCurrent ? togglePlayback() : playFrom(index))}>
										<span className="lf-num">{isCurrent && nowPlaying.playing ? "♫" : index + 1}</span>
										<span className="lf-play">{isCurrent && nowPlaying.playing ? "❚❚" : "▶"}</span>
									</span>
									<span className="lf-title">
										<Cover track={track} size={40} />
										<span>{track.title}</span>
									</span>
									<span>{track.artist}</span>
									<span>{track.album}</span>
									<span className="lf-format">{track.format.toUpperCase()}</span>
									<span>{formatTime(track.duration)}</span>
								</div>
							);
						})}
					</div>
				</>
			)}
		</div>
	);
};
