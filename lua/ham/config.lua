-- Configuration + defaults for ham.
-- Anything under `backend` is forwarded verbatim to the Node backend as its
-- {"type":"config"} message, so Google-specific selectors/URL/timings can be
-- overridden from a user's setup() call without editing the plugin.

local M = {}

local function plugin_root()
  -- .../lua/ham/config.lua -> plugin root
  local src = debug.getinfo(1, 'S').source:sub(2)
  return vim.fn.fnamemodify(src, ':h:h:h')
end

M.defaults = {
  -- How to launch the backend. `server_path` defaults to backend/server.js in
  -- this repo; `node_cmd` is the node executable.
  node_cmd = 'node',
  server_path = plugin_root() .. '/backend/server.js',

  -- UI
  split = {
    side = 'right', -- 'right' | 'left'
    width_pct = 45, -- chat panel takes 45% of screen width (editor keeps 55%)
    width = nil, -- optional fixed column override; when set, wins over width_pct
    input_height = 6, -- rows for the input box
  },
  -- Keymaps (buffer-local to the chat panel)
  keymaps = {
    submit_normal = '<CR>', -- in the input buffer, normal mode
    submit_insert = '<C-s>', -- in the input buffer, insert mode
    focus_input = 'i', -- in the conversation buffer, jump to input
    quit = 'q', -- in the conversation buffer, close the panel
  },
  -- Slash command (typed in the input box) that clears the chat window and starts
  -- a fresh AI Mode conversation. Set to false/'' to disable.
  clear_command = '/clear',
  -- Slash command that re-asks the last question. Set to false/'' to disable.
  retry_command = '/retry',
  -- Slash command that asks AI Mode to explain the unnamed register (your last
  -- yank) in plain English. Set to false/'' to disable.
  explain_command = '/explain',
  explain_prompt = 'Explain in plain English. Annotate in a code block with a comment above per line:',

  -- How ham gets the user's Firefox into debug mode. Firefox's remote agent is
  -- startup-only, so ham (re)launches Firefox with --remote-debugging-port when
  -- the port isn't already up.
  firefox = {
    manage = true, -- allow ham to launch/restart Firefox at all
    auto_restart = true, -- (default-profile fallback) quit+relaunch a running Firefox
    headless = true, -- run Firefox headless (no window). Avoids the Firefox-on-
    -- Wayland occlusion freeze that stalls streaming when a visible window is
    -- backgrounded. You never need to see ham's Firefox — answers render in nvim.
    -- A DEDICATED profile so ham's Firefox is a separate instance from your normal
    -- browsing Firefox (no single-instance lock). Sign in once with :Ham login.
    -- Set to '' to reuse your default profile instead (blocks your own Firefox).
    profile = vim.fn.stdpath('data') .. '/ham/firefox',
    -- Quit ham's Firefox when the panel is closed / nvim exits. Set false to keep
    -- it running in the background so reopening is instant (session stays warm).
    close_on_stop = true,
    cmd = 'firefox',
    extra_args = {},
    launch_timeout_ms = 20000,
  },

  -- Forwarded to the Node backend (see backend/browser.js DEFAULTS for the full
  -- list). Only override what you need.
  backend = {
    host = '127.0.0.1',
    port = 9222,
    -- How queries are answered:
    --   'browser' = drive the AI Mode DOM in headless Firefox (default; proven,
    --               streams incrementally, answers cleaned to markdown).
    --   'http'    = browserless token-chaining fetcher — plain HTTP GETs to AI
    --               Mode's async endpoints (faster, DOM-selector-independent, good
    --               for TTY). Firefox is still used to bootstrap cookies + solve
    --               captchas; the queries themselves need no browser.
    mode = 'browser',
    -- ai_mode_url, followup_selectors, response_selectors, timings all default
    -- inside browser.js; add them here to override.
  },
}

M.options = vim.deepcopy(M.defaults)

function M.setup(opts)
  M.options = vim.tbl_deep_extend('force', vim.deepcopy(M.defaults), opts or {})
  return M.options
end

return M
