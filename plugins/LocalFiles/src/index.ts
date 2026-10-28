import { Tracer, type LunaUnload } from "@luna/core";
import { ContextMenu, StyleTag } from "@luna/lib";
import { Page } from "@luna/ui";

import React from "react";

import { LocalFilesPage } from "./components";
import { initLibrary, onScanned } from "./library";
import { stopServer } from "./scan.native";
import { addSidebarButton } from "./sidebar";
import { fixAutoplay, fixCovers, interceptFetch, interceptPlaylists, registerInStore } from "./tidal";

import styles from "file://styles.css?minify";

export const { trace, errSignal } = Tracer("[LocalFiles]");

// Functions in unloads are called when plugin is unloaded.
export const unloads = new Set<LunaUnload>();
unloads.add(() => void stopServer());

export { Settings } from "./Settings";

new StyleTag("LocalFiles", unloads, styles);

// Make local files look & play like Tidal tracks
interceptFetch(unloads);
interceptPlaylists(unloads);
fixCovers(unloads);
fixAutoplay(unloads);
unloads.add(onScanned(registerInStore));

// "Local Files" page
export const localFilesPage = Page.register("LocalFiles", unloads, React.createElement(LocalFilesPage));
const openPage = () => localFilesPage.open();

addSidebarButton(unloads, openPage, () => location.search === "?LocalFiles");

// Also in the profile menu (same place as "Luna Settings")
const menuButton = ContextMenu.addButton(unloads);
menuButton.text = "Local Files";
menuButton.onClick(openPage);
ContextMenu.onOpen(unloads, async ({ event, contextMenu }) => {
	if (event.type === "USER_PROFILE") await menuButton.show(contextMenu);
});

initLibrary();
