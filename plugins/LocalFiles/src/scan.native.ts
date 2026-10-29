// Runs in Tidal's Node (main) process. Exports are callable from the renderer via IPC.
import { randomBytes } from "crypto";
import { createReadStream } from "fs";
import { open, readdir, stat, type FileHandle } from "fs/promises";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { basename, extname, join } from "path";

import { localId } from "./ids";
import type { LocalTrack, ServerInfo } from "./types";

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac"]);

type Picture = { mime: string; data: Buffer };
type Tags = Partial<Pick<LocalTrack, "title" | "artist" | "album" | "albumArtist" | "trackNumber" | "discNumber" | "year" | "sampleRate" | "bitDepth">> & {
	duration?: number;
	hasCover?: boolean;
	picture?: Picture;
};

// #region File helpers
const readAt = async (fh: FileHandle, position: number, length: number) => {
	const buf = Buffer.alloc(length);
	const { bytesRead } = await fh.read(buf, 0, length, position);
	return buf.subarray(0, bytesRead);
};

const findAudioFiles = async (folder: string, recursive: boolean, out: string[] = []) => {
	const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const fullPath = join(folder, entry.name);
		if (entry.isDirectory()) {
			if (recursive && !entry.name.startsWith(".")) await findAudioFiles(fullPath, recursive, out);
		} else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
			out.push(fullPath);
		}
	}
	return out;
};

const parseNumber = (value?: string) => {
	const num = parseInt(value?.split("/")[0] ?? "", 10);
	return Number.isFinite(num) ? num : undefined;
};
// #endregion

// #region ID3v2 (MP3)
// yap yap thats just ID3 storing sizes in 7 bit chunks because why not
const syncsafe = (buf: Buffer, offset: number) => (buf[offset] << 21) | (buf[offset + 1] << 14) | (buf[offset + 2] << 7) | buf[offset + 3];

const decodeText = (buf: Buffer, encoding: number) => {
	let text: string;
	switch (encoding) {
		case 1: {
			// UTF-16 with BOM
			if (buf[0] === 0xfe && buf[1] === 0xff) text = swap16(buf.subarray(2)).toString("utf16le");
			else if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString("utf16le");
			else text = buf.toString("utf16le");
			break;
		}
		case 2:
			text = swap16(buf).toString("utf16le");
			break;
		case 3:
			text = buf.toString("utf8");
			break;
		default:
			text = buf.toString("latin1");
	}
	// Multiple values are null separated, keep the first one
	return text.split("\0")[0].trim();
};
const swap16 = (buf: Buffer) => {
	const copy = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
	return copy.swap16();
};

/** Index of the null terminator for the given text encoding, starting at `from` */
const findTerminator = (buf: Buffer, from: number, encoding: number) => {
	if (encoding === 1 || encoding === 2) {
		for (let i = from; i + 1 < buf.length; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) return [i, 2];
		return [buf.length, 0];
	}
	const idx = buf.indexOf(0, from);
	return idx === -1 ? [buf.length, 0] : [idx, 1];
};

type TagField = "title" | "artist" | "album" | "albumArtist" | "trackNumber" | "discNumber" | "year";
const ID3_TEXT_FRAMES: Record<string, TagField> = {
	TIT2: "title",
	TT2: "title",
	TPE1: "artist",
	TP1: "artist",
	TALB: "album",
	TAL: "album",
	TPE2: "albumArtist",
	TP2: "albumArtist",
	TRCK: "trackNumber",
	TRK: "trackNumber",
	TPOS: "discNumber",
	TPA: "discNumber",
	TYER: "year",
	TYE: "year",
	TDRC: "year",
};

