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

Ham('close')

if #failures == 0 then
  print('\nALL PASS')
  os.exit(0)
else
  print('\nFAILURES: ' .. table.concat(failures, ', '))
  os.exit(1)
end
