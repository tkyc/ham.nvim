-- :checkhealth ham

local config = require('ham.config')
local firefox = require('ham.firefox')

local M = {}

local health = vim.health or require('health')
local h_start = health.start or health.report_start
local h_ok = health.ok or health.report_ok
local h_warn = health.warn or health.report_warn
local h_error = health.error or health.report_error

function M.check()
  local opts = config.options

  h_start('ham')

  -- query mode
  local mode = opts.backend.mode or 'http'
  if mode == 'http' then
    h_ok('query mode: http (browserless token-chaining fetcher; Firefox only for login + captcha)')
    -- Cookie source: on a dedicated profile, queries read cookies straight from disk.
    local prof = opts.firefox.profile
    if prof and prof ~= '' then
      if vim.fn.filereadable(prof .. '/cookies.sqlite') == 1 then
        h_ok('cookies: cookies.sqlite found in profile (no Firefox needed for queries)')
      else
        h_warn('cookies: no cookies.sqlite in ' .. prof, { 'Close the panel (:Ham close), then run  :Ham login  once to sign in.' })
      end
    else
      h_ok('cookies: shared default profile — harvested from a running Firefox')
    end
  elseif mode == 'browser' then
    h_ok('query mode: browser (drives the AI Mode DOM in headless Firefox)')
  else
    h_warn("query mode: '" .. tostring(mode) .. "' is unknown — expected 'browser' or 'http'", {
      "Set backend.mode to 'browser' or 'http' in setup().",
    })
  end

  -- node
  if vim.fn.executable(opts.node_cmd) == 1 then
    h_ok('node found: ' .. opts.node_cmd)
  else
    h_error('`' .. opts.node_cmd .. '` not found on PATH', { 'Install Node.js' })
  end

  -- backend server
  if vim.fn.filereadable(opts.server_path) == 1 then
    h_ok('backend present: ' .. opts.server_path)
  else
    h_error('backend not found: ' .. opts.server_path)
  end

  -- backend deps
  local dep = vim.fn.fnamemodify(opts.server_path, ':h') .. '/node_modules/puppeteer-core'
  if vim.fn.isdirectory(dep) == 1 then
    h_ok('puppeteer-core installed')
  else
    h_error('puppeteer-core not installed', {
      'Run:  cd ' .. vim.fn.fnamemodify(opts.server_path, ':h') .. ' && npm install',
    })
  end

  -- firefox binary
  if vim.fn.executable(opts.firefox.cmd) == 1 then
    h_ok('firefox found: ' .. opts.firefox.cmd)
  else
    h_error('`' .. opts.firefox.cmd .. '` not found on PATH', { 'Install Firefox or set firefox.cmd' })
  end

  -- Firefox remote agent
  local host, port = opts.backend.host, opts.backend.port
  if firefox.is_up_sync(host, port, 800) then
    h_ok(('Firefox debug port reachable at %s:%d'):format(host, port))
  elseif opts.firefox.manage then
    if config.uses_disk_cookies() then
      h_ok(('debug port %s:%d is down — expected in http mode; Firefox launches only for :Ham login and captchas'):format(host, port))
    else
      h_ok(('debug port %s:%d is down — ham will %s Firefox on :Ham'):format(
        host, port, opts.firefox.auto_restart and 'launch/restart' or 'launch'))
    end
  else
    h_warn(('nothing listening at %s:%d (firefox.manage is off)'):format(host, port), {
      'Launch Firefox yourself with:  firefox --remote-debugging-port ' .. tostring(port),
      'or set firefox.manage = true to let ham do it.',
    })
  end
end

return M
