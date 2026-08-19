-- Public API for ham.

local config = require('ham.config')
local ui = require('ham.ui')
local backend = require('ham.backend')

local M = {}

function M.setup(opts)
  config.setup(opts)
  return M
end

function M.open()
  ui.open()
end

function M.close()
  ui.close()
end

function M.toggle()
  ui.toggle()
end

-- Called from plugin/ham.lua for the :Ham command.
function M.login()
  require('ham.firefox').login()
end

function M._command(args)
  local sub = (args and args.args or ''):lower()
  if sub == 'close' then
    ui.close()
  elseif sub == 'toggle' then
    ui.toggle()
  elseif sub == 'login' then
    M.login()
  elseif sub == 'clear' then
    ui.clear()
  elseif sub == 'retry' then
    ui.retry()
  elseif sub == 'explain' then
    ui.explain()
  else
    ui.open()
  end
end

function M.shutdown()
  backend.stop()
  require('ham.firefox').close() -- quit ham's headless Firefox on nvim exit
end

return M
