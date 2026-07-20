# HideMediaEverywhere

A Vencord userplugin that lets you hide specific images, GIFs, and videos in Discord.

Instead of removing the message, blocked media is replaced with a placeholder. Right-click a message and select **Hide this media** to hide it everywhere it appears.

## Installation

You need a [Vencord source installation](https://docs.vencord.dev/installing/) to use custom plugins.

From your Vencord folder, run:

```sh
cd src/userplugins
git clone https://github.com/t6rtar/HideMediaEverywhere.git
cd ../..
pnpm build
```

Restart Discord or Vesktop, then enable **HideMediaEverywhere** in Vencord's plugin settings.

If you have not installed your source build yet, follow Vencord's [custom build installation steps](https://docs.vencord.dev/installing/#installing-your-custom-build).

Hidden media stays blocked across chats, search results, previews, and the GIF picker.

## Settings

- **Drag to peek:** Drag the placeholder down to reveal the hidden media.
- **Autoplay GIFs:** Automatically play GIFs while they are revealed.
- **Do not hide my images:** Keep images you send visible.
- **Placeholder image:** Choose a custom image to display over hidden media.
