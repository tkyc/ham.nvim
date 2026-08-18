-- :checkhealth nam

local config = require('nam.config')
local firefox = require('nam.firefox')

local M = {}

local health = vim.health or require('health')
local h_start = health.start or health.report_start
local h_ok = health.ok or health.report_ok
local h_warn = health.warn or health.report_warn
local h_error = health.error or health.report_error

function M.check()
  local opts = config.options

  h_start('nam')

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
    h_ok(('debug port %s:%d is down — nam will %s Firefox on :nam'):format(
      host, port, opts.firefox.auto_restart and 'launch/restart' or 'launch'))
  else
    h_warn(('nothing listening at %s:%d (firefox.manage is off)'):format(host, port), {
      'Launch Firefox yourself with:  firefox --remote-debugging-port ' .. tostring(port),
      'or set firefox.manage = true to let nam do it.',
    })
  end
end

return M
