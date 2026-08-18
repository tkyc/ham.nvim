-- Firefox lifecycle manager for nam.
--
-- Firefox's WebDriver BiDi remote agent can only be enabled at *startup* via
-- --remote-debugging-port; it cannot be toggled on a running instance, and
-- Firefox is single-instance per profile. So to attach to the user's real
-- (logged-in) Firefox we make sure a debug-enabled instance is running, quitting
-- and relaunching their normal Firefox when necessary.

local config = require('nam.config')

local M = {}

local uv = vim.uv or vim.loop

local function notify(msg, level)
  -- May be called from a libuv fast context; nvim_echo is not allowed there.
  vim.schedule(function()
    vim.notify('[nam] ' .. msg, level or vim.log.levels.INFO)
  end)
end

-- Async: is something listening on host:port? Calls cb(bool) on the main loop.
function M.is_up(host, port, timeout_ms, cb)
  local tcp = uv.new_tcp()
  local timer = uv.new_timer()
  local done = false
  local function finish(ok)
    if done then return end
    done = true
    pcall(function() timer:stop() end)
    pcall(function() timer:close() end)
    pcall(function() tcp:close() end)
    vim.schedule(function() cb(ok) end)
  end
  timer:start(timeout_ms, 0, function() finish(false) end)
  tcp:connect(host, port, function(err) finish(err == nil) end)
end

-- Synchronous variant (pumps the loop) for :checkhealth.
function M.is_up_sync(host, port, timeout_ms)
  local done, result = false, false
  local tcp = uv.new_tcp()
  local timer = uv.new_timer()
  timer:start(timeout_ms, 0, function()
    if not done then done = true; pcall(function() tcp:close() end) end
  end)
  tcp:connect(host, port, function(err)
    if not done then
      done = true; result = err == nil
      pcall(function() timer:stop() end); pcall(function() tcp:close() end)
    end
  end)
  local deadline = uv.now() + timeout_ms + 100
  while not done and uv.now() < deadline do uv.run('nowait') end
  pcall(function() timer:close() end)
  return result
end

-- Async: is a Firefox process running? Calls cb(bool).
function M.is_running(cb)
  vim.system({ 'pgrep', '-x', 'firefox' }, { text = true }, function(res)
    local hit = res.code == 0 and (res.stdout or ''):match('%S') ~= nil
    -- vim.system callbacks run in a fast context; resume on the main loop so
    -- callers may safely use nvim_echo/jobstart/etc.
    vim.schedule(function() cb(hit) end)
  end)
end

local function launch(opts)
  local args = { opts.firefox.cmd, '--remote-debugging-port', tostring(opts.backend.port) }
  vim.list_extend(args, opts.firefox.extra_args or {})
  local env = nil
  if vim.env.WAYLAND_DISPLAY and vim.env.WAYLAND_DISPLAY ~= '' then
    env = { MOZ_ENABLE_WAYLAND = '1' }
  end
  -- detach so Firefox outlives nvim; nam never closes the user's browser.
  vim.fn.jobstart(args, { detach = true, env = env })
end

-- Poll the debug port until it is up or the deadline passes.
local function wait_up(host, port, deadline, cb)
  M.is_up(host, port, 500, function(up)
    if up then
      cb(true)
    elseif uv.now() > deadline then
      cb(false, ('Firefox debug port never came up on %s:%d'):format(host, port))
    else
      vim.defer_fn(function() wait_up(host, port, deadline, cb) end, 400)
    end
  end)
end

-- Poll until no Firefox process remains (so the profile lock is released), then
-- a short extra delay before proceeding. Falls through on timeout.
local function wait_gone(deadline, done)
  M.is_running(function(running)
    if not running then
      vim.defer_fn(done, 800) -- let the profile lockfile clear
    elseif uv.now() > deadline then
      done()
    else
      vim.defer_fn(function() wait_gone(deadline, done) end, 300)
    end
  end)
end

local function quit(done)
  vim.system({ 'pkill', 'firefox' }, {}, function()
    wait_gone(uv.now() + 10000, done)
  end)
end

-- Ensure a debug-enabled Firefox is reachable, then cb(true). On failure,
-- cb(false, message). Only ever attempts one restart (no kill loops).
function M.ensure(cb)
  local opts = config.options
  local host, port = opts.backend.host, opts.backend.port

  M.is_up(host, port, 800, function(up)
    if up then
      cb(true) -- already in debug mode; touch nothing
      return
    end

    if not opts.firefox.manage then
      cb(false, ('Firefox debug port %s:%d is down. Launch Firefox with '
        .. '--remote-debugging-port %d (or set firefox.manage=true).'):format(host, port, port))
      return
    end

    M.is_running(function(running)
      local deadline = uv.now() + opts.firefox.launch_timeout_ms
      local function do_launch()
        launch(opts)
        wait_up(host, port, deadline, cb)
      end

      if running then
        if opts.firefox.auto_restart then
          notify('restarting Firefox in debug mode…')
          quit(do_launch)
        else
          cb(false, ('Firefox is running without debug mode. Restart it with '
            .. '--remote-debugging-port %d, or set firefox.auto_restart=true.'):format(port))
        end
      else
        notify('launching Firefox in debug mode…')
        do_launch()
      end
    end)
  end)
end

-- Force a restart of Firefox into debug mode, unconditionally (used to recover
-- from an orphaned BiDi session, where the port is UP but connections are
-- refused, so ensure()'s "port up ⇒ done" check would not help). cb(true) once
-- the debug port is back up, else cb(false, message).
function M.restart(cb)
  local opts = config.options
  local host, port = opts.backend.host, opts.backend.port
  if not opts.firefox.manage then
    cb(false, 'firefox.manage is off; cannot restart Firefox to recover.')
    return
  end
  local deadline = uv.now() + opts.firefox.launch_timeout_ms
  local function do_launch()
    launch(opts)
    wait_up(host, port, deadline, cb)
  end
  M.is_running(function(running)
    if running then quit(do_launch) else do_launch() end
  end)
end

return M
