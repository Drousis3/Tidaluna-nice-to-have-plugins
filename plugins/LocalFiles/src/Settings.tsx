import React from "react";

import { LunaButtonSetting, LunaSettings, LunaSwitchSetting } from "@luna/ui";

import { localFilesPage } from ".";
import { chooseFolder, rescan, storage } from "./library";

export const Settings = () => {
	const [folder, setFolder] = React.useState(storage.folder);
	const [recursive, setRecursive] = React.useState(storage.recursive);
	const [scanOnStartup, setScanOnStartup] = React.useState(storage.scanOnStartup);

	return (
		<LunaSettings>
			<LunaButtonSetting
				title="Music folder"
				desc={folder ? `Scanning ${folder}` : "Choose the folder containing your MP3 and FLAC files"}
				children={folder ? "Change folder" : "Choose folder"}
				onClick={async () => setFolder((await chooseFolder()) ?? storage.folder)}
			/>
			<LunaSwitchSetting
				title="Include subfolders"
				desc="Also scan all folders inside the music folder"
				checked={recursive}
				onChange={(_: unknown, checked?: boolean) => setRecursive((storage.recursive = checked ?? false))}
			/>
			<LunaSwitchSetting
				title="Rescan on startup"
				desc="Look for new or removed files every time Tidal starts"
				checked={scanOnStartup}
				onChange={(_: unknown, checked?: boolean) => setScanOnStartup((storage.scanOnStartup = checked ?? false))}
			/>
			<LunaButtonSetting title="Rescan now" desc="Scan the music folder again" children="Rescan" onClick={rescan} />
			<LunaButtonSetting title="Local Files playlist" desc="Also available via your profile menu" children="Open" onClick={() => localFilesPage.open()} />
		</LunaSettings>
	);
};
