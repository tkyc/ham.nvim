-- Test for the :Ham open/close/toggle command dispatch and window lifecycle.
-- Run headless:  nvim --headless -l test/ham_commands_test.lua
-- Exits 0 on success, 1 on failure.
--
-- Uses a dead debug port + firefox.manage=false so opening the panel has no
-- Firefox/backend side effects (we only care about the window logic here).

local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':h:h')
vim.opt.runtimepath:append(root)
vim.cmd('runtime plugin/ham.lua')

local ham = require('ham')
ham.setup({ firefox = { manage = false }, backend = { port = 9999 } })
local ui = require('ham.ui')
local backend = require('ham.backend')

-- This suite exercises the UI/command layer, not the real Node backend. Stub
-- backend.query so send_query populates the transcript without spawning node/Firefox
-- (which would also fire async start-failures that bleed across tests). Individual
-- tests below override backend.ping / backend.is_running as needed.
backend.query = function() return 1 end

-- Count the panel's windows (conversation = markdown, input = ham-input).
local function ham_wins()
  local n = 0
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    local ft = vim.bo[vim.api.nvim_win_get_buf(w)].filetype
    if ft == 'markdown' or ft == 'ham-input' then n = n + 1 end
  end
  return n
end

local failures = {}
local function check(name, got, want)
  local ok = got == want
  print(string.format('%-40s got=%-6s want=%-6s %s', name, tostring(got), tostring(want), ok and 'OK' or 'FAIL'))
  if not ok then table.insert(failures, name) end
end

-- Simulate :Ham <sub> exactly as the user command does.
local function Ham(sub)
  ham._command({ args = sub or '' })
end

check('command registered', vim.api.nvim_get_commands({}).Ham ~= nil, true)

