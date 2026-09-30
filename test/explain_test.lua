-- Test the /explain slash command: it asks AI Mode to explain the unnamed
-- register (your last yank) in plain English.
--
-- Run headless:  nvim --headless -l test/explain_test.lua
-- Exits 0 on success, 1 on failure.
--
-- Dead debug port + firefox.manage=false: the submitted query just errors out;
-- we only assert on the transcript the UI builds from the register, not on any
-- real answer.

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
  print(string.format('%-48s got=%-6s want=%-6s %s', name, tostring(got), tostring(want), ok and 'OK' or 'FAIL'))
  if not ok then table.insert(failures, name) end
end
local function conv_text()
  return table.concat(vim.api.nvim_buf_get_lines(conv.buf, 0, -1, false), '\n')
end
local function contains(s)
  return conv_text():find(s, 1, true) ~= nil
end
local function count_you()
  local n = 0
  for _ in conv_text():gmatch('▶ You') do n = n + 1 end
  return n
end
local function submit(line)
  vim.api.nvim_buf_set_lines(input.buf, 0, -1, false, vim.split(line, '\n', { plain = true }))
  for _, m in ipairs(vim.api.nvim_buf_get_keymap(input.buf, 'n')) do
    if m.lhs == '<CR>' and m.callback then m.callback(); return end
  end
  error('submit keymap not found')
end

if not (conv and input) then print('FAIL: panel windows not found'); os.exit(1) end

-- Empty register -> /explain is a no-op (no new turn).
vim.fn.setreg('"', '')
submit('/explain')
check('/explain with empty register adds no turn', count_you(), 0)

-- Yank some multi-line "code" into the unnamed register, then /explain.
vim.fn.setreg('"', 'local function add(a, b)\n  return a + b\nend\n')
submit('/explain')

check('/explain adds a You turn', count_you(), 1)
check('includes the explain prompt', contains('Explain in plain English. Annotate in a code block with a comment above per line:'), true)
check('includes register line 1', contains('local function add(a, b)'), true)
check('includes register line 2 (multi-line kept)', contains('return a + b'), true)
check('the literal "/explain" is not shown', contains('/explain'), false)

-- /explain rejected because a query is in flight must still wipe its own "/explain" text
-- from the input box. Stub backend.query so the turn stays `awaiting` (a dead backend
-- would otherwise error out and clear it before we can submit the /explain).
local backend = require('ham.backend')
local orig_query = backend.query
backend.query = function() return 1 end -- accept, never call handlers → stays awaiting
ui.clear() -- reset transcript + awaiting to a known state
vim.fn.setreg('"', 'local y = 2')
submit('a question that never answers') -- awaiting = true
check('setup: one turn while awaiting', count_you(), 1)
submit('/explain') -- rejected: "still waiting on the previous answer…"
local input_text = table.concat(vim.api.nvim_buf_get_lines(input.buf, 0, -1, false), '\n')
check('/explain rejected while awaiting clears the input box', input_text, '')
check('/explain rejected while awaiting adds no new turn', count_you(), 1)

-- :Ham <query> asks your own question about the yank: query, blank line, yanked text.
-- Capture what reaches the backend (the stub keeps the turn awaiting, so clear between).
local sent
backend.query = function(text) sent = text; return 1 end
local Ham = function(args) require('ham')._command({ args = args }) end

ui.clear()
vim.fn.setreg('"', 'SELECT * FROM users;\n')
Ham('Rewrite this as a Django ORM query')
check(':Ham <query> sends query + yank', sent, 'Rewrite this as a Django ORM query\n\nSELECT * FROM users;')
check(':Ham <query> adds a You turn', count_you(), 1)
check(':Ham <query> keeps the query casing', contains('Django ORM'), true)
check(':Ham <query> does not use the explain prompt', contains('Explain in plain English'), false)

ui.clear()
sent = nil
vim.fn.setreg('"', '')
Ham('what does this do')
check(':Ham <query> with empty register sends nothing', sent, nil)
check(':Ham <query> with empty register adds no turn', count_you(), 0)

-- A query that merely starts with a subcommand word is still a query, not the subcommand.
ui.clear()
vim.fn.setreg('"', 'x = 1')
Ham('explain this in French')
check(':Ham "explain …" is a query, not :Ham explain', sent, 'explain this in French\n\nx = 1')

-- /ask <query> is the input-box form of :Ham <query>.
local function input_text()
  return table.concat(vim.api.nvim_buf_get_lines(input.buf, 0, -1, false), '\n')
end
ui.clear()
sent = nil
vim.fn.setreg('"', 'def f(): pass\n')
submit('/ask What Does This Return?')
check('/ask sends query + yank', sent, 'What Does This Return?\n\ndef f(): pass')
check('/ask adds a You turn', count_you(), 1)
check('the literal "/ask" is not shown', contains('/ask'), false)
check('/ask clears the input box', input_text(), '')

ui.clear()
sent = nil
submit('/ask line one\nline two') -- multi-line question typed in the box
check('/ask keeps a multi-line query', sent, 'line one\nline two\n\ndef f(): pass')

ui.clear()
sent = nil
submit('/ask') -- no question: warn, don't send "/ask" as a literal query
check('bare /ask sends nothing', sent, nil)
check('bare /ask adds no turn', count_you(), 0)
check('bare /ask clears the input box', input_text(), '')

ui.clear()
sent = nil
submit('/asking for a friend') -- not the /ask command: an ordinary question
check('"/asking …" is a plain query', sent, '/asking for a friend')
ui.clear()
backend.query = orig_query

if #failures == 0 then
  print('\nALL PASS')
  os.exit(0)
else
  print('\nFAILURES: ' .. table.concat(failures, ', '))
  os.exit(1)
end
