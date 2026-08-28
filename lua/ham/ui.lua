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
  awaiting_id = nil, -- backend id of the in-flight query (so :Ham cancel can abort it)
  starting = false, -- true while Firefox + backend are coming up (shows the spinner)
  query_seq = 0, -- bumped per submit/clear; guards late replies from superseded turns
  augroup = nil, -- generation-scoped WinClosed autocmd group for the current panel
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
    local empty = { '' }
    if state.starting then
      table.insert(empty, '⏳ Starting Firefox in debug mode…')
      table.insert(empty, '   (first run may restart your browser to attach)')
      table.insert(empty, '')
    end
    return empty
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

local function clear_input()
  if buf_valid(state.input_buf) then
    vim.api.nvim_buf_set_lines(state.input_buf, 0, -1, false, { '' })
  end
end

-- Wipe the conversation window and start a fresh AI Mode conversation.
function M.clear()
  if not M.is_open() then M.open() end
  state.messages = {}
  state.awaiting = false
  state.awaiting_id = nil
  -- Supersede any in-flight query so its late reply can't render into the cleared
  -- transcript (backend.reset also drops its handlers — this guards the seq path too).
  state.query_seq = (state.query_seq or 0) + 1
  clear_input()
  redraw()
  backend.reset() -- drop pending results + reset the AI Mode conversation
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
local function start_watchdog(seq, id)
  local function current() return state.awaiting and state.query_seq == seq end
  local function tick()
    if not current() then return end -- answered, superseded, or panel closed
    -- Backend not up yet (the query is still queued behind a slow Firefox/backend
    -- startup): with no job, ping() is a silent no-op that must NOT read as a wedge.
    -- Keep waiting — a genuine startup failure or crash clears `awaiting` via
    -- on_error/on_exit, which makes current() false and stops this loop.
    if not backend.is_running() then
      vim.defer_fn(tick, M._watchdog.interval_ms)
      return
    end
    local ponged = false
    backend.ping(function() ponged = true end)
    vim.defer_fn(function()
      if not current() then return end
      if ponged then
        vim.defer_fn(tick, M._watchdog.interval_ms) -- alive → keep waiting, re-check later
      else
        state.awaiting = false
        state.awaiting_id = nil
        -- Retire the wedged query's handlers so a much-later reply from it can't land
        -- in whatever turn happens to be last by then.
        backend.cancel(id)
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
  local seq = state.query_seq
  redraw()
  scroll_new_turn_to_top() -- put the new question at the top; answer fills below

  -- Guard every handler by `seq`: if this query has been superseded (a new submit, a
  -- /clear, or a watchdog give-up) its late reply must not write into a later turn.
  local id = backend.query(text, {
    on_chunk = function(t) if state.query_seq == seq then set_last_ai(t) end end,
    on_done = function(t)
      if state.query_seq ~= seq then return end
      set_last_ai(t)
      state.awaiting = false
      state.awaiting_id = nil
    end,
    on_error = function(msg)
      if state.query_seq ~= seq then return end
      set_last_ai('⚠ ' .. msg)
      state.awaiting = false
      state.awaiting_id = nil
    end,
  })

  state.awaiting_id = id
  start_watchdog(seq, id)
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

-- Abandon the in-flight query without tearing down the session (also /cancel and
-- :Ham cancel). Supersedes the turn so its late reply can't render, asks the backend to
-- abort the running operation (freeing the queue for the next query), and leaves the
-- panel ready to ask again — unlike :Ham close, which stops the backend and Firefox.
function M.cancel()
  if not M.is_open() then
    vim.notify('[ham] no chat panel open', vim.log.levels.WARN)
    return
  end
  if not state.awaiting then
    vim.notify('[ham] nothing to cancel', vim.log.levels.WARN)
    return
  end
  local id = state.awaiting_id
  state.awaiting = false
  state.awaiting_id = nil
  -- Bump the seq so a late on_chunk/on_done from this turn is ignored (the same guard
  -- the watchdog uses when it gives up on a wedged query).
  state.query_seq = (state.query_seq or 0) + 1
  -- NOTE: we deliberately do NOT clear the input here — a :Ham cancel must not wipe a
  -- question the user has started typing while waiting. The /cancel slash path clears its
  -- own "/cancel" text in submit() before calling this.
  set_last_ai('⏹ cancelled')
  backend.abort(id) -- drop the handlers locally + tell the backend to stop working it
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
  -- /cancel must be handled BEFORE the awaiting guard below (it's the one slash command
  -- whose whole job is to interrupt an in-flight turn).
  local nc = config.options.cancel_command
  -- Typed as a slash command: clear the "/cancel" text (M.cancel leaves the input alone so
  -- the :Ham cancel command path can preserve an in-progress draft).
  if nc and nc ~= '' and text == nc then clear_input(); M.cancel(); return end

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

  -- Compute the chat panel width: width_pct of the screen (default 45%), unless a
  -- fixed `width` override is given.
  local width = opts.split.width
  if not width then
    width = math.floor(vim.o.columns * (opts.split.width_pct or 45) / 100)
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

  -- Full teardown on ANY panel close, not just `q` / `:Ham close`. If the user closes a
  -- panel window by other means (`:q`, <C-w>c, closing the tab), route it through
  -- M.close so the backend + headless Firefox don't orphan and the scratch buffers
  -- don't leak. Generation-scoped group so a stale autocmd can't fire on a later panel.
  state.augroup = vim.api.nvim_create_augroup('ham_panel_' .. gen, { clear = true })
  vim.api.nvim_create_autocmd('WinClosed', {
    group = state.augroup,
    callback = function(ev)
      if open_generation ~= gen then return true end -- superseded panel → drop this autocmd
      local closed = tonumber(ev.match)
      if closed == state.conv_win or closed == state.input_win then
        vim.schedule(M.close)
      end
    end,
  })

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
  -- Drop the WinClosed watcher FIRST so closing the panel windows below doesn't
  -- re-enter M.close through it.
  if state.augroup then pcall(vim.api.nvim_del_augroup_by_id, state.augroup); state.augroup = nil end
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
  state.awaiting_id = nil
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
