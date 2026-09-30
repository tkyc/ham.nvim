-- Public API for ham.

local config = require('ham.config')
local ui = require('ham.ui')
local backend = require('ham.backend')

local M = {}

function M.setup(opts)
  config.setup(opts)
  return M
end

M.open, M.close, M.toggle = ui.open, ui.close, ui.toggle

function M.login()
  -- Login launches a visible Firefox on the debug port; doing that while the panel is
  -- open would kill/replace the instance it's using or still starting (or the captcha
  -- solver) and break the session. Require the panel to be closed first.
  if ui.is_open() or backend.is_running() then
    vim.notify('[ham] close the chat panel first (:Ham close), then run :Ham login.', vim.log.levels.WARN)
    return
  end
  require('ham.firefox').login()
end

-- Every :Ham subcommand: the panel's (ui.commands) plus login, which isn't a panel action.
local commands = vim.tbl_extend('error', ui.commands, { login = M.login })

-- Sorted subcommand names, for :Ham completion.
function M.subcommands()
  local names = vim.tbl_keys(commands)
  table.sort(names)
  return names
end

-- Called from plugin/ham.lua for the :Ham command. :Ham <subcommand> runs that
-- subcommand; any other text is a question about your last yank (:Ham <query>), sent
-- with its original casing.
function M._command(args)
  local text = vim.trim(args and args.args or '')
  if text == '' then return ui.open() end
  local cmd = commands[text:lower()]
  if cmd then cmd() else ui.ask(text) end
end

function M.shutdown()
  backend.stop() -- also quits ham's headless Firefox on nvim exit
end

return M
