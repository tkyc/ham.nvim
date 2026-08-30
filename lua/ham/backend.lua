-- Manages the long-lived Node backend process and the NDJSON protocol.

local config = require('ham.config')
local firefox = require('ham.firefox')

local M = {}

local job = nil -- channel id from jobstart
local ready = false
local stopping = false -- true when we deliberately jobstop()
local ensuring = false -- true while bringing Firefox + backend up
local stdout_buf = ''
local next_id = 0
local pending = {} -- id -> { on_chunk, on_done, on_error }
local on_ready_cbs = {}
local pong_cbs = {} -- callbacks waiting for the next pong (liveness check)

local function decode(line)
  local ok, obj = pcall(vim.json.decode, line)
  if ok then return obj end
  return nil
end

-- Return Firefox to its resting state after a captcha episode that will NOT resume
-- (the user cancelled, the solve timed out, or ham gave up): flip the visible solver
-- window back to headless, or in http-disk mode fully quit it (queries then read cookies
-- from disk again). Fire-and-forget. The happy path (captcha_cleared) does this itself as
-- part of resuming, so this only covers the abandoned paths. No-op when ham doesn't
-- manage Firefox (then no solver was ever opened).
local function restore_firefox_after_captcha()
  if not config.options.firefox.manage then return end
  if config.uses_disk_cookies() then
    firefox.quit(function() end)
  else
    firefox.to_headless(function() end)
  end
end

