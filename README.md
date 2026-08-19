# Neovim AI Mode - Nam 

Use Google's **AI Mode** from inside Neovim. Run `:Nam` and the screen splits —
your file editor on the left, a chat panel on the right. Ask questions, get
answers, keep asking follow-ups; the conversation lives for the whole nvim session.

Because AI Mode is a web-only product with no public API, nam drives **your own
Firefox** over the WebDriver BiDi protocol and reuses your logged-in Google
session. Nothing is scraped headlessly and your browser is never launched or
closed for you — nam only *attaches* to a Firefox you started.

## Requirements

- Neovim 0.10+ (developed on 0.12)
- Node.js + npm
- Firefox
- A Google account signed in inside that Firefox profile

## Install

**1. Get the plugin on your runtimepath** (example with lazy.nvim):

```lua
{
  dir = '/home/tkyc/repo/nam', -- or a git URL once you publish it
  build = 'cd backend && npm install',
  opts = {}, -- calls require('nam').setup({})
  cmd = 'Nam',
}
```

Without a plugin manager, add the repo to your `runtimepath` and run
`require('nam').setup()` in your config.

**2. Install the backend dependency:**

```sh
cd /home/tkyc/repo/nam/backend
npm install        # pulls puppeteer-core (does NOT download Chromium)
```

## Usage

**First time:** run **`:Nam login`** once. nam opens a visible Firefox on its own
dedicated profile — sign into Google, then close the window. (nam runs headless
after this; you only see Firefox for login or a captcha.)

Then just **`:Nam`**:

- Type your question in the input box, press `<CR>` (normal) or `<C-s>` (insert)
- `:Nam toggle` / `:Nam close` — toggle or close the panel
- In the conversation pane: `i` jumps to the input box, `q` closes the panel
- Slash commands in the input box: `/clear`, `/retry`, `/explain` (explains your
  last yank)

nam drives Firefox **headless** (no window) on a **dedicated profile**, so:

- No window means no Firefox-on-Wayland occlusion freeze (streaming never stalls
  when your terminal is focused).
- A separate profile means nam **never touches your normal Firefox** — browse as
  usual while nam runs.

> **Captcha:** if Google shows a bot-check, nam can't solve it headless, so it
> **opens a visible Firefox window** at the challenge. Solve it; nam detects that
> it cleared, returns to headless, and finishes your query automatically. nam also
> reduces how often this happens (hides `navigator.webdriver`, stays signed in).

Run `:checkhealth nam` to verify node, the backend deps, Firefox, and the debug
port state.

### Profiles

By default nam uses a dedicated profile at `stdpath('data')/nam/firefox`
(≈ `~/.local/share/nvim/nam/firefox`). To reuse your **default** profile instead
(no `:Nam login`, but nam's headless instance then blocks your own Firefox while
it runs), set `firefox.profile = ''`. Prefer to manage Firefox yourself? Set
`firefox.manage = false` and launch `firefox --remote-debugging-port 9222`.

## Configuration

Defaults shown; pass overrides to `setup()`:

```lua
require('nam').setup({
  node_cmd = 'node',
  split = {
    side = 'right',      -- 'right' | 'left'
    width_pct = 30,      -- chat panel = 30% of screen (editor keeps 70%)
    width = nil,         -- optional fixed columns; overrides width_pct when set
    input_height = 6,
  },
  keymaps = {
    submit_normal = '<CR>',
    submit_insert = '<C-s>',
    focus_input = 'i',
    quit = 'q',
  },
  firefox = {
    manage = true,          -- let nam launch/restart Firefox
    headless = true,        -- no window (avoids the Wayland occlusion freeze)
    profile = vim.fn.stdpath('data') .. '/nam/firefox', -- dedicated profile; '' ⇒ default
    auto_restart = true,    -- (default-profile fallback only) restart a running Firefox
    cmd = 'firefox',
    extra_args = {},
    launch_timeout_ms = 20000,
  },
  backend = {
    host = '127.0.0.1',
    port = 9222,
    -- Advanced (see backend/browser.js DEFAULTS): ai_mode_url,
    -- followup_selectors, response_selectors, and timing knobs. Override these
    -- when Google changes AI Mode's markup.
  },
})
```

## Troubleshooting

- **"Could not attach to Firefox…" / debug port never came up** — nam couldn't get
  Firefox into debug mode. Check `:checkhealth nam`; make sure `firefox` is on your
  PATH. With `firefox.manage = false`, launch Firefox yourself with
  `firefox --remote-debugging-port 9222`.
- **Orphaned automation session** — Firefox allows only one WebDriver BiDi session
  and does not reap it if the backend dies uncleanly (a crash / kill), so the port
  stays up but refuses new connections. nam detects this and **auto-restarts
  Firefox to recover** (once per query, when `firefox.manage` is on); you'll see
  "restarting Firefox to recover…". If it recurs, that's fine — it self-heals.
- **Tabs didn't reopen after nam restarted Firefox** — enable Firefox's "Open
  previous windows and tabs" (Settings → General → Startup); nam relies on
  Firefox's own session restore.
- **Empty / `⚠ No answer text found`** — Google changed AI Mode's DOM. Update
  `response_selectors` / `followup_selectors` in `backend/browser.js` (or via
  `setup({ backend = { ... } })`).
- **Debug the automation in isolation** — the backend ships a canary:

  ```sh
  cd backend
  node test.js "what is the tallest mountain?"
  ```

  It connects, asks once, and prints the answer to stdout with progress on
  stderr — the fastest way to re-tune selectors without involving nvim.

## How it works

```
Neovim (Lua)  ──NDJSON over stdio──▶  Node backend        ──WebDriver BiDi──▶  your Firefox ──▶ google.com AI Mode
  :Nam UI         jobstart/chansend      backend/server.js    ws://127.0.0.1:9222
```

The Lua front end owns the command, the split, and the two buffers. The Node
backend (`puppeteer-core`) attaches to Firefox, submits the first query by
navigating to the AI Mode URL and follow-ups by typing into the on-page box, then
streams the answer back. Rather than a flat text dump, the backend walks the
answer DOM into **Markdown** (headings, bold/italic, lists, links) while dropping
hidden UI and inline citation chips; the chat buffer renders it as markdown.
Selectors, URL, and timings all live in `backend/browser.js` because Google
changes them often.
