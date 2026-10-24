# autodemo

**Your coding agent records the product demo.** Claude Code, Codex, Cursor or any MCP client rehearses the flow, writes a script, and autodemo records it like a human would. The finished video has smooth cursor moves, auto-zoom on clicks, a local AI voice, captions, a title card, and no dead time. It also exports a vertical cut for Shorts and Reels.

```
rehearse (live, unrecorded) → demo.json → record at human speed → render → agent reviews frames → retake if needed
```

## Why it works

- **No AI pauses on camera.** The agent explores first. The recording is a clean replay of the script, so the model's thinking time never shows up in the video.
- **Only the app is recorded.** Frames come from the browser page itself, so other windows, notifications and your desktop can't appear.
- **Voice is always in sync.** Narration is generated before recording, and each scene lasts as long as its line.
- **Sign-in is handled.** The agent opens a window, you sign in, and the session is saved to a profile. Passwords never pass through the agent.
- **Everything runs locally.** Kokoro-82M for the voice (falls back to macOS `say`), Playwright and ffmpeg. No cloud APIs.

## Install

```bash
git clone <this repo> ~/autodemo && cd ~/autodemo && npm install && npx playwright install chromium
node bin/autodemo.js doctor        # checks ffmpeg, Chromium, downloads the voice model (~90MB, once)
```

Plug it into your agent:

```bash
claude mcp add --scope user autodemo -- node ~/autodemo/bin/autodemo.js mcp
codex mcp add autodemo -- node ~/autodemo/bin/autodemo.js mcp
```

Also link the skill, which teaches the agent how to direct a good demo: `ln -s ~/autodemo/skills/autodemo ~/.claude/skills/autodemo` (and `~/.codex/skills/`).
Or install it as a Claude Code plugin: the repo root is a plugin (`.claude-plugin/plugin.json`).

Then ask: *"Make a 30 second demo video of the signup flow on localhost:3000."*

## MCP tools

| Tool | What it does |
|---|---|
| `open`, `snapshot`, `screenshot`, `step` | Rehearse live in an unrecorded browser |
| `login`, `login_done` | The user signs in by hand; the session is saved to a profile |
| `check` | Fast dry run of the whole script |
| `record`, `job` | Record and render in the background, then wait for the result |
| `review` | One frame per scene plus the timeline, so the agent can check its own video |

## CLI

```bash
autodemo run demo.json --out demos/x   # record + narrate + render
autodemo check demo.json               # dry run
autodemo render demos/x                # re-render only (tweak zoom/captions without re-recording)
autodemo login https://app.com --profile app
```

## Script

See [skills/autodemo/SKILL.md](skills/autodemo/SKILL.md) for the format and the directing rules, and [examples/](examples/) for samples.

Output in the folder: `final.mp4` (1920×1080), `vertical.mp4` (1080×1920, if `output.vertical`), `timeline.json`, `demo.json`, and the raw `frames/` and `recording.json`. Keep the raw files to re-render later.

## Limits (v0.1)

- Web apps only: anything in a browser, including localhost and staging. Native macOS apps (ScreenCaptureKit window capture + Accessibility input) are next.
- Single tab: links that would open a new tab open in the same tab.
- No background music yet.
