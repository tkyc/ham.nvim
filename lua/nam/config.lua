-- Configuration + defaults for nam.
-- Anything under `backend` is forwarded verbatim to the Node backend as its
-- {"type":"config"} message, so Google-specific selectors/URL/timings can be
-- overridden from a user's setup() call without editing the plugin.

local M = {}

local function plugin_root()
  -- .../lua/nam/config.lua -> plugin root
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

  -- How nam gets the user's Firefox into debug mode. Firefox's remote agent is
  -- startup-only, so nam (re)launches Firefox with --remote-debugging-port when
  -- the port isn't already up.
  firefox = {
    manage = true, -- allow nam to launch/restart Firefox at all
    auto_restart = true, -- quit+relaunch a normally-running Firefox into debug mode
    cmd = 'firefox',
    extra_args = {}, -- empty ⇒ default profile (keeps your Google login)
    launch_timeout_ms = 20000,
  },

  -- Forwarded to the Node backend (see backend/browser.js DEFAULTS for the full
  -- list). Only override what you need.
  backend = {
    host = '127.0.0.1',
    port = 9222,
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
