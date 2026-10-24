# autodemo

**A screen recorder for AI agents.** Tell Claude Code, Codex, Cursor or any MCP agent to "record a demo of the signup flow". The agent opens the app with the tools it already has (Claude in Chrome, computer use, a browser MCP) and drives it. autodemo films the tab or window and edits the result into a polished video:

- zoom on every action
- a smooth cursor and click ripples
- a local AI voice reading the agent's narration, with word-by-word captions
- macOS desktop or gradient backgrounds, with a window frame
- the agent's thinking time cut out
- a Loom-style share page

```
agent picks a tab/window → camera rolls → agent drives the app & narrates → camera_stop → render → agent reviews → studio
```

## Why it works

- **Like sharing a tab in Zoom, with no picker.** The agent names a tab (`"todomvc.com"`) or an app window. autodemo finds it in Chrome, Brave, Edge or Safari, brings it forward and films only that page. Browser bars and banners can be trimmed off.
- **Uses the agent's own hands.** The agent drives with its own browser or computer-use tools, logged in as you. If it has none, `camera_act` clicks and types for it.
- **Any app or device.** Web apps, native Mac apps, the iOS Simulator, Android emulators, iPhone Mirroring.
- **Long takes.** 10 to 20 minute walkthroughs, with chapters. If macOS drops the stream mid-take, it keeps recording in a new segment.
- **Cheap on tokens.** One call per step, one-word replies, small screenshots only when needed.
- **Local and private.** ScreenCaptureKit, Kokoro-82M voice (falls back to macOS `say`), ffmpeg. No cloud.

## Install

As a Claude Code plugin:

```bash
claude plugin marketplace add mdayan8/autodemo
claude plugin install autodemo@autodemo
```

Or as an MCP server for any agent:

```bash
claude mcp add --scope user autodemo -- npx -y autodemo mcp
codex mcp add autodemo -- npx -y autodemo mcp
```

Then copy or link `skills/autodemo` into your agent's skills folder: it teaches the agent to behave like a presenter.

The first time, macOS asks for **Screen Recording** permission for the app running your agent. Allow it, and **Accessibility** too if you want `camera_act`. Run `npx autodemo doctor` to check ffmpeg, the voice model and Chromium.

Then ask: *"Record a 30 second demo of creating an invoice in my app, the tab with localhost:3000."*

## Looks

`background`: `macos` (desktop with menu bar and Dock), `macos-light`, `aurora`, `grid`, `midnight`, `sunset`, `ocean`, `forest`, `peach`, `mono`, `light`, any two colors, or your own image.
`frame`: `mac` (traffic lights) or `browser` (address bar).
`output`: 4K or 1080p, plus a vertical cut for Shorts and Reels.

## Studio

`autodemo serve` (or the `studio` tool) opens a local page listing every demo your agents recorded, with live status while one is recording or rendering. Each demo opens its share page: player, chapters, transcript, captions and a call-to-action button.

## MCP tools

| Tool | What it does |
|---|---|
| `intake` | Asks the user what video they want (goal, length, voice, formats) |
| `windows` | Lists open windows to film |
| `camera_start` | Starts filming a `tab` or `window` (or the screen), with background, frame and trim |
| `camera_say` | One step: narration line, plus click position and chapter |
| `camera_trim` | Cuts browser bars and banners off the whole video |
| `camera_act` | Real click, type, key or scroll, for agents with no browser tool |
| `camera_screenshot`, `camera_focus`, `camera_click` | Look, point the zoom, mark a click |
| `camera_pause`, `camera_resume` | Stops filming while the user signs in |
| `camera_stop`, `job`, `review` | Renders, waits, checks every scene |
| `studio` | Local gallery of all demos |
| `open`, `step`, `check`, `record` | Scripted mode: re-recordable `demo.json` demos for CI |

## CLI

```bash
autodemo serve                         # studio at http://localhost:4747
autodemo render demos/x                # re-render (new background, trim, captions) without re-recording
autodemo run demo.json --out demos/x   # scripted mode: record + narrate + render
autodemo doctor
```

Each demo folder contains:
- `final.mp4` (and `vertical.mp4`)
- `share.html`
- `captions.vtt`
- `transcript.md`
- `poster.jpg`
- `preview.gif`
- `timeline.json`
- the raw `segment-*.mp4` and `recording.json`, kept so you can re-render later

## Limits

- Camera mode needs macOS 14+, because it uses ScreenCaptureKit. The Swift helper builds on first use and needs Xcode Command Line Tools. Scripted mode runs anywhere Playwright runs.
- The camera films the window's area of the screen. A cover guard pauses whenever another window or a notification is on top of it, and drops the moment before it noticed, so you can keep using your Mac during a take. Don't use the filmed window yourself while it records.
- macOS sometimes stops a capture stream on its own (about once a minute on some machines). autodemo starts a new segment immediately, losing about a second each time.
