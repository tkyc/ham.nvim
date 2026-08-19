-- The :nam chat panel: a vertical split holding a read-only conversation buffer
-- on top and a small editable input buffer below.

local config = require('nam.config')
local backend = require('nam.backend')
local firefox = require('nam.firefox')

local M = {}

local state = {
  conv_buf = nil,
  conv_win = nil,
  input_buf = nil,
  input_win = nil,
  messages = {}, -- { { role = 'you'|'ai'|'system', text = string }, ... }
  awaiting = false, -- a query is in flight
}

local function win_valid(w)
  return w and vim.api.nvim_win_is_valid(w)
end

local function buf_valid(b)
  return b and vim.api.nvim_buf_is_valid(b)
end

-- Turn the message list into display lines.
local function render_lines()
  local lines = {}
  local function push_block(label, text)
    table.insert(lines, label)
    for _, l in ipairs(vim.split(text ~= '' and text or '…', '\n', { plain = true })) do
      table.insert(lines, l)
    end
    table.insert(lines, '')
  end

  if #state.messages == 0 then
    local lines = {
      '',
    }
    if state.starting then
      table.insert(lines, '⏳ Starting Firefox in debug mode…')
      table.insert(lines, '   (first run may restart your browser to attach)')
      table.insert(lines, '')
    end
    return lines
  end

  for _, m in ipairs(state.messages) do
    if m.role == 'you' then
      push_block('## ▶ You', m.text)
    elseif m.role == 'ai' then
      push_block('## ◆ AI Mode', m.text)
    else
      push_block('> ' .. (m.text or ''), '')
    end
  end
  return lines
end

local function redraw()
  if not buf_valid(state.conv_buf) then return end
  local lines = render_lines()
  vim.bo[state.conv_buf].modifiable = true
  vim.api.nvim_buf_set_lines(state.conv_buf, 0, -1, false, lines)
  vim.bo[state.conv_buf].modifiable = false
  -- Intentionally does NOT scroll: streaming a long answer leaves the view where
  -- it is, so you can read from the top instead of being yanked to the bottom.
end

-- Scroll the newest "You" turn to the top of the conversation window. Called once
-- when a turn is submitted so the answer streams in below it.
local function scroll_new_turn_to_top()
  if not (win_valid(state.conv_win) and buf_valid(state.conv_buf)) then return end
  local lines = vim.api.nvim_buf_get_lines(state.conv_buf, 0, -1, false)
  local target = 1
  for i = #lines, 1, -1 do
    if lines[i]:find('▶ You', 1, true) then target = i; break end
  end
  vim.api.nvim_win_call(state.conv_win, function()
    pcall(vim.api.nvim_win_set_cursor, state.conv_win, { target, 0 })
    pcall(vim.cmd, 'normal! zt')
  end)
end

-- Update the text of the last AI message (used while streaming).
local function set_last_ai(text)
  for i = #state.messages, 1, -1 do
    if state.messages[i].role == 'ai' then
      state.messages[i].text = text
      break
    end
  end
  redraw()
end

-- Wipe the conversation window and start a fresh AI Mode conversation.
local function clear()
  state.messages = {}
  state.awaiting = false
  if buf_valid(state.input_buf) then
    vim.api.nvim_buf_set_lines(state.input_buf, 0, -1, false, { '' })
  end
  redraw()
  backend.reset() -- drop pending results + reset the AI Mode conversation
end

local function clear_input()
  if buf_valid(state.input_buf) then
    vim.api.nvim_buf_set_lines(state.input_buf, 0, -1, false, { '' })
  end
end

-- The text of the most recent user question, or nil if there is none yet.
local function last_query()
  for i = #state.messages, 1, -1 do
    if state.messages[i].role == 'you' then return state.messages[i].text end
  end
  return nil
end

-- Append a new turn for `text` and send it to the backend.
local function send_query(text)
  table.insert(state.messages, { role = 'you', text = text })
  table.insert(state.messages, { role = 'ai', text = '' })
  state.awaiting = true
  redraw()
  scroll_new_turn_to_top() -- put the new question at the top; answer fills below

  backend.query(text, {
    on_chunk = function(t) set_last_ai(t) end,
    on_done = function(t)
      set_last_ai(t)
      state.awaiting = false
    end,
    on_error = function(msg)
      set_last_ai('⚠ ' .. msg)
      state.awaiting = false
    end,
  })
end

