# HideMediaEverywhere

A Vencord userplugin that lets you hide specific images, GIFs, and videos in Discord.

Instead of removing the message, blocked media is replaced with a placeholder. Right-click a message and select **Hide this media** to hide it everywhere it appears.

## Installation

1. Clone this repository into `src/userplugins/HideMediaEverywhere` inside your Vencord checkout.
2. Build Vencord.
3. Enable **HideMediaEverywhere** in Vencord's plugin settings.

Hidden media stays blocked across chats, search results, previews, and the GIF picker.

## Settings

- **Drag to peek:** Drag the placeholder down to reveal the hidden media.
- **Autoplay GIFs:** Automatically play GIFs while they are revealed.
- **Do not hide my images:** Keep images you send visible.
- **Placeholder image:** Choose a custom image to display over hidden media.
