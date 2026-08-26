-- Firefox lifecycle manager for ham.
--
-- Firefox's WebDriver BiDi remote agent can only be enabled at *startup* via
-- --remote-debugging-port; it cannot be toggled on a running instance, and
-- Firefox is single-instance per profile. So to attach to the user's real
-- (logged-in) Firefox we make sure a debug-enabled instance is running, quitting
-- and relaunching their normal Firefox when necessary.

local config = require('ham.config')

local M = {}

local uv = vim.uv or vim.loop

-- AI Mode page opened headful for one-time login and for solving a captcha. A benign
-- query so the page loads AI Mode (and any pending bot-check) for the user.
local LOGIN_URL = 'https://www.google.com/search?udm=50&q=hello'

local function notify(msg, level)
  -- May be called from a libuv fast context; nvim_echo is not allowed there.
  vim.schedule(function()
    vim.notify('[ham] ' .. msg, level or vim.log.levels.INFO)
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

-- The dedicated profile dir (nil when reusing the default profile).
local function dedicated(opts)
  local p = opts.firefox.profile
  if p and p ~= '' then return p end
  return nil
end

-- Launch ham's Firefox. mode = { headless = bool (default from config), url = str }.
local function launch(opts, mode)
  mode = mode or {}
  local headless = mode.headless
  if headless == nil then headless = opts.firefox.headless ~= false end
  local args = { opts.firefox.cmd, '--remote-debugging-port', tostring(opts.backend.port) }
  local prof = dedicated(opts)
  if prof then
    vim.fn.mkdir(prof, 'p') -- Firefox populates a fresh profile here on first run
    -- --new-instance + a distinct profile ⇒ a SEPARATE instance from the user's
    -- normal (default-profile) Firefox, so ham never blocks their browsing.
    table.insert(args, '--new-instance')
    table.insert(args, '--profile')
    table.insert(args, prof)
  end
  -- Headless has no window ⇒ sidesteps the Firefox-on-Wayland occlusion freeze
  -- that stalls streaming when a visible window is backgrounded.
  if headless then table.insert(args, '--headless') end
  vim.list_extend(args, opts.firefox.extra_args or {})
  if mode.url then table.insert(args, mode.url) end
  -- Only force Wayland for a HEADFUL window (headless needs no display).
  local env = nil
  if (not headless) and vim.env.WAYLAND_DISPLAY and vim.env.WAYLAND_DISPLAY ~= '' then
    env = { MOZ_ENABLE_WAYLAND = '1' }
  end
  vim.fn.jobstart(args, { detach = true, env = env }) -- detached: outlives nvim
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

-- Poll until the debug port is released (ham's instance owns it, so this signals
-- our old instance has exited and the profile lock is free), then a short delay.
local function wait_port_down(host, port, deadline, done)
  M.is_up(host, port, 400, function(up)
    if not up then
      vim.defer_fn(done, 600)
    elseif uv.now() > deadline then
      done()
    else
      vim.defer_fn(function() wait_port_down(host, port, deadline, done) end, 300)
    end
  end)
end

-- Quit ONLY ham's Firefox by matching the debug-port flag on its command line.
-- The user's normal browsing Firefox never has --remote-debugging-port, so it is
-- never touched (regardless of profile). pkill skips its own PID.
local function quit(opts, done)
  local pattern = 'remote-debugging-port ' .. tostring(opts.backend.port)
  vim.system({ 'pkill', '-f', pattern }, {}, function()
    wait_port_down(opts.backend.host, opts.backend.port, uv.now() + 10000, done)
  end)
end

-- Quit (if running) then relaunch in the given mode, cb(true) once the port is up.
local function flip(opts, mode, cb)
  local host, port = opts.backend.host, opts.backend.port
  local deadline = uv.now() + opts.firefox.launch_timeout_ms
  local function do_launch()
    launch(opts, mode)
    wait_up(host, port, deadline, cb)
  end
  M.is_up(host, port, 800, function(up)
    if up then quit(opts, do_launch) else do_launch() end
  end)
end

-- Ensure a debug-enabled Firefox (ham's instance) is reachable, then cb(true).
function M.ensure(cb)
  local opts = config.options
  local host, port = opts.backend.host, opts.backend.port

  M.is_up(host, port, 800, function(up)
    if up then cb(true); return end -- ham's instance already running

    if not opts.firefox.manage then
      cb(false, ('Firefox debug port %s:%d is down. Launch Firefox with '
        .. '--remote-debugging-port %d (or set firefox.manage=true).'):format(host, port, port))
      return
    end

    local deadline = uv.now() + opts.firefox.launch_timeout_ms

    -- Dedicated profile: ham's instance is separate from the user's Firefox, so
    -- there's no conflict — just launch ours (headless).
    if dedicated(opts) then
      notify('launching Firefox (headless)…')
      launch(opts)
      wait_up(host, port, deadline, cb)
      return
    end

    -- Default-profile fallback: ham shares the user's profile, so a running Firefox
    -- (no debug port) must be fully restarted into debug mode (broad kill).
    M.is_running(function(running)
      local function do_launch() launch(opts); wait_up(host, port, deadline, cb) end
      if running then
        if opts.firefox.auto_restart then
          notify('restarting Firefox in debug mode…')
          vim.system({ 'pkill', 'firefox' }, {}, function()
            wait_port_down(host, port, uv.now() + 10000, do_launch)
          end)
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

-- Force-restart ham's Firefox (used to recover from an orphaned BiDi session where
-- the port is up but refuses connections). cb(true) once the port is back up.
function M.restart(cb)
  local opts = config.options
  if not opts.firefox.manage then
    cb(false, 'firefox.manage is off; cannot restart Firefox to recover.')
    return
  end
  flip(opts, {}, cb) -- default mode (headless)
end

-- One-time Google sign-in: open ham's profile HEADFUL (with the debug port) at AI
-- Mode so the user logs in; cookies persist in the dedicated profile.
function M.login(cb)
  local opts = config.options
  notify('opening Firefox — sign into Google, then close the window.')
  flip(opts, { headless = false, url = LOGIN_URL }, cb or function() end)
end

-- Captcha handling: open a VISIBLE window (headful) so the user can solve it…
function M.open_solver(cb)
  flip(config.options, { headless = false, url = LOGIN_URL }, cb)
end

-- …then return to headless once it's solved.
function M.to_headless(cb)
  flip(config.options, { headless = true }, cb)
end

-- Quit ham's Firefox and WAIT for it to fully exit (a clean SIGTERM shutdown flushes
-- cookies to <profile>/cookies.sqlite), then cb(). Used by http mode after a captcha:
-- with the fresh exemption now on disk, the re-sent query reads it and no headless
-- browser is ever launched.
function M.quit(cb)
  quit(config.options, cb or function() end)
end

-- Quit ham's Firefox (only the instance on the debug port — never the user's
-- browsing Firefox). Called on panel close / nvim exit. Synchronous so it still
-- fires during VimLeavePre. No-op when ham doesn't manage Firefox, or when
-- close_on_stop is disabled (keep the headless instance warm).
function M.close()
  local opts = config.options
  if not opts.firefox.manage then return end
  if opts.firefox.close_on_stop == false then return end
  pcall(vim.fn.system, { 'pkill', '-f', 'remote-debugging-port ' .. tostring(opts.backend.port) })
end

return M