-- Subcommand completion must narrow to the typed prefix. A function `complete` uses
-- customlist semantics (Neovim does NOT filter it for us), so the plugin filters itself.
local function comp(lead) return vim.fn.getcompletion('Ham ' .. lead, 'cmdline') end
check('completion: "cl" -> close,clear', table.concat(comp('cl'), ','), 'close,clear')
check('completion: "c" -> close,clear,cancel', table.concat(comp('c'), ','), 'close,clear,cancel')
check('completion: empty prefix -> all 8', #comp(''), 8)
check('completion: no match -> empty', #comp('zzz'), 0)

check('closed initially', ui.is_open(), false)

local start_win = vim.api.nvim_get_current_win()
Ham('') -- :Ham (open)
check('after :Ham -> open', ui.is_open(), true)
check('after :Ham -> 2 windows', ham_wins(), 2)
-- Opening the panel must NOT move the cursor or start insert mode.
check('open keeps cursor in original window', vim.api.nvim_get_current_win() == start_win, true)
check('open stays in normal mode', vim.fn.mode(), 'n')

Ham('close') -- :Ham close
check('after :Ham close -> closed', ui.is_open(), false)
check('after :Ham close -> 0 windows', ham_wins(), 0)

Ham('toggle') -- :Ham toggle (opens)
check('after :Ham toggle -> open', ui.is_open(), true)

Ham('toggle') -- :Ham toggle (closes)
check('after :Ham toggle -> closed', ui.is_open(), false)

-- close() on an already-closed panel must be a harmless no-op
local ok_noop = pcall(function() Ham('close') end)
check('close when already closed is safe', ok_noop and not ui.is_open(), true)

-- Subcommands that mirror the slash commands (dead backend: they only build the
-- transcript; the query itself errors out harmlessly).
local function conv_text()
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    local b = vim.api.nvim_win_get_buf(w)
    if vim.bo[b].filetype == 'markdown' then
      return table.concat(vim.api.nvim_buf_get_lines(b, 0, -1, false), '\n')
    end
  end
  return ''
end

vim.fn.setreg('"', 'local x = 1')
Ham('explain') -- opens the panel and asks to explain the yank
pcall(vim.cmd, 'stopinsert')
check(':Ham explain opens panel', ui.is_open(), true)
check(':Ham explain uses the register', conv_text():find('Explain in plain English. Annotate in a code block with a comment above per line:', 1, true) ~= nil, true)

Ham('clear')
check(':Ham clear wipes the transcript', conv_text():find('Explain in plain English. Annotate in a code block with a comment above per line:', 1, true) == nil, true)

-- close() tears down the backend, so it must also drop the transcript AND delete the
-- scratch buffers (bufhidden='hide' would otherwise leak them across open/close).
vim.fn.setreg('"', 'local sentinel_close = 1')
Ham('explain') -- re-adds a message to the transcript
pcall(vim.cmd, 'stopinsert')
check('message present before close', conv_text():find('Explain in plain English', 1, true) ~= nil, true)
local conv_bufs_before = {}
for _, w in ipairs(vim.api.nvim_list_wins()) do
  local b = vim.api.nvim_win_get_buf(w)
  if vim.bo[b].filetype == 'markdown' or vim.bo[b].filetype == 'ham-input' then
    table.insert(conv_bufs_before, b)
  end
end
Ham('close')
local leaked = 0
for _, b in ipairs(conv_bufs_before) do if vim.api.nvim_buf_is_valid(b) then leaked = leaked + 1 end end
check('close deletes the scratch buffers (no leak)', leaked, 0)
Ham('') -- reopen
check('transcript cleared after close→reopen', conv_text():find('Explain in plain English', 1, true) == nil, true)

Ham('close')

-- :Ham login is refused while the backend is running (it would kill the Firefox the
-- backend uses). Stub firefox.login (so no real browser launches) and backend.is_running.
local firefox = require('ham.firefox')
local login_called = false
firefox.login = function() login_called = true end

local orig_is_running = backend.is_running
backend.is_running = function() return true end
login_called = false
Ham('login')
check(':Ham login blocked while backend running', login_called, false)

backend.is_running = function() return false end
login_called = false
Ham('login')
check(':Ham login proceeds when backend not running', login_called, true)
backend.is_running = orig_is_running

-- Liveness watchdog: with the backend stubbed to accept a query but never answer, the
-- panel would hang forever. The watchdog unsticks it only when the backend stops
-- responding to pings; while it still pongs (busy/slow/captcha) it keeps waiting.
ui._watchdog.interval_ms = 10
ui._watchdog.pong_ms = 10
local orig_query = backend.query
local orig_ping = backend.ping
local captured_handlers = nil
backend.query = function(_, handlers) captured_handlers = handlers; return 1 end -- capture, never answer

-- Case A: backend does not pong → watchdog fires and unsticks the panel.
backend.ping = function(_) return true end -- never calls the pong cb
Ham('') -- ensure open
vim.fn.setreg('"', 'watchdog probe')
Ham('explain')
pcall(vim.cmd, 'stopinsert')
vim.wait(500, function() return conv_text():find('stopped responding', 1, true) ~= nil end, 10)
check('watchdog fires when backend stops responding', conv_text():find('stopped responding', 1, true) ~= nil, true)

-- The give-up supersedes the turn (bumps query_seq), so a chunk still arriving from that
-- same turn must NOT repaint over the "stopped responding" message.
if captured_handlers and captured_handlers.on_chunk then
  captured_handlers.on_chunk('a late partial answer sneaking in')
end
check('late chunk after give-up keeps the stopped-responding message',
  conv_text():find('stopped responding', 1, true) ~= nil, true)
check('late chunk after give-up does not render into the turn',
  conv_text():find('late partial answer', 1, true) == nil, true)

-- Case B: backend pongs → watchdog keeps waiting, does NOT unstick.
Ham('clear') -- reset transcript + awaiting
backend.ping = function(cb) if cb then cb() end; return true end -- pong immediately
vim.fn.setreg('"', 'watchdog probe two')
Ham('explain')
pcall(vim.cmd, 'stopinsert')
vim.wait(150) -- several tick cycles
check('watchdog does NOT fire while backend pongs', conv_text():find('stopped responding', 1, true) == nil, true)

Ham('clear') -- awaiting → false, stops the running watchdog
backend.query = orig_query
backend.ping = orig_ping

if #failures == 0 then
  print('\nALL PASS')
  os.exit(0)
else
  print('\nFAILURES: ' .. table.concat(failures, ', '))
  os.exit(1)
end
