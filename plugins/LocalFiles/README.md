# Local Files

Yippie local mp3 and flac files, less reasons to use spotify, more to use tidal :)

Part of [Tidaluna nice to have plugins](../../README.md).

## Features

- **"Local Files" entry in the sidebar** (also in the profile menu) listing every MP3 and FLAC file of a folder you choose
- **Plays through TIDAL's own player**: player bar, queue, shuffle, repeat, media keys
- **Add local tracks to your normal playlists**: right click a track → *Add to playlist*. They show up at the end of the playlist and can be removed like any other track
- Playlists play straight through, from TIDAL tracks into local tracks and back
- Reads ID3v1 / ID3v2.2–2.4 (MP3) and Vorbis comments (FLAC) incl. embedded covers
- Untagged files named `Artist - Title.mp3` (or `Artist_-_Title.mp3`) are split automatically

## Setup

1. Install **@imp/local-files** from the store (see the [main README](../../README.md))
2. Click **Local Files** in the sidebar → **Choose folder**
3. Optional: in the plugin settings choose whether subfolders are included and whether to rescan on every start

## How it works

- A tiny http server on `127.0.0.1` (random port + secret token) serves only the scanned files
- Local tracks get fake TIDAL ids (starting at `9000000000000`) and are put into TIDAL's store
- When TIDAL asks for stream info of a local id, the plugin answers with a url to the local server and TIDAL's built in player plays it
- Playlist responses from TIDAL get the locally stored entries appended

## Limitations

- Local tracks in playlists only exist on this PC, they won't show up on your phone or the web player
- Local tracks are always at the end of a playlist
- *Add to My Collection*, album/artist pages, lyrics and credits aren't available for local files
- Other plugins can't download local files (there is no need, they are already on your PC)

---

I hope you like this plugin and I hope we can get more people switch to tidal
