import type { LunaUnloads } from "@luna/core";
import { observe } from "@luna/lib";

import { trace } from ".";

const BUTTON_ID = "sidebar-local-files";
// fill="none" on every shape, Tidal's icon class sets fill on the svg
const FOLDER_ICON = `<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path fill="none" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle fill="none" cx="10.5" cy="14.5" r="1.8"/><path fill="none" d="M12.3 14.5V10l3 .8"/></svg>`;

// Newer Tidal: flat "sidebar-collection-*" links. Older Tidal: one "My Collection" button with a hover submenu.
const COLLECTION_ITEMS = `a[data-test^="sidebar-collection-"]`;
const COLLECTION_MENU = `[data-test="sidebar-collection-menu"]`;

/**
 * Adds a "Local Files" entry to Tidal's sidebar by cloning one of its collection entries.
 */
// skibidi sidebar button, it just shows up and vibes
export const addSidebarButton = (unloads: LunaUnloads, onClick: () => void, isOpen: () => boolean) => {
	const buttons = new Set<HTMLElement>();

	const makeButton = (template: HTMLElement) => {
		const button = <HTMLElement>template.cloneNode(true);
		button.dataset.test = BUTTON_ID;
		button.removeAttribute("aria-haspopup");
		button.removeAttribute("href");
		button.removeAttribute("aria-current");
		button.style.cursor = "pointer";
		// Drop state classes (selected, active, drop target...)
		button.className = [...template.classList].filter((name) => !/selected|active|isOver/i.test(name)).join(" ");

		const icon = button.querySelector("svg");
		if (icon) {
			const wrapper = document.createElement("template");
			wrapper.innerHTML = FOLDER_ICON;
			const newIcon = wrapper.content.firstElementChild!;
			newIcon.setAttribute("class", icon.getAttribute("class") ?? "");
			icon.replaceWith(newIcon);
		}
		button.querySelector(`[class*="arrowRight"]`)?.remove();
		const title = button.querySelector(`[class*="title"]`) ?? button.querySelector("span");
		if (title) title.textContent = "Local Files";

		button.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onClick();
		});
		buttons.add(button);
		return button;
	};

	const add = () => {
		if (document.querySelector(`[data-test="${BUTTON_ID}"]`)) return;
		const items = document.querySelectorAll<HTMLElement>(COLLECTION_ITEMS);
		if (items.length > 0) {
			// Use a plain entry (not the selected one) as template, append after the last entry of the section
			const template = [...items].find((item) => item.getAttribute("aria-current") === null) ?? items[0];
			items[items.length - 1].after(makeButton(template));
			return;
		}
		const menu = document.querySelector<HTMLElement>(COLLECTION_MENU);
		if (menu) (menu.closest<HTMLElement>(`[class*="collectionWrapper"]`) ?? menu).after(makeButton(menu));
	};

	add();
	observe(unloads, `${COLLECTION_ITEMS}, ${COLLECTION_MENU}`, add);
	unloads.add(() => buttons.forEach((button) => button.remove()));

	// Highlight like Tidal's own entries while the Local Files page is open
	const updateActive = () => {
		for (const button of buttons) {
			if (isOpen()) button.setAttribute("aria-current", "page");
			else button.removeAttribute("aria-current");
		}
	};
	const interval = setInterval(updateActive, 500);
	unloads.add(() => clearInterval(interval));

	// Help debugging if Tidal changed its sidebar
	const check = setTimeout(() => {
		if (document.querySelector(`[data-test="${BUTTON_ID}"]`)) return;
		const testIds = [...document.querySelectorAll("[data-test]")].map((el) => el.getAttribute("data-test")).filter((id) => /sidebar|collection|nav/i.test(id ?? ""));
		trace.warn("Sidebar button not added, could not find the collection entries. Sidebar elements:", testIds);
	}, 15000);
	unloads.add(() => clearTimeout(check));
};