const parseId3 = (tag: Buffer, version: number, withPicture: boolean): Tags => {
	const tags: Tags = {};
	const headerSize = version === 2 ? 6 : 10;
	const idLength = version === 2 ? 3 : 4;
	let offset = 0;
	while (offset + headerSize <= tag.length) {
		const id = tag.toString("latin1", offset, offset + idLength);
		if (!/^[A-Z0-9]+$/.test(id)) break; // Padding reached
		let size: number;
		if (version === 2) size = (tag[offset + 3] << 16) | (tag[offset + 4] << 8) | tag[offset + 5];
		else if (version === 4) size = syncsafe(tag, offset + 4);
		else size = tag.readUInt32BE(offset + 4);
		const body = tag.subarray(offset + headerSize, offset + headerSize + size);
		offset += headerSize + size;
		if (body.length === 0) continue;

		const textKey = ID3_TEXT_FRAMES[id];
		if (textKey !== undefined) {
			const value = decodeText(body.subarray(1), body[0]);
			if (value === "") continue;
			if (textKey === "trackNumber" || textKey === "discNumber") tags[textKey] = parseNumber(value);
			else if (textKey === "year") tags.year ??= value.slice(0, 4);
			else tags[textKey] = value;
		} else if (id === "APIC" || id === "PIC") {
			tags.hasCover = true;
			if (!withPicture || tags.picture !== undefined) continue;
			const encoding = body[0];
			let mime: string;
			let pos: number;
			if (id === "PIC") {
				// v2.2: 3 char image format
				const format = body.toString("latin1", 1, 4).toLowerCase();
				mime = format === "png" ? "image/png" : "image/jpeg";
				pos = 4;
			} else {
				const mimeEnd = body.indexOf(0, 1);
				mime = body.toString("latin1", 1, mimeEnd) || "image/jpeg";
				if (!mime.includes("/")) mime = `image/${mime.toLowerCase()}`;
				pos = mimeEnd + 1;
			}
			pos += 1; // Picture type
			const [descEnd, termLength] = findTerminator(body, pos, encoding);
			tags.picture = { mime, data: Buffer.from(body.subarray(descEnd + termLength)) };
		}
	}
	return tags;
};
// #endregion

// #region MP3 duration
const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = [44100, 48000, 32000];

// sigma frame header hunter, no ffmpeg needed
const mp3Duration = (buf: Buffer, audioStart: number, fileSize: number) => {
	// Leave room for the Xing/VBRI header reads below
	for (let i = 0; i + 64 < buf.length; i++) {
		if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
		const versionBits = (buf[i + 1] >> 3) & 0x3; // 0 = 2.5, 2 = 2, 3 = 1
		const layerBits = (buf[i + 1] >> 1) & 0x3; // 1 = Layer III
		const bitrateIdx = buf[i + 2] >> 4;
		const sampleRateIdx = (buf[i + 2] >> 2) & 0x3;
		if (versionBits === 1 || layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) continue;

		const isMpeg1 = versionBits === 3;
		const sampleRate = SAMPLE_RATES[sampleRateIdx] / (isMpeg1 ? 1 : versionBits === 2 ? 2 : 4);
		const samplesPerFrame = isMpeg1 ? 1152 : 576;
		const mono = buf[i + 3] >> 6 === 3;

		// Xing/Info header (VBR & LAME CBR)
		const xingOffset = i + 4 + (isMpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17);
		const xingId = buf.toString("latin1", xingOffset, xingOffset + 4);
		if ((xingId === "Xing" || xingId === "Info") && buf[xingOffset + 7] & 0x1) {
			const frames = buf.readUInt32BE(xingOffset + 8);
			if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
		}
		// VBRI header (Fraunhofer)
		if (buf.toString("latin1", i + 36, i + 40) === "VBRI") {
			const frames = buf.readUInt32BE(i + 36 + 14);
			if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
		}
		// Assume CBR
		const bitrate = (isMpeg1 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES)[bitrateIdx] * 1000;
		return ((fileSize - audioStart - i) * 8) / bitrate;
	}
	return undefined;
};

const readMp3 = async (fh: FileHandle, fileSize: number, withPicture: boolean): Promise<Tags> => {
	let tags: Tags = {};
	let audioStart = 0;
	const header = await readAt(fh, 0, 10);
	if (header.length === 10 && header.toString("latin1", 0, 3) === "ID3") {
		const version = header[3];
		const tagSize = syncsafe(header, 6);
		const hasFooter = (header[5] & 0x10) !== 0;
		audioStart = 10 + tagSize + (hasFooter ? 10 : 0);
		if (version >= 2 && version <= 4) {
			let tagBody = await readAt(fh, 10, tagSize);
			// Skip extended header
			if (header[5] & 0x40 && version >= 3) {
				const extSize = version === 4 ? syncsafe(tagBody, 0) : tagBody.readUInt32BE(0) + 4;
				tagBody = tagBody.subarray(extSize);
			}
			tags = parseId3(tagBody, version, withPicture);
		}
	} else if (fileSize > 128) {
		// ID3v1 fallback
		const v1 = await readAt(fh, fileSize - 128, 128);
		if (v1.toString("latin1", 0, 3) === "TAG") {
			const field = (start: number, end: number) => v1.toString("latin1", start, end).replace(/\0.*$/, "").trim() || undefined;
			tags = { title: field(3, 33), artist: field(33, 63), album: field(63, 93), year: field(93, 97) };
		}
	}
	tags.duration = mp3Duration(await readAt(fh, audioStart, 16384), audioStart, fileSize);
	return tags;
};
// #endregion

