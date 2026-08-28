-- Test :Ham cancel / /cancel: abandon an in-flight query without tearing down the
-- session. The backend is stubbed so a submitted query stays `awaiting` forever
-- (accept, never answer); backend.abort is stubbed to record the aborted id.
--
-- Run headless:  nvim --headless -l test/cancel_test.lua
-- Exits 0 on success, 1 on failure.

local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':h:h')
vim.opt.runtimepath:append(root)
vim.o.lines = 40
vim.o.columns = 100
vim.cmd('runtime plugin/ham.lua')

require('ham').setup({ firefox = { manage = false }, backend = { port = 9999 } })
local ui = require('ham.ui')
local backend = require('ham.backend')

-- Stub the backend: accept a query (return a fresh id), never call the handlers → the
-- panel stays awaiting. Record what backend.abort is asked to cancel.
local next_id = 100
backend.query = function() next_id = next_id + 1; return next_id end
local aborted_id = nil
backend.abort = function(id) aborted_id = id end

ui.open()
pcall(vim.cmd, 'stopinsert')

local conv, input
for _, w in ipairs(vim.api.nvim_list_wins()) do
  local b = vim.api.nvim_win_get_buf(w)
  local ft = vim.bo[b].filetype
  if ft == 'markdown' then conv = { win = w, buf = b }
  elseif ft == 'ham-input' then input = { win = w, buf = b } end
end
if not (conv and input) then print('FAIL: panel windows not found'); os.exit(1) end

local failures = {}
local function check(name, got, want)
  local ok = got == want
  print(string.format('%-52s got=%-6s want=%-6s %s', name, tostring(got), tostring(want), ok and 'OK' or 'FAIL'))
  if not ok then table.insert(failures, name) end
end
local function conv_text() return table.concat(vim.api.nvim_buf_get_lines(conv.buf, 0, -1, false), '\n') end
local function count(pat) local n = 0; for _ in conv_text():gmatch(pat) do n = n + 1 end; return n end
local function submit(line)
  vim.api.nvim_buf_set_lines(input.buf, 0, -1, false, { line })
  for _, m in ipairs(vim.api.nvim_buf_get_keymap(input.buf, 'n')) do
    if m.lhs == '<CR>' and m.callback then m.callback(); return end
  end
  error('submit keymap not found')
end

-- Nothing in flight yet: cancel is a harmless no-op (no cancelled marker, no abort).
ui.cancel()
check('cancel with nothing in flight adds no marker', conv_text():find('cancelled', 1, true) == nil, true)
check('cancel with nothing in flight does not abort', aborted_id == nil, true)

-- Ask a question; the stub never answers, so the turn stays in flight.
submit('a slow question')
check('question shows a You turn', count('▶ You'), 1)
check('no cancelled marker while awaiting', conv_text():find('cancelled', 1, true) == nil, true)

-- :Ham cancel abandons it: marks the turn cancelled and aborts the backend query id.
ui.cancel()
check(':Ham cancel marks the turn cancelled', conv_text():find('cancelled', 1, true) ~= nil, true)
check(':Ham cancel aborted a real backend query id', type(aborted_id) == 'number', true)

-- After cancel the panel is free: a new question is accepted (not blocked as awaiting).
submit('a fresh question')
check('submit works after cancel (awaiting cleared)', count('▶ You'), 2)
check('fresh question was sent', conv_text():find('a fresh question', 1, true) ~= nil, true)

-- The /cancel slash command routes to cancel too, even while awaiting, and is not shown
-- as a turn of its own.
submit('/cancel')
check('/cancel marks cancelled again', conv_text():find('cancelled', 1, true) ~= nil, true)
check('literal "/cancel" is not shown as a turn', conv_text():find('/cancel', 1, true) == nil, true)
check('/cancel added no new You turn', count('▶ You'), 2)

-- :Ham cancel (the command form) must NOT wipe a question the user started typing while
-- waiting — only the /cancel slash form clears the input (its own text).
submit('another slow one') -- awaiting again
vim.api.nvim_buf_set_lines(input.buf, 0, -1, false, { 'my draft in progress' })
ui.cancel()
check(':Ham cancel preserves an in-progress input draft',
  table.concat(vim.api.nvim_buf_get_lines(input.buf, 0, -1, false), '\n'), 'my draft in progress')

if #failures == 0 then
  print('\nALL PASS')
  os.exit(0)
else
  print('\nFAILURES: ' .. table.concat(failures, ', '))
  os.exit(1)
end
