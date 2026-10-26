# Copy a YouTube video transcript

This extension adds a button on YouTube video pages. One click copies the title, the link, and the transcript (with timestamps) to the clipboard.

The text is not sent anywhere: it stays on your computer.

## Install it in Chrome

1. Download this project (green **Code** button, then **Download ZIP**) and unzip the ZIP file.
2. Open Chrome. Click the address bar, type `chrome://extensions`, and press Enter.
3. At the top right, turn on **Developer mode**.
4. Click **Load unpacked**. Choose the unzipped folder, the one that contains the file `manifest.json`. Do not choose a file inside the folder.
5. Open a YouTube video. The **Copy transcript** button appears next to Like and Share. Click it, then paste the text wherever you want (Ctrl+V, or Cmd+V on a Mac).

If a YouTube tab was already open, reload it after installing.

You need a recent version of Chrome.

## What the button can show

- **Copied!**: it worked, the text is copied.
- **No captions**: this video has no subtitles.
- **Couldn't load**: YouTube did not send the transcript. Reload the page and try again.
- **Clipboard blocked**: Chrome refused the copy. Click the button again.

The button goes back to **Copy transcript** on its own after two seconds.

## Choose the caption language

Next to **Copy transcript** is a small arrow. Click it to see the languages for this video. Each language is written out by name. Captions that YouTube made automatically say **(auto-generated)**. When YouTube can translate the captions, those languages are listed too, and they say **(translated)**.

A check mark shows which language will be copied. Click the one you want, then click **Copy transcript**.

The extension starts with the video's own language when it can tell which one that is. If it cannot tell, it starts with the first captions a person wrote. After you pick a language, it remembers that choice for the next video. The list updates when you open another video.

## Update an extension you already installed

1. Download the new version and unzip it. Put the new files in the same folder you chose when you first clicked **Load unpacked**, so they replace the old files.
2. Open Chrome. Click the address bar, type `chrome://extensions`, and press Enter.
3. Find **Copy YouTube Transcript** and click the reload button on its card (the round arrow).
4. Go back to YouTube and reload the video tab.

## Contributors

- Denis-Q.S. S. ([@DenisQS](https://github.com/DenisQS))
- [Cursor](https://cursor.com)
