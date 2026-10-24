---
name: autodemo
description: Record a polished, narrated demo video of a web app or website using the autodemo MCP tools (or `npx autodemo` CLI). Use when the user asks for a demo video, product walkthrough, launch video, screen recording of a feature, or a video proof that a feature works.
---

# Directing a demo with autodemo

You are the director. autodemo is the camera crew: it replays your script at human speed, records only the browser page, auto-zooms on clicks, draws a clean cursor, speaks your narration with a local voice, adds captions and a title card, and cuts dead time.

## Workflow

1. **Rehearse (nothing is recorded).** `open` the URL, `snapshot` to read the page, and try each action with `step`. Fix selectors until every step works. Use `screenshot` when the layout matters.
2. **Sign-in.** If the flow needs an account, call `login` with a profile name and ask the user to sign in in the window that opens. Never type passwords yourself. Call `login_done` when they confirm, and add `"profile"` to the script.
3. **Write the script.** Save it as `demos/<name>/demo.json` in the user's project so it can be re-recorded when the UI changes.
4. **`check`** the script (a fast dry run). Fix whatever fails.
5. **`record`**, then call `job` until it's done.
6. **`review`** the video. Look at every frame: wrong page, error toast, cut-off text, private data on screen? Fix the script and record again (at most twice). Then give the user the video path.

## Script format

```json
{
  "title": "Invoices in 30 seconds",
  "subtitle": "Acme Billing",
  "url": "http://localhost:3000",
  "profile": "acme",
  "voice": "af_heart",
  "blur": [".user-email", "#api-key"],
  "output": { "vertical": true },
  "scenes": [
    { "say": "Creating an invoice used to take five screens. Now it's one." },
    { "click": "role=button[name=\"New invoice\"]" },
    { "type": { "into": "label=Client", "text": "Acme Corp" }, "say": "Pick the client..." },
    { "click": "role=button[name=\"Send\"]", "say": "...and send it." },
    { "wait_for": "text=Sent", "zoom": false }
  ]
}
```

- One action per scene: `goto`, `click`, `hover`, `type` ({into, text, enter?, clear?}), `press`, `scroll` (pixels or a selector), `wait_for`, `wait` (ms).
- Extras: `say` (narration that plays while the action happens; the scene lasts at least as long as the line), `zoom` (`false`, or a level like `2.2`), `pause` (ms), `timeout` (ms).
- Selectors are Playwright selectors. Prefer what a user sees: `role=button[name="Save"]`, `text=Pricing`, `label=Email`, then CSS.
- Voices: `af_heart` (default, warm US female), `af_bella`, `am_michael`, `am_adam`, `bf_emma`, `bm_george`.

## What makes a good demo

- **20 to 60 seconds.** Show one flow, not a feature tour.
- **The first line is a hook:** the problem, or the result. Never "Welcome to our app".
- **Narrate why, not what.** The viewer can see the click. Say what it gets them: "One click and the whole team has it", not "Now I click the share button".
- **Short lines,** 6 to 14 words each. Not every scene needs one, and silence while something visibly happens is fine.
- **Use realistic data,** never "test123" or "asdf".
- **End on the payoff,** the finished result on screen, with a closing line.
- Hide anything private with `blur`. Use demo accounts.

## CLI (agents without MCP)

`npx autodemo check demo.json`, then `npx autodemo run demo.json --out demos/x`, and `npx autodemo render demos/x` re-renders without re-recording. Run `npx autodemo doctor` once to set up.