local function submit()
  if not buf_valid(state.input_buf) then return end
  local raw = vim.api.nvim_buf_get_lines(state.input_buf, 0, -1, false)
  local text = vim.trim(table.concat(raw, '\n'))
  if text == '' then return end

  -- Slash command: clear the chat window (works even while awaiting a reply).
  local cc = config.options.clear_command
  if cc and cc ~= '' and text == cc then
    clear()
    return
  end

  if state.awaiting then
    vim.notify('[nam] still waiting on the previous answer…', vim.log.levels.WARN)
    return
  end

  -- Slash command: /retry re-asks the last question as a new turn.
  local rc = config.options.retry_command
  if rc and rc ~= '' and text == rc then
    local q = last_query()
    clear_input()
    if not q then
      vim.notify('[nam] nothing to retry yet', vim.log.levels.WARN)
      return
    end
    send_query(q)
    return
  end

  -- Slash command: /explain asks AI Mode to explain the unnamed register (your
  -- last yank) in plain English.
  local ec = config.options.explain_command
  if ec and ec ~= '' and text == ec then
    local snippet = (vim.fn.getreg('"') or ''):gsub('%s+$', '')
    clear_input()
    if snippet == '' then
      vim.notify('[nam] nothing yanked to explain', vim.log.levels.WARN)
      return
    end
    send_query(config.options.explain_prompt .. '\n\n' .. snippet)
    return
  end

  clear_input()
  send_query(text)
end

local function focus_input()
  if win_valid(state.input_win) then
    vim.api.nvim_set_current_win(state.input_win)
    vim.cmd('startinsert')
  end
end

local function make_scratch()
  local b = vim.api.nvim_create_buf(false, true)
  vim.bo[b].buftype = 'nofile'
  vim.bo[b].bufhidden = 'hide'
  vim.bo[b].swapfile = false
  return b
end

local function apply_win_opts(w, conceal)
  vim.wo[w].wrap = true
  vim.wo[w].linebreak = true
  vim.wo[w].number = false
  vim.wo[w].relativenumber = false
  vim.wo[w].signcolumn = 'no'
  vim.wo[w].cursorline = false
  if conceal then
    -- Conceal markdown markup (**, [](), etc.) for a cleaner read.
    vim.wo[w].conceallevel = 2
    vim.wo[w].concealcursor = 'nc'
  end
end

local function set_keymaps()
  local km = config.options.keymaps
  local function map(buf, mode, lhs, fn)
    if lhs and lhs ~= '' then
      vim.keymap.set(mode, lhs, fn, { buffer = buf, nowait = true, silent = true })
    end
  end
  map(state.input_buf, 'n', km.submit_normal, submit)
  map(state.input_buf, 'i', km.submit_insert, function()
    -- leave insert so the join/clear is clean, then submit
    vim.cmd('stopinsert')
    submit()
  end)
  map(state.conv_buf, 'n', km.focus_input, focus_input)
  map(state.conv_buf, 'n', km.quit, function() M.close() end)
end

function M.is_open()
  return win_valid(state.conv_win) == true
end

function M.open()
  if M.is_open() then
    focus_input()
    return
  end

  local opts = config.options
  state.conv_buf = make_scratch()
  state.input_buf = make_scratch()
  -- Render the transcript as markdown so headings, bold, lists and links from the
  -- AI Mode answer get proper highlighting.
  vim.bo[state.conv_buf].filetype = 'markdown'
  vim.bo[state.input_buf].filetype = 'nam-input'
  vim.bo[state.conv_buf].modifiable = false

  -- Compute the chat panel width: width_pct of the screen (default 30%), unless a
  -- fixed `width` override is given.
  local width = opts.split.width
  if not width then
    width = math.floor(vim.o.columns * (opts.split.width_pct or 30) / 100)
  end
  width = math.max(20, width)

  -- Vertical split to the chosen side; the new window becomes current.
  local split_cmd = opts.split.side == 'left' and 'topleft vsplit' or 'botright vsplit'
  vim.cmd(split_cmd)
  state.conv_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_width(state.conv_win, width)
  vim.api.nvim_win_set_buf(state.conv_win, state.conv_buf)
  apply_win_opts(state.conv_win, true)

  -- Input box below the conversation, inside the same column.
  vim.cmd('belowright split')
  state.input_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(state.input_win, state.input_buf)
  vim.api.nvim_win_set_height(state.input_win, opts.split.input_height)
  apply_win_opts(state.input_win)

  set_keymaps()
  state.starting = true
  redraw()

  -- Bring up Firefox (may restart it) + the backend so the first query is fast.
  backend.start(function()
    state.starting = false
    redraw()
  end)
  -- Safety net: clear the spinner even if startup fails (ready cb won't fire).
  vim.defer_fn(function()
    if state.starting then
      state.starting = false
      redraw()
    end
  end, (config.options.firefox.launch_timeout_ms or 20000) + 3000)

  focus_input()
end

function M.close()
  if win_valid(state.input_win) then pcall(vim.api.nvim_win_close, state.input_win, true) end
  if win_valid(state.conv_win) then pcall(vim.api.nvim_win_close, state.conv_win, true) end
  state.conv_win = nil
  state.input_win = nil
  state.awaiting = false
  -- Full teardown: stop the Node backend (which cleanly ends its Firefox session)
  -- and quit nam's headless Firefox. Reopening with :Nam relaunches both.
  backend.stop()
  firefox.close()
end

function M.toggle()
  if M.is_open() then M.close() else M.open() end
end

return M