local function dispatch(msg)
  if msg.type == 'ready' then
    ready = true
    for _, cb in ipairs(on_ready_cbs) do
      pcall(cb)
    end
    on_ready_cbs = {}
    return
  end

  if msg.type == 'pong' then
    local cbs = pong_cbs
    pong_cbs = {}
    for _, cb in ipairs(cbs) do pcall(cb) end
    return
  end

  local h = msg.id ~= nil and pending[msg.id] or nil

  if msg.type == 'chunk' then
    if h and h.on_chunk then h.on_chunk(msg.text or '') end
  elseif msg.type == 'done' then
    if h and h.on_done then h.on_done(msg.text or '') end
    if msg.id ~= nil then pending[msg.id] = nil end
  elseif msg.type == 'captcha_cleared' then
    -- User solved the captcha in the visible window: get Firefox out of the way and
    -- re-send the original query.
    if h then
      h.awaiting_captcha = false -- the resume below owns the Firefox flip from here
      vim.notify('[ham] captcha solved — resuming…', vim.log.levels.INFO)
      local function resume(ok, err)
        if ok then
          M._send({ type = 'query', id = msg.id, text = h.text })
        elseif h.on_error then
          h.on_error('could not resume after captcha: ' .. (err or '?'))
          pending[msg.id] = nil
        end
      end
      if config.uses_disk_cookies() then
        -- http mode reads cookies from disk: fully CLOSE Firefox (flushing the fresh
        -- exemption to cookies.sqlite), then re-send — no headless browser needed.
        firefox.quit(function() resume(true) end)
      else
        -- browser mode (and shared-profile http): flip back to headless to continue.
        firefox.to_headless(resume)
      end
    end
  elseif msg.type == 'error' then
    -- Orphaned-session recovery: the port is up but Firefox refuses new BiDi
    -- sessions. Restart Firefox once, then re-send the same query.
    if msg.code == 'ESESSIONBUSY' and h and not h.recovered and config.options.firefox.manage then
      h.recovered = true
      vim.notify('[ham] Firefox automation session was stuck; restarting Firefox to recover…', vim.log.levels.WARN)
      firefox.restart(function(ok, err)
        if not pending[msg.id] then return end -- cancelled during the restart; don't re-send
        if ok then
          M._send({ type = 'query', id = msg.id, text = h.text })
        elseif h.on_error then
          h.on_error('recovery failed: ' .. (err or 'could not restart Firefox'))
          pending[msg.id] = nil
        end
      end)
      return
    end
    -- Captcha: open a visible window so the user can solve it, then wait for it to
    -- clear (the backend replies captcha_cleared → flip back to headless + retry).
    if msg.code == 'ECAPTCHA' and h and not h.captcha_tried and config.options.firefox.manage then
      h.captcha_tried = true
      if h.on_chunk then h.on_chunk('⚠ Captcha — solve it in the Firefox window that opened; ham will resume automatically.') end
      vim.notify('[ham] captcha — opening Firefox to solve it…', vim.log.levels.WARN)
      firefox.open_solver(function(ok, err)
        -- Cancelled (:Ham cancel) while the solver was still opening: bail without starting
        -- the captcha-clear wait. The flip to headful is finished by the time this callback
        -- runs, so flipping back to headless here is SEQUENTIAL (no concurrent flip, unlike
        -- doing it from M.abort mid-open) — that's what keeps the solver window from lingering.
        if not pending[msg.id] then
          if ok then restore_firefox_after_captcha() end
          return
        end
        if ok then
          h.awaiting_captcha = true -- lets :Ham cancel / a give-up restore Firefox
          M._send({ type = 'await_captcha_clear', id = msg.id })
        elseif h.on_error then
          h.on_error('could not open captcha window: ' .. (err or '?'))
          pending[msg.id] = nil
        end
      end)
      return
    end
    -- No cookies on disk yet (http mode, never logged in): point the user at login.
    if msg.code == 'ENOCOOKIES' then
      vim.schedule(function()
        vim.notify('[ham] no saved Google cookies — close the panel (:Ham close), then run :Ham login.', vim.log.levels.WARN)
      end)
    end
    if h and h.on_error then
      -- If this terminal error ends an unsolved captcha episode (the solve timed out, or
      -- a second bot-check we won't retry), return the lingering solver window to headless.
      if h.awaiting_captcha then
        h.awaiting_captcha = false
        restore_firefox_after_captcha()
      end
      h.on_error(msg.message or 'unknown error', msg.code)
      pending[msg.id] = nil
    elseif msg.id == nil then
      -- Untargeted error (no id) — surface globally.
      vim.schedule(function()
        vim.notify('[ham] backend error: ' .. (msg.message or '?'), vim.log.levels.ERROR)
      end)
    end
    -- else: a targeted error whose handler was already retired (watchdog gave up, or the
    -- query was superseded/cleared). The user has already seen that turn resolve — drop it
    -- silently rather than popping a stray global "backend error".
  end
end

local function on_stdout(_, data)
  if not data then return end
  stdout_buf = stdout_buf .. table.concat(data, '\n')
  while true do
    local nl = stdout_buf:find('\n', 1, true)
    if not nl then break end
    local line = stdout_buf:sub(1, nl - 1)
    stdout_buf = stdout_buf:sub(nl + 1)
    line = vim.trim(line)
    if line ~= '' then
      local msg = decode(line)
      if msg then
        vim.schedule(function() dispatch(msg) end)
      end
    end
  end
end

local function on_stderr(_, data)
  if not data then return end
  local text = vim.trim(table.concat(data, '\n'))
  if text ~= '' then
    -- Backend logs progress on stderr; keep it quiet unless a line looks like a real
    -- error (avoids surfacing benign lines that merely contain the word, e.g. "0 errors").
    local low = text:lower()
    if low:match('error[:%s]') or low:find('exception') or low:find('unhandled') then
      vim.schedule(function()
        vim.notify('[ham] ' .. text, vim.log.levels.WARN)
      end)
    end
  end
end

local function on_exit(id, code)
  -- If a newer backend has since started (stop → restart within the exit latency),
  -- this exit belongs to the OLD process — ignore it so we don't clear the new
  -- backend's ready flag or fail its freshly-queued pending handlers.
  if job ~= nil and id ~= job then return end
  local deliberate = stopping
  vim.schedule(function()
    if code ~= 0 and not deliberate then
      vim.notify('[ham] backend exited (code ' .. code .. ')', vim.log.levels.WARN)
    end
  end)
  job = nil
  ready = false
  stopping = false
  stdout_buf = ''
  -- Fail any in-flight requests. If the backend died mid-captcha-solve, the visible
  -- solver window would otherwise linger (no captcha_cleared/timeout reply is coming to
  -- flip it back), so return Firefox to its resting state once.
  local had_captcha = false
  for pid, h in pairs(pending) do
    if h.awaiting_captcha then had_captcha = true end
    if h.on_error then h.on_error('backend process exited') end
    pending[pid] = nil
  end
  if had_captcha then restore_firefox_after_captcha() end
end

function M.is_running()
  return job ~= nil
end

-- Fail any queued startup/query callbacks (e.g. Firefox never came up).
local function flush_start_failure(err)
  on_ready_cbs = {}
  for id, h in pairs(pending) do
    if h.on_error then h.on_error(err or 'could not start backend') end
    pending[id] = nil
  end
end

-- Actually spawn the Node backend (called once Firefox is confirmed reachable).
local function spawn_backend()
  local opts = config.options
  stopping = false -- fresh process; clear any leftover deliberate-stop flag
  job = vim.fn.jobstart({ opts.node_cmd, opts.server_path }, {
    on_stdout = on_stdout,
    on_stderr = on_stderr,
    on_exit = on_exit,
  })

  if job <= 0 then
    job = nil
    flush_start_failure('failed to start backend process')
    vim.notify('[ham] failed to start backend', vim.log.levels.ERROR)
    return
  end

  -- Send config immediately. Include the Firefox profile dir so the backend can read
  -- cookies from <profile>/cookies.sqlite in http mode (browserless queries).
  M._send({ type = 'config', config = vim.tbl_extend('force', {}, opts.backend, { profile = opts.firefox.profile }) })
end

-- Start the backend if it isn't running. `cb` (optional) fires once it's ready.
-- Ensures a debug-enabled Firefox is up first (may quit/relaunch the browser).
function M.start(cb)
  local opts = config.options
  if job then
    if ready and cb then cb() elseif cb then table.insert(on_ready_cbs, cb) end
    return
  end

  if cb then table.insert(on_ready_cbs, cb) end
  if ensuring then return end -- already coming up; cb is queued

  if vim.fn.executable(opts.node_cmd) == 0 then
    flush_start_failure('`' .. opts.node_cmd .. '` not found on PATH')
    vim.notify('[ham] `' .. opts.node_cmd .. '` not found on PATH', vim.log.levels.ERROR)
    return
  end
  if vim.fn.filereadable(opts.server_path) == 0 then
    flush_start_failure('backend not found at ' .. opts.server_path)
    vim.notify('[ham] backend not found at ' .. opts.server_path, vim.log.levels.ERROR)
    return
  end

  -- HTTP mode on a dedicated profile answers queries from the profile's cookies.sqlite,
  -- so no Firefox is needed to start — skip launching it. (Firefox is still launched
  -- later by :Ham login and the captcha solver.) Browser mode, and http mode on the
  -- shared default profile (profile == ''), still need Firefox up first.
  if config.uses_disk_cookies() then
    spawn_backend()
    return
  end

  ensuring = true
  firefox.ensure(function(ok, err)
    ensuring = false
    if not ok then
      vim.notify('[ham] ' .. (err or 'could not start Firefox'), vim.log.levels.ERROR)
      flush_start_failure(err)
      return
    end
    spawn_backend()
  end)
end

function M._send(obj)
  if not job then return false end
  vim.fn.chansend(job, vim.json.encode(obj) .. '\n')
  return true
end

-- Liveness probe: send a ping; `cb()` fires when the backend pongs. The backend
-- answers pings even while busy on a query (its event loop is free during awaits),
-- so a missing pong means it's genuinely wedged — not just slow or awaiting a captcha.
function M.ping(cb)
  if not job then return false end
  if cb then table.insert(pong_cbs, cb) end
  return M._send({ type = 'ping' })
end

-- Ask a question. handlers = { on_chunk = fn(text), on_done = fn(text), on_error = fn(msg, code) }
function M.query(text, handlers)
  next_id = next_id + 1
  local id = next_id
  local h = handlers or {}
  h.text = text -- kept so we can re-send after an orphaned-session recovery
  pending[id] = h

  local function do_send()
    M._send({ type = 'query', id = id, text = text })
  end

  if ready then
    do_send()
  else
    M.start(do_send)
  end
  return id
end

-- Drop a specific query's handlers so a late/abandoned backend reply can no longer
-- render into the UI (used by the watchdog when it gives up on a wedged query).
function M.cancel(id)
  if id ~= nil then pending[id] = nil end
end

-- User-initiated cancel (:Ham cancel / /cancel): drop the handlers locally (like
-- cancel) AND tell the backend to abort the in-flight/queued operation so the queue
-- frees up and the next query starts promptly. The backend message is a no-op if the
-- backend isn't running (M._send returns false).
function M.abort(id)
  if id == nil then return end
  local h = pending[id]
  pending[id] = nil
  M._send({ type = 'cancel', id = id }) -- stops a running query OR a captcha solve-wait
  -- If we were mid-captcha-solve, the resume path that normally flips Firefox back won't
  -- run (its handler is now dropped), so return the solver window to headless here.
  if h and h.awaiting_captcha then restore_firefox_after_captcha() end
end

-- Reset the AI Mode conversation: drop any in-flight query callbacks (their
-- results would render into the just-cleared window) and tell the backend to
-- start a fresh conversation on the next query.
function M.reset()
  -- If a query is parked on a captcha solve, simply dropping its handler would strand the
  -- visible solver window: the later captcha_cleared / timeout reply then finds no handler
  -- and never flips Firefox back. Abort the backend's solve-wait and restore Firefox first
  -- — the same cleanup M.abort does for a single cancelled captcha turn.
  local had_captcha = false
  for id, h in pairs(pending) do
    if h.awaiting_captcha then
      M._send({ type = 'cancel', id = id }) -- stop the backend's captcha solve-wait
      had_captcha = true
    end
    pending[id] = nil
  end
  if had_captcha then restore_firefox_after_captcha() end
  if ready then
    M._send({ type = 'reset' })
  else
    -- Backend still starting: defer the reset to on-ready, otherwise it's dropped and
    -- the first query continues the previous thread instead of a fresh one.
    table.insert(on_ready_cbs, function() M._send({ type = 'reset' }) end)
  end
end

function M.stop()
  if job then
    stopping = true
    pcall(vim.fn.jobstop, job)
    job = nil
    ready = false
  end
end

-- Test seams: let the suite drive the real protocol dispatch and process-exit handling
-- (which are otherwise reached only through a live jobstart), so the captcha-teardown
-- paths above can be exercised without spawning Node/Firefox.
M._dispatch = dispatch
M._on_exit = on_exit

return M
