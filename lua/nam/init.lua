-- Public API for nam.

local config = require('nam.config')
local ui = require('nam.ui')
local backend = require('nam.backend')

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

-- Called from plugin/nam.lua for the :Nam command.
function M.login()
  require('nam.firefox').login()
end

function M._command(args)
  local sub = (args and args.args or ''):lower()
  if sub == 'close' then
    ui.close()
  elseif sub == 'toggle' then
    ui.toggle()
  elseif sub == 'login' then
    M.login()
  else
    ui.open()
  end
end

function M.shutdown()
  backend.stop()
  require('nam.firefox').close() -- quit nam's headless Firefox on nvim exit
end

return M
