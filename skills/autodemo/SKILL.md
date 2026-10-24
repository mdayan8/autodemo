---
name: autodemo
description: Record a polished, narrated demo video of any app, website, simulator or emulator while you drive it with your own tools (Claude in Chrome, computer use, any browser tool), using the autodemo MCP tools. Use when the user asks for a demo video, product walkthrough, launch video, tutorial, screen recording of a feature, a long walkthrough (10-20 min), or a video proof that a feature works.
---

# Shooting a demo with autodemo

autodemo is a screen recorder for you. You use the real app with the tools you already have while it films. Afterwards it does the editing:
- zoom on the action
- a smooth cursor and click ripples
- your narration in a local voice, with captions
- a background template and window frame
- title and end cards
- cutting the time you spent thinking

Your job: **behave like a calm human presenter shooting a demo.**

## Workflow

1. **`intake`**: ask what the user wants (goal, length, voiceover, formats, background).
2. **Pick what to film**, like choosing what to share in Zoom or Meet, but without a picker:
   - **A browser tab** (most demos): `tab` = part of its URL or title (`"todomvc.com"`). autodemo finds it in Chrome, Brave, Edge or Safari, makes it active, restores and raises its window, and films only the page. Open the tab first with your own browser tool. With Claude in Chrome, use the tab it controls (signed in as the user).
   - **An app window**: `window` = app name or title. This covers Figma, a native app, the **iOS Simulator** (`"Simulator"`), an **Android emulator** (`"Android Emulator"`) or a mirrored iPhone (`"iPhone Mirroring"`). Use `windows` to list them.
   - Never use a web page that records with the browser's share picker (getDisplayMedia). A person must pick there, and sandboxed pages such as claude.ai artifacts block it.
3. **Choose how you drive it**, in this order:
   1. Your own browser or computer-use tool.
   2. If you have none, `camera_act` (real clicks and typing). Loop: `camera_screenshot` → decide → `camera_act`. It takes over the real mouse, so use it only when the user is not using the Mac. The first time, the user may need to allow Accessibility.
4. **Rehearse off camera.** Walk the flow once:
   - Find every element.
   - Close popups and cookie banners.
   - Load realistic demo data.
   - Then reset to the starting screen.
5. **Set the stage.** Make the window large. A cover guard pauses filming whenever another window or a notification covers the filmed one, so the user can keep working. Still ask them not to use the filmed window during the take.
6. **`camera_start`** with `tab` or `window`, `title`, and a look:
   - `background`: `macos` (desktop with menu bar and Dock), `macos-light`, `aurora`, `grid`, `midnight`, `sunset`, `ocean`, `forest`, `peach`, `mono`, `light`, two colors, or an image path.
   - `frame`: `mac` (traffic lights and title) or `browser` (address bar). The default is `mac` on macOS backgrounds.
   - `output`: `{resolution: "4k"}` for launch videos, or `"1080p"` for long or quick takes.
7. **Clean the picture.** The start reply flags a bar across the top when it sees one. Look at the screenshot: if a browser bar or banner isn't part of the app, call `camera_trim` (e.g. `{top: 34}`). Examples: Chrome's "Claude started debugging this browser", "Chrome is being controlled by automated software", a cookie banner. Add a few pixels on each side if your browser tool draws a glow around the page.
8. **Perform.** One step = one `camera_say` call (`text`, plus `click` [x, y] where you are about to click and `chapter` at a new section). Then do the action with your own tool.
9. **Private moments:** for sign-in or anything private, `camera_pause`, ask the user to do it, then `camera_resume`. Never type passwords.
10. **`camera_stop`**, then `job` until it's done, then **`review`** every frame. Check for the wrong page, error toasts, private data, or bars you missed (fix those with a re-render: `trim` in recording.json, then `autodemo render <dir>`). Shoot again at most twice.
11. **Hand it over.** Give the user the video path, the share page, and the `studio` URL (a local page listing every demo you recorded).

## Behave like a human presenter

- **One idea per step.** Say the line, do the action, let the result sit on screen for about a second before moving on.
- **Hook first:** the problem or the result. Never "Welcome to our app".
- **Narrate why, not what.** "One click and the whole team has it", not "Now I click Share".
- **Short lines:** 6 to 14 words. Silence while something visibly happens is fine.
- **Deliberate:** no wandering, no wrong clicks, no retries on camera. If something goes wrong, stop and shoot again.
- **Realistic data:** real-looking names, amounts and dates; never "test123".
- **Scroll like a person:** in steps, pausing on what matters, not one jump to the bottom.
- **End on the payoff:** the finished result on screen, plus a closing line.
- **Length:** 20 to 60 seconds for a feature demo.

## Long takes (10 to 20 minutes)

Walkthroughs, tutorials and full QA runs work fine.
- Use `output: {resolution: "1080p", fps: 30}`. Recording at that size costs about 15 MB a minute.
- Add a `chapter` for every section. They become the share page's table of contents.
- Narrate every 20 to 60 seconds so the viewer is never lost.
- Thinking time is cut automatically, so take your time.
- If macOS drops the stream mid-take, autodemo starts a new segment by itself.
- Rendering takes roughly as long as the take.

## Spend few tokens

- Don't screenshot after every step. Read the page with your browser tool's text or DOM reads (`find`, `read_page`, `get_page_text`) to locate elements, and use `camera_screenshot` only to get coordinates or check the look.
- One `camera_say` call per step (line, click and chapter together). Replies are one word.
- Rehearse with text tools; screenshots are for layout questions only.
- `review` once at the end, not during the take.

## Scripted mode (re-recording in CI)

When the user wants a demo that re-records itself whenever the UI changes, use `open` / `step` / `check` / `record` with a `demos/<name>/demo.json` script. CLI: `npx autodemo run demo.json --out demos/x`.
