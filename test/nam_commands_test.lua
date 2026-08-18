-- Test for the :Nam open/close/toggle command dispatch and window lifecycle.
-- Run headless:  nvim --headless -l test/nam_commands_test.lua
-- Exits 0 on success, 1 on failure.
--
-- Uses a dead debug port + firefox.manage=false so opening the panel has no
-- Firefox/backend side effects (we only care about the window logic here).

local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':h:h')
vim.opt.runtimepath:append(root)
vim.cmd('runtime plugin/nam.lua')

local nam = require('nam')
nam.setup({ firefox = { manage = false }, backend = { port = 9999 } })
local ui = require('nam.ui')

-- Count the panel's windows (conversation = markdown, input = nam-input).
local function nam_wins()
  local n = 0
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    local ft = vim.bo[vim.api.nvim_win_get_buf(w)].filetype
    if ft == 'markdown' or ft == 'nam-input' then n = n + 1 end
  end
  return n
end

local failures = {}
local function check(name, got, want)
  local ok = got == want
  print(string.format('%-40s got=%-6s want=%-6s %s', name, tostring(got), tostring(want), ok and 'OK' or 'FAIL'))
  if not ok then table.insert(failures, name) end
end

-- Simulate :Nam <sub> exactly as the user command does.
local function Nam(sub)
  nam._command({ args = sub or '' })
  pcall(vim.cmd, 'stopinsert') -- open() ends by focusing the input in insert mode
end

check('command registered', vim.api.nvim_get_commands({}).Nam ~= nil, true)

check('closed initially', ui.is_open(), false)

Nam('') -- :Nam (open)
check('after :Nam -> open', ui.is_open(), true)
check('after :Nam -> 2 windows', nam_wins(), 2)

Nam('close') -- :Nam close
check('after :Nam close -> closed', ui.is_open(), false)
check('after :Nam close -> 0 windows', nam_wins(), 0)

Nam('toggle') -- :Nam toggle (opens)
check('after :Nam toggle -> open', ui.is_open(), true)

Nam('toggle') -- :Nam toggle (closes)
check('after :Nam toggle -> closed', ui.is_open(), false)

-- close() on an already-closed panel must be a harmless no-op
local ok_noop = pcall(function() Nam('close') end)
check('close when already closed is safe', ok_noop and not ui.is_open(), true)

if #failures == 0 then
  print('\nALL PASS')
  os.exit(0)
else
  print('\nFAILURES: ' .. table.concat(failures, ', '))
  os.exit(1)
end
