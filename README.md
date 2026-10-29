# Tidaluna nice to have plugins

A collection of skibidi cool plugins for [TidaLuna](https://github.com/Inrixia/TidaLuna), the plugin enabled Tidal desktop client.

## Install

In TIDAL open **Luna Settings → Plugin Store** and add this store url:

```
https://github.com/Drousis3/Tidaluna-nice-to-have-plugins/releases/download/latest/store.json
```

Then install the plugins you want from that store. (You want them all)

## Plugins

| Plugin | Description |
| --- | --- |
| [Local Files](plugins/LocalFiles/README.md) | Yippie local mp3 and flac files, less reasons to use spotify, more to use tidal :) |

## Development

Every plugin lives in its own folder under [`plugins/`](plugins). To add a new one, create `plugins/<Name>/package.json` with a `name`, `description` and `main` entry, it is picked up by the build and the store automatically.

```sh
corepack enable
pnpm install
pnpm run watch
```

Then install the plugins from the **DEV** store in **Luna Settings → Plugin Store**. Every push to `main` builds the plugins and publishes them to the `latest` release.

---

I hope you like this plugin and I hope we can get more people switch to tidal