// #region FLAC
const VORBIS_FIELDS: Record<string, TagField> = {
	TITLE: "title",
	ARTIST: "artist",
	ALBUM: "album",
	ALBUMARTIST: "albumArtist",
	"ALBUM ARTIST": "albumArtist",
	TRACKNUMBER: "trackNumber",
	DISCNUMBER: "discNumber",
	DATE: "year",
	YEAR: "year",
};

const readFlac = async (fh: FileHandle, withPicture: boolean): Promise<Tags> => {
	const tags: Tags = {};
	let offset = 0;
	const head = await readAt(fh, 0, 10);
	// Some taggers put an ID3 tag in front of FLAC files
	if (head.toString("latin1", 0, 3) === "ID3") offset = 10 + syncsafe(head, 6);
	if ((await readAt(fh, offset, 4)).toString("latin1") !== "fLaC") return tags;
	offset += 4;

	let isLast = false;
	while (!isLast) {
		const blockHeader = await readAt(fh, offset, 4);
		if (blockHeader.length < 4) break;
		isLast = (blockHeader[0] & 0x80) !== 0;
		const type = blockHeader[0] & 0x7f;
		const length = blockHeader.readUIntBE(1, 3);
		const blockStart = offset + 4;
		offset = blockStart + length;

		if (type === 0) {
			// STREAMINFO
			const info = await readAt(fh, blockStart, length);
			const sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
			const totalSamples = (info[13] & 0x0f) * 2 ** 32 + info.readUInt32BE(14);
			if (sampleRate > 0 && totalSamples > 0) tags.duration = totalSamples / sampleRate;
			if (sampleRate > 0) tags.sampleRate = sampleRate;
			tags.bitDepth = (((info[12] & 0x01) << 4) | (info[13] >> 4)) + 1;
		} else if (type === 4) {
			// VORBIS_COMMENT (little endian)
			const block = await readAt(fh, blockStart, length);
			let pos = 4 + block.readUInt32LE(0);
			const count = block.readUInt32LE(pos);
			pos += 4;
			for (let i = 0; i < count && pos + 4 <= block.length; i++) {
				const len = block.readUInt32LE(pos);
				const comment = block.toString("utf8", pos + 4, pos + 4 + len);
				pos += 4 + len;
				const eq = comment.indexOf("=");
				const key = VORBIS_FIELDS[comment.slice(0, eq).toUpperCase()];
				const value = comment.slice(eq + 1).trim();
				if (key === undefined || value === "") continue;
				if (key === "trackNumber" || key === "discNumber") tags[key] ??= parseNumber(value);
				else if (key === "year") tags.year ??= value.slice(0, 4);
				else tags[key] ??= value;
			}
		} else if (type === 6) {
			// PICTURE
			tags.hasCover = true;
			if (!withPicture || tags.picture !== undefined) continue;
			const block = await readAt(fh, blockStart, length);
			let pos = 4;
			const mimeLength = block.readUInt32BE(pos);
			const mime = block.toString("latin1", pos + 4, pos + 4 + mimeLength);
			pos += 4 + mimeLength;
			pos += 4 + block.readUInt32BE(pos); // Description
			pos += 16; // Width, height, depth, colors
			const dataLength = block.readUInt32BE(pos);
			tags.picture = { mime, data: Buffer.from(block.subarray(pos + 4, pos + 4 + dataLength)) };
		}
	}
	return tags;
};
// #endregion

const readTags = async (path: string, withPicture: boolean) => {
	const fh = await open(path, "r");
	try {
		const { size } = await fh.stat();
		const tags = extname(path).toLowerCase() === ".flac" ? await readFlac(fh, withPicture) : await readMp3(fh, size, withPicture);
		return { tags, size };
	} finally {
		await fh.close();
	}
};

/** Splits "Artist - Title" (or "Artist_-_Title") */
// skibidi function that fixes your "Artist_-_Title_FINAL_v2" downloads
const splitName = (name: string) => {
	name = name.replace(/_+/g, " ").trim();
	const dash = name.indexOf(" - ");
	if (dash <= 0) return { title: name };
	return { artist: name.slice(0, dash).trim(), title: name.slice(dash + 3).trim() };
};

