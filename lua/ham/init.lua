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
  -- Login launches a visible Firefox on the debug port; doing that while the backend
  -- is running would kill/replace the instance it's using (or the captcha solver) and
  -- break the session. Require the panel to be closed first.
  if backend.is_running() then
    vim.notify('[ham] close the chat panel first (:Ham close), then run :Ham login.', vim.log.levels.WARN)
    return
  end
  require('ham.firefox').login()
end

function M._command(args)
  local sub = (args and args.args or ''):lower()
  if sub == 'close' then
    ui.close()
  elseif sub == 'toggle' then
    ui.toggle()
  elseif sub == 'tab' then
    ui.open('tab')
  elseif sub == 'login' then
    M.login()
  elseif sub == 'clear' then
    ui.clear()
  elseif sub == 'retry' then
    ui.retry()
  elseif sub == 'explain' then
    ui.explain()
  elseif sub == 'cancel' then
    ui.cancel()
  else
    ui.open()
  end
end

function M.shutdown()
  backend.stop()
  require('ham.firefox').close() -- quit ham's headless Firefox on nvim exit
end

return M
