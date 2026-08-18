-- Test that the conversation window does NOT scroll to the bottom while rendering.
-- Submitting a question scrolls it to the TOP; subsequent renders leave the view
-- put (so a long streaming answer isn't yanked to the bottom).
--
-- Run headless:  nvim --headless -l test/scroll_test.lua
-- Exits 0 on success, 1 on failure.
--
-- Uses a dead debug port + firefox.manage=false, so no Firefox/backend side
-- effects — the submitted query just errors out, which is enough to trigger the
-- render we want to observe.

local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':h:h')
vim.opt.runtimepath:append(root)
vim.o.lines = 40
vim.o.columns = 100
vim.cmd('runtime plugin/nam.lua')

require('nam').setup({ firefox = { manage = false }, backend = { port = 9999 }, split = { input_height = 4 } })
local ui = require('nam.ui')
ui.open()
pcall(vim.cmd, 'stopinsert')

-- Locate the two panes by their filetypes.
local conv, input
for _, w in ipairs(vim.api.nvim_list_wins()) do
  local b = vim.api.nvim_win_get_buf(w)
  local ft = vim.bo[b].filetype
  if ft == 'markdown' then conv = { win = w, buf = b }
  elseif ft == 'nam-input' then input = { win = w, buf = b } end
end

local failures = {}
local function check(name, got, want)
  local ok = got == want
  print(string.format('%-45s got=%-6s want=%-6s %s', name, tostring(got), tostring(want), ok and 'OK' or 'FAIL'))
  if not ok then table.insert(failures, name) end
end

local function topline()
  return vim.api.nvim_win_call(conv.win, function() return vim.fn.winsaveview().topline end)
end
local function has_error_rendered()
  return table.concat(vim.api.nvim_buf_get_lines(conv.buf, 0, -1, false), '\n'):find('⚠', 1, true) ~= nil
end

if not (conv and input) then
  print('FAIL: panel windows not found')
  os.exit(1)
end

-- Submit one long question so the buffer is taller than the window.
local q = {}
for i = 1, 60 do q[i] = 'line ' .. i .. ' of a very long question' end
vim.api.nvim_buf_set_lines(input.buf, 0, -1, false, q)
for _, m in ipairs(vim.api.nvim_buf_get_keymap(input.buf, 'n')) do
  if m.lhs == '<CR>' and m.callback then m.callback(); break end
end

local win_h = vim.api.nvim_win_get_height(conv.win)
local buf_lines = vim.api.nvim_buf_line_count(conv.buf)
local tl_after_submit = topline()

vim.wait(5000, has_error_rendered, 100) -- wait for the dead-backend error render
local tl_after_render = topline()

check('buffer taller than window (scroll possible)', buf_lines > win_h, true)
check('new question scrolled to top', tl_after_submit, 1)
check('view unchanged across render (no scroll-to-bottom)', tl_after_render, tl_after_submit)

if #failures == 0 then
  print('\nALL PASS')
  os.exit(0)
else
  print('\nFAILURES: ' .. table.concat(failures, ', '))
  os.exit(1)
end