const toTrack = async (path: string): Promise<LocalTrack> => {
	const id = localId(path);
	const format = extname(path).slice(1).toLowerCase() as LocalTrack["format"];
	const fallback = splitName(basename(path, extname(path)));
	try {
		const { tags, size } = await readTags(path, false);
		// Without an artist tag, the title (or file name) often is "Artist - Title"
		const named: { title?: string; artist?: string } = tags.artist || tags.albumArtist ? { title: tags.title } : tags.title ? splitName(tags.title) : fallback;
		return {
			id,
			path,
			format,
			size,
			title: named.title || fallback.title,
			artist: tags.artist || tags.albumArtist || named.artist || "Unknown artist",
			album: tags.album || "Unknown album",
			albumArtist: tags.albumArtist,
			trackNumber: tags.trackNumber,
			discNumber: tags.discNumber,
			year: tags.year,
			duration: tags.duration,
			hasCover: tags.hasCover ?? false,
			sampleRate: tags.sampleRate,
			bitDepth: tags.bitDepth,
		};
	} catch {
		return { id, path, format, size: 0, title: fallback.title, artist: fallback.artist ?? "Unknown artist", album: "Unknown album", hasCover: false };
	}
};

/**
 * Finds all mp3/flac files in `folder` and reads their tags.
 */
export const scanFolder = async (folder: string, recursive: boolean = true): Promise<LocalTrack[]> => {
	if (!(await stat(folder).catch(() => undefined))?.isDirectory()) throw new Error(`Folder not found: ${folder}`);
	const files = await findAudioFiles(folder, recursive);
	const tracks: LocalTrack[] = new Array(files.length);
	// Read tags with limited concurrency
	let next = 0;
	const worker = async () => {
		while (next < files.length) {
			const idx = next++;
			tracks[idx] = await toTrack(files[idx]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(16, files.length) }, worker));
	registerFiles(tracks);
	return tracks;
};

// #region Stream server
/** Only files from the last scan (or registered from the cache) can be served */
// the bouncer, no list no entry
const filesById = new Map<number, string>();
export const registerFiles = (tracks: Pick<LocalTrack, "id" | "path">[]) => {
	filesById.clear();
	for (const { id, path } of tracks) filesById.set(id, path);
};

const MIME_TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".flac": "audio/flac" };
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Private-Network": "true",
	"Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

let server: Server | undefined;
let serverInfo: ServerInfo | undefined;

/**
 * Starts a http server on 127.0.0.1 serving the scanned files so Tidal's player can stream them.
 * Urls: <baseUrl>/audio/<id>.<ext> and <baseUrl>/cover/<id>
 */
export const startServer = async (): Promise<ServerInfo> => {
	if (serverInfo !== undefined) return serverInfo;
	// Random token so other websites can't read local files through the server
	const token = randomBytes(16).toString("hex");
	server = createServer(async (req, res) => {
		try {
			if (req.method === "OPTIONS") {
				res.writeHead(204, CORS_HEADERS).end();
				return;
			}
			const match = /^\/([0-9a-f]+)\/(audio|cover)\/(\d+)(?:\.\w+)?$/.exec(req.url?.split("?")[0] ?? "");
			const path = match?.[1] === token ? filesById.get(Number(match[3])) : undefined;
			if (match === null || path === undefined) {
				res.writeHead(404, CORS_HEADERS).end();
				return;
			}

			if (match[2] === "cover") {
				const { tags } = await readTags(path, true);
				if (tags.picture === undefined || tags.picture.data.length === 0) {
					res.writeHead(404, CORS_HEADERS).end();
					return;
				}
				res.writeHead(200, { ...CORS_HEADERS, "Content-Type": tags.picture.mime, "Cache-Control": "max-age=3600" });
				res.end(tags.picture.data);
				return;
			}

			const { size } = await stat(path);
			const headers: Record<string, string | number> = {
				...CORS_HEADERS,
				"Content-Type": MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
				"Accept-Ranges": "bytes",
			};
			let start = 0;
			let end = size - 1;
			const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
			if (range !== null) {
				if (range[1] === "") start = Math.max(0, size - Number(range[2]));
				else {
					start = Number(range[1]);
					if (range[2] !== "") end = Math.min(end, Number(range[2]));
				}
				if (start > end || start >= size) {
					res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` }).end();
					return;
				}
				headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
			}
			headers["Content-Length"] = end - start + 1;
			res.writeHead(range !== null ? 206 : 200, headers);
			if (req.method === "HEAD") {
				res.end();
				return;
			}
			const stream = createReadStream(path, { start, end });
			stream.on("error", () => res.destroy());
			res.on("close", () => stream.destroy());
			stream.pipe(res);
		} catch {
			if (!res.headersSent) res.writeHead(500, CORS_HEADERS);
			res.end();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server!.once("error", reject);
		server!.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	return (serverInfo = { baseUrl: `http://127.0.0.1:${port}/${token}` });
};

export const stopServer = async () => {
	const closing = server;
	server = undefined;
	serverInfo = undefined;
	if (closing === undefined) return;
	closing.closeAllConnections();
	await new Promise((resolve) => closing.close(resolve));
};
// #endregion
