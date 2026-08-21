-- The :ham chat panel: a vertical split holding a read-only conversation buffer
-- on top and a small editable input buffer below.

local config = require('ham.config')
local backend = require('ham.backend')
local firefox = require('ham.firefox')

local M = {}

local state = {
  conv_buf = nil,
  conv_win = nil,
  input_buf = nil,
  input_win = nil,
  messages = {}, -- { { role = 'you'|'ai'|'system', text = string }, ... }
  awaiting = false, -- a query is in flight
}

-- Bumped on every open(); lets a deferred timer tell whether it belongs to the
-- current panel or a since-closed one (avoids a stale timer touching a new panel).
local open_generation = 0

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
function M.clear()
  if not M.is_open() then M.open() end
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

-- Liveness watchdog: while a query is awaiting, periodically ping the backend. The
-- backend pongs even while busy (slow answer, or waiting on a captcha you're solving),
-- so we only unstick the panel if it stops responding entirely — a genuine wedge. A
-- dead process is already handled by on_exit, so this covers the alive-but-stuck case.
-- Timings (exposed so tests can shorten them). pong_ms must clear the backend's only
-- synchronous work (parsing a large answer) so we never false-fire on a busy backend.
M._watchdog = { interval_ms = 20000, pong_ms = 8000 }
local function start_watchdog(seq)
  local function current() return state.awaiting and state.query_seq == seq end
  local function tick()
    if not current() then return end -- answered, superseded, or panel closed
    local ponged = false
    backend.ping(function() ponged = true end)
    vim.defer_fn(function()
      if not current() then return end
      if ponged then
        vim.defer_fn(tick, M._watchdog.interval_ms) -- alive → keep waiting, re-check later
      else
        state.awaiting = false
        set_last_ai('⚠ backend stopped responding — try /retry, or :Ham close and reopen.')
      end
    end, M._watchdog.pong_ms)
  end
  vim.defer_fn(tick, M._watchdog.interval_ms)
end

-- Append a new turn for `text` and send it to the backend.
local function send_query(text)
  table.insert(state.messages, { role = 'you', text = text })
  table.insert(state.messages, { role = 'ai', text = '' })
  state.awaiting = true
  state.query_seq = (state.query_seq or 0) + 1
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

  start_watchdog(state.query_seq)
end

-- Re-ask the last question (also the /retry command and :Ham retry).
function M.retry()
  if not M.is_open() then M.open() end
  if state.awaiting then
    vim.notify('[ham] still waiting on the previous answer…', vim.log.levels.WARN)
    return
  end
  local q = last_query()
  clear_input()
  if not q then
    vim.notify('[ham] nothing to retry yet', vim.log.levels.WARN)
    return
  end
  send_query(q)
end

-- Explain the unnamed register / last yank (also /explain and :Ham explain).
function M.explain()
  if not M.is_open() then M.open() end
  if state.awaiting then
    vim.notify('[ham] still waiting on the previous answer…', vim.log.levels.WARN)
    return
  end
  local snippet = (vim.fn.getreg('"') or ''):gsub('%s+$', '')
  clear_input()
  if snippet == '' then
    vim.notify('[ham] nothing yanked to explain', vim.log.levels.WARN)
    return
  end
  send_query(config.options.explain_prompt .. '\n\n' .. snippet)
end

local function submit()
  if not buf_valid(state.input_buf) then return end
  local raw = vim.api.nvim_buf_get_lines(state.input_buf, 0, -1, false)
  local text = vim.trim(table.concat(raw, '\n'))
  if text == '' then return end

  -- Slash commands mirror the :Ham subcommands.
  local cc = config.options.clear_command
  if cc and cc ~= '' and text == cc then M.clear(); return end
  local rc = config.options.retry_command
  if rc and rc ~= '' and text == rc then M.retry(); return end
  local ec = config.options.explain_command
  if ec and ec ~= '' and text == ec then M.explain(); return end

  if state.awaiting then
    vim.notify('[ham] still waiting on the previous answer…', vim.log.levels.WARN)
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

  -- Remember the window the user was in so opening the panel doesn't steal the
  -- cursor: ham builds the split, then hands focus straight back.
  local prev_win = vim.api.nvim_get_current_win()

  local opts = config.options
  state.conv_buf = make_scratch()
  state.input_buf = make_scratch()
  -- Render the transcript as markdown so headings, bold, lists and links from the
  -- AI Mode answer get proper highlighting.
  vim.bo[state.conv_buf].filetype = 'markdown'
  vim.bo[state.input_buf].filetype = 'ham-input'
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
  open_generation = open_generation + 1
  local gen = open_generation
  state.starting = true
  redraw()

  -- Bring up Firefox (may restart it) + the backend so the first query is fast.
  backend.start(function()
    if open_generation ~= gen then return end -- panel was closed/reopened since
    state.starting = false
    redraw()
  end)
  -- Safety net: clear the spinner even if startup fails (ready cb won't fire). Guard
  -- with the generation so a stale timer can't touch a since-reopened panel.
  vim.defer_fn(function()
    if open_generation == gen and state.starting then
      state.starting = false
      redraw()
    end
  end, (config.options.firefox.launch_timeout_ms or 20000) + 3000)

  -- Return the cursor to where it was; opening the panel must not move focus or
  -- start insert mode. (Use :Ham again, or the focus_input keymap, to jump in.)
  if win_valid(prev_win) then
    vim.api.nvim_set_current_win(prev_win)
  end
end

function M.close()
  if win_valid(state.input_win) then pcall(vim.api.nvim_win_close, state.input_win, true) end
  if win_valid(state.conv_win) then pcall(vim.api.nvim_win_close, state.conv_win, true) end
  -- Wipe the scratch buffers (bufhidden='hide' would otherwise leave them lingering
  -- in memory across every open/close cycle).
  if buf_valid(state.input_buf) then pcall(vim.api.nvim_buf_delete, state.input_buf, { force = true }) end
  if buf_valid(state.conv_buf) then pcall(vim.api.nvim_buf_delete, state.conv_buf, { force = true }) end
  state.conv_win = nil
  state.input_win = nil
  state.conv_buf = nil
  state.input_buf = nil
  state.awaiting = false
  state.starting = false
  -- Full teardown: stop the Node backend (which cleanly ends its Firefox session)
  -- and quit ham's headless Firefox. Reopening with :Ham relaunches both — so drop
  -- the transcript too, otherwise the reopened panel would show a conversation the
  -- fresh backend has no memory of.
  state.messages = {}
  backend.stop()
  firefox.close()
end

function M.toggle()
  if M.is_open() then M.close() else M.open() end
end

return M
