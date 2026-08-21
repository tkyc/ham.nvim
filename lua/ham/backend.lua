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
      vim.notify('[ham] captcha solved — resuming…', vim.log.levels.INFO)
      local function resume(ok, err)
        if ok then
          M._send({ type = 'query', id = msg.id, text = h.text })
        elseif h.on_error then
          h.on_error('could not resume after captcha: ' .. (err or '?'))
          pending[msg.id] = nil
        end
      end
      local opts = config.options
      local http_disk = opts.backend.mode == 'http'
        and opts.firefox.profile ~= nil and opts.firefox.profile ~= ''
      if http_disk then
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
        if ok then
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
      h.on_error(msg.message or 'unknown error', msg.code)
      pending[msg.id] = nil
    else
      -- Untargeted error (no id) — surface globally.
      vim.schedule(function()
        vim.notify('[ham] backend error: ' .. (msg.message or '?'), vim.log.levels.ERROR)
      end)
    end
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
    -- Backend logs progress on stderr; keep it quiet unless it looks like a real error.
    if text:lower():find('error') then
      vim.schedule(function()
        vim.notify('[ham] ' .. text, vim.log.levels.WARN)
      end)
    end
  end
end

local function on_exit(_, code)
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
  -- Fail any in-flight requests.
  for id, h in pairs(pending) do
    if h.on_error then h.on_error('backend process exited') end
    pending[id] = nil
  end
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
  local http_diskcookies = opts.backend.mode == 'http'
    and opts.firefox.profile ~= nil and opts.firefox.profile ~= ''
  if http_diskcookies then
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

-- Reset the AI Mode conversation: drop any in-flight query callbacks (their
-- results would render into the just-cleared window) and tell the backend to
-- start a fresh conversation on the next query.
function M.reset()
  for id in pairs(pending) do
    pending[id] = nil
  end
  if ready then
    M._send({ type = 'reset' })
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

return M
