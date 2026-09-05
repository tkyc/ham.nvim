# Headless AI Mode - Ham 

[![CI](https://github.com/tkyc/ham.nvim/actions/workflows/ci.yml/badge.svg)](https://github.com/tkyc/ham.nvim/actions/workflows/ci.yml)

Use Google's **AI Mode** from inside Neovim. Run `:Ham` and the screen splits —
your file editor on the left, a chat panel on the right. Ask questions, get
answers, keep asking follow-ups; the conversation lives for the whole nvim session.

Because AI Mode is a web-only product with no public API, ham drives **your own
Firefox** over the WebDriver BiDi protocol and reuses your logged-in Google
session. Nothing is scraped headlessly and your browser is never launched or
closed for you — ham only *attaches* to a Firefox you started.

## Requirements

- Neovim 0.10+ (developed on 0.12)
- Node.js + npm
- Firefox
- A Google account signed in inside that Firefox profile

## Install

**1. Get the plugin on your runtimepath** (example with lazy.nvim):

```lua
{
  dir = '/path/to/ham', -- local checkout, or a git URL once you publish it
  build = 'cd backend && npm install',
  opts = {}, -- calls require('ham').setup({})
  cmd = 'Ham',
}
```

Without a plugin manager, add the repo to your `runtimepath` and run
`require('ham').setup()` in your config.

**2. Install the backend dependency:**

```sh
cd /path/to/ham/backend
npm install        # pulls puppeteer-core (does NOT download Chromium)
```

## Usage

**First time:** run **`:Ham login`** once. ham opens a visible Firefox on its own
dedicated profile — sign into Google, then close the window. (ham runs headless
after this; you only see Firefox for login or a captcha.)

Then just **`:Ham`** — type your question in the input box and press `<CR>`
(normal mode) or `<C-s>` (insert mode) to send.

### Commands

`:Ham` (and the lowercase `:ham`) takes an optional subcommand, tab-completed:

| Command | What it does |
|---|---|
| `:Ham` | Open the chat panel (focuses the input box if already open) |
| `:Ham close` | Close the panel, stop the backend, and quit ham's headless Firefox |
| `:Ham toggle` | Open if closed, close if open |
| `:Ham tab` | Open the panel in its own tab (full width) instead of a side split |
| `:Ham login` | One-time: open a visible Firefox to sign into Google |
| `:Ham clear` | Wipe the transcript and start a fresh AI Mode conversation |
| `:Ham retry` | Re-ask your last question |
| `:Ham explain` | Ask AI Mode to explain the unnamed register (your last `y` yank) |
| `:Ham cancel` | Abandon the in-flight query and free the panel (session stays up) |

The last four also work as **slash commands** typed in the input box —
`/clear`, `/retry`, `/explain`, `/cancel` — configurable via `clear_command`,
`retry_command`, `explain_command`, `cancel_command`. (`/cancel` is the one that
works *while a query is in flight* — the others wait for it to finish.)

### Keys (in the panel)

| Key | Where | Action |
|---|---|---|
| `<CR>` | input box | Send the question |
| `<C-s>` | input box (insert) | Send the question |
| `i` | conversation pane | Jump to the input box |
| `q` | conversation pane | Close the panel |

All keys are configurable under `keymaps` in `setup()`.

ham drives Firefox **headless** (no window) on a **dedicated profile**, so:

- No window means no Firefox-on-Wayland occlusion freeze (streaming never stalls
  when your terminal is focused).
- A separate profile means ham **never touches your normal Firefox** — browse as
  usual while ham runs.

> **Captcha:** if Google shows a bot-check, ham can't solve it headless, so it
> **opens a visible Firefox window** at the challenge. Solve it; ham detects that
> it cleared, returns to headless, and finishes your query automatically. ham also
> reduces how often this happens (hides `navigator.webdriver`, stays signed in).

Run `:checkhealth ham` to verify node, the backend deps, Firefox, and the debug
port state.

### Profiles

By default ham uses a dedicated profile at `stdpath('data')/ham/firefox`
(≈ `~/.local/share/nvim/ham/firefox`). To reuse your **default** profile instead
(no `:Ham login`, but ham's headless instance then blocks your own Firefox while
it runs), set `firefox.profile = ''`. Prefer to manage Firefox yourself? Set
`firefox.manage = false` and launch `firefox --remote-debugging-port 9222`.

## Configuration

Defaults shown; pass overrides to `setup()`:

```lua
require('ham').setup({
  node_cmd = 'node',
  split = {
    layout = 'vsplit',   -- 'vsplit' (side panel) | 'tab' (own tabpage, full width)
    side = 'right',      -- 'right' | 'left' (vsplit layout only)
    width_pct = 45,      -- chat panel = 45% of screen (editor keeps 55%)
    width = nil,         -- optional fixed columns; overrides width_pct when set
    input_height = 6,
  },
  keymaps = {
    submit_normal = '<CR>',
    submit_insert = '<C-s>',
    focus_input = 'i',
    quit = 'q',
  },
  -- Slash commands typed in the input box (mirror the :Ham subcommands). Set any to
  -- false/'' to disable that slash command.
  clear_command = '/clear',
  retry_command = '/retry',
  cancel_command = '/cancel',
  explain_command = '/explain',
  explain_prompt = 'Explain in plain English. Annotate in a code block with a comment above per line:',
  firefox = {
    manage = true,          -- let ham launch/restart Firefox
    headless = true,        -- no window (avoids the Wayland occlusion freeze)
    profile = vim.fn.stdpath('data') .. '/ham/firefox', -- dedicated profile; '' ⇒ default
    auto_restart = true,    -- (default-profile fallback only) restart a running Firefox
    close_on_stop = true,   -- quit ham's Firefox on panel close / nvim exit; false keeps
                            -- the headless instance warm so reopening is instant
    cmd = 'firefox',
    extra_args = {},
    launch_timeout_ms = 20000,
  },
  backend = {
    host = '127.0.0.1',
    port = 9222,
    mode = 'http',           -- 'http' | 'browser'  (see "Query modes" below)
    -- Advanced (see backend/browser.js DEFAULTS): ai_mode_url,
    -- followup_selectors, response_selectors, and timing knobs. Override these
    -- when Google changes AI Mode's markup.
  },
})
```

### Query modes

`backend.mode` chooses how ham fetches answers:

- **`'http'`** (default) — a browserless client that talks to AI Mode's async
  endpoints over plain HTTP (no DOM driving). Faster per query and independent of AI
  Mode's HTML markup, so it keeps working when Google reshuffles selectors — handy on
  a bare TTY. The answer arrives in one shot (no incremental streaming). On the
  dedicated profile it reads your Google cookies straight from
  `<profile>/cookies.sqlite`, so **no Firefox runs to answer queries at all**. Firefox
  is still launched only for **`:Ham login`** (to create/refresh the cookie DB) and to
  **solve a captcha** when the bot-check exemption expires. Requires Node with
  `node:sqlite` (Node 22+); on the shared default profile (`firefox.profile = ''`) it
  falls back to harvesting cookies from a running Firefox.
- **`'browser'`** — drives the AI Mode page in headless Firefox. Proven, streams the
  answer in as it's generated, and renders it as clean markdown.

Both modes need the same logged-in Firefox profile. `:checkhealth ham` shows the active
mode and (in http mode) whether the cookie DB is present. If you haven't logged in yet,
http mode reports `no usable cookies — run :Ham login`.

## Troubleshooting

- **"Could not attach to Firefox…" / debug port never came up** — ham couldn't get
  Firefox into debug mode. Check `:checkhealth ham`; make sure `firefox` is on your
  PATH. With `firefox.manage = false`, launch Firefox yourself with
  `firefox --remote-debugging-port 9222`.
- **Orphaned automation session** — Firefox allows only one WebDriver BiDi session
  and does not reap it if the backend dies uncleanly (a crash / kill), so the port
  stays up but refuses new connections. ham detects this and **auto-restarts
  Firefox to recover** (once per query, when `firefox.manage` is on); you'll see
  "restarting Firefox to recover…". If it recurs, that's fine — it self-heals.
- **Tabs didn't reopen after ham restarted Firefox** — enable Firefox's "Open
  previous windows and tabs" (Settings → General → Startup); ham relies on
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
  :Ham UI         jobstart/chansend      backend/server.js    ws://127.0.0.1:9222
```

The Lua front end owns the command, the split, and the two buffers. The Node
backend (`puppeteer-core`) attaches to Firefox, submits the first query by
navigating to the AI Mode URL and follow-ups by typing into the on-page box, then
streams the answer back. Rather than a flat text dump, the backend walks the
answer DOM into **Markdown** (headings, bold/italic, lists, links) while dropping
hidden UI and inline citation chips; the chat buffer renders it as markdown.
Selectors, URL, and timings all live in `backend/browser.js` because Google
changes them often.
