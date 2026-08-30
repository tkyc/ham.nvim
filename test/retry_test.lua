-- Test the /retry slash command: it re-asks the last question as a new turn.
--
-- Run headless:  nvim --headless -l test/retry_test.lua
-- Exits 0 on success, 1 on failure.
--
-- Dead debug port + firefox.manage=false: the submitted query just errors out,
-- which clears `awaiting` so the next submit is accepted. We only assert on the
-- transcript the UI builds, not on any real answer.

local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':h:h')
vim.opt.runtimepath:append(root)
vim.o.lines = 40
vim.o.columns = 100
vim.cmd('runtime plugin/ham.lua')

require('ham').setup({ firefox = { manage = false }, backend = { port = 9999 } })
local ui = require('ham.ui')
ui.open()
pcall(vim.cmd, 'stopinsert')

local conv, input
for _, w in ipairs(vim.api.nvim_list_wins()) do
  local b = vim.api.nvim_win_get_buf(w)
  local ft = vim.bo[b].filetype
  if ft == 'markdown' then conv = { win = w, buf = b }
  elseif ft == 'ham-input' then input = { win = w, buf = b } end
end

local failures = {}
local function check(name, got, want)
  local ok = got == want
  print(string.format('%-45s got=%-6s want=%-6s %s', name, tostring(got), tostring(want), ok and 'OK' or 'FAIL'))
  if not ok then table.insert(failures, name) end
end

local function conv_text()
  return table.concat(vim.api.nvim_buf_get_lines(conv.buf, 0, -1, false), '\n')
end
local function count(pat)
  local n = 0
  for _ in conv_text():gmatch(pat) do n = n + 1 end
  return n
end
local function submit(line)
  vim.api.nvim_buf_set_lines(input.buf, 0, -1, false, { line })
  for _, m in ipairs(vim.api.nvim_buf_get_keymap(input.buf, 'n')) do
    if m.lhs == '<CR>' and m.callback then m.callback(); return end
  end
  error('submit keymap not found')
end
local function wait_error() -- dead-backend error render clears `awaiting`
  vim.wait(5000, function() return conv_text():find('⚠', 1, true) ~= nil end, 100)
end

if not (conv and input) then print('FAIL: panel windows not found'); os.exit(1) end

-- /retry with nothing asked yet is a no-op (no new turn).
submit('/retry')
check('/retry on empty transcript adds no turn', count('▶ You'), 0)

-- Ask a real question, let it error so awaiting clears.
submit('what is the tallest mountain')
wait_error()
check('after first question: 1 You turn', count('▶ You'), 1)

-- /retry should re-ask that same question as a second turn.
submit('/retry')
check('/retry adds a second You turn', count('▶ You'), 2)
check('/retry re-asked the same question', count('what is the tallest mountain'), 2)
check('the literal "/retry" is not shown as a turn', conv_text():find('/retry', 1, true) == nil, true)

-- /retry rejected because a query is in flight must still wipe its own "/retry" text
-- from the input box. Stub backend.query so the turn stays `awaiting` (a dead backend
-- would otherwise error out and clear it before we can submit the /retry).
local backend = require('ham.backend')
local orig_query = backend.query
backend.query = function() return 1 end -- accept, never call handlers → stays awaiting
ui.clear() -- reset transcript + awaiting to a known state
submit('a question that never answers') -- awaiting = true
check('setup: one turn while awaiting', count('▶ You'), 1)
submit('/retry') -- rejected: "still waiting on the previous answer…"
local input_text = table.concat(vim.api.nvim_buf_get_lines(input.buf, 0, -1, false), '\n')
check('/retry rejected while awaiting clears the input box', input_text, '')
check('/retry rejected while awaiting adds no new turn', count('▶ You'), 1)
backend.query = orig_query

if #failures == 0 then
  print('\nALL PASS')
  os.exit(0)
else
  print('\nFAILURES: ' .. table.concat(failures, ', '))
  os.exit(1)
end
